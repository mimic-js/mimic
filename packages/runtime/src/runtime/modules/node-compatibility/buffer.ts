type BufferEncoding = 'utf8' | 'ascii' | 'latin1' | 'utf16le' | 'hex' | 'base64' | 'base64url';
type BufferSearchValue = string | number | Uint8Array;

/**
 * Marks Buffer prototypes without touching instances, so a Buffer keeps
 * `Object.keys(buffer)` equal to its indices. The registry symbol lets
 * `isBuffer` recognise instances of another copy of this module in the same
 * realm, which `instanceof` alone would reject.
 */
const BUFFER_BRAND = Symbol.for('node-compatibility.buffer');

export class BrowserBuffer extends Uint8Array {
  static poolSize = 8192;

  static get [Symbol.species](): typeof BrowserBuffer {
    return this;
  }

  static from(arrayLike: ArrayLike<number>): BrowserBuffer;
  static from<T>(arrayLike: ArrayLike<T>, mapfn: (value: T, index: number) => number, thisArg?: unknown): BrowserBuffer;
  static from(elements: Iterable<number>): BrowserBuffer;
  static from<T>(elements: Iterable<T>, mapfn?: (value: T, index: number) => number, thisArg?: unknown): BrowserBuffer;
  static from(input: ArrayBufferLike, byteOffset?: number, length?: number): BrowserBuffer;
  static from(input: string | ArrayBufferLike | ArrayBufferView | ArrayLike<number>, encoding?: string): BrowserBuffer;
  static from(
    input: unknown,
    encodingOffsetOrMapfn: string | number | ((value: unknown, index: number) => number) = 'utf8',
    lengthOrThisArg?: unknown
  ): BrowserBuffer {
    const BufferClass = this;
    if (typeof encodingOffsetOrMapfn === 'function') {
      return new BufferClass(Uint8Array.from(input as ArrayLike<unknown>, encodingOffsetOrMapfn, lengthOrThisArg));
    }
    if (typeof input === 'string') return new BufferClass(decodeString(input, encodingOffsetOrMapfn as string));
    if (isArrayBufferLike(input)) {
      const byteOffset = typeof encodingOffsetOrMapfn === 'number' ? encodingOffsetOrMapfn : 0;
      const length = typeof lengthOrThisArg === 'number' ? lengthOrThisArg : input.byteLength - byteOffset;
      return new BufferClass(input, byteOffset, length);
    }
    // Node reads a DataView as an object without a length, which is an empty Buffer.
    if (input instanceof DataView) return new BufferClass(0);
    // Typed arrays contribute their element values, not their bytes. The
    // constructor converts them natively; a per-element callback made copying
    // a megabyte take tens of milliseconds.
    if (ArrayBuffer.isView(input) && isIterable(input)) {
      return new BufferClass(input as unknown as ArrayLike<number>);
    }
    if (isIterable(input)) return new BufferClass(Uint8Array.from(input as Iterable<number>));
    if (input !== null && typeof input === 'object') {
      const serialized = input as { type?: unknown; data?: unknown };
      if (serialized.type === 'Buffer' && Array.isArray(serialized.data)) return new BufferClass(serialized.data as number[]);
      return new BufferClass(Uint8Array.from(input as ArrayLike<number>));
    }
    throw bufferError(
      TypeError,
      'ERR_INVALID_ARG_TYPE',
      `The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object. Received ${describeReceived(input)}`
    );
  }

