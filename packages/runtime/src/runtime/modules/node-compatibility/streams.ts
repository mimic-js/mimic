import './port-dependencies/provide';
import streamPort from 'readable-stream/lib/stream.js';
import type { EventEmitter } from './events';

type Callback = (error?: Error | null) => void;
type DestroyHandler = (this: unknown, error: Error | null, callback: Callback) => void;

export type ReadableOptions = {
  objectMode?: boolean;
  highWaterMark?: number;
  encoding?: string;
  autoDestroy?: boolean;
  emitClose?: boolean;
  signal?: AbortSignal;
  read?: (this: unknown, size: number) => void;
  destroy?: DestroyHandler;
  construct?: (this: unknown, callback: Callback) => void;
};

export type WritableOptions = {
  objectMode?: boolean;
  highWaterMark?: number;
  decodeStrings?: boolean;
  defaultEncoding?: string;
  autoDestroy?: boolean;
  emitClose?: boolean;
  signal?: AbortSignal;
  write?: (this: unknown, chunk: unknown, encoding: string, callback: Callback) => void;
  writev?: (this: unknown, chunks: Array<{ chunk: unknown; encoding: string }>, callback: Callback) => void;
  final?: (this: unknown, callback: Callback) => void;
  destroy?: DestroyHandler;
  construct?: (this: unknown, callback: Callback) => void;
};

export type DuplexOptions = ReadableOptions & WritableOptions & {
  allowHalfOpen?: boolean;
  readableObjectMode?: boolean;
  writableObjectMode?: boolean;
  readableHighWaterMark?: number;
  writableHighWaterMark?: number;
};

export type TransformOptions = DuplexOptions & {
  transform?: (this: unknown, chunk: unknown, encoding: string, callback: (error?: Error | null, data?: unknown) => void) => void;
  flush?: (this: unknown, callback: (error?: Error | null, data?: unknown) => void) => void;
};

export interface NodeReadableStream extends EventEmitter {
  readable: boolean;
  readonly readableEnded: boolean;
  readonly readableObjectMode: boolean;
  readonly readableFlowing: boolean | null;
  destroyed: boolean;
  readonly readableLength: number;
  readonly readableHighWaterMark: number;
  readonly _readableState: { length: number; ended: boolean; endEmitted: boolean; highWaterMark: number };
  push(chunk: unknown, encoding?: string): boolean;
  read(size?: number): unknown;
  unshift(chunk: unknown): void;
  pause(): this;
  resume(): this;
  isPaused(): boolean;
  setEncoding(encoding?: string): this;
  pipe<Destination>(destination: Destination, options?: { end?: boolean }): Destination;
  unpipe(destination?: unknown): this;
  [Symbol.asyncIterator](): AsyncIterableIterator<unknown>;
  destroy(error?: Error): this;
}

export interface NodeWritableStream extends EventEmitter {
  writable: boolean;
  destroyed: boolean;
  readonly writableLength: number;
  readonly writableHighWaterMark: number;
  readonly writableNeedDrain: boolean;
  readonly writableEnded: boolean;
  readonly writableFinished: boolean;
  readonly writableObjectMode: boolean;
  readonly _writableState: { length: number; needDrain: boolean; finished: boolean };
  write(chunk?: unknown, encoding?: unknown, callback?: (error?: Error) => void): boolean;
  end(chunk?: unknown, encoding?: unknown, callback?: () => void): this;
  cork(): void;
  uncork(): void;
  destroy(error?: Error): this;
}

export type NodeTransformStream = NodeReadableStream & NodeWritableStream;

type FinishedOptions = { readable?: boolean; writable?: boolean; error?: boolean; signal?: AbortSignal; cleanup?: boolean };

/** The members of `node:stream` the runtime uses; the port ships no types. */
export type NodeStreamBuiltin = {
  readonly Readable: (new (options?: ReadableOptions) => NodeReadableStream) & {
    from(iterable: unknown, options?: ReadableOptions): NodeReadableStream;
    fromWeb(web: ReadableStream<unknown>, options?: ReadableOptions): NodeReadableStream;
    toWeb(readable: NodeReadableStream): ReadableStream<unknown>;
  };
  readonly Writable: (new (options?: WritableOptions) => NodeWritableStream) & {
    fromWeb(web: WritableStream<unknown>, options?: WritableOptions): NodeWritableStream;
    toWeb(writable: NodeWritableStream): WritableStream<unknown>;
  };
  readonly Duplex: (new (options?: DuplexOptions) => NodeTransformStream) & {
    from(source: unknown): NodeTransformStream;
    fromWeb(pair: { readable: ReadableStream<unknown>; writable: WritableStream<unknown> }, options?: DuplexOptions): NodeTransformStream;
    toWeb(duplex: NodeTransformStream): { readable: ReadableStream<unknown>; writable: WritableStream<unknown> };
  };
  readonly Transform: new (options?: TransformOptions) => NodeTransformStream;
  readonly PassThrough: new (options?: TransformOptions) => NodeTransformStream;
  readonly Stream: new () => EventEmitter;
  finished(target: unknown, optionsOrCallback: FinishedOptions | Callback, callback?: Callback): () => void;
  pipeline(...args: unknown[]): unknown;
  compose(...stages: unknown[]): NodeTransformStream;
  addAbortSignal<Target>(signal: AbortSignal, stream: Target): Target;
  readonly promises: {
    finished(target: unknown, options?: FinishedOptions): Promise<void>;
    pipeline(...stages: unknown[]): Promise<unknown>;
  };
};

