import {
  Decompress as FflateDecompress,
  Deflate as FflateDeflate,
  Gunzip as FflateGunzip,
  Gzip as FflateGzip,
  Inflate as FflateInflate,
  Unzlib as FflateUnzlib,
  Zlib as FflateZlib,
  deflateSync as deflateRawSyncBytes,
  gzipSync as gzipSyncBytes,
  inflateSync as inflateRawSyncBytes,
  unzlibSync as inflateSyncBytes,
  zlibSync as deflateSyncBytes
} from 'fflate';

import brotliDecompressSyncBytes from 'brotli/decompress.js';

import { BrowserBuffer } from './buffer';
import { nodeStream as stream } from './streams';

type ZlibCallback = (error: Error | null, result: BrowserBuffer) => void;
type ZlibFormat = 'gzip' | 'deflate' | 'deflate-raw';
type ZlibTransform = (input: unknown) => Promise<BrowserBuffer>;
type RuntimeCapabilityError = Error & { code: 'ERR_UNSUPPORTED_NODE_COMPATIBILITY' };

/** Creates the context-local Node-shaped compression builtin. */
export function createZlibBuiltin(): unknown {
  const syncApi = (transform: (input: Uint8Array) => Uint8Array) => (input: unknown, _options?: unknown) =>
    BrowserBuffer.from(transform(toBuffer(input)));
  const callbackApi =
    (transform: ZlibTransform) =>
    (input: unknown, options?: unknown, callback?: ZlibCallback): undefined => {
      const resolvedCallback = typeof options === 'function' ? (options as ZlibCallback) : callback;
      if (!resolvedCallback) throw new TypeError('The "callback" argument must be of type function');
      transform(input).then(
        (result) => resolvedCallback(null, result),
        (error) => resolvedCallback(asError(error), BrowserBuffer.alloc(0))
      );
      return undefined;
    };
  const unsupportedCallback = callbackApi(async () => {
    throw unsupported('Brotli compression is not supported in this browser runtime');
  });
  const gzipTransform = createBrowserTransform('compress', 'gzip');
  const deflateTransform = createBrowserTransform('compress', 'deflate');
  const inflateTransform = createBrowserTransform('decompress', 'deflate');
  const deflateRawTransform = createBrowserTransform('compress', 'deflate-raw');
  const inflateRawTransform = createBrowserTransform('decompress', 'deflate-raw');
  const gzip = callbackApi(gzipTransform);
  // Node's gunzip ignores what follows the last member; the browser's decoder rejects it.
  const gunzip = callbackApi(async (input) => BrowserBuffer.from(gunzipBytes(toBuffer(input))));
  const unzip = callbackApi(async (input) => BrowserBuffer.from(unzipBytes(toBuffer(input))));
  const deflate = callbackApi(deflateTransform);
  const inflate = callbackApi(inflateTransform);
  const deflateRaw = callbackApi(deflateRawTransform);
  const inflateRaw = callbackApi(inflateRawTransform);
  const brotliDecompress = callbackApi(async (input) =>
    BrowserBuffer.from(Uint8Array.from(brotliDecompressSyncBytes(toBuffer(input))))
  );
  // Brotli has no incremental decoder here, so its streams buffer until end.
  class BufferedZlibStream extends stream.Transform {
    private readonly inputChunks: BrowserBuffer[] = [];

    constructor(private readonly operation: ZlibTransform) {
      super({
        transform(chunk, _encoding, callback) {
          const target = this as BufferedZlibStream;
          target.inputChunks.push(toBuffer(chunk));
          callback();
        },
        flush(callback) {
          const target = this as BufferedZlibStream;
          target.operation(BrowserBuffer.concat(target.inputChunks)).then(
            (result) => callback(null, BrowserBuffer.from(result)),
            (error) => callback(asError(error))
          );
        }
      });
    }

    flush(kind?: unknown, callback?: () => void): void {
      (typeof kind === 'function' ? kind : callback)?.();
    }

    close(callback?: () => void): void {
      callback?.();
      this.destroy();
    }

    reset(): void {
      this.inputChunks.length = 0;
    }
  }
  // Written through the stream so a flush keeps its place among pending writes.
  const flushRequest = BrowserBuffer.alloc(0);
  class NodeZlibHandle extends stream.Transform {
    readonly _handle = { close: () => this.close() };
    bytesWritten = 0;
    private streamHandle: FflateStream;
    private closed = false;

    constructor(private readonly createStreamHandle: () => FflateStream) {
      super({
        transform(chunk, _encoding, callback) {
          const target = this as NodeZlibHandle;
          let output: BrowserBuffer[];
          try {
            output = chunk === flushRequest ? target.flushHandle() : target.processChunk(chunk, false);
          } catch (error) {
            callback(asError(error));
            return;
          }
          callback(null, output.length === 0 ? undefined : BrowserBuffer.concat(output));
        },
        flush(callback) {
          let output: BrowserBuffer[];
          try {
            output = (this as NodeZlibHandle).processChunk(new Uint8Array(), true);
          } catch (error) {
            callback(asError(error));
            return;
          }
          callback(null, output.length === 0 ? undefined : BrowserBuffer.concat(output));
        }
      });
      this.streamHandle = createStreamHandle();
    }

    _processChunk(chunk: unknown, flushFlag: number): BrowserBuffer | BrowserBuffer[] {
      const output = this.processChunk(chunk, flushFlag === 4);
      return output.length === 1 ? output[0]! : output;
    }

    flush(kind?: unknown, callback?: () => void): void {
      const done = typeof kind === 'function' ? kind as () => void : callback;
      if (this.writableEnded || this.destroyed) done?.();
      else this.write(flushRequest, undefined, () => done?.());
    }

    reset(): void {
      this.streamHandle = this.createStreamHandle();
    }

    close(callback?: () => void): void {
      this.closed = true;
      callback?.();
      this.destroy();
    }

    private flushHandle(): BrowserBuffer[] {
      return this.collect((handle) => handle.flush?.());
    }

    private processChunk(chunk: unknown, final: boolean): BrowserBuffer[] {
      if (this.closed) throw new Error('zlib binding closed');
      const bytes = toBuffer(chunk);
      this.bytesWritten += bytes.byteLength;
      return this.collect((handle) => handle.push(bytes, final));
    }

    private collect(run: (handle: FflateStream) => void): BrowserBuffer[] {
      const output: BrowserBuffer[] = [];
      this.streamHandle.ondata = (data) => {
        if (data.byteLength > 0) output.push(BrowserBuffer.from(data));
      };
      try {
        run(this.streamHandle);
      } catch (error) {
        throw zlibError(error);
      }
      return output;
    }
  }
  const nodeZlibConstructor = (createStreamHandle: (options: FflateOptions) => FflateStream) =>
    class extends NodeZlibHandle {
      constructor(options?: unknown) {
        const settings = fflateOptions(options);
        super(() => createStreamHandle(settings));
      }
    };
  const Deflate = nodeZlibConstructor((options) => new FflateZlib(options));
  const Inflate = nodeZlibConstructor((options) => new FflateUnzlib(options));
  const Gzip = nodeZlibConstructor((options) => new FflateGzip(options));
  const Gunzip = nodeZlibConstructor((options) => new NodeGunzipStream(options));
  const DeflateRaw = nodeZlibConstructor((options) => new FflateDeflate(options));
  const InflateRaw = nodeZlibConstructor((options) => new FflateInflate(options));
  const Unzip = nodeZlibConstructor((options) => new NodeUnzipStream(options));
  const zlib = {
    Z_NO_FLUSH: 0,
    Z_PARTIAL_FLUSH: 1,
    Z_SYNC_FLUSH: 2,
    Z_FULL_FLUSH: 3,
    Z_FINISH: 4,
    Z_OK: 0,
    Z_STREAM_END: 1,
    Z_DEFAULT_COMPRESSION: -1,
    constants: {
      Z_NO_FLUSH: 0,
      Z_PARTIAL_FLUSH: 1,
      Z_SYNC_FLUSH: 2,
      Z_FULL_FLUSH: 3,
      Z_FINISH: 4,
      Z_OK: 0,
      Z_STREAM_END: 1,
      Z_DEFAULT_COMPRESSION: -1
    },
    gzip,
    gzipSync: syncApi(gzipSyncBytes),
    gunzip,
    gunzipSync: syncApi(gunzipBytes),
    unzip,
    unzipSync: syncApi(unzipBytes),
    deflate,
    deflateSync: syncApi(deflateSyncBytes),
    deflateRaw,
    deflateRawSync: syncApi(deflateRawSyncBytes),
    inflate,
    inflateSync: syncApi(inflateSyncBytes),
    inflateRaw,
    inflateRawSync: syncApi(inflateRawSyncBytes),
    brotliCompress: unsupportedCallback,
    brotliCompressSync: () => {
      throw unsupported('Brotli compression is not supported in this browser runtime');
    },
    brotliDecompress,
    brotliDecompressSync: syncApi((input) => Uint8Array.from(brotliDecompressSyncBytes(input))),
    createGzip: (options?: unknown) => new Gzip(options),
    createGunzip: (options?: unknown) => new Gunzip(options),
    createDeflate: (options?: unknown) => new Deflate(options),
    createDeflateRaw: (options?: unknown) => new DeflateRaw(options),
    createInflate: (options?: unknown) => new Inflate(options),
    createInflateRaw: (options?: unknown) => new InflateRaw(options),
    createUnzip: (options?: unknown) => new Unzip(options),
    createBrotliCompress: () => new BufferedZlibStream(async () => {
      throw unsupported('Brotli compression is not supported in this browser runtime');
    }),
    createBrotliDecompress: () =>
      new BufferedZlibStream(async (input) => BrowserBuffer.from(Uint8Array.from(brotliDecompressSyncBytes(toBuffer(input))))),
    Deflate,
    Inflate,
    Gzip,
    Gunzip,
    DeflateRaw,
    InflateRaw,
    Unzip
  };
  return { ...zlib, default: zlib };
}