  static copyBytesFrom(view: ArrayBufferView, offset = 0, length?: number): BrowserBuffer {
    if (!ArrayBuffer.isView(view) || view instanceof DataView) {
      throw bufferError(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "view" argument must be an instance of TypedArray.');
    }
    const elements = view as unknown as Uint8Array;
    const selected = elements.subarray(offset, length === undefined ? undefined : offset + length);
    return new this(new Uint8Array(selected.buffer, selected.byteOffset, selected.byteLength));
  }

  static alloc(size: number, fill?: string | number | Uint8Array, encoding?: string): BrowserBuffer {
    const buffer = new this(size);
    if (fill !== undefined && fill !== 0 && size > 0) buffer.fill(fill, encoding);
    return buffer;
  }

  static allocUnsafe(size: number): BrowserBuffer {
    return new this(size);
  }

  static allocUnsafeSlow(size: number): BrowserBuffer {
    return new this(size);
  }

  static byteLength(input: string | ArrayBufferLike | ArrayBufferView, encoding = 'utf8'): number {
    if (typeof input !== 'string') return input.byteLength;
    // Node sizes hex and base64 from the string length without validating its characters.
    const normalized = normalizeEncoding(encoding);
    if (normalized === 'hex') return input.length >>> 1;
    if (normalized === 'base64' || normalized === 'base64url') {
      let characters = input.length;
      if (input.charCodeAt(characters - 1) === 0x3d) characters -= 1;
      if (characters > 1 && input.charCodeAt(characters - 1) === 0x3d) characters -= 1;
      return (characters * 3) >>> 2;
    }
    return decodeString(input, normalized).byteLength;
  }

  static concat(chunks: readonly Uint8Array[], totalLength?: number): BrowserBuffer {
    for (const chunk of chunks) {
      if (!(chunk instanceof Uint8Array)) {
        throw bufferError(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "list" argument must be an instance of Array of Buffer or Uint8Array.');
      }
    }
    const length = totalLength ?? chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const output = new this(length);
    let offset = 0;
    for (const chunk of chunks) {
      if (offset >= length) break;
      output.set(chunk.subarray(0, length - offset), offset);
      offset += chunk.byteLength;
    }
    return output;
  }

  static compare(source: Uint8Array, target: Uint8Array): number {
    assertCompareInput(source, 'source');
    assertCompareInput(target, 'target');
    return compareBytes(source, target);
  }

  static isBuffer(input: unknown): input is BrowserBuffer {
    return input instanceof BrowserBuffer
      || (input instanceof Uint8Array && (input as { [BUFFER_BRAND]?: unknown })[BUFFER_BRAND] === true);
  }

  static isEncoding(encoding: unknown): boolean {
    return typeof encoding === 'string' && resolveEncoding(encoding) !== undefined;
  }

  /** `new Buffer(string[, encoding])` is deprecated in Node but still decodes. */
  constructor(
    input?: number | string | ArrayBufferLike | ArrayLike<number> | Iterable<number>,
    encodingOrOffset?: string | number,
    length?: number
  ) {
    if (typeof input === 'string') {
      super(decodeString(input, typeof encodingOrOffset === 'string' ? encodingOrOffset : 'utf8'));
    } else {
      super(input as ArrayBuffer, encodingOrOffset as number | undefined, length);
    }
  }

  toString(encoding?: string, start = 0, end = this.byteLength): string {
    const boundedStart = clampIndex(start, this.byteLength);
    const boundedEnd = clampIndex(end, this.byteLength);
    if (boundedEnd <= boundedStart) return '';
    return encodeBytes(this.subarray(boundedStart, boundedEnd), encoding ?? 'utf8');
  }

  toJSON(): { type: 'Buffer'; data: number[] } {
    return { type: 'Buffer', data: Array.from(this) };
  }

  equals(other: Uint8Array): boolean {
    if (!(other instanceof Uint8Array)) {
      throw bufferError(
        TypeError,
        'ERR_INVALID_ARG_TYPE',
        `The "otherBuffer" argument must be an instance of Buffer or Uint8Array. Received ${describeReceived(other)}`
      );
    }
    if (this.byteLength !== other.byteLength) return false;
    for (let index = 0; index < this.byteLength; index += 1) {
      if (this[index] !== other[index]) return false;
    }
    return true;
  }

  compare(
    target: Uint8Array,
    targetStart = 0,
    targetEnd?: number,
    sourceStart = 0,
    sourceEnd = this.byteLength
  ): number {
    assertCompareInput(target, 'target');
    const resolvedTargetEnd = targetEnd ?? target.byteLength;
    assertCompareOffset(targetStart, 'targetStart');
    assertCompareEnd(resolvedTargetEnd, target.byteLength, 'targetEnd');
    assertCompareOffset(sourceStart, 'sourceStart');
    assertCompareEnd(sourceEnd, this.byteLength, 'sourceEnd');
    return compareBytes(
      this.subarray(Math.min(sourceStart, this.byteLength), sourceEnd),
      target.subarray(Math.min(targetStart, target.byteLength), resolvedTargetEnd)
    );
  }

  copy(target: Uint8Array, targetStart = 0, sourceStart = 0, sourceEnd = this.byteLength): number {
    if (!(target instanceof Uint8Array)) throw new TypeError('The target argument must be an instance of Uint8Array or Buffer');
    if (targetStart < 0 || sourceStart < 0 || sourceEnd < 0) throw new RangeError('Buffer copy offsets must be non-negative');
    const boundedSourceStart = Math.min(sourceStart, this.byteLength);
    const boundedSourceEnd = Math.min(Math.max(sourceEnd, boundedSourceStart), this.byteLength);
    const writableLength = Math.max(0, Math.min(boundedSourceEnd - boundedSourceStart, target.byteLength - targetStart));
    if (writableLength === 0) return 0;
    target.set(this.subarray(boundedSourceStart, boundedSourceStart + writableLength), targetStart);
    return writableLength;
  }

  /** Unlike `Uint8Array.prototype.slice`, a Buffer slice is a view over the same memory. */
  slice(start?: number, end?: number): BrowserBuffer {
    return this.subarray(start, end) as BrowserBuffer;
  }

  fill(value: string | number | Uint8Array, offsetOrEncoding?: number | string, endOrEncoding?: number | string, encoding?: string): this {
    let offset = 0;
    let end = this.byteLength;
    let resolvedEncoding = encoding ?? 'utf8';
    if (typeof offsetOrEncoding === 'string') {
      resolvedEncoding = offsetOrEncoding;
    } else {
      if (offsetOrEncoding !== undefined) offset = offsetOrEncoding;
      if (typeof endOrEncoding === 'string') resolvedEncoding = endOrEncoding;
      else if (endOrEncoding !== undefined) end = endOrEncoding;
    }
    if (!(offset >= 0 && offset <= this.byteLength)) throw outOfRange('offset', `>= 0 and <= ${this.byteLength}`, offset);
    if (!(end >= 0 && end <= this.byteLength)) throw outOfRange('end', `>= 0 and <= ${this.byteLength}`, end);
    if (end <= offset) return this;
    if (typeof value !== 'string' && !(value instanceof Uint8Array)) {
      super.fill(Number(value) & 0xff, offset, end);
      return this;
    }
    let pattern = typeof value === 'string' ? decodeString(value, resolvedEncoding) : value;
    if (pattern.byteLength === 0) {
      // Only an empty string fills with zeroes; `fill('zz', 'hex')` decodes to nothing and is an error.
      if (value === '') {
        super.fill(0, offset, end);
        return this;
      }
      throw bufferError(TypeError, 'ERR_INVALID_ARG_VALUE', `The argument 'value' is invalid. Received ${describeValue(value)}`);
    }
    if (pattern.buffer === this.buffer) pattern = Uint8Array.from(pattern);
    for (let index = offset, patternIndex = 0; index < end; index += 1) {
      this[index] = pattern[patternIndex];
      patternIndex = patternIndex + 1 === pattern.byteLength ? 0 : patternIndex + 1;
    }
    return this;
  }

  indexOf(value: BufferSearchValue, byteOffset?: number | string, encoding?: string): number {
    return searchBytes(this, value, byteOffset, encoding, true);
  }

  lastIndexOf(value: BufferSearchValue, byteOffset?: number | string, encoding?: string): number {
    return searchBytes(this, value, byteOffset, encoding, false);
  }

  includes(value: BufferSearchValue, byteOffset?: number | string, encoding?: string): boolean {
    return searchBytes(this, value, byteOffset, encoding, true) !== -1;
  }

  write(
    value: string,
    offsetOrEncoding: number | string = 0,
    lengthOrEncoding?: number | string,
    encoding = 'utf8'
  ): number {
    const offset = typeof offsetOrEncoding === 'number' ? offsetOrEncoding : 0;
    const resolvedEncoding = typeof offsetOrEncoding === 'string'
      ? offsetOrEncoding
      : typeof lengthOrEncoding === 'string'
        ? lengthOrEncoding
        : encoding;
    if (!(offset >= 0 && offset <= this.byteLength)) throw outOfRange('offset', `>= 0 && <= ${this.byteLength}`, offset);
    const normalized = normalizeEncoding(resolvedEncoding);
    const bytes = decodeString(value, normalized);
    const length = typeof lengthOrEncoding === 'number' ? lengthOrEncoding : bytes.byteLength;
    let writable = Math.max(0, Math.min(length, bytes.byteLength, this.byteLength - offset));
    // Node never writes part of a character.
    if (normalized === 'utf8') {
      while (writable > 0 && writable < bytes.byteLength && (bytes[writable] & 0xc0) === 0x80) writable -= 1;
    } else if (normalized === 'utf16le') {
      writable -= writable % 2;
    }
    this.set(bytes.subarray(0, writable), offset);
    return writable;
  }

  readUInt8(offset = 0): number { return readUnsigned(this, offset, 1, true); }
  readUInt16LE(offset = 0): number { return readUnsigned(this, offset, 2, true); }
  readUInt16BE(offset = 0): number { return readUnsigned(this, offset, 2, false); }
  readUInt32LE(offset = 0): number { return readUnsigned(this, offset, 4, true); }
  readUInt32BE(offset = 0): number { return readUnsigned(this, offset, 4, false); }
  readUIntLE(offset: number, byteLength: number): number { return readUnsigned(this, offset, variableWidth(byteLength), true); }
  readUIntBE(offset: number, byteLength: number): number { return readUnsigned(this, offset, variableWidth(byteLength), false); }
  readInt8(offset = 0): number { return readSigned(this, offset, 1, true); }
  readInt16LE(offset = 0): number { return readSigned(this, offset, 2, true); }
  readInt16BE(offset = 0): number { return readSigned(this, offset, 2, false); }
  readInt32LE(offset = 0): number { return readSigned(this, offset, 4, true); }
  readInt32BE(offset = 0): number { return readSigned(this, offset, 4, false); }
  readIntLE(offset: number, byteLength: number): number { return readSigned(this, offset, variableWidth(byteLength), true); }
  readIntBE(offset: number, byteLength: number): number { return readSigned(this, offset, variableWidth(byteLength), false); }
  readBigUInt64LE(offset = 0): bigint { return readBigUnsigned(this, offset, true); }
  readBigUInt64BE(offset = 0): bigint { return readBigUnsigned(this, offset, false); }
  readBigInt64LE(offset = 0): bigint { return BigInt.asIntN(64, readBigUnsigned(this, offset, true)); }
  readBigInt64BE(offset = 0): bigint { return BigInt.asIntN(64, readBigUnsigned(this, offset, false)); }
  readFloatLE(offset = 0): number { return floatView(this, offset, 4).getFloat32(offset, true); }
  readFloatBE(offset = 0): number { return floatView(this, offset, 4).getFloat32(offset, false); }
  readDoubleLE(offset = 0): number { return floatView(this, offset, 8).getFloat64(offset, true); }
  readDoubleBE(offset = 0): number { return floatView(this, offset, 8).getFloat64(offset, false); }

  writeUInt8(value: number, offset = 0): number { return writeInteger(this, value, offset, 1, true, false); }
  writeUInt16LE(value: number, offset = 0): number { return writeInteger(this, value, offset, 2, true, false); }
  writeUInt16BE(value: number, offset = 0): number { return writeInteger(this, value, offset, 2, false, false); }
  writeUInt32LE(value: number, offset = 0): number { return writeInteger(this, value, offset, 4, true, false); }
  writeUInt32BE(value: number, offset = 0): number { return writeInteger(this, value, offset, 4, false, false); }
  writeUIntLE(value: number, offset: number, byteLength: number): number { return writeInteger(this, value, offset, variableWidth(byteLength), true, false); }
  writeUIntBE(value: number, offset: number, byteLength: number): number { return writeInteger(this, value, offset, variableWidth(byteLength), false, false); }
  writeInt8(value: number, offset = 0): number { return writeInteger(this, value, offset, 1, true, true); }
  writeInt16LE(value: number, offset = 0): number { return writeInteger(this, value, offset, 2, true, true); }
  writeInt16BE(value: number, offset = 0): number { return writeInteger(this, value, offset, 2, false, true); }
  writeInt32LE(value: number, offset = 0): number { return writeInteger(this, value, offset, 4, true, true); }
  writeInt32BE(value: number, offset = 0): number { return writeInteger(this, value, offset, 4, false, true); }
  writeIntLE(value: number, offset: number, byteLength: number): number { return writeInteger(this, value, offset, variableWidth(byteLength), true, true); }
  writeIntBE(value: number, offset: number, byteLength: number): number { return writeInteger(this, value, offset, variableWidth(byteLength), false, true); }
  writeBigUInt64LE(value: bigint, offset = 0): number { return writeBigInteger(this, value, offset, true, false); }
  writeBigUInt64BE(value: bigint, offset = 0): number { return writeBigInteger(this, value, offset, false, false); }
  writeBigInt64LE(value: bigint, offset = 0): number { return writeBigInteger(this, value, offset, true, true); }
  writeBigInt64BE(value: bigint, offset = 0): number { return writeBigInteger(this, value, offset, false, true); }
  writeFloatLE(value: number, offset = 0): number { floatView(this, offset, 4).setFloat32(offset, value, true); return offset + 4; }
  writeFloatBE(value: number, offset = 0): number { floatView(this, offset, 4).setFloat32(offset, value, false); return offset + 4; }
  writeDoubleLE(value: number, offset = 0): number { floatView(this, offset, 8).setFloat64(offset, value, true); return offset + 8; }
  writeDoubleBE(value: number, offset = 0): number { floatView(this, offset, 8).setFloat64(offset, value, false); return offset + 8; }

  swap16(): this { return swapBytes(this, 2); }
  swap32(): this { return swapBytes(this, 4); }
  swap64(): this { return swapBytes(this, 8); }
}

Object.defineProperty(BrowserBuffer, 'name', { value: 'Buffer' });
Object.defineProperty(BrowserBuffer.prototype, BUFFER_BRAND, { value: true });

/** `util.inspect` prints a Buffer through this hook, as Node's `buffer.js` defines it. */
const INSPECT_MAX_BYTES = 50;
Object.defineProperty(BrowserBuffer.prototype, Symbol.for('nodejs.util.inspect.custom'), {
  configurable: true,
  writable: true,
  value: function inspect(this: BrowserBuffer): string {
    const remaining = this.byteLength - INSPECT_MAX_BYTES;
    let bytes = encodeBytes(this.subarray(0, INSPECT_MAX_BYTES), 'hex').replace(/(.{2})/g, '$1 ').trim();
    if (remaining > 0) bytes += ` ... ${remaining} more byte${remaining > 1 ? 's' : ''}`;
    return `<${this.constructor.name} ${bytes}>`;
  }
});

// Node spells every `UInt` accessor a second way (`readUint8`, `writeBigUint64LE`, ...).
for (const name of Object.getOwnPropertyNames(BrowserBuffer.prototype)) {
  if (!name.includes('UInt')) continue;
  Object.defineProperty(
    BrowserBuffer.prototype,
    name.replace('UInt', 'Uint'),
    Object.getOwnPropertyDescriptor(BrowserBuffer.prototype, name)!
  );
}

// Node's Buffer has a slice and a write method per encoding, which its
// `toString` and `write` call and packages call directly (busboy parses
// headers with `latin1Slice`).
const ENCODING_METHODS = {
  ascii: 'ascii',
  base64: 'base64',
  base64url: 'base64url',
  hex: 'hex',
  latin1: 'latin1',
  ucs2: 'utf16le',
  utf8: 'utf8'
} as const;
for (const [prefix, encoding] of Object.entries(ENCODING_METHODS)) {
  Object.defineProperty(BrowserBuffer.prototype, `${prefix}Slice`, {
    configurable: true,
    writable: true,
    value: function (this: BrowserBuffer, start = 0, end = this.byteLength): string {
      return this.toString(encoding, start, end);
    }
  });
  Object.defineProperty(BrowserBuffer.prototype, `${prefix}Write`, {
    configurable: true,
    writable: true,
    value: function (this: BrowserBuffer, value: string, offset = 0, length = this.byteLength - offset): number {
      return this.write(value, offset, length, encoding);
    }
  });
}

// Node's Buffer statics do not depend on their receiver; packages call them
// detached (`const { alloc } = Buffer`, `(0, Buffer.from)(...)`). They are
// enumerable, as in Node, where they are assigned to the constructor:
// `safer-buffer` copies them with `for...in`.
for (const name of Object.getOwnPropertyNames(BrowserBuffer)) {
  const descriptor = Object.getOwnPropertyDescriptor(BrowserBuffer, name);
  if (name === 'prototype' || typeof descriptor?.value !== 'function') continue;
  Object.defineProperty(BrowserBuffer, name, {
    ...descriptor,
    enumerable: true,
    value: Object.defineProperty(descriptor.value.bind(BrowserBuffer), 'name', { value: name })
  });
}

/** `node:buffer`, one per realm like the Buffer the adopted ports share (ADR-0026). */
export const nodeBuffer = (() => {
  const buffer = {
    Buffer: BrowserBuffer,
    SlowBuffer: BrowserBuffer,
    Blob: globalThis.Blob,
    File: globalThis.File,
    atob: globalThis.atob?.bind(globalThis),
    btoa: globalThis.btoa?.bind(globalThis),
    isUtf8,
    isAscii,
    INSPECT_MAX_BYTES,
    kMaxLength: Number.MAX_SAFE_INTEGER,
    kStringMaxLength: Number.MAX_SAFE_INTEGER,
    constants: {
      MAX_LENGTH: Number.MAX_SAFE_INTEGER,
      MAX_STRING_LENGTH: Number.MAX_SAFE_INTEGER
    }
  };
  return { ...buffer, default: buffer };
})();

export function isUtf8(input: ArrayBufferLike | ArrayBufferView): boolean {
  const bytes = decodableBytes(utf8InputBytes(input));
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function isAscii(input: ArrayBufferLike | ArrayBufferView): boolean {
  return utf8InputBytes(input).every((byte) => byte < 0x80);
}

export function encodeBytes(bytes: Uint8Array, encoding: string): string {
  const normalized = normalizeEncoding(encoding);
  if (normalized === 'hex') return bytesToHex(bytes);
  if (normalized === 'base64') return bytesToBase64(bytes, BASE64_ALPHABET, true);
  if (normalized === 'base64url') return bytesToBase64(bytes, BASE64URL_ALPHABET, false);
  if (normalized === 'ascii') return bytesToSingleByteText(bytes, 0x7f);
  if (normalized === 'latin1') return bytesToSingleByteText(bytes, 0xff);
  if (normalized === 'utf16le') {
    let decoded = '';
    for (let index = 0; index + 1 < bytes.byteLength; index += 2) {
      decoded += String.fromCharCode(bytes[index] | (bytes[index + 1] << 8));
    }
    return decoded;
  }
  return utf8Decoder.decode(decodableBytes(bytes));
}

// Node keeps a leading byte order mark when it decodes UTF-8.
const utf8Decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const utf8Encoder = new TextEncoder();

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const BASE64_VALUES = new Int8Array(128).fill(-1);
for (let index = 0; index < 64; index += 1) {
  BASE64_VALUES[BASE64_ALPHABET.charCodeAt(index)] = index;
  BASE64_VALUES[BASE64URL_ALPHABET.charCodeAt(index)] = index;
}
const HEX_VALUES = new Int8Array(128).fill(-1);
for (let index = 0; index < 16; index += 1) {
  HEX_VALUES['0123456789abcdef'.charCodeAt(index)] = index;
  HEX_VALUES['0123456789ABCDEF'.charCodeAt(index)] = index;
}
const HEX_BYTES = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, '0'));

function decodeString(input: string, encoding: string): Uint8Array {
  const normalized = normalizeEncoding(encoding);
  if (normalized === 'hex') return hexToBytes(input);
  if (normalized === 'base64' || normalized === 'base64url') return base64ToBytes(input);
  if (normalized === 'ascii' || normalized === 'latin1') {
    // One byte per UTF-16 code unit, so an astral character becomes two bytes.
    const bytes = new Uint8Array(input.length);
    for (let index = 0; index < input.length; index += 1) bytes[index] = input.charCodeAt(index) & 0xff;
    return bytes;
  }
  if (normalized === 'utf16le') {
    const bytes = new Uint8Array(input.length * 2);
    for (let index = 0; index < input.length; index += 1) {
      const code = input.charCodeAt(index);
      bytes[index * 2] = code & 0xff;
      bytes[index * 2 + 1] = code >>> 8;
    }
    return bytes;
  }
  return utf8Encoder.encode(input);
}

/** Decodes whole byte pairs and stops at the first one that is not hexadecimal, as Node does. */
function hexToBytes(input: string): Uint8Array {
  const bytes = new Uint8Array(input.length >>> 1);
  for (let index = 0; index < bytes.length; index += 1) {
    const high = hexValue(input.charCodeAt(index * 2));
    const low = hexValue(input.charCodeAt(index * 2 + 1));
    if (high < 0 || low < 0) return bytes.subarray(0, index);
    bytes[index] = (high << 4) | low;
  }
  return bytes;
}

function hexValue(code: number): number {
  return code < 128 ? HEX_VALUES[code] : -1;
}

/**
 * Node's base64 decoder is forgiving where `atob` throws: it accepts both
 * alphabets under either encoding name, skips every character outside them,
 * needs no padding, and stops at the first `=`.
 */
function base64ToBytes(input: string): Uint8Array {
  const bytes = new Uint8Array(Math.ceil((input.length * 3) / 4));
  let length = 0;
  let bits = 0;
  let bitCount = 0;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code === 0x3d) break;
    const value = code < 128 ? BASE64_VALUES[code] : -1;
    if (value < 0) continue;
    bits = ((bits << 6) | value) & 0xffff;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes[length] = (bits >>> bitCount) & 0xff;
      length += 1;
    }
  }
  return bytes.subarray(0, length);
}

