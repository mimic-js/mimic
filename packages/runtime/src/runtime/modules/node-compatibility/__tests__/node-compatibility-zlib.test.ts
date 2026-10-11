import { describe, expect, test } from 'vitest';

import { createZlibBuiltin } from '../zlib';

type ZlibBuiltin = {
  gzipSync(input: string | Uint8Array): Uint8Array & { toString(encoding?: string): string };
  gunzipSync(input: Uint8Array): Uint8Array & { toString(encoding?: string): string };
  deflateSync(input: string | Uint8Array): Uint8Array & { toString(encoding?: string): string };
  inflateSync(input: Uint8Array): Uint8Array & { toString(encoding?: string): string };
  brotliDecompressSync(input: Uint8Array): Uint8Array & { toString(encoding?: string): string };
  brotliCompressSync(input: string | Uint8Array): never;
  gzip(input: string | Uint8Array, callback: Callback): void;
  gunzip(input: Uint8Array, callback: Callback): void;
  brotliCompress(input: string | Uint8Array, callback: Callback): void;
  createGzip(): ZlibStream;
  createGunzip(): ZlibStream;
  Unzip: new () => {
    _processChunk(chunk: Uint8Array, flushFlag: number): Uint8Array | Uint8Array[];
  };
  default: {
    gzip: unknown;
    gunzip: unknown;
    deflateSync: unknown;
    inflateSync: unknown;
  };
};

type Callback = (error: Error | null, result: Uint8Array) => void;
type ZlibStream = {
  readable: boolean;
  writable: boolean;
  write(chunk: string | Uint8Array): boolean;
  end(chunk?: string | Uint8Array): unknown;
  on(event: 'data', listener: (chunk: Uint8Array) => void): ZlibStream;
  on(event: 'end' | 'error', listener: (error?: Error) => void): ZlibStream;
  pipe(destination: ZlibStream): ZlibStream;
};