type FflateStream = {
  ondata?: (data: Uint8Array, final: boolean) => void;
  push(chunk: Uint8Array, final?: boolean): void;
  flush?(): void;
};
type FflateOptions = { level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9; dictionary?: Uint8Array };

/**
 * Gunzip as Node does it: one member after another. After a member, a zero
 * byte ends the stream and what follows it is ignored (old npm tarballs are
 * padded with zeros); any other byte starts the next member, so what is not
 * a gzip header is an error. Input that ends before a member does, its
 * header included, is an unexpected end of file. fflate reads multiple
 * members, but takes the padding for a broken header and accepts an input
 * that ends between or before members.
 */
class NodeGunzipStream implements FflateStream {
  ondata?: (data: Uint8Array, final: boolean) => void;
  readonly #inner: FflateGunzip;
  #ended = false;

  constructor(options: FflateOptions = {}) {
    this.#inner = new FflateGunzip(options);
    this.#inner.ondata = (data, final) => this.ondata?.(data, final);
  }

  push(chunk: Uint8Array, final = false): void {
    if (!this.#ended) {
      try {
        this.#inner.push(chunk, false);
      } catch (error) {
        // fflate rejected what follows a member as the next member's header.
        const following = this.#following();
        if (following === undefined || following[0] !== 0) throw headerError(following) ?? error;
        this.#ended = true;
      }
      const following = this.#following();
      if (!this.#ended && following !== undefined && following.byteLength > 0) {
        if (following[0] === 0) this.#ended = true;
        else {
          const error = headerError(following);
          if (error) throw error;
        }
      }
    }
    if (!final) return;
    if (this.#ended || this.#following()?.byteLength === 0) {
      this.ondata?.(new Uint8Array(), true);
      return;
    }
    // Input ends within a header, the first one or a following member's.
    if (this.#following() !== undefined || this.#awaitingFirstHeader()) throw unexpectedEndOfFile();
    this.#inner.push(new Uint8Array(), true);
  }

  /**
   * What followed the last complete member, when one ended and fflate waits
   * for the next one's header: fflate 0.8 then keeps that header's offset,
   * plus one, in `v`, which is 1 before the first header and 0 within a member.
   */
  #following(): Uint8Array | undefined {
    const { v: nextHeader, p: pending } = this.#inner as unknown as { readonly v?: unknown; readonly p?: Uint8Array };
    if (typeof nextHeader !== 'number' || nextHeader <= 1 || !(pending instanceof Uint8Array)) return undefined;
    return pending.subarray(nextHeader - 1);
  }