/**
 * `node:stream` is the `readable-stream` port, the userland copy of Node's own
 * streams (ADR-0026). Its classes are this realm's: process stdio, sockets,
 * HTTP messages, file and compression streams all extend them. The port
 * predates Node's WHATWG stream adapters, which this module adds.
 */
export const nodeStream = streamPort as unknown as NodeStreamBuiltin;

// Node 22 raised the default byte high-water mark from Node 18's 16 KiB to 64 KiB.
(streamPort as { setDefaultHighWaterMark(objectMode: boolean, value: number): void }).setDefaultHighWaterMark(false, 64 * 1024);

// Every builtin of this runtime carries itself as `default`.
Object.assign(nodeStream, { default: nodeStream });
Object.assign(nodeStream.promises, { default: nodeStream.promises });

const { Duplex, Readable, Writable } = nodeStream;

/**
 * Node's `finished()` and `pipeline()` observe a WHATWG stream through the
 * closed promise Node's own web streams carry under this registry symbol.
 * The platform's streams carry none, so one is attached when such a stream
 * is first observed, settled as the stream is consumed: through the reader
 * or writer it hands out, a pipe, its async iterator, or its own `cancel`,
 * `close` or `abort`.
 */
const kIsClosedPromise = Symbol.for('nodejs.webstream.isClosedPromise');

type ClosedPromise = { readonly promise: Promise<void> };

function observeWebStream(stream: unknown): void {
  if (typeof stream !== 'object' || stream === null || kIsClosedPromise in stream) return;
  const target = stream as Record<PropertyKey, unknown>;
  const readable = typeof target.getReader === 'function' && typeof target.pipeThrough === 'function';
  const writable = typeof target.getWriter === 'function' && typeof target.abort === 'function';
  if (!readable && !writable) return;
  let settle!: (error?: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    settle = (error) => (error === undefined ? resolve() : reject(error));
  });
  promise.catch(() => undefined);
  const closed: ClosedPromise = { promise };
  Object.defineProperty(target, kIsClosedPromise, { value: closed, configurable: true });
  const follow = <Value>(value: Promise<Value>): Promise<Value> => {
    value.then(() => settle(), (error: unknown) => settle(error ?? new Error('The stream errored.')));
    return value;
  };
  type Method = (...args: unknown[]) => unknown;
  const own = (name: string | symbol, method: (this: unknown, original: Method, ...args: unknown[]) => unknown): void => {
    const original = target[name];
    if (typeof original !== 'function') return;
    Object.defineProperty(target, name, {
      value: function (this: unknown, ...args: unknown[]) {
        return method.call(this, original as Method, ...args);
      },
      configurable: true,
      writable: true
    });
  };
  if (readable) {
    own('getReader', function (this: unknown, original, ...args) {
      const reader = original.apply(this, args) as { closed: Promise<void> };
      follow(reader.closed);
      return reader;
    });
    own('pipeTo', function (this: unknown, original, ...args) {
      return follow(original.apply(this, args) as Promise<void>);
    });
    own('pipeThrough', function (this: unknown, _original, transform, options) {
      const pair = transform as { readonly readable: ReadableStream; readonly writable: WritableStream };
      // Through this stream's own `pipeTo`, so the pipe is observed.
      const piped = (this as ReadableStream).pipeTo(pair.writable, options as StreamPipeOptions);
      piped.catch(() => undefined);
      return pair.readable;
    });
    own('cancel', function (this: unknown, original, ...args) {
      return follow(original.apply(this, args) as Promise<void>);
    });
    own('tee', function (this: unknown, original, ...args) {
      const branches = original.apply(this, args) as [ReadableStream, ReadableStream];
      let remaining = branches.length;
      for (const branch of branches) {
        observeWebStream(branch);
        (branch as unknown as Record<symbol, ClosedPromise>)[kIsClosedPromise].promise.then(
          () => { if ((remaining -= 1) === 0) settle(); },
          (error: unknown) => settle(error)
        );
      }
      return branches;
    });
    const iterate = function (this: unknown, original: Method, ...args: unknown[]) {
      const iterator = original.apply(this, args) as AsyncIterator<unknown>;
      const observed: AsyncIterableIterator<unknown> = {
        next: (...nextArgs) =>
          iterator.next(...nextArgs).then(
            (result) => {
              if (result.done) settle();
              return result;
            },
            (error: unknown) => {
              settle(error);
              throw error;
            }
          ),
        return: (value) =>
          (iterator.return?.(value) ?? Promise.resolve({ done: true, value })).then((result) => {
            settle();
            return result;
          }),
        [Symbol.asyncIterator]: () => observed
      };
      return observed;
    };
    own('values', iterate);
    own(Symbol.asyncIterator, iterate);
  }
  if (writable) {
    own('getWriter', function (this: unknown, original, ...args) {
      const writer = original.apply(this, args) as { closed: Promise<void> };
      follow(writer.closed);
      return writer;
    });
    own('close', function (this: unknown, original, ...args) {
      return follow(original.apply(this, args) as Promise<void>);
    });
    own('abort', function (this: unknown, original, ...args) {
      return follow(original.apply(this, args) as Promise<void>);
    });
  }
}