function resolveEncoding(encoding: string): BufferEncoding | undefined {
  switch (encoding.toLowerCase()) {
    case 'utf8':
    case 'utf-8':
      return 'utf8';
    case 'ascii':
      return 'ascii';
    case 'latin1':
    case 'binary':
      return 'latin1';
    case 'utf16le':
    case 'utf-16le':
    case 'ucs2':
    case 'ucs-2':
      return 'utf16le';
    case 'hex':
      return 'hex';
    case 'base64':
      return 'base64';
    case 'base64url':
      return 'base64url';
    default:
      return undefined;
  }
}

function normalizeEncoding(encoding: string): BufferEncoding {
  const resolved = resolveEncoding(String(encoding));
  if (!resolved) throw bufferError(TypeError, 'ERR_UNKNOWN_ENCODING', `Unknown encoding: ${encoding}`);
  return resolved;
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return !!value && typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function';
}

function utf8InputBytes(input: unknown): Uint8Array {
  if (isArrayBufferLike(input)) return new Uint8Array(input);
  if (ArrayBuffer.isView(input) && !(input instanceof DataView)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw bufferError(
    TypeError,
    'ERR_INVALID_ARG_TYPE',
    'The "input" argument must be an instance of ArrayBuffer, Buffer, or TypedArray.'
  );
}

/** `TextDecoder` rejects views over shared memory, so those are copied first. */
function decodableBytes(bytes: Uint8Array): Uint8Array {
  return typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer
    ? Uint8Array.from(bytes)
    : bytes;
}

export function isArrayBufferLike(input: unknown): input is ArrayBufferLike {
  return input instanceof ArrayBuffer
    || (typeof SharedArrayBuffer !== 'undefined' && input instanceof SharedArrayBuffer);
}

function compareBytes(source: Uint8Array, target: Uint8Array): number {
  const sharedLength = Math.min(source.byteLength, target.byteLength);
  for (let index = 0; index < sharedLength; index += 1) {
    if (source[index] < target[index]) return -1;
    if (source[index] > target[index]) return 1;
  }
  if (source.byteLength < target.byteLength) return -1;
  if (source.byteLength > target.byteLength) return 1;
  return 0;
}

function assertCompareInput(value: unknown, name: string): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`The ${name} argument must be an instance of Buffer or Uint8Array`);
  }
}