describe('Node Compatibility zlib', () => {
  test('exposes one Buffer-backed gzip and deflate sync contract through the adapter entry point', () => {
    const zlib = loadBuiltin();
    const input = 'node-compatibility compression payload';
    const gzip = zlib.gzipSync(input);
    const deflate = zlib.deflateSync(input);

    expect(gzip).not.toEqual(new TextEncoder().encode(input));
    expect(deflate).not.toEqual(new TextEncoder().encode(input));
    expect(gzip[0]).toBe(31);
    expect(gzip[1]).toBe(139);
    expect(zlib.gunzipSync(gzip).toString()).toBe(input);
    expect(zlib.inflateSync(deflate).toString()).toBe(input);
    expect(zlib.default.gzip).toBe(zlib.gzip);
    expect(zlib.default.gunzip).toBe(zlib.gunzip);
    expect(zlib.default.deflateSync).toBe(zlib.deflateSync);
    expect(zlib.default.inflateSync).toBe(zlib.inflateSync);
  });

  test('round-trips gzip through callback and stream APIs without a data passthrough', async () => {
    const zlib = loadBuiltin();
    const input = 'callback and stream compression payload';
    const compressed = await invoke(zlib.gzip, input);

    expect(compressed.toString()).not.toBe(input);
    expect((await invoke(zlib.gunzip, compressed)).toString()).toBe(input);

    const gzipper = zlib.createGzip();
    const gunzipper = zlib.createGunzip();
    const chunks: Uint8Array[] = [];
    await new Promise<void>((resolve, reject) => {
      gzipper.on('error', reject);
      gunzipper.on('error', reject);
      gunzipper.on('data', (chunk) => chunks.push(chunk));
      gunzipper.on('end', () => resolve());
      gzipper.pipe(gunzipper);
      gzipper.end(input);
    });

    expect(new TextDecoder().decode(concat(chunks))).toBe(input);
    expect(gzipper.writable).toBe(false);
    expect(gunzipper.readable).toBe(false);
  });

  test('exposes Node constructor names with synchronous chunk processing for tar consumers', () => {
    const zlib = loadBuiltin();
    const compressed = zlib.gzipSync('constructor payload');
    const unzip = new zlib.Unzip();
    const output = unzip._processChunk(compressed, 4);
    const bytes = Array.isArray(output) ? concat(output) : output;

    expect(new TextDecoder().decode(bytes)).toBe('constructor payload');
  });

  test('gunzips one member after another and ignores what follows that starts none, as Node does', async () => {
    const zlib = loadBuiltin();
    const first = zlib.gzipSync('first ');
    const second = zlib.gzipSync('second');
    // Old npm tarballs are gzip members padded with zeros to a 10 KiB block.
    const padded = concat([first, second, new Uint8Array(512)]);

    expect(new TextDecoder().decode(zlib.gunzipSync(padded))).toBe('first second');
    const streamed = await new Promise<string>((resolve, reject) => {
      const chunks: Uint8Array[] = [];
      const gunzip = zlib.createGunzip();
      gunzip.on('data', (chunk) => chunks.push(chunk));
      gunzip.on('end', () => resolve(new TextDecoder().decode(concat(chunks))));
      gunzip.on('error', reject);
      for (let offset = 0; offset < padded.byteLength; offset += 7) gunzip.write(padded.subarray(offset, offset + 7));
      gunzip.end();
    });
    expect(streamed).toBe('first second');
    expect(() => zlib.gunzipSync(new Uint8Array(32))).toThrow(expect.objectContaining({ code: 'Z_DATA_ERROR' }));
  });

  test('unzips and gunzips with a callback the same padded members, as npm extracts an old tarball', async () => {
    const zlib = loadBuiltin();
    const padded = concat([zlib.gzipSync('first '), zlib.gzipSync('second'), new Uint8Array(512)]);
    // node-tar extracts through minizlib's Unzip, which tells gzip from zlib by the first bytes.
    const unzipped = await new Promise<string>((resolve, reject) => {
      const chunks: Uint8Array[] = [];
      const unzip = zlib.createUnzip();
      unzip.on('data', (chunk) => chunks.push(chunk));
      unzip.on('end', () => resolve(new TextDecoder().decode(concat(chunks))));
      unzip.on('error', reject);
      for (let offset = 0; offset < padded.byteLength; offset += 1) unzip.write(padded.subarray(offset, offset + 1));
      unzip.end();
    });
    const viaCallback = await new Promise<string>((resolve, reject) =>
      zlib.gunzip(padded, (error, result) => (error ? reject(error) : resolve(new TextDecoder().decode(result))))
    );

    expect(unzipped).toBe('first second');
    expect(viaCallback).toBe('first second');
    expect(new TextDecoder().decode(zlib.unzipSync(zlib.deflateSync('zlib stream')))).toBe('zlib stream');
  });

  test('decodes Brotli while naming unavailable compression instead of passing bytes through', async () => {
    const zlib = loadBuiltin();
    const compressed = Uint8Array.from(atob('CweAWWFybiBQblAgbG9hZGVyAw=='), (byte) => byte.charCodeAt(0));

    expect(zlib.brotliDecompressSync(compressed).toString()).toBe('Yarn PnP loader');
    expect(() => zlib.brotliCompressSync('unsupported')).toThrow(
      expect.objectContaining({ code: 'ERR_UNSUPPORTED_NODE_COMPATIBILITY' })
    );
    await expect(invoke(zlib.brotliCompress, 'unsupported')).rejects.toMatchObject({
      code: 'ERR_UNSUPPORTED_NODE_COMPATIBILITY'
    });
  });

  test('reports unavailable browser stream compression rather than returning the input bytes', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'CompressionStream');
    Object.defineProperty(globalThis, 'CompressionStream', { configurable: true, value: undefined });
    try {
      await expect(invoke(loadBuiltin().gzip, 'unavailable-compression')).rejects.toMatchObject({
        code: 'ERR_UNSUPPORTED_NODE_COMPATIBILITY'
      });
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'CompressionStream', descriptor);
      else Reflect.deleteProperty(globalThis, 'CompressionStream');
    }
  });

  test('emits compressed and decompressed output incrementally, before the stream ends', async () => {
    const zlib = loadBuiltin() as unknown as StreamingZlib;
    const input = noise(256 * 1024);
    for (const [compress, decompress] of [
      [zlib.createGzip, zlib.createGunzip],
      [zlib.createDeflate, zlib.createInflate],
      [zlib.createDeflateRaw, zlib.createInflateRaw],
      [zlib.createGzip, zlib.createUnzip]
    ] as const) {
      const compressor = compress();
      const compressed: Uint8Array[] = [];
      compressor.on('data', (chunk) => compressed.push(chunk));
      for (let offset = 0; offset < input.byteLength; offset += 64 * 1024) {
        compressor.write(input.subarray(offset, offset + 64 * 1024));
      }
      const compressedBeforeEnd = compressed.length;
      await new Promise<void>((resolve) => {
        compressor.on('end', () => resolve());
        compressor.end();
      });
      expect(compressedBeforeEnd).toBeGreaterThan(0);
      expect(compressed.length).toBeGreaterThan(compressedBeforeEnd);

      const decompressor = decompress();
      const restored: Uint8Array[] = [];
      decompressor.on('data', (chunk) => restored.push(chunk));
      const bytes = concat(compressed);
      const half = Math.floor(bytes.byteLength / 2);
      decompressor.write(bytes.subarray(0, half));
      const restoredBeforeEnd = concat(restored).byteLength;
      await new Promise<void>((resolve) => {
        decompressor.on('end', () => resolve());
        decompressor.end(bytes.subarray(half));
      });
      expect(restoredBeforeEnd).toBeGreaterThan(0);
      expect(restoredBeforeEnd).toBeLessThan(input.byteLength);
      expect(concat(restored)).toEqual(input);
    }
  });

  test('flush() emits everything written so far in a form a decompressor can read', async () => {
    const zlib = loadBuiltin() as unknown as StreamingZlib;
    const deflate = zlib.createDeflate({ level: 9 });
    const inflate = zlib.createInflate();
    const compressed: Uint8Array[] = [];
    const restored: Uint8Array[] = [];
    deflate.on('data', (chunk) => compressed.push(chunk));
    inflate.on('data', (chunk) => restored.push(chunk));

    deflate.write('first message');
    expect(concat(compressed).byteLength).toBeLessThan(8);
    await new Promise<void>((resolve) => deflate.flush(resolve));
    inflate.write(concat(compressed));
    expect(new TextDecoder().decode(concat(restored))).toBe('first message');

    const flushedLength = compressed.length;
    deflate.write('second message');
    await new Promise<void>((resolve) => deflate.flush(2, resolve));
    inflate.write(concat(compressed.slice(flushedLength)));
    expect(new TextDecoder().decode(concat(restored))).toBe('first messagesecond message');

    const tailStart = compressed.length;
    await new Promise<void>((resolve) => {
      inflate.on('end', () => resolve());
      deflate.on('end', () => inflate.end(concat(compressed.slice(tailStart))));
      deflate.end();
    });
    expect(new TextDecoder().decode(concat(restored))).toBe('first messagesecond message');
    expect(deflate.bytesWritten).toBe('first messagesecond message'.length);
  });

  test('reports corrupt and truncated input with zlib error codes', async () => {
    const zlib = loadBuiltin() as unknown as StreamingZlib;
    const failure = (stream: StreamingZlibStream, bytes: Uint8Array) =>
      new Promise<Error>((resolve) => {
        stream.on('error', (error) => resolve(error as Error));
        stream.on('data', () => undefined);
        stream.end(bytes);
      });

    await expect(failure(zlib.createGunzip(), new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).resolves.toMatchObject({
      code: 'Z_DATA_ERROR',
      errno: -3
    });
    const compressed = zlib.gzipSync('truncated payload that never reaches its trailer');
    await expect(failure(zlib.createGunzip(), compressed.subarray(0, compressed.byteLength - 12))).resolves.toMatchObject({
      code: 'Z_BUF_ERROR',
      errno: -5
    });
  });

  test('gunzip answers what follows a member as Node does: zeros end it, anything else starts a member', async () => {
    const zlib = loadBuiltin() as unknown as StreamingZlib & Pick<ZlibBuiltin, 'gunzipSync' | 'gunzip'> & {
      unzipSync(input: Uint8Array): Uint8Array;
    };
    const member = zlib.gzipSync('hello');
    const outcome = async (input: Uint8Array) => {
      const describe = (error: unknown, result?: Uint8Array) =>
        error ? `${(error as { code: string }).code} ${(error as Error).message}` : new TextDecoder().decode(result);
      let sync: string;
      try {
        sync = describe(null, zlib.gunzipSync(input));
      } catch (error) {
        sync = describe(error);
      }
      const viaCallback = await new Promise<string>((resolve) =>
        zlib.gunzip(input, (error, result) => resolve(describe(error, result)))
      );
      const streamed = await new Promise<string>((resolve) => {
        const chunks: Uint8Array[] = [];
        const gunzip = zlib.createGunzip();
        gunzip.on('data', (chunk) => chunks.push(chunk));
        gunzip.on('error', (error) => resolve(describe(error)));
        gunzip.on('end', () => resolve(describe(null, concat(chunks))));
        for (let offset = 0; offset < input.byteLength; offset += 3) gunzip.write(input.subarray(offset, offset + 3));
        gunzip.end();
      });
      return [sync, viaCallback, streamed];
    };
    const unexpectedEnd = 'Z_BUF_ERROR unexpected end of file';

    await expect(outcome(new Uint8Array())).resolves.toEqual([unexpectedEnd, unexpectedEnd, unexpectedEnd]);
    await expect(outcome(member.subarray(0, 5))).resolves.toEqual([unexpectedEnd, unexpectedEnd, unexpectedEnd]);
    for (const trailing of [[0x1f], [0x1f, 0x8b, 0x08], [0x41]]) {
      await expect(outcome(concat([member, Uint8Array.from(trailing)]))).resolves.toEqual([
        unexpectedEnd,
        unexpectedEnd,
        unexpectedEnd
      ]);
    }
    const headerCheck = 'Z_DATA_ERROR incorrect header check';
    await expect(outcome(concat([member, new TextEncoder().encode('garbage!')]))).resolves.toEqual([
      headerCheck,
      headerCheck,
      headerCheck
    ]);
    // A zero after a member ends the stream, whatever follows it.
    await expect(outcome(concat([member, Uint8Array.from([0]), new TextEncoder().encode('garbage!')]))).resolves.toEqual([
      'hello',
      'hello',
      'hello'
    ]);
    await expect(outcome(concat([member, zlib.gzipSync(' world'), new Uint8Array(10)]))).resolves.toEqual([
      'hello world',
      'hello world',
      'hello world'
    ]);
    expect(() => zlib.unzipSync(new Uint8Array())).toThrow(expect.objectContaining({ code: 'Z_BUF_ERROR', errno: -5 }));
  });
});

type StreamingZlibStream = {
  bytesWritten: number;
  write(chunk: string | Uint8Array): boolean;
  end(chunk?: string | Uint8Array): unknown;
  flush(callback: () => void): void;
  flush(kind: number, callback: () => void): void;
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
  on(event: 'end' | 'error', listener: (error?: Error) => void): unknown;
};
type StreamingZlib = Pick<ZlibBuiltin, 'gzipSync'> & Record<
  'createGzip' | 'createGunzip' | 'createDeflate' | 'createInflate' | 'createDeflateRaw' | 'createInflateRaw' | 'createUnzip',
  (options?: { level?: number }) => StreamingZlibStream
>;

// Deterministic incompressible bytes, so compressed output crosses fflate's block size.
function noise(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let seed = 0x2545f491;
  for (let index = 0; index < length; index += 1) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    bytes[index] = seed & 0xff;
  }
  return bytes;
}

function loadBuiltin(): ZlibBuiltin {
  return createZlibBuiltin() as ZlibBuiltin;
}

function invoke(callbackApi: (input: string | Uint8Array, callback: Callback) => void, input: string | Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    callbackApi(input, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
