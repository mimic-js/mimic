/**
 * The one binary encoding of values that cross a synchronous channel. It
 * covers what the structured clone algorithm covers for plain data:
 * primitives, BigInt, strings, arrays, plain objects, Map, Set, Date, RegExp,
 * Error, ArrayBuffer and typed arrays, with shared references and cycles kept.
 * Bytes travel as raw bytes, never as text or number arrays; a large byte
 * payload is referenced, not copied, until the channel writes it.
 *
 * A value the encoding cannot carry by content (a SharedArrayBuffer) is handed
 * to an `external` hook that names it with a serialisable descriptor, and the
 * decoding side resolves that descriptor back to the shared object.
 */

export interface EncodedValue {
  readonly byteLength: number;
  /** Consecutive pieces of the encoding; large byte payloads are their own piece. */
  readonly parts: readonly Uint8Array[];
}

export interface ValueEncodingOptions {
  /** Names a SharedArrayBuffer by a descriptor the receiving side can resolve. */
  external?(buffer: SharedArrayBuffer): unknown;
}

export interface ValueDecodingOptions {
  external?(descriptor: unknown): SharedArrayBuffer;
}

const Tag = {
  undefined: 0,
  null: 1,
  false: 2,
  true: 3,
  int32: 4,
  float64: 5,
  bigint: 6,
  string: 7,
  array: 8,
  object: 9,
  map: 10,
  set: 11,
  date: 12,
  regexp: 13,
  error: 14,
  arrayBuffer: 15,
  view: 16,
  sharedView: 17,
  reference: 18
} as const;

const viewKinds = [
  Uint8Array,
  Int8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
  DataView
] as const;

type ViewConstructor = (typeof viewKinds)[number];

// Payloads at least this large become their own part instead of being copied.
const REFERENCED_PAYLOAD_BYTES = 4 * 1024;
const INITIAL_SCRATCH_BYTES = 1024;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class ValueEncodingError extends Error {
  readonly code = 'DATA_CLONE_ERROR';

  constructor(message: string) {
    super(message);
    this.name = 'DataCloneError';
  }
}