{
  const observing = <Args extends unknown[], Result>(call: (...args: Args) => Result) =>
    (...args: Args): Result => {
      for (const argument of args) {
        if (Array.isArray(argument)) argument.forEach(observeWebStream);
        else observeWebStream(argument);
      }
      return call(...args);
    };
  Object.assign(nodeStream, {
    finished: observing(nodeStream.finished),
    pipeline: observing(nodeStream.pipeline)
  });
  Object.assign(nodeStream.promises, {
    finished: observing(nodeStream.promises.finished),
    pipeline: observing(nodeStream.promises.pipeline)
  });
}

Object.assign(Readable, {
  fromWeb(web: ReadableStream<unknown>, options: ReadableOptions = {}): NodeReadableStream {
    const reader = web.getReader();
    let closed = false;
    const readable: NodeReadableStream = new Readable({
      ...options,
      read() {
        reader.read().then(
          ({ done, value }) => {
            if (done) closed = true;
            readable.push(done ? null : value);
          },
          (error: unknown) => {
            closed = true;
            readable.destroy(asError(error));
          }
        );
      },
      destroy(error, callback) {
        if (!closed) void reader.cancel(error ?? undefined).catch(() => undefined);
        callback(error);
      }
    });
    return readable;
  },
  toWeb(readable: NodeReadableStream): ReadableStream<unknown> {
    const objectMode = readable.readableObjectMode;
    return new ReadableStream<unknown>({
      start(controller) {
        readable.pause();
        readable.on('data', (chunk) => {
          controller.enqueue(!objectMode && chunk instanceof Uint8Array ? new Uint8Array(chunk) : chunk);
          if ((controller.desiredSize ?? 0) <= 0) readable.pause();
        });
        nodeStream.finished(readable, (error) => {
          if (error) controller.error(error);
          else controller.close();
        });
      },
      pull() {
        readable.resume();
      },
      cancel(reason) {
        readable.destroy(reason instanceof Error ? reason : undefined);
      }
    });
  }
});

Object.assign(Writable, {
  fromWeb(web: WritableStream<unknown>, options: WritableOptions = {}): NodeWritableStream {
    const writer = web.getWriter();
    let closed = false;
    return new Writable({
      ...options,
      write(chunk, _encoding, callback) {
        writer.ready.then(() => writer.write(chunk)).then(() => callback(), (error: unknown) => callback(asError(error)));
      },
      final(callback) {
        closed = true;
        writer.close().then(() => callback(), (error: unknown) => callback(asError(error)));
      },
      destroy(error, callback) {
        if (!closed) void writer.abort(error ?? undefined).catch(() => undefined);
        callback(error);
      }
    });
  },
  toWeb(writable: NodeWritableStream): WritableStream<unknown> {
    return new WritableStream<unknown>({
      start(controller) {
        writable.on('error', (error) => controller.error(error));
      },
      write(chunk) {
        return new Promise<void>((resolve, reject) => {
          writable.write(chunk, undefined, (error) => (error ? reject(error) : resolve()));
        });
      },
      close() {
        return new Promise<void>((resolve, reject) => {
          writable.end(() => resolve());
          writable.once('error', reject);
        });
      },
      abort(reason) {
        writable.destroy(asError(reason));
      }
    });
  }
});

Object.assign(Duplex, {
  fromWeb(pair: { readable: ReadableStream<unknown>; writable: WritableStream<unknown> }, options: DuplexOptions = {}) {
    return Duplex.from({
      readable: Readable.fromWeb(pair.readable, options),
      writable: Writable.fromWeb(pair.writable, options)
    });
  },
  toWeb(duplex: NodeTransformStream) {
    return { readable: Readable.toWeb(duplex), writable: Writable.toWeb(duplex) };
  }
});

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