function assertCompareOffset(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}

function assertCompareEnd(value: number, length: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > length) {
    throw new RangeError(`${name} must be an integer between 0 and ${length}`);
  }
}

function clampIndex(value: number, length: number): number {
  const index = Math.trunc(Number(value));
  if (!(index > 0)) return 0;
  return index > length ? length : index;
}

/**
 * `indexOf`/`lastIndexOf` over bytes. A string or byte-array needle matches as
 * a whole sequence, a number as one byte; a negative offset counts from the end.
 */
function searchBytes(
  bytes: Uint8Array,
  value: BufferSearchValue,
  byteOffset: number | string | undefined,
  encoding: string | undefined,
  forward: boolean
): number {
  let requested: number | undefined;
  let resolvedEncoding = encoding ?? 'utf8';
  if (typeof byteOffset === 'string') resolvedEncoding = byteOffset;
  else requested = byteOffset;
  let needle: Uint8Array;
  if (typeof value === 'string') needle = decodeString(value, resolvedEncoding);
  else if (typeof value === 'number') needle = Uint8Array.of(value & 0xff);
  else if (value instanceof Uint8Array) needle = value;
  else {
    throw bufferError(
      TypeError,
      'ERR_INVALID_ARG_TYPE',
      `The "value" argument must be one of type number or string or an instance of Buffer or Uint8Array. Received ${describeReceived(value)}`
    );
  }

  const length = bytes.byteLength;
  let offset = Number(requested);
  if (Number.isNaN(offset)) offset = forward ? 0 : length;
  offset = Math.trunc(offset);
  if (offset < 0) offset += length;
  if (needle.byteLength === 0) return Math.max(0, Math.min(offset, length));
  if (offset < 0) {
    if (!forward) return -1;
    offset = 0;
  }
  const lastStart = length - needle.byteLength;
  if (forward) {
    for (let index = offset; index <= lastStart; index += 1) {
      if (matchesAt(bytes, needle, index)) return index;
    }
    return -1;
  }
  for (let index = Math.min(offset, lastStart); index >= 0; index -= 1) {
    if (matchesAt(bytes, needle, index)) return index;
  }
  return -1;
}