  #awaitingFirstHeader(): boolean {
    return (this.#inner as unknown as { readonly v?: unknown }).v === 1;
  }
}

/** Why `bytes` cannot start a gzip member, as zlib tells it once it has read enough of them. */
function headerError(bytes: Uint8Array | undefined): Error | undefined {
  if (!bytes || bytes.byteLength < 2) return undefined;
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return zlibFailure('Z_DATA_ERROR', 'incorrect header check');
  if (bytes.byteLength >= 3 && bytes[2] !== 8) return zlibFailure('Z_DATA_ERROR', 'unknown compression method');
  return undefined;
}

function unexpectedEndOfFile(): Error {
  return zlibFailure('Z_BUF_ERROR', 'unexpected end of file');
}

function zlibFailure(code: 'Z_BUF_ERROR' | 'Z_DATA_ERROR', message: string): Error {
  return Object.assign(new Error(message), { code, errno: code === 'Z_BUF_ERROR' ? -5 : -3 });
}

/**
 * Unzip as Node does it: a gzip stream, read as Gunzip reads it, or a zlib one,
 * told apart by the first two bytes.
 */
class NodeUnzipStream implements FflateStream {
  ondata?: (data: Uint8Array, final: boolean) => void;
  readonly #options: FflateOptions;
  #inner: FflateStream | undefined;
  #pending: Uint8Array = new Uint8Array();

