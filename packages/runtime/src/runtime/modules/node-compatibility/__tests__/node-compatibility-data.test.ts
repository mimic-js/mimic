import { describe, expect, test } from 'vitest';

import { BrowserBuffer, nodeBuffer } from '../buffer';
import { nodeStringDecoder } from '../string-decoder';

describe('Node Compatibility byte data and encoding', () => {
  test('owns Buffer byte identity and encoding without mutating the host global', () => {
    const hostBuffer = globalThis.Buffer;
    const buffer = loadBuiltin('buffer') as {
      Buffer: {
        from(input: string | ArrayLike<number>, encoding?: string): Uint8Array & {
          copy(target: Uint8Array, targetStart?: number, sourceStart?: number, sourceEnd?: number): number;
          toString(encoding?: string, start?: number, end?: number): string;
        };
        isBuffer(input: unknown): boolean;
      };
      SlowBuffer: unknown;
      isUtf8(input: ArrayBufferLike | ArrayBufferView): boolean;
      default: {
        Buffer: unknown;
        SlowBuffer: unknown;
        isUtf8: unknown;
      };
    };

    const encoded = buffer.Buffer.from('browser-data', 'utf8');
    const base64url = encoded.toString('base64url');
    const target = new Uint8Array(7);

    expect(buffer.Buffer.from(base64url, 'base64url').toString()).toBe('browser-data');
    expect(encoded.copy(target, 0, 0, 7)).toBe(7);
    expect(new TextDecoder().decode(target)).toBe('browser');
    expect(buffer.Buffer.isBuffer(encoded)).toBe(true);
    expect(buffer.SlowBuffer).toBe(buffer.Buffer);
    expect(buffer.default.Buffer).toBe(buffer.Buffer);
    expect(buffer.default.SlowBuffer).toBe(buffer.SlowBuffer);
    expect(buffer.default.isUtf8).toBe(buffer.isUtf8);
    expect(globalThis.Buffer).toBe(hostBuffer);
  });

  test('validates complete UTF-8 byte sequences through node:buffer', () => {
    const buffer = loadBuiltin('buffer') as {
      isUtf8(input: ArrayBufferLike | ArrayBufferView): boolean;
    };
    const validView = Uint8Array.from([0x61, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80]);

    expect(buffer.isUtf8(new Uint8Array())).toBe(true);
    expect(buffer.isUtf8(validView)).toBe(true);
    expect(buffer.isUtf8(validView.buffer)).toBe(true);
    const shared = new SharedArrayBuffer(validView.byteLength);
    new Uint8Array(shared).set(validView);
    expect(buffer.isUtf8(shared)).toBe(true);
    expect(buffer.isUtf8(Uint8Array.from([0xc0, 0xaf]))).toBe(false);
    expect(buffer.isUtf8(Uint8Array.from([0xe2, 0x82]))).toBe(false);
    expect(buffer.isUtf8(Uint8Array.from([0x80]))).toBe(false);
  });

  test('rejects non-TypedArray UTF-8 inputs with a Node-shaped argument error', () => {
    const buffer = loadBuiltin('buffer') as {
      isUtf8(input: ArrayBufferLike | ArrayBufferView): boolean;
    };

    expect(() => buffer.isUtf8(new DataView(new ArrayBuffer(1)))).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' })
    );
    expect(() => Reflect.apply(buffer.isUtf8, buffer, ['utf8'])).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' })
    );
  });

  test('decodes split multibyte input through node:string_decoder semantics', () => {
    const stringDecoder = loadBuiltin('string_decoder') as {
      StringDecoder: new (encoding?: string) => {
        write(input: Uint8Array): string;
        end(input?: Uint8Array): string;
      };
      default: {
        StringDecoder: unknown;
      };
    };
    const decoder = new stringDecoder.StringDecoder('utf8');
    const emoji = Uint8Array.from([0xf0, 0x9f, 0x98, 0x80]);

    expect(decoder.write(emoji.slice(0, 2))).toBe('');
    expect(decoder.end(emoji.slice(2))).toBe('😀');
    expect(stringDecoder.default.StringDecoder).toBe(stringDecoder.StringDecoder);
  });

  test('lets a package inherit from StringDecoder by calling it on its own instance', () => {
    const { StringDecoder } = nodeStringDecoder as unknown as {
      StringDecoder: { call(receiver: object, encoding: string): void; prototype: object };
    };
    function LegacyDecoder(this: object): void {
      StringDecoder.call(this, 'utf8');
    }
    LegacyDecoder.prototype = StringDecoder.prototype;
    const decoder = new (LegacyDecoder as unknown as new () => {
      write(input: Uint8Array): string;
      end(): string;
    })();
    const euro = Uint8Array.from([0xe2, 0x82, 0xac]);

    expect(decoder.write(euro.slice(0, 1))).toBe('');
    expect(decoder.write(euro.slice(1))).toBe('€');
    expect(decoder.end()).toBe('');
  });

  test('enumerates the Buffer statics a for...in copy of the constructor carries', () => {
    const copy: Record<string, unknown> = {};
    for (const key in BrowserBuffer) copy[key] = (BrowserBuffer as unknown as Record<string, unknown>)[key];

    expect(Object.keys(copy)).toEqual(
      expect.arrayContaining(['alloc', 'byteLength', 'compare', 'concat', 'from', 'isBuffer', 'isEncoding', 'poolSize'])
    );
    expect((copy.isBuffer as (input: unknown) => boolean)(BrowserBuffer.from('a'))).toBe(true);
  });

  test('preserves Buffer view, copy, typed-array, allocation, and integer behavior', () => {
    const backing = Uint8Array.from([0, 1, 2, 3, 4, 5]);
    const sharedView = BrowserBuffer.from(backing.buffer, 2, 3);
    sharedView[1] = 9;
    expect([...sharedView]).toEqual([2, 9, 4]);
    expect(backing[3]).toBe(9);

    const sourceView = Uint8Array.from([1, 2, 3]);
    const copiedView = BrowserBuffer.from(sourceView);
    sourceView[1] = 9;
    expect([...copiedView]).toEqual([1, 2, 3]);
    expect([...BrowserBuffer.from(new Uint16Array([0x1234, 0x5678]))]).toEqual([0x34, 0x78]);
    expect([...BrowserBuffer.from(new DataView(new ArrayBuffer(4)))]).toEqual([]);

    const framing = BrowserBuffer.from([0x12, 0x34, 0x56, 0x78]);
    expect(framing.readUInt16BE(0)).toBe(0x1234);
    expect(framing.readUInt16BE(2)).toBe(0x5678);
    expect(framing.readUInt32BE(0)).toBe(0x12345678);
    expect(BrowserBuffer.allocUnsafeSlow(4)).toHaveLength(4);
  });

  test('accepts the Buffer.write string-encoding overload used by module lexers', () => {
    const buffer = BrowserBuffer.alloc(8);

    expect(buffer.write('AΩ', 'utf16le')).toBe(4);
    expect([...buffer]).toEqual([0x41, 0x00, 0xa9, 0x03, 0, 0, 0, 0]);
  });

  test('compares Buffer ranges with Node-compatible byte ordering', () => {
    const gitLfsPrefix = BrowserBuffer.from('version https://git-lfs.github.com');
    const asset = BrowserBuffer.from('version https://git-lfs.github.com/spec/v1');

    expect(gitLfsPrefix.compare(asset, 0, gitLfsPrefix.length)).toBe(0);
    expect(BrowserBuffer.from('abc').compare(BrowserBuffer.from('abd'))).toBe(-1);
    expect(BrowserBuffer.compare(BrowserBuffer.from('abd'), BrowserBuffer.from('abc'))).toBe(1);
    expect(BrowserBuffer.compare(BrowserBuffer.from('abc'), Uint8Array.from([97, 98, 99]))).toBe(0);
  });

  test('rejects non-byte-array Buffer comparison operands', () => {
    const buffer = BrowserBuffer.from([1]);
    const dataView = new DataView(new ArrayBuffer(1));

    expect(() => Reflect.apply(BrowserBuffer.compare, BrowserBuffer, [dataView, buffer])).toThrow(TypeError);
    expect(() => Reflect.apply(BrowserBuffer.compare, BrowserBuffer, [buffer, dataView])).toThrow(TypeError);
    expect(() => Reflect.apply(buffer.compare, buffer, [dataView])).toThrow(TypeError);
  });

  test('shares memory between a Buffer and its slices, and keeps instances free of own properties', () => {
    const { Buffer: ContextBuffer } = loadBuiltin('buffer') as { Buffer: typeof BrowserBuffer };
    const parent = ContextBuffer.from('hello');
    const slice = parent.slice(1, 3);
    const view = parent.subarray(-2);

    slice[0] = 0x41;
    view[1] = 0x21;
    expect(parent.toString()).toBe('hAll!');
    expect(slice.buffer).toBe(parent.buffer);
    expect(slice).toBeInstanceOf(ContextBuffer);
    expect(view).toBeInstanceOf(ContextBuffer);
    expect(parent.slice(-3, -1).toString()).toBe('ll');
    expect(ContextBuffer.isBuffer(slice)).toBe(true);
    expect(ContextBuffer.isBuffer(parent.map((byte) => byte))).toBe(true);

    expect(Object.keys(ContextBuffer.alloc(1))).toEqual(['0']);
    expect(Object.getOwnPropertySymbols(ContextBuffer.alloc(1))).toEqual([]);
    expect(Object.keys(BrowserBuffer.from('ab'))).toEqual(['0', '1']);
    // One context's Buffer is a Buffer to every other context and to the runtime.
    const { Buffer: OtherContextBuffer } = loadBuiltin('buffer') as { Buffer: typeof BrowserBuffer };
    expect(OtherContextBuffer.isBuffer(parent)).toBe(true);
    expect(BrowserBuffer.isBuffer(parent)).toBe(true);
    expect(BrowserBuffer.isBuffer(new Uint8Array(1))).toBe(false);
    expect(BrowserBuffer.isBuffer({ length: 1, 0: 1 })).toBe(false);
  });

  test('builds Buffers from views, serialized Buffers and fill patterns as Node does', () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);

    // Node reads a DataView as an object with no length.
    expect([...BrowserBuffer.from(new DataView(bytes.buffer, 1, 2))]).toEqual([]);
    expect([...BrowserBuffer.from(new Float32Array([1.5, 300, -1]))]).toEqual([0x01, 0x2c, 0xff]);
    // Node refuses to mix BigInt elements with numbers.
    expect(() => BrowserBuffer.from(new BigInt64Array([1n]))).toThrow(TypeError);
    expect([...BrowserBuffer.copyBytesFrom(new Uint16Array([1, 2, 3]), 1, 1)]).toEqual([2, 0]);
    expect([...BrowserBuffer.from({ type: 'Buffer', data: [1, 2] } as unknown as ArrayLike<number>)]).toEqual([1, 2]);
    expect([...BrowserBuffer.from({ length: 2, 0: 5, 1: 6 })]).toEqual([5, 6]);
    expect([...BrowserBuffer.from(new SharedArrayBuffer(2))]).toEqual([0, 0]);
    expect(() => BrowserBuffer.from(5 as unknown as string)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    expect([...new BrowserBuffer('ab')]).toEqual([0x61, 0x62]);
    expect([...new BrowserBuffer('ab', 'hex')]).toEqual([0xab]);

    expect([...BrowserBuffer.alloc(5, 'ab')]).toEqual([0x61, 0x62, 0x61, 0x62, 0x61]);
    expect([...BrowserBuffer.alloc(5, '0a0b', 'hex')]).toEqual([0x0a, 0x0b, 0x0a, 0x0b, 0x0a]);
    expect([...BrowserBuffer.alloc(5, Uint8Array.from([1, 2]))]).toEqual([1, 2, 1, 2, 1]);
    expect([...BrowserBuffer.alloc(3, 257)]).toEqual([1, 1, 1]);
    expect([...BrowserBuffer.alloc(3, '')]).toEqual([0, 0, 0]);
    expect([...BrowserBuffer.alloc(6).fill('abc', 1, 5)]).toEqual([0, 0x61, 0x62, 0x63, 0x61, 0]);
    expect(() => BrowserBuffer.alloc(4).fill('zz', 'hex')).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }));
    expect([...BrowserBuffer.concat([BrowserBuffer.from('a')], 3)]).toEqual([0x61, 0, 0]);
    expect(BrowserBuffer.concat([BrowserBuffer.from('abc'), BrowserBuffer.from('def')], 4).toString()).toBe('abcd');
  });

  test('decodes base64 and hex leniently and encodes every Node encoding', () => {
    const decode = (text: string, encoding: string) => BrowserBuffer.from(text, encoding).toString('latin1');

    expect(decode('aGVs bG8\n=', 'base64')).toBe('hello');
    expect(decode('aGVs*bG8', 'base64')).toBe('hello');
    expect(decode('aGk=aGk=', 'base64')).toBe('hi');
    expect(decode('aGk', 'base64')).toBe('hi');
    expect(decode('aG', 'base64')).toBe('h');
    expect(decode('a', 'base64')).toBe('');
    expect([...BrowserBuffer.from('-_-_', 'base64')]).toEqual([0xfb, 0xff, 0xbf]);
    expect([...BrowserBuffer.from('+/+/', 'base64url')]).toEqual([0xfb, 0xff, 0xbf]);
    expect([...BrowserBuffer.from('abc', 'hex')]).toEqual([0xab]);
    expect([...BrowserBuffer.from('abzz12', 'hex')]).toEqual([0xab]);
    expect([...BrowserBuffer.from('Ła', 'latin1')]).toEqual([0x41, 0x61]);
    expect([...BrowserBuffer.from('ab', 'ucs2')]).toEqual([0x61, 0, 0x62, 0]);
    expect(BrowserBuffer.byteLength('aGk=', 'base64')).toBe(2);
    expect(BrowserBuffer.byteLength('hé', 'utf8')).toBe(3);

    const sample = BrowserBuffer.from([0xfb, 0xff, 0xbf, 0xe9, 0x41]);
    expect(sample.toString('hex')).toBe('fbffbfe941');
    expect(sample.toString('base64')).toBe('+/+/6UE=');
    expect(sample.toString('base64url')).toBe('-_-_6UE');
    expect(sample.toString('latin1')).toBe('ûÿ¿éA');
    expect(sample.toString('binary')).toBe('ûÿ¿éA');
    expect(sample.subarray(3).toString('ascii')).toBe('iA');
    expect(BrowserBuffer.from([0x41, 0, 0x42]).toString('utf16le')).toBe('A');
    expect(BrowserBuffer.from('héllo').toString('utf8', 1, 3)).toBe('é');
    expect(BrowserBuffer.from('hello').toString(undefined, -1, 99)).toBe('hello');
    // A byte order mark survives decoding, as it does in Node.
    expect(BrowserBuffer.from([0xef, 0xbb, 0xbf, 0x41]).toString()).toBe('﻿A');
    expect(['UTF-8', 'binary', 'ucs-2', 'utf-16le', 'base64url', 'nope', 1].map((name) => BrowserBuffer.isEncoding(name)))
      .toEqual([true, true, true, true, true, false, false]);
    expect(() => BrowserBuffer.from('a', 'nope')).toThrow(expect.objectContaining({ code: 'ERR_UNKNOWN_ENCODING' }));
  });

  test('searches, serializes, compares and swaps bytes', () => {
    const buffer = BrowserBuffer.from('hello world');

    expect(buffer.indexOf('o')).toBe(4);
    expect(buffer.indexOf('o', 5)).toBe(7);
    expect(buffer.indexOf('o', -3)).toBe(-1);
    expect(buffer.indexOf('6c6c', 'hex')).toBe(2);
    expect(buffer.indexOf(BrowserBuffer.from('wor'))).toBe(6);
    expect(buffer.indexOf(Uint8Array.from([0x6c, 0x64]))).toBe(9);
    expect(buffer.indexOf(111)).toBe(4);
    expect(buffer.indexOf('', 3)).toBe(3);
    expect(buffer.lastIndexOf('o')).toBe(7);
    expect(buffer.lastIndexOf('o', 5)).toBe(4);
    expect(buffer.lastIndexOf('l', -3)).toBe(3);
    expect(buffer.includes('world')).toBe(true);
    expect(buffer.includes('xyz')).toBe(false);

    expect(JSON.stringify(BrowserBuffer.from('ab'))).toBe('{"type":"Buffer","data":[97,98]}');
    expect(BrowserBuffer.from('a').equals(Uint8Array.from([0x61]))).toBe(true);
    expect(BrowserBuffer.from('a').equals(BrowserBuffer.from('b'))).toBe(false);
    expect(() => BrowserBuffer.from('a').equals('a' as unknown as Uint8Array)).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' })
    );
    expect([...BrowserBuffer.from([1, 2, 3, 4]).swap16()]).toEqual([2, 1, 4, 3]);
    expect([...BrowserBuffer.from([1, 2, 3, 4]).swap32()]).toEqual([4, 3, 2, 1]);
    expect([...BrowserBuffer.from([1, 2, 3, 4, 5, 6, 7, 8]).swap64()]).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
    expect(() => BrowserBuffer.from([1, 2, 3]).swap16()).toThrow(expect.objectContaining({ code: 'ERR_INVALID_BUFFER_SIZE' }));

    const partial = BrowserBuffer.alloc(4);
    expect(partial.write('héllo', 1)).toBe(3);
    expect([...partial]).toEqual([0, 0x68, 0xc3, 0xa9]);
    // A character that does not fit whole is not written at all.
    expect(BrowserBuffer.alloc(2).write('é€')).toBe(2);
    const overlapping = BrowserBuffer.from('abcdef');
    overlapping.copy(overlapping, 2, 0, 4);
    expect(overlapping.toString()).toBe('ababcd');
  });

  test('reads and writes the whole integer and float accessor family like the host Buffer', () => {
    type Accessors = Record<string, (...args: unknown[]) => unknown>;
    const sample = [0x01, 0x82, 0x03, 0xf4, 0x05, 0x86, 0x07, 0xf8, 0x09, 0x8a];
    const outcome = (run: () => unknown): unknown => {
      try {
        return run();
      } catch (error) {
        return `throws ${(error as { code?: string }).code}`;
      }
    };
    const fixedWidth = [
      'UInt8', 'UInt16LE', 'UInt16BE', 'UInt32LE', 'UInt32BE', 'Int8', 'Int16LE', 'Int16BE', 'Int32LE', 'Int32BE',
      'FloatLE', 'FloatBE', 'DoubleLE', 'DoubleBE', 'Uint8', 'Uint16BE', 'Uint32LE'
    ];
    const bigWidth = ['BigUInt64LE', 'BigUInt64BE', 'BigInt64LE', 'BigInt64BE', 'BigUint64LE'];
    const numbers = [0, 1, 127, 128, 255, 256, 65_535, 65_536, 2 ** 31, 2 ** 32 - 1, 2 ** 32, -1, -128, -129, -32_768, -(2 ** 31), 1.7, NaN];
    const bigints = [0n, 1n, 255n, 2n ** 63n - 1n, 2n ** 63n, 2n ** 64n - 1n, 2n ** 64n, -1n, -(2n ** 63n), -(2n ** 63n) - 1n];

    for (const name of [...fixedWidth, ...bigWidth]) {
      for (const offset of [0, 1, 2, 3, 9, 10, -1, 0.5]) {
        expect(
          outcome(() => String((BrowserBuffer.from(sample) as unknown as Accessors)[`read${name}`](offset))),
          `read${name}(${offset})`
        ).toBe(outcome(() => String((Buffer.from(sample) as unknown as Accessors)[`read${name}`](offset))));
        for (const value of bigWidth.includes(name) ? bigints : numbers) {
          const write = (target: Uint8Array) => outcome(() => [(target as unknown as Accessors)[`write${name}`](value, offset), [...target]]);
          expect(write(BrowserBuffer.alloc(10)), `write${name}(${value}, ${offset})`).toEqual(write(Buffer.alloc(10)));
        }
      }
    }
    for (const name of ['UIntLE', 'UIntBE', 'IntLE', 'IntBE']) {
      for (let width = 0; width <= 7; width += 1) {
        for (const offset of [0, 2, 6]) {
          expect(
            outcome(() => (BrowserBuffer.from(sample) as unknown as Accessors)[`read${name}`](offset, width)),
            `read${name}(${offset}, ${width})`
          ).toBe(outcome(() => (Buffer.from(sample) as unknown as Accessors)[`read${name}`](offset, width)));
          for (const value of [0, 1, 255, 256, 2 ** 40, 2 ** 47, 2 ** 48 - 1, -1, -(2 ** 47), -5]) {
            const write = (target: Uint8Array) => outcome(() => [(target as unknown as Accessors)[`write${name}`](value, offset, width), [...target]]);
            expect(write(BrowserBuffer.alloc(10)), `write${name}(${value}, ${offset}, ${width})`).toEqual(write(Buffer.alloc(10)));
          }
        }
      }
    }

    const framing = BrowserBuffer.from(sample);
    expect(framing.readInt16BE(1)).toBe(-32_253);
    expect(framing.readUIntBE(0, 6)).toBe(0x018203f40586);
    expect(framing.readIntLE(0, 3)).toBe(0x038201);
    expect(framing.readBigUInt64BE(0)).toBe(0x018203f4058607f8n);
    expect(BrowserBuffer.from([0, 0, 0xc0, 0x3f]).readFloatLE(0)).toBe(1.5);
    expect(() => framing.readUInt32BE(7)).toThrow(expect.objectContaining({ code: 'ERR_OUT_OF_RANGE' }));
    expect(() => BrowserBuffer.alloc(2).readUInt32BE(0)).toThrow(expect.objectContaining({ code: 'ERR_BUFFER_OUT_OF_BOUNDS' }));
    expect(() => BrowserBuffer.alloc(2).writeUInt8(256)).toThrow(expect.objectContaining({ code: 'ERR_OUT_OF_RANGE' }));
  });

  test('keeps Buffer statics usable when packages detach them from Buffer', () => {
    const { Buffer: ContextBuffer } = loadBuiltin('buffer') as { Buffer: typeof BrowserBuffer };
    const { alloc, allocUnsafe, allocUnsafeSlow, concat, from } = ContextBuffer;

    expect(alloc(2, 1)).toBeInstanceOf(ContextBuffer);
    expect(allocUnsafe(2)).toBeInstanceOf(ContextBuffer);
    expect(allocUnsafeSlow(2)).toBeInstanceOf(ContextBuffer);
    expect(from('detached').toString()).toBe('detached');
    expect(from('detached')).toBeInstanceOf(ContextBuffer);
    expect(concat([from('a'), from('b')]).toString()).toBe('ab');
    expect(ContextBuffer.from.name).toBe('from');
  });
});

function loadBuiltin(name: string): unknown {
  const builtin = { buffer: nodeBuffer, string_decoder: nodeStringDecoder }[name];
  if (!builtin) throw new Error(`Missing Node Compatibility builtin: ${name}`);
  return builtin;
}