export function encodeValue(value: unknown, options: ValueEncodingOptions = {}): EncodedValue {
  const writer = new Writer();
  const references = new Map<object, number>();

  const remember = (object: object): boolean => {
    const index = references.get(object);
    if (index !== undefined) {
      writer.byte(Tag.reference);
      writer.uint32(index);
      return true;
    }
    references.set(object, references.size);
    return false;
  };

  const encode = (item: unknown): void => {
    switch (typeof item) {
      case 'undefined':
        writer.byte(Tag.undefined);
        return;
      case 'boolean':
        writer.byte(item ? Tag.true : Tag.false);
        return;
      case 'number':
        if (Number.isInteger(item) && item >= -0x80000000 && item <= 0x7fffffff && !Object.is(item, -0)) {
          writer.byte(Tag.int32);
          writer.int32(item);
        } else {
          writer.byte(Tag.float64);
          writer.float64(item);
        }
        return;
      case 'bigint':
        writer.byte(Tag.bigint);
        writer.string(item.toString());
        return;
      case 'string':
        writer.byte(Tag.string);
        writer.string(item);
        return;
      case 'object':
        if (item === null) {
          writer.byte(Tag.null);
          return;
        }
        encodeObject(item);
        return;
      default:
        throw new ValueEncodingError(`A ${typeof item} value cannot be encoded.`);
    }
  };

  const encodeObject = (item: object): void => {
    if (ArrayBuffer.isView(item)) {
      encodeView(item);
      return;
    }
    if (remember(item)) return;
    if (Array.isArray(item)) {
      writer.byte(Tag.array);
      writer.uint32(item.length);
      for (let index = 0; index < item.length; index += 1) encode(item[index]);
      return;
    }
    if (item instanceof ArrayBuffer) {
      writer.byte(Tag.arrayBuffer);
      writer.bytes(new Uint8Array(item));
      return;
    }
    if (typeof SharedArrayBuffer === 'function' && item instanceof SharedArrayBuffer) {
      throw new ValueEncodingError('A SharedArrayBuffer can only be encoded through a view.');
    }
    if (item instanceof Map) {
      writer.byte(Tag.map);
      writer.uint32(item.size);
      for (const [key, entry] of item) {
        encode(key);
        encode(entry);
      }
      return;
    }
    if (item instanceof Set) {
      writer.byte(Tag.set);
      writer.uint32(item.size);
      for (const entry of item) encode(entry);
      return;
    }
    if (item instanceof Date) {
      writer.byte(Tag.date);
      writer.float64(item.getTime());
      return;
    }
    if (item instanceof RegExp) {
      writer.byte(Tag.regexp);
      writer.string(item.source);
      writer.string(item.flags);
      return;
    }
    if (item instanceof Error) {
      writer.byte(Tag.error);
      writer.string(item.name);
      writer.string(item.message);
      encode(typeof item.stack === 'string' ? item.stack : undefined);
      return;
    }
    const keys = Object.keys(item);
    writer.byte(Tag.object);
    writer.uint32(keys.length);
    for (const key of keys) {
      writer.string(key);
      encode((item as Record<string, unknown>)[key]);
    }
  };

  const encodeView = (view: ArrayBufferView): void => {
    const kind = viewKinds.findIndex((constructor) => view instanceof constructor);
    if (kind < 0) throw new ValueEncodingError('This typed array kind cannot be encoded.');
    const elements = view instanceof DataView ? view.byteLength : (view as Uint8Array).length;
    if (typeof SharedArrayBuffer === 'function' && view.buffer instanceof SharedArrayBuffer) {
      if (!options.external) {
        throw new ValueEncodingError('A view of shared memory cannot be encoded on this channel.');
      }
      if (remember(view)) return;
      const descriptor = options.external(view.buffer);
      writer.byte(Tag.sharedView);
      writer.byte(kind);
      writer.uint32(view.byteOffset);
      writer.uint32(elements);
      encode(descriptor);
      return;
    }
    if (remember(view)) return;
    // A view travels as its own bytes; the rest of its buffer stays behind.
    writer.byte(Tag.view);
    writer.byte(kind);
    writer.uint32(elements);
    writer.bytes(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  };

  encode(value);
  return writer.finish();
}

export function decodeValue(bytes: Uint8Array, options: ValueDecodingOptions = {}): unknown {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const references: unknown[] = [];
  let offset = 0;

  const take = (length: number): number => {
    const start = offset;
    if (start + length > bytes.byteLength) throw new Error('The encoded value is truncated.');
    offset += length;
    return start;
  };
  const byte = (): number => bytes[take(1)];
  const uint32 = (): number => view.getUint32(take(4), true);
  const string = (): string => {
    const length = uint32();
    const start = take(length);
    return textDecoder.decode(bytes.subarray(start, start + length));
  };
  const payload = (): Uint8Array => {
    const length = uint32();
    const start = take(length);
    return bytes.slice(start, start + length);
  };
  const construct = (kind: number, buffer: ArrayBufferLike, byteOffset: number, elements: number): ArrayBufferView => {
    const constructor: ViewConstructor | undefined = viewKinds[kind];
    if (!constructor) throw new Error('The encoded typed array kind is unknown.');
    return new (constructor as new (buffer: ArrayBufferLike, byteOffset: number, length: number) => ArrayBufferView)(
      buffer,
      byteOffset,
      elements
    );
  };

  const decode = (): unknown => {
    const tag = byte();
    switch (tag) {
      case Tag.undefined:
        return undefined;
      case Tag.null:
        return null;
      case Tag.false:
        return false;
      case Tag.true:
        return true;
      case Tag.int32:
        return view.getInt32(take(4), true);
      case Tag.float64:
        return view.getFloat64(take(8), true);
      case Tag.bigint:
        return BigInt(string());
      case Tag.string:
        return string();
      case Tag.array: {
        const length = uint32();
        const array: unknown[] = new Array(length);
        references.push(array);
        for (let index = 0; index < length; index += 1) array[index] = decode();
        return array;
      }
      case Tag.object: {
        const count = uint32();
        const object: Record<string, unknown> = {};
        references.push(object);
        for (let index = 0; index < count; index += 1) {
          const key = string();
          Object.defineProperty(object, key, {
            value: decode(),
            enumerable: true,
            writable: true,
            configurable: true
          });
        }
        return object;
      }
      case Tag.map: {
        const count = uint32();
        const map = new Map<unknown, unknown>();
        references.push(map);
        for (let index = 0; index < count; index += 1) {
          const key = decode();
          map.set(key, decode());
        }
        return map;
      }
      case Tag.set: {
        const count = uint32();
        const set = new Set<unknown>();
        references.push(set);
        for (let index = 0; index < count; index += 1) set.add(decode());
        return set;
      }
      case Tag.date: {
        const date = new Date(view.getFloat64(take(8), true));
        references.push(date);
        return date;
      }
      case Tag.regexp: {
        const source = string();
        const regexp = new RegExp(source, string());
        references.push(regexp);
        return regexp;
      }
      case Tag.error: {
        const error = new Error();
        references.push(error);
        error.name = string();
        error.message = string();
        const stack = decode();
        if (typeof stack === 'string') error.stack = stack;
        return error;
      }
      case Tag.arrayBuffer: {
        const buffer = payload().buffer;
        references.push(buffer);
        return buffer;
      }
      case Tag.view: {
        const kind = byte();
        const elements = uint32();
        const index = references.push(undefined) - 1;
        const result = construct(kind, payload().buffer, 0, elements);
        references[index] = result;
        return result;
      }
      case Tag.sharedView: {
        const kind = byte();
        const byteOffset = uint32();
        const elements = uint32();
        const index = references.push(undefined) - 1;
        const descriptor = decode();
        if (!options.external) throw new Error('A shared memory view arrived on a channel that cannot resolve it.');
        const result = construct(kind, options.external(descriptor), byteOffset, elements);
        references[index] = result;
        return result;
      }
      case Tag.reference: {
        const index = uint32();
        if (index >= references.length) throw new Error('The encoded value refers to an unknown object.');
        return references[index];
      }
      default:
        throw new Error(`The encoded value tag ${tag} is unknown.`);
    }
  };

  const result = decode();
  if (offset !== bytes.byteLength) throw new Error('The encoded value has trailing bytes.');
  return result;
}

class Writer {
  #scratch = new Uint8Array(INITIAL_SCRATCH_BYTES);
  #view = new DataView(this.#scratch.buffer);
  #offset = 0;
  #parts: Uint8Array[] = [];
  #byteLength = 0;

  byte(value: number): void {
    this.#reserve(1);
    this.#scratch[this.#offset] = value;
    this.#offset += 1;
  }

  uint32(value: number): void {
    this.#reserve(4);
    this.#view.setUint32(this.#offset, value, true);
    this.#offset += 4;
  }

  int32(value: number): void {
    this.#reserve(4);
    this.#view.setInt32(this.#offset, value, true);
    this.#offset += 4;
  }

  float64(value: number): void {
    this.#reserve(8);
    this.#view.setFloat64(this.#offset, value, true);
    this.#offset += 8;
  }

  string(value: string): void {
    if (value.length >= REFERENCED_PAYLOAD_BYTES) {
      this.bytes(textEncoder.encode(value));
      return;
    }
    // UTF-8 needs at most three bytes per UTF-16 code unit.
    this.#reserve(4 + value.length * 3);
    const { written } = textEncoder.encodeInto(value, this.#scratch.subarray(this.#offset + 4));
    this.#view.setUint32(this.#offset, written, true);
    this.#offset += 4 + written;
  }

  bytes(value: Uint8Array): void {
    this.uint32(value.byteLength);
    if (value.byteLength < REFERENCED_PAYLOAD_BYTES) {
      this.#reserve(value.byteLength);
      this.#scratch.set(value, this.#offset);
      this.#offset += value.byteLength;
      return;
    }
    this.#flush();
    this.#parts.push(value);
    this.#byteLength += value.byteLength;
  }

  finish(): EncodedValue {
    this.#flush();
    return { byteLength: this.#byteLength, parts: this.#parts };
  }

  #reserve(length: number): void {
    if (this.#offset + length <= this.#scratch.byteLength) return;
    const grown = new Uint8Array(Math.max(this.#scratch.byteLength * 2, this.#offset + length));
    grown.set(this.#scratch.subarray(0, this.#offset));
    this.#scratch = grown;
    this.#view = new DataView(grown.buffer);
  }

  #flush(): void {
    if (this.#offset === 0) return;
    this.#parts.push(this.#scratch.subarray(0, this.#offset));
    this.#byteLength += this.#offset;
    this.#scratch = new Uint8Array(INITIAL_SCRATCH_BYTES);
    this.#view = new DataView(this.#scratch.buffer);
    this.#offset = 0;
  }
}