  constructor(options: FflateOptions = {}) {
    this.#options = options;
  }

  push(chunk: Uint8Array, final = false): void {
    if (!this.#inner) {
      const head = new Uint8Array(this.#pending.byteLength + chunk.byteLength);
      head.set(this.#pending);
      head.set(chunk, this.#pending.byteLength);
      if (head.byteLength < 2) {
        if (final) throw unexpectedEndOfFile();
        this.#pending = head;
        return;
      }
      this.#pending = new Uint8Array();
      this.#inner = isGzip(head) ? new NodeGunzipStream(this.#options) : new FflateDecompress(this.#options);
      this.#inner.ondata = (data, last) => this.ondata?.(data, last);
      chunk = head;
    }
    this.#inner.push(chunk, final);
  }
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function unzipBytes(input: Uint8Array): Uint8Array {
  if (input.byteLength < 2) throw unexpectedEndOfFile();
  return isGzip(input) ? gunzipBytes(input) : inflateSyncBytes(input);
}

function gunzipBytes(input: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  const stream = new NodeGunzipStream();
  stream.ondata = (data) => {
    if (data.byteLength > 0) chunks.push(data);
  };
  try {
    // fflate moves on to a following member only within a push that is not the last.
    stream.push(input, false);
    stream.push(new Uint8Array(), true);
  } catch (error) {
    throw zlibError(error);
  }
  const output = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function fflateOptions(options: unknown): FflateOptions {
  const { level, dictionary } = (options && typeof options === 'object' ? options : {}) as { level?: unknown; dictionary?: unknown };
  return {
    ...(typeof level === 'number' && Number.isInteger(level) && level >= 0 && level <= 9 ? { level: level as FflateOptions['level'] } : {}),
    ...(dictionary instanceof Uint8Array ? { dictionary } : {})
  };
}

// fflate reports a truncated stream as code 0; everything else is corrupt input.
function zlibError(error: unknown): Error {
  const failure = asError(error);
  const { code } = failure as { code?: unknown };
  if (code === 'Z_BUF_ERROR' || code === 'Z_DATA_ERROR') return failure;
  if (code === 0) return Object.assign(failure, { message: 'unexpected end of file', code: 'Z_BUF_ERROR', errno: -5 });
  return Object.assign(failure, { code: 'Z_DATA_ERROR', errno: -3 });
}

function toBuffer(input: unknown): BrowserBuffer {
  if (BrowserBuffer.isBuffer(input)) return input as BrowserBuffer;
  if (input instanceof Uint8Array || input instanceof ArrayBuffer || typeof input === 'string') return BrowserBuffer.from(input);
  return BrowserBuffer.from(String(input ?? ''));
}

async function transformWithBrowserStream(
  input: unknown,
  mode: 'compress' | 'decompress',
  format: ZlibFormat
): Promise<BrowserBuffer> {
  const ctorName = mode === 'compress' ? 'CompressionStream' : 'DecompressionStream';
  const StreamCtor = mode === 'compress' ? globalThis.CompressionStream : globalThis.DecompressionStream;
  if (typeof StreamCtor !== 'function') {
    throw unsupported(`${ctorName} is unavailable for ${format} ${mode === 'compress' ? 'compression' : 'decompression'}`);
  }
  try {
    const bytes = toBuffer(input);
    const ownedBytes = new Uint8Array(bytes);
    const transformed = new Blob([ownedBytes]).stream().pipeThrough(new StreamCtor(format));
    return BrowserBuffer.from(await new Response(transformed).arrayBuffer());
  } catch (error) {
    if (isUnsupported(error)) throw error;
    throw unsupported(`${ctorName} does not support ${format}`);
  }
}

function createBrowserTransform(
  mode: 'compress' | 'decompress',
  format: ZlibFormat
): ZlibTransform {
  return (input) => transformWithBrowserStream(input, mode, format);
}

function unsupported(message: string): RuntimeCapabilityError {
  return Object.assign(new Error(message), { code: 'ERR_UNSUPPORTED_NODE_COMPATIBILITY' as const });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isUnsupported(error: unknown): error is RuntimeCapabilityError {
  return error instanceof Error && (error as Partial<RuntimeCapabilityError>).code === 'ERR_UNSUPPORTED_NODE_COMPATIBILITY';
}