function matchesAt(bytes: Uint8Array, needle: Uint8Array, start: number): boolean {
  for (let index = 0; index < needle.byteLength; index += 1) {
    if (bytes[start + index] !== needle[index]) return false;
  }
  return true;
}

function checkOffset(bytes: Uint8Array, offset: number, width: number): void {
  if (typeof offset !== 'number') {
    throw bufferError(TypeError, 'ERR_INVALID_ARG_TYPE', `The "offset" argument must be of type number. Received ${describeReceived(offset)}`);
  }
  const maximum = bytes.byteLength - width;
  if (Number.isInteger(offset) && offset >= 0 && offset <= maximum) return;
  if (!Number.isInteger(offset)) throw outOfRange('offset', 'an integer', offset);
  if (maximum < 0) throw bufferError(RangeError, 'ERR_BUFFER_OUT_OF_BOUNDS', 'Attempt to access memory outside buffer bounds');
  throw outOfRange('offset', `>= 0 and <= ${maximum}`, offset);
}

/** The variable-width accessors read and write between one and six bytes. */
function variableWidth(byteLength: number): number {
  if (!Number.isInteger(byteLength) || byteLength < 1 || byteLength > 6) {
    throw outOfRange('byteLength', '>= 1 and <= 6', byteLength);
  }
  return byteLength;
}

function readUnsigned(bytes: Uint8Array, offset: number, width: number, littleEndian: boolean): number {
  checkOffset(bytes, offset, width);
  let value = 0;
  // Multiplication keeps values above 32 bits exact; shifts would wrap them.
  for (let index = 0; index < width; index += 1) {
    value = value * 256 + bytes[littleEndian ? offset + width - 1 - index : offset + index];
  }
  return value;
}

function readSigned(bytes: Uint8Array, offset: number, width: number, littleEndian: boolean): number {
  const value = readUnsigned(bytes, offset, width, littleEndian);
  const signBoundary = 2 ** (width * 8 - 1);
  return value >= signBoundary ? value - signBoundary * 2 : value;
}

function writeInteger(
  bytes: Uint8Array,
  value: number,
  offset: number,
  width: number,
  littleEndian: boolean,
  signed: boolean
): number {
  const numeric = Number(value);
  const span = 2 ** (width * 8);
  const minimum = signed ? -span / 2 : 0;
  const maximum = signed ? span / 2 - 1 : span - 1;
  if (numeric < minimum || numeric > maximum) throw outOfRange('value', `>= ${minimum} and <= ${maximum}`, value);
  checkOffset(bytes, offset, width);
  // A fraction is truncated and NaN is written as zero.
  let remaining = Math.trunc(numeric) || 0;
  if (remaining < 0) remaining += span;
  for (let index = 0; index < width; index += 1) {
    bytes[littleEndian ? offset + index : offset + width - 1 - index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  return offset + width;
}

function readBigUnsigned(bytes: Uint8Array, offset: number, littleEndian: boolean): bigint {
  checkOffset(bytes, offset, 8);
  const first = readUnsigned(bytes, offset, 4, littleEndian);
  const second = readUnsigned(bytes, offset + 4, 4, littleEndian);
  return littleEndian
    ? (BigInt(second) << 32n) | BigInt(first)
    : (BigInt(first) << 32n) | BigInt(second);
}

function writeBigInteger(bytes: Uint8Array, value: bigint, offset: number, littleEndian: boolean, signed: boolean): number {
  if (typeof value !== 'bigint') {
    throw bufferError(TypeError, 'ERR_INVALID_ARG_TYPE', `The "value" argument must be of type bigint. Received ${describeReceived(value)}`);
  }
  const minimum = signed ? -(1n << 63n) : 0n;
  const maximum = signed ? (1n << 63n) - 1n : (1n << 64n) - 1n;
  if (value < minimum || value > maximum) {
    throw outOfRange('value', signed ? '>= -(2n ** 63n) and < 2n ** 63n' : '>= 0n and < 2n ** 64n', `${value}n`);
  }
  checkOffset(bytes, offset, 8);
  const unsigned = BigInt.asUintN(64, value);
  const low = Number(unsigned & 0xffff_ffffn);
  const high = Number(unsigned >> 32n);
  writeInteger(bytes, littleEndian ? low : high, offset, 4, littleEndian, false);
  writeInteger(bytes, littleEndian ? high : low, offset + 4, 4, littleEndian, false);
  return offset + 8;
}

function floatView(bytes: Uint8Array, offset: number, width: number): DataView {
  checkOffset(bytes, offset, width);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function swapBytes<T extends Uint8Array>(bytes: T, width: number): T {
  if (bytes.byteLength % width !== 0) {
    throw bufferError(RangeError, 'ERR_INVALID_BUFFER_SIZE', `Buffer size must be a multiple of ${width * 8}-bits`);
  }
  for (let offset = 0; offset < bytes.byteLength; offset += width) {
    for (let low = offset, high = offset + width - 1; low < high; low += 1, high -= 1) {
      const swapped = bytes[low];
      bytes[low] = bytes[high];
      bytes[high] = swapped;
    }
  }
  return bytes;
}

function outOfRange(name: string, range: string, received: unknown): RangeError & { code: string } {
  return bufferError(
    RangeError,
    'ERR_OUT_OF_RANGE',
    `The value of "${name}" is out of range. It must be ${range}. Received ${String(received)}`
  );
}

function bufferError<T extends Error>(ErrorClass: new (message: string) => T, code: string, message: string): T & { code: string } {
  return Object.assign(new ErrorClass(message), { code });
}

function describeReceived(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'function') return `function ${value.name}`;
  if (typeof value === 'object') return `an instance of ${value.constructor?.name ?? 'Object'}`;
  return `type ${typeof value} (${describeValue(value)})`;
}

function describeValue(value: unknown): string {
  return typeof value === 'string' ? `'${value}'` : String(value);
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let index = 0; index < bytes.byteLength; index += 1) hex += HEX_BYTES[bytes[index]];
  return hex;
}

function bytesToSingleByteText(bytes: Uint8Array, mask: number): string {
  let text = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 8_192) {
    text += String.fromCharCode(
      ...Uint8Array.from(bytes.subarray(offset, offset + 8_192), (byte) => byte & mask)
    );
  }
  return text;
}

function bytesToBase64(bytes: Uint8Array, alphabet: string, padded: boolean): string {
  let encoded = '';
  const wholeLength = bytes.byteLength - (bytes.byteLength % 3);
  for (let index = 0; index < wholeLength; index += 3) {
    const triple = (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2];
    encoded += alphabet[triple >>> 18] + alphabet[(triple >>> 12) & 63] + alphabet[(triple >>> 6) & 63] + alphabet[triple & 63];
  }
  const remainder = bytes.byteLength - wholeLength;
  if (remainder === 1) {
    const single = bytes[wholeLength];
    encoded += alphabet[single >>> 2] + alphabet[(single << 4) & 63] + (padded ? '==' : '');
  } else if (remainder === 2) {
    const pair = (bytes[wholeLength] << 8) | bytes[wholeLength + 1];
    encoded += alphabet[pair >>> 10] + alphabet[(pair >>> 4) & 63] + alphabet[(pair << 2) & 63] + (padded ? '=' : '');
  }
  return encoded;
}
