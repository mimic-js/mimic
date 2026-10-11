import { describe, expect, test } from 'vitest';

import { nodeStream } from '../streams';

describe('Node Compatibility streams', () => {
  test('settles finished() for the platform\'s own web streams as they are consumed', async () => {
    const chunks = (...values: string[]) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const value of values) controller.enqueue(new TextEncoder().encode(value));
          controller.close();
        }
      });
    const finished = (stream: unknown) =>
      new Promise<string>((resolve) => {
        nodeStream.finished(stream, (error?: Error | null) => resolve(error ? `error:${error.message}` : 'finished'));
      });

    const read = chunks('a', 'b');
    const readDone = finished(read);
    const reader = read.getReader();
    while (!(await reader.read()).done) continue;
    await expect(readDone).resolves.toBe('finished');

    const piped = chunks('c').pipeThrough(new TransformStream<Uint8Array, Uint8Array>());
    const pipedDone = finished(piped);
    await new Response(piped).text();
    await expect(pipedDone).resolves.toBe('finished');

    const iterated = chunks('d');
    const iteratedDone = finished(iterated);
    for await (const _chunk of iterated as AsyncIterable<Uint8Array>) continue;
    await expect(iteratedDone).resolves.toBe('finished');

    const failing = new ReadableStream({ start(controller) { controller.error(new Error('broken')); } });
    const failingDone = finished(failing);
    await failing.getReader().closed.catch(() => undefined);
    await expect(failingDone).resolves.toBe('error:broken');

    const sink = new WritableStream();
    const sinkDone = nodeStream.promises.finished(sink);
    const writer = sink.getWriter();
    await writer.write(new Uint8Array([1]));
    await writer.close();
    await expect(sinkDone).resolves.toBeUndefined();
  });

  test('accounts for readable byte and object high-water marks', () => {
    const stream = nodeStream as {
      Readable: new (options: { highWaterMark: number; objectMode?: boolean; read(): void }) => {
        push(chunk: unknown): boolean;
        read(size?: number): unknown;
        readableLength: number;
      };
    };
    const bytes = new stream.Readable({ highWaterMark: 2, read() {} });
    const objects = new stream.Readable({ highWaterMark: 1, objectMode: true, read() {} });

    expect(bytes.push('a')).toBe(true);
    expect(bytes.push('bc')).toBe(false);
    expect(bytes.readableLength).toBe(3);
    expect(String(bytes.read(1))).toBe('a');
    expect(bytes.readableLength).toBe(2);
    expect(objects.push({ id: 1 })).toBe(false);
    expect(objects.readableLength).toBe(1);
  });

  test('constructs Readable and Writable through legacy Base.call(this) inheritance', async () => {
    type LegacyBase = { call(receiver: unknown): void; prototype: object };
    const stream = nodeStream as unknown as { Readable: LegacyBase; Writable: LegacyBase };
    function LegacyReadable(this: { remaining: number }) {
      stream.Readable.call(this);
      this.remaining = 2;
    }
    Object.setPrototypeOf(LegacyReadable.prototype, stream.Readable.prototype);
    LegacyReadable.prototype._read = function (this: { remaining: number; push(chunk: unknown): boolean }) {
      this.push(this.remaining-- > 0 ? `chunk-${this.remaining}` : null);
    };
    function LegacyWritable(this: { written: string[] }) {
      stream.Writable.call(this);
      this.written = [];
    }
    Object.setPrototypeOf(LegacyWritable.prototype, stream.Writable.prototype);
    LegacyWritable.prototype._write = function (
      this: { written: string[] },
      chunk: unknown,
      _encoding: string,
      done: () => void
    ) {
      this.written.push(String(chunk));
      done();
    };

    const source = new (LegacyReadable as unknown as new () => { pipe(destination: unknown): unknown })();
    const destination = new (LegacyWritable as unknown as new () => {
      written: string[];
      on(event: string, listener: () => void): void;
    })();
    await new Promise<void>((resolve) => {
      destination.on('finish', resolve);
      source.pipe(destination);
    });

    expect(destination.written).toEqual(['chunk-1', 'chunk-0']);
    expect(source).toBeInstanceOf(stream.Readable as unknown as new () => object);
    const detached = stream.Readable as unknown as () => unknown;
    expect(detached()).toBeInstanceOf(stream.Readable as unknown as new () => object);
  });

  test('keeps a pipe destination open when piped with end: false', async () => {
    const stream = nodeStream as {
      PassThrough: new () => {
        pipe(destination: unknown, options?: { end?: boolean }): unknown;
        end(chunk?: string): void;
        on(event: string, listener: (chunk: unknown) => void): void;
        writableEnded: boolean;
      };
    };
    const destination = new stream.PassThrough();
    const chunks: string[] = [];
    destination.on('data', (chunk) => chunks.push(String(chunk)));
    for (const text of ['first', 'second']) {
      const source = new stream.PassThrough();
      source.pipe(destination, { end: false });
      source.end(text);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(destination.writableEnded).toBe(false);
    expect(chunks).toEqual(['first', 'second']);
  });

  test('pulls from a Readable subclass when an async iterator requests an empty buffer', async () => {
    const stream = nodeStream as {
      Readable: new () => {
        _read?: () => void;
        push(chunk: unknown): boolean;
        [Symbol.asyncIterator](): AsyncIterableIterator<unknown>;
      };
    };
    const readable = new stream.Readable();
    let pulls = 0;
    readable._read = () => {
      pulls += 1;
      readable.push('body');
      readable.push(null);
    };

    const first = readable[Symbol.asyncIterator]().next();

    const result = await Promise.race([
      first,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('Readable async iterator did not pull from _read().')), 50)
      )
    ]);
    expect(result.done).toBe(false);
    expect(String(result.value)).toBe('body');
    expect(pulls).toBe(1);
  });

  test('emits a string passed to Readable.from as one chunk', async () => {
    const stream = nodeStream as {
      Readable: { from(value: string): AsyncIterable<unknown> };
    };
    const chunks: unknown[] = [];

    for await (const chunk of stream.Readable.from('angular')) chunks.push(chunk);

    expect(chunks).toEqual(['angular']);
  });

  test('pulls from an empty Readable when a flowing consumer starts', async () => {
    const stream = nodeStream as {
      Readable: new (options: { read(this: { push(chunk: unknown): boolean }): void }) => {
        on(event: 'data', listener: (chunk: unknown) => void): unknown;
        on(event: 'end', listener: () => void): unknown;
        resume(): unknown;
      };
    };
    const pulledByData: unknown[] = [];
    const dataReadable = new stream.Readable({
      read() {
        this.push('data-body');
        this.push(null);
      }
    });
    const dataEnded = new Promise<void>((resolve) => dataReadable.on('end', resolve));
    dataReadable.on('data', (chunk) => pulledByData.push(String(chunk)));

    await expect(dataEnded).resolves.toBeUndefined();
    expect(pulledByData).toEqual(['data-body']);

    let resumePulls = 0;
    const resumedReadable = new stream.Readable({
      read() {
        resumePulls += 1;
        this.push('resume-body');
        this.push(null);
      }
    });
    expect(resumePulls).toBe(0);
    resumedReadable.resume();
    await nextMacrotask();

    expect(resumePulls).toBe(1);
  });

  test('continues pulling a flowing Readable that produces one chunk per read', async () => {
    const stream = nodeStream as {
      Readable: new (options: { read(this: { push(chunk: unknown): boolean }): void }) => {
        on(event: 'data', listener: (chunk: unknown) => void): unknown;
        on(event: 'end', listener: () => void): unknown;
      };
    };
    const chunks = ['first', 'second', 'third'];
    let pulls = 0;
    const readable = new stream.Readable({
      read() {
        const chunk = chunks.shift();
        pulls += 1;
        this.push(chunk ?? null);
      }
    });
    const observed: unknown[] = [];
    const ended = new Promise<void>((resolve) => readable.on('end', resolve));
    readable.on('data', (chunk) => observed.push(String(chunk)));

    await expect(ended).resolves.toBeUndefined();
    expect(observed).toEqual(['first', 'second', 'third']);
    expect(pulls).toBe(4);
  });

  test('ends a flowing async iterator with a premature close when its readable is destroyed', async () => {
    const stream = nodeStream as {
      Readable: new (options: { read(): void }) => {
        destroy(): unknown;
        on(event: 'data', listener: (chunk: unknown) => void): unknown;
        [Symbol.asyncIterator](): AsyncIterableIterator<unknown>;
      };
    };
    const readable = new stream.Readable({ read() {} });
    readable.on('data', () => undefined);
    const next = readable[Symbol.asyncIterator]().next();

    readable.destroy();

    await expect(next).rejects.toMatchObject({ code: 'ERR_STREAM_PREMATURE_CLOSE' });
  });

  test('reports a premature close from finished', async () => {
    const stream = nodeStream as {
      Readable: new () => { destroy(): unknown };
      finished(stream: { destroy(): unknown }, callback: (error?: Error | null) => void): () => void;
    };
    const readable = new stream.Readable();

    const outcome = new Promise<Error | null>((resolve) => {
      stream.finished(readable, (error) => resolve(error ?? null));
    });
    readable.destroy();

    await expect(outcome).resolves.toMatchObject({ code: 'ERR_STREAM_PREMATURE_CLOSE' });
  });

  test('finished cleanup cancels completion callbacks', async () => {
    const stream = nodeStream as {
      Readable: new () => { push(chunk: unknown): boolean };
      finished(stream: object, callback: (error?: Error | null) => void): () => void;
    };
    const readable = new stream.Readable();
    let callbackCount = 0;
    const cleanup = stream.finished(readable, () => {
      callbackCount += 1;
    });

    cleanup();
    readable.push(null);
    await Promise.resolve();

    expect(callbackCount).toBe(0);
  });

  test('observes a consumed WHATWG readable without taking its reader lock', async () => {
    const stream = nodeStream as {
      finished(stream: ReadableStream<Uint8Array>, callback: (error?: Error | null) => void): () => void;
    };
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const readable = new ReadableStream<Uint8Array>({
      start(current) {
        controller = current;
      }
    });
    const outcome = new Promise<Error | null>((resolve) => {
      stream.finished(readable, (error) => resolve(error ?? null));
    });

    expect(readable.locked).toBe(false);
    const reader = readable.getReader();
    controller.enqueue(new Uint8Array([1, 2]));
    controller.close();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    reader.releaseLock();

    await expect(outcome).resolves.toBeNull();
  });

  test('rejects promise finished with a premature-close error', async () => {
    const stream = nodeStream as {
      Readable: new () => { destroy(): unknown };
    };
    const promises = nodeStream.promises as {
      finished(stream: object): Promise<void>;
    };
    const readable = new stream.Readable();
    const outcome = promises.finished(readable);

    readable.destroy();

    await expect(outcome).rejects.toMatchObject({ code: 'ERR_STREAM_PREMATURE_CLOSE' });
  });

  test('rejects finished attached after a stream was destroyed with an error', async () => {
    const stream = nodeStream as {
      Writable: new () => {
        destroy(error?: Error): unknown;
        on(event: string, listener: (...args: unknown[]) => void): unknown;
      };
    };
    const promises = nodeStream.promises as {
      finished(stream: object): Promise<void>;
    };
    const writable = new stream.Writable();

    writable.on('error', () => undefined);
    writable.destroy(new Error('destroyed first'));

    await expect(promises.finished(writable)).rejects.toThrow('destroyed first');
  });

  test('waits only for the requested writable side of a duplex', async () => {
    const stream = nodeStream as {
      Duplex: new (options: { read(): void; write(chunk: unknown, encoding: string, callback: (error?: Error | null) => void): void }) => {
        push(chunk: unknown): unknown;
        end(): unknown;
      };
      finished(stream: object, options: { readable: boolean; writable: boolean }, callback: (error?: Error | null) => void): () => void;
    };
    const promises = nodeStream.promises as {
      finished(stream: object, options: { readable: boolean; writable: boolean }): Promise<void>;
    };
    const duplex = new stream.Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
    let callbackCount = 0;
    const callbackFinished = new Promise<void>((resolve, reject) => {
      stream.finished(duplex, { readable: false, writable: true }, (error) => {
        callbackCount += 1;
        error ? reject(error) : resolve();
      });
    });
    const promiseFinished = promises.finished(duplex, { readable: false, writable: true });

    duplex.push(null);
    await Promise.resolve();
    expect(callbackCount).toBe(0);
    duplex.end();

    await expect(callbackFinished).resolves.toBeUndefined();
    await expect(promiseFinished).resolves.toBeUndefined();
  });

  test('applies high-water-mark backpressure until an asynchronous write drains', async () => {
    const stream = nodeStream as {
      Writable: new (options: {
        highWaterMark: number;
        write(chunk: unknown, encoding: string, callback: (error?: Error | null) => void): void;
      }) => {
        write(chunk: string): boolean;
        writableLength: number;
        writableHighWaterMark: number;
        writableNeedDrain: boolean;
        writableEnded: boolean;
        writableFinished: boolean;
        end(): unknown;
        once(event: string, listener: () => void): unknown;
      };
    };
    let release: (() => void) | undefined;
    const writable = new stream.Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        release = () => callback();
      }
    });
    const drained = new Promise<void>((resolve) => writable.once('drain', resolve));

    expect(writable.write('x')).toBe(false);
    expect(writable.writableHighWaterMark).toBe(1);
    expect(writable.writableLength).toBe(1);
    expect(writable.writableNeedDrain).toBe(true);
    expect(writable.writableEnded).toBe(false);
    expect(writable.writableFinished).toBe(false);

    release?.();
    await expect(drained).resolves.toBeUndefined();
    expect(writable.writableLength).toBe(0);
    expect(writable.writableNeedDrain).toBe(false);
    const finished = new Promise<void>((resolve) => writable.once('finish', resolve));
    writable.end();
    expect(writable.writableEnded).toBe(true);
    await finished;
    expect(writable.writableFinished).toBe(true);
  });

  test('pauses a readable pipeline source until its backpressured target drains', async () => {
    const stream = nodeStream as {
      Readable: new (options: { read(): void }) => { push(chunk: unknown): boolean };
      Writable: new (options: {
        highWaterMark: number;
        write(chunk: unknown, encoding: string, callback: (error?: Error | null) => void): void;
      }) => object;
      pipeline(source: object, destination: object, callback: (error?: Error | null) => void): unknown;
    };
    const source = new stream.Readable({ read() {} });
    const writes: string[] = [];
    const releases: Array<() => void> = [];
    const destination = new stream.Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        writes.push(String(chunk));
        releases.push(() => callback());
      }
    });
    const completed = new Promise<void>((resolve, reject) => {
      stream.pipeline(source, destination, (error) => error ? reject(error) : resolve());
    });

    source.push('first');
    source.push('second');
    source.push(null);
    await nextMacrotask();
    expect(writes).toEqual(['first']);

    releases.shift()?.();
    await nextMacrotask();
    expect(writes).toEqual(['first', 'second']);
    releases.shift()?.();

    await expect(completed).resolves.toBeUndefined();
  });

  test('serializes transform writes and propagates writable backpressure', async () => {
    const stream = nodeStream as {
      Transform: new (options: {
        highWaterMark: number;
        transform(chunk: unknown, encoding: string, callback: (error?: Error | null, data?: unknown) => void): void;
      }) => {
        write(chunk: string): boolean;
        end(): unknown;
        once(event: string, listener: () => void): unknown;
        resume(): unknown;
      };
    };
    const started: string[] = [];
    const releases: Array<() => void> = [];
    const transform = new stream.Transform({
      highWaterMark: 1,
      transform(chunk, _encoding, callback) {
        started.push(String(chunk));
        releases.push(() => callback(null, chunk));
      }
    });
    const drained = new Promise<void>((resolve) => transform.once('drain', resolve));
    transform.resume();

    expect(transform.write('first')).toBe(false);
    expect(transform.write('second')).toBe(false);
    expect(started).toEqual(['first']);
    releases.shift()?.();
    await nextMacrotask();
    expect(started).toEqual(['first', 'second']);
    releases.shift()?.();
    await expect(drained).resolves.toBeUndefined();
    transform.end();
  });

  test('waits for transform and destination destroy hooks before a failed pipeline callback', async () => {
    const stream = nodeStream as {
      Readable: new (options: {
        read(): void;
        destroy(error: Error | null, callback: (error?: Error | null) => void): void;
      }) => {
        push(chunk: unknown): boolean;
      };
      Transform: new (options: {
        transform(chunk: unknown, encoding: string, callback: (error?: Error | null, data?: unknown) => void): void;
        destroy(error: Error | null, callback: (error?: Error | null) => void): void;
      }) => object;
      Writable: new (options: { destroy(error: Error | null, callback: (error?: Error | null) => void): void }) => object;
      pipeline(source: object, transform: object, destination: object, callback: (error?: Error | null) => void): unknown;
    };
    const events: string[] = [];
    const source = new stream.Readable({
      read() {},
      destroy(error, callback) {
        events.push(`source-destroy:${error?.message ?? 'none'}`);
        queueMicrotask(callback);
      }
    });
    const transform = new stream.Transform({
      transform(chunk, _encoding, callback) {
        events.push(`transform:${chunk}`);
        callback(new Error('transform failed'));
      },
      destroy(error, callback) {
        events.push(`transform-destroy:${error?.message ?? 'none'}`);
        queueMicrotask(callback);
      }
    });
    const destination = new stream.Writable({
      destroy(error, callback) {
        events.push(`destination-destroy:${error?.message ?? 'none'}`);
        queueMicrotask(callback);
      }
    });

    const failure = await new Promise<Error | null>((resolve) => {
      stream.pipeline(source, transform, destination, (error) => resolve(error ?? null));
      source.push('body');
    });

    expect(failure).toMatchObject({ message: 'transform failed' });
    expect(events).toEqual([
      'transform:body',
      'transform-destroy:transform failed',
      'source-destroy:Premature close',
      'destination-destroy:Premature close'
    ]);
  });

  test('resolves pipeline with an async destination result', async () => {
    const stream = nodeStream as {
      Readable: { from(chunks: Iterable<unknown>): AsyncIterable<unknown> };
      PassThrough: new () => AsyncIterable<unknown> & { pipe(destination: object): unknown };
      Writable: new (options: {
        write(chunk: unknown, encoding: string, callback: (error?: Error | null) => void): void;
      }) => object;
    };
    const promises = nodeStream.promises as {
      pipeline(...stages: unknown[]): Promise<unknown>;
    };

    const transform = new stream.PassThrough();
    transform.pipe(new stream.Writable({ write(_chunk, _encoding, callback) { callback(); } }));
    const result = promises.pipeline(
      stream.Readable.from(['angular']),
      transform,
      async (source: AsyncIterable<unknown>) => {
        const chunks: unknown[] = [];
        for await (const chunk of source) chunks.push(chunk);
        return chunks.join('');
      }
    );

    await expect(result).resolves.toBe('angular');
  });

  test('keeps callable stream and stream/promises default export shapes', () => {
    const stream = nodeStream as {
      (): void;
      default: unknown;
      Transform: unknown;
    };
    const promises = nodeStream.promises as {
      default: { pipeline: unknown; finished: unknown };
      pipeline: unknown;
      finished: unknown;
    };

    expect(typeof stream).toBe('function');
    expect(stream.default).toBe(stream);
    expect(stream.Transform).toBeDefined();
    expect(promises.default.pipeline).toBe(promises.pipeline);
    expect(promises.default.finished).toBe(promises.finished);
  });

  test('supports util.inherits-style Transform constructor calls', async () => {
    const stream = nodeStream as {
      Transform: {
        new (options?: unknown): {
          end(chunk?: unknown): unknown;
          on(event: string, listener: (...args: unknown[]) => void): unknown;
          push(chunk: unknown): boolean;
        };
        call(target: object, options?: unknown): void;
        prototype: object;
      };
    };
    function LegacyTransform(this: { seen?: unknown[] }) {
      stream.Transform.call(this);
      this.seen = [];
    }
    Object.setPrototypeOf(LegacyTransform.prototype, stream.Transform.prototype);
    Object.assign(LegacyTransform.prototype, {
      _transform(this: { seen: unknown[]; push(chunk: unknown): boolean }, chunk: unknown, _encoding: string, done: () => void) {
        this.seen.push(chunk);
        this.push(chunk);
        done();
      }
    });

    const legacy = new (LegacyTransform as unknown as new () => InstanceType<typeof stream.Transform>)();
    const chunks: unknown[] = [];
    const ended = new Promise<void>((resolve) => {
      legacy.on('data', (chunk) => chunks.push(String(chunk)));
      legacy.on('end', resolve);
    });
    legacy.end('line');

    await ended;
    expect(chunks).toEqual(['line']);
  });

  test('completes finished after a transform flushes', async () => {
    const stream = nodeStream as {
      PassThrough: new () => { end(chunk?: unknown): unknown; resume(): unknown };
      finished(stream: object, callback: (error?: Error | null) => void): () => void;
    };
    const transform = new stream.PassThrough();
    transform.resume();
    const complete = new Promise<boolean>((resolve) => {
      stream.finished(transform, (error) => resolve(error === undefined || error === null));
    });

    transform.end('body');

    await expect(complete).resolves.toBe(true);
  });

  test('settles queued callbacks and closes after write and final errors', async () => {
    const stream = nodeStream as {
      Writable: new (options: {
        write?(chunk: unknown, encoding: string, callback: (error?: Error | null) => void): void;
        final?(callback: (error?: Error | null) => void): void;
      }) => {
        write(chunk: string, callback: (error?: Error) => void): boolean;
        writableLength: number;
        writableNeedDrain: boolean;
        end(callback?: (error?: Error) => void): unknown;
        on(event: string, listener: (...args: unknown[]) => void): unknown;
      };
    };
    let failWrite!: (error: Error) => void;
    const callbacks: string[] = [];
    const writable = new stream.Writable({ write(_chunk, _encoding, callback) { failWrite = callback; } });
    writable.on('error', (error) => callbacks.push(`error:${(error as Error).message}`));
    writable.on('close', () => callbacks.push('close'));
    writable.write('first', (error) => callbacks.push(`first:${error?.message}`));
    writable.write('second', (error) => callbacks.push(`second:${error?.message}`));
    writable.end((error) => callbacks.push(`end:${error?.message}`));
    failWrite(new Error('write failed'));
    expect(callbacks).toEqual(['first:write failed', 'second:write failed', 'end:write failed']);
    await nextMacrotask();
    expect(callbacks).toEqual([
      'first:write failed',
      'second:write failed',
      'end:write failed',
      'error:write failed',
      'close'
    ]);
    expect(writable.writableLength).toBe(0);
    expect(writable.writableNeedDrain).toBe(false);

    const finalEvents: string[] = [];
    const final = new stream.Writable({ final(callback) { callback(new Error('final failed')); } });
    final.on('error', (error) => finalEvents.push(`error:${(error as Error).message}`));
    final.on('close', () => finalEvents.push('close'));
    final.end((error) => finalEvents.push(`end:${error?.message}`));
    await nextMacrotask();
    // Node 22 also calls the `end` callback with the error afterwards; the port (Node 18.19's streams) does not (ADR-0026).
    expect(finalEvents.slice(0, 2)).toEqual(['error:final failed', 'close']);
  });

  test('preserves Node encodings and unpipes a source from a failed destination', async () => {
    const stream = nodeStream as {
      Readable: new (options: { read(): void }) => {
        push(chunk: unknown): boolean;
        pipe(destination: object): unknown;
        setEncoding(encoding: string): unknown;
        on(event: string, listener: (...args: unknown[]) => void): unknown;
        listenerCount(event: string): number;
      };
      Writable: new () => {
        destroy(error: Error): unknown;
        once(event: string, listener: (...args: unknown[]) => void): unknown;
      };
    };
    const readable = new stream.Readable({ read() {} });
    const encoded: string[] = [];
    readable.setEncoding('base64');
    readable.on('data', (chunk) => encoded.push(String(chunk)));
    readable.push(new Uint8Array([1, 2]));
    readable.push(new Uint8Array([3, 4]));
    readable.push(null);
    await nextMacrotask();
    expect(encoded.join('')).toBe('AQIDBA==');

    const utf16 = new stream.Readable({ read() {} });
    const utf16Chunks: string[] = [];
    utf16.setEncoding('ucs2');
    utf16.on('data', (chunk) => utf16Chunks.push(String(chunk)));
    utf16.push(new Uint8Array([0x41, 0, 0x42, 0]));
    utf16.push(null);
    await nextMacrotask();
    expect(utf16Chunks.join('')).toBe('AB');

    const source = new stream.Readable({ read() {} });
    const destination = new stream.Writable();
    const handled: string[] = [];
    destination.once('error', (error) => handled.push((error as Error).message));
    source.pipe(destination);
    expect(source.listenerCount('data')).toBe(1);
    destination.destroy(new Error('destination failed'));
    await nextMacrotask();
    expect(handled).toEqual(['destination failed']);
    expect(source.listenerCount('data')).toBe(0);
  });

  test('initialises all four base classes in place for util.inherits constructors and ES subclasses', async () => {
    const stream = loadStream();
    const inherit = (constructor: { prototype: object }, base: { prototype: object }) => {
      Object.setPrototypeOf(constructor.prototype, base.prototype);
      Object.setPrototypeOf(constructor, base);
    };

    function LegacyReadable(this: LooseStream) {
      stream.Readable.call(this, { objectMode: true });
      this.remaining = 2;
    }
    inherit(LegacyReadable, stream.Readable);
    LegacyReadable.prototype._read = function (this: LooseStream) {
      this.push(this.remaining > 0 ? { id: this.remaining-- } : null);
    };
    function LegacyWritable(this: LooseStream) {
      stream.Writable.call(this, { objectMode: true });
      this.written = [];
    }
    inherit(LegacyWritable, stream.Writable);
    LegacyWritable.prototype._write = function (this: LooseStream, chunk: unknown, _encoding: string, done: () => void) {
      this.written.push(chunk);
      done();
    };
    function LegacyDuplex(this: LooseStream) {
      stream.Duplex.call(this);
      this.written = [];
    }
    inherit(LegacyDuplex, stream.Duplex);
    LegacyDuplex.prototype._read = function (this: LooseStream) {
      this.push('duplex-read');
      this.push(null);
    };
    LegacyDuplex.prototype._write = function (this: LooseStream, chunk: unknown, _encoding: string, done: () => void) {
      this.written.push(String(chunk));
      done();
    };
    function LegacyTransform(this: LooseStream) {
      stream.Transform.call(this);
    }
    inherit(LegacyTransform, stream.Transform);
    LegacyTransform.prototype._transform = function (this: LooseStream, chunk: unknown, _encoding: string, done: () => void) {
      this.push(String(chunk).toUpperCase());
      done();
    };
    LegacyTransform.prototype._flush = function (this: LooseStream, done: () => void) {
      this.push('!');
      done();
    };

    const readable = construct(LegacyReadable);
    const writable = construct(LegacyWritable);
    const listenerReceivers: unknown[] = [];
    writable.on('finish', function (this: unknown) { listenerReceivers.push(this); });
    await new Promise<void>((resolve) => {
      writable.on('finish', resolve);
      readable.pipe(writable);
    });
    expect(writable.written).toEqual([{ id: 2 }, { id: 1 }]);
    // The receiver is the stream itself, not a facade over a hidden instance.
    expect(listenerReceivers).toEqual([writable]);
    expect(Object.prototype.hasOwnProperty.call(readable, '_readableState')).toBe(true);
    expect(readable).toBeInstanceOf(stream.Readable);
    expect(writable).toBeInstanceOf(stream.Writable);

    const duplex = construct(LegacyDuplex);
    const duplexChunks = collectText(duplex);
    duplex.end('duplex-write');
    expect(await duplexChunks).toEqual(['duplex-read']);
    expect(duplex.written).toEqual(['duplex-write']);
    expect(duplex).toBeInstanceOf(stream.Duplex);
    expect(duplex).toBeInstanceOf(stream.Readable);
    expect(duplex).toBeInstanceOf(stream.Writable);
    expect(readable).not.toBeInstanceOf(stream.Writable);

    const transform = construct(LegacyTransform);
    const transformed = collectText(transform);
    transform.write('ab');
    transform.end('cd');
    expect(await transformed).toEqual(['AB', 'CD', '!']);

    class ModernTransform extends stream.Transform {
      _transform(chunk: unknown, _encoding: string, done: (error?: Error | null, data?: unknown) => void) {
        done(null, `<${String(chunk)}>`);
      }
    }
    const modern = new ModernTransform();
    const modernChunks = collectText(modern);
    modern.end('x');
    expect(await modernChunks).toEqual(['<x>']);
    expect(modern).toBeInstanceOf(stream.Transform);
  });

  test('looks implementation methods up at call time', async () => {
    const stream = loadStream();
    const events: string[] = [];

    const writable = new stream.Writable();
    writable._write = (chunk: unknown, _encoding: string, done: () => void) => {
      events.push(`write:${String(chunk)}`);
      done();
    };
    writable._final = (done: () => void) => {
      events.push('final');
      done();
    };
    writable._destroy = (error: Error | null, done: (error?: Error | null) => void) => {
      events.push('destroy');
      done(error);
    };
    writable.on('data', () => events.push('unexpected data event'));
    writable.write('a');
    writable._write = (chunk: unknown, _encoding: string, done: () => void) => {
      events.push(`replaced:${String(chunk)}`);
      done();
    };
    const closed = new Promise((resolve) => writable.on('close', resolve));
    writable.end('b');
    expect(events).toEqual(['write:a', 'replaced:b', 'final']);
    await closed;
    expect(events).toEqual(['write:a', 'replaced:b', 'final', 'destroy']);

    const readable = new stream.Readable();
    readable._read = () => {
      readable.push('late-read');
      readable.push(null);
    };
    expect(await collectText(readable)).toEqual(['late-read']);
    const closing = new stream.Readable();
    closing._destroy = (error: Error | null, done: (error?: Error | null) => void) => {
      events.push('readable-destroy');
      done(error);
    };
    closing.destroy();
    expect(events.at(-1)).toBe('readable-destroy');

    const transform = new stream.Transform();
    transform._transform = (chunk: unknown, _encoding: string, done: (error?: Error | null, data?: unknown) => void) =>
      done(null, `${String(chunk)}${String(chunk)}`);
    transform._flush = (done: (error?: Error | null, data?: unknown) => void) => done(null, 'flushed');
    const transformed = collectText(transform);
    transform.end('x');
    expect(await transformed).toEqual(['xx', 'flushed']);

    const batches: string[][] = [];
    const vectored = new stream.Writable();
    vectored._writev = (chunks: Array<{ chunk: unknown }>, done: () => void) => {
      batches.push(chunks.map(({ chunk }) => String(chunk)));
      done();
    };
    vectored.write('solo');
    expect(batches).toEqual([['solo']]);

    const unimplemented = new stream.Writable();
    expect(() => unimplemented.write('x')).toThrow(expect.objectContaining({ code: 'ERR_METHOD_NOT_IMPLEMENTED' }));
  });

  test('honors the Duplex read option', async () => {
    const stream = loadStream();
    let reads = 0;
    const duplex = new stream.Duplex({
      read(this: LooseStream) {
        reads += 1;
        this.push('from-read-option');
        this.push(null);
      },
      write(_chunk: unknown, _encoding: string, done: () => void) { done(); }
    });

    expect(await collectText(duplex)).toEqual(['from-read-option']);
    expect(reads).toBe(1);
  });

  test('buffers corked writes and hands them to _writev as one batch', async () => {
    const stream = loadStream();
    const batches: Array<Array<{ chunk: string; encoding: string }>> = [];
    const vectored = new stream.Writable({
      decodeStrings: false,
      writev(chunks: Array<{ chunk: string; encoding: string }>, done: () => void) {
        batches.push(chunks.map(({ chunk, encoding }) => ({ chunk, encoding })));
        done();
      }
    });
    const callbacks: string[] = [];
    vectored.cork();
    vectored.cork();
    vectored.write('a', () => callbacks.push('a'));
    vectored.write('b', () => callbacks.push('b'));
    expect(vectored.writableCorked).toBe(2);
    expect(vectored.writableLength).toBe(2);
    vectored.uncork();
    expect(batches).toEqual([]);
    vectored.uncork();
    expect(batches).toEqual([[{ chunk: 'a', encoding: 'utf8' }, { chunk: 'b', encoding: 'utf8' }]]);
    await nextMacrotask();
    expect(callbacks).toEqual(['a', 'b']);
    expect(vectored.writableLength).toBe(0);

    const writes: string[] = [];
    const plain = new stream.Writable({
      write(chunk: unknown, _encoding: string, done: () => void) {
        writes.push(String(chunk));
        done();
      }
    });
    plain.cork();
    plain.write('first');
    expect(writes).toEqual([]);
    // Ending a corked stream releases the cork before finishing.
    plain.end('last');
    expect(writes).toEqual(['first', 'last']);
    await nextMacrotask();
    expect(plain.writableFinished).toBe(true);
  });

  test('Readable.from is object mode and pulls from the iterator only on demand', async () => {
    const stream = loadStream();
    let produced = 0;
    function* numbers() {
      for (;;) yield { value: ++produced };
    }
    const readable = stream.Readable.from(numbers());
    expect(readable.readableObjectMode).toBe(true);
    expect(readable.readableHighWaterMark).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(produced).toBe(0);

    const iterator = readable[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: { value: 1 } });
    expect(await iterator.next()).toEqual({ done: false, value: { value: 2 } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(produced).toBeLessThanOrEqual(3);

    let cleanedUp = false;
    async function* guarded() {
      try {
        yield 'first';
        yield 'second';
      } finally {
        cleanedUp = true;
      }
    }
    const destroyed = stream.Readable.from(guarded());
    const firstChunk = await destroyed[Symbol.asyncIterator]().next();
    expect(firstChunk.value).toBe('first');
    destroyed.destroy();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cleanedUp).toBe(true);

    const failing = stream.Readable.from((async function* () {
      yield 'ok';
      throw new Error('iterator failed');
    })());
    await expect(collect(failing)).rejects.toThrow('iterator failed');
    expect(() => stream.Readable.from(42)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
  });

  test('pipeline accepts iterables, generator stages and a consumer function', async () => {
    const stream = loadStream();
    const written: string[] = [];
    const sink = () => new stream.Writable({
      write(chunk: unknown, _encoding: string, done: () => void) {
        written.push(String(chunk));
        done();
      }
    });
    const upper = async function* (source: AsyncIterable<unknown>) {
      for await (const chunk of source) yield String(chunk).toUpperCase();
    };

    await new Promise<void>((resolve, reject) => {
      stream.pipeline(['a', 'b'], upper, sink(), (error?: Error | null) => error ? reject(error) : resolve());
    });
    expect(written).toEqual(['A', 'B']);

    written.length = 0;
    const signals: unknown[] = [];
    await stream.promises.pipeline(
      async function* (options: { signal?: AbortSignal }) {
        signals.push(options.signal);
        yield 'c';
        yield 'd';
      },
      new stream.PassThrough(),
      upper,
      sink()
    );
    expect(written.join('')).toBe('CD');
    expect(signals[0]).toBeInstanceOf(AbortSignal);

    await expect(stream.promises.pipeline(
      new Set(['e', 'f']),
      upper,
      async (source: AsyncIterable<unknown>) => {
        let joined = '';
        for await (const chunk of source) joined += String(chunk);
        return joined;
      }
    )).resolves.toBe('EF');

    // A trailing generator is drained into the stream that pipeline returns.
    const output = stream.pipeline(stream.Readable.from(['g']), upper, () => undefined);
    expect(await collectText(output)).toEqual(['G']);

    await expect(stream.promises.pipeline(['x'], async function* () {
      yield 'y';
      throw new Error('stage failed');
    }, sink())).rejects.toThrow('stage failed');
    await expect(stream.promises.pipeline(['x'], () => 42, sink())).rejects.toMatchObject({ code: 'ERR_INVALID_RETURN_VALUE' });
    await expect(stream.promises.pipeline(42, sink())).rejects.toMatchObject({ code: 'ERR_INVALID_ARG_TYPE' });
  });

  test('pipeline applies backpressure to an iterable source', async () => {
    const stream = loadStream();
    let produced = 0;
    const releases: Array<() => void> = [];
    const slow = new stream.Writable({
      objectMode: true,
      highWaterMark: 1,
      write(_chunk: unknown, _encoding: string, done: () => void) { releases.push(done); }
    });
    const completed = stream.promises.pipeline((function* () {
      while (produced < 3) yield ++produced;
    })(), slow);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(produced).toBe(1);
    while (releases.length > 0) {
      releases.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await expect(completed).resolves.toBeUndefined();
    expect(produced).toBe(3);
  });

  test('pipeline honors trailing signal and end options', async () => {
    const stream = loadStream();
    const controller = new AbortController();
    const source = new stream.Readable({ read() {} });
    const destination = new stream.PassThrough();
    const aborted = stream.promises.pipeline(source, destination, { signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });
    expect(source.destroyed).toBe(true);
    expect(destination.destroyed).toBe(true);

    const preAborted = AbortSignal.abort();
    await expect(
      stream.promises.pipeline(['never'], new stream.PassThrough(), { signal: preAborted })
    ).rejects.toMatchObject({ name: 'AbortError' });

    const open = new stream.PassThrough();
    const chunks: string[] = [];
    open.on('data', (chunk: unknown) => chunks.push(String(chunk)));
    await stream.promises.pipeline(stream.Readable.from(['kept']), open, { end: false });
    await stream.promises.pipeline(['open'], open, { end: false });
    expect(chunks).toEqual(['kept', 'open']);
    expect(open.writableEnded).toBe(false);
  });

  test('exposes stream.promises as the stream/promises builtin', async () => {
    const stream = loadStream();
    expect(stream.promises.default).toBe(stream.promises);
    expect(typeof stream.promises.pipeline).toBe('function');
    expect(typeof stream.promises.finished).toBe('function');
    const writable = new stream.Writable({ write(_chunk: unknown, _encoding: string, done: () => void) { done(); } });
    const done = stream.promises.finished(writable);
    writable.end();
    await expect(done).resolves.toBeUndefined();
  });

  test('addAbortSignal destroys the stream with an AbortError', async () => {
    const stream = loadStream();
    const controller = new AbortController();
    const readable = new stream.Readable({ read() {} });
    const failure = new Promise<Error>((resolve) => readable.on('error', resolve));

    expect(stream.addAbortSignal(controller.signal, readable)).toBe(readable);
    expect(readable.destroyed).toBe(false);
    controller.abort();

    await expect(failure).resolves.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });
    expect(readable.destroyed).toBe(true);
    expect(() => stream.addAbortSignal({}, readable)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    expect(() => stream.addAbortSignal(controller.signal, {})).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
  });

  test('compose chains streams and generator stages into one Duplex', async () => {
    const stream = loadStream();
    const composed = stream.compose(
      async function* (source: AsyncIterable<unknown>) {
        for await (const chunk of source) yield String(chunk).toUpperCase();
      },
      new stream.Transform({
        objectMode: true,
        transform(chunk: unknown, _encoding: string, done: (error?: Error | null, data?: unknown) => void) {
          done(null, `${String(chunk)}!`);
        }
      })
    );
    const chunks = collect(composed);
    composed.write('hi');
    composed.end('there');
    expect(await chunks).toEqual(['HI!', 'THERE!']);
    expect(composed).toBeInstanceOf(stream.Duplex);

    const failing = stream.compose(
      new stream.PassThrough(),
      new stream.Transform({
        transform(_chunk: unknown, _encoding: string, done: (error?: Error | null) => void) {
          done(new Error('compose stage failed'));
        }
      })
    );
    const failure = new Promise<Error>((resolve) => failing.on('error', resolve));
    failing.write('x');
    await expect(failure).resolves.toMatchObject({ message: 'compose stage failed' });
    expect(failing.destroyed).toBe(true);
  });

  test('Duplex.from adapts generators, iterables, promises and stream pairs', async () => {
    const stream = loadStream();
    const doubled = stream.Duplex.from(async function* (source: AsyncIterable<unknown>) {
      for await (const chunk of source) yield `${String(chunk)}${String(chunk)}`;
    });
    const doubledChunks = collect(doubled);
    doubled.end('q');
    expect(await doubledChunks).toEqual(['qq']);

    expect(await collect(stream.Duplex.from(['a', 'b']))).toEqual(['a', 'b']);
    expect(await collect(stream.Duplex.from(Promise.resolve('resolved')))).toEqual(['resolved']);

    const written: string[] = [];
    const pair = stream.Duplex.from({
      readable: stream.Readable.from(['from-pair']),
      writable: new stream.Writable({
        write(chunk: unknown, _encoding: string, done: () => void) {
          written.push(String(chunk));
          done();
        }
      })
    });
    const pairChunks = collect(pair);
    pair.end('to-pair');
    expect(await pairChunks).toEqual(['from-pair']);
    expect(written).toEqual(['to-pair']);

    const existing = new stream.PassThrough();
    expect(stream.Duplex.from(existing)).toBe(existing);
    expect(() => stream.Duplex.from(42)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
  });

  test('converts between Node streams and WHATWG streams', async () => {
    const stream = loadStream();
    const fromWeb = stream.Readable.fromWeb(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
        controller.close();
      }
    }));
    expect((await collect(fromWeb)).map((chunk) => Array.from(chunk as Uint8Array))).toEqual([[1, 2], [3]]);

    const reader = (stream.Readable.toWeb(stream.Readable.from(['x', 'y'])) as ReadableStream<unknown>).getReader();
    const webChunks: unknown[] = [];
    for (let result = await reader.read(); !result.done; result = await reader.read()) webChunks.push(result.value);
    expect(webChunks).toEqual(['x', 'y']);
    const bytes = new stream.Readable({ read() {} });
    bytes.push('text');
    bytes.push(null);
    const byteReader = (stream.Readable.toWeb(bytes) as ReadableStream<unknown>).getReader();
    expect(await byteReader.read()).toEqual({ done: false, value: new TextEncoder().encode('text') });
    expect((await byteReader.read()).done).toBe(true);

    const received: unknown[] = [];
    let closed = false;
    const writable = stream.Writable.fromWeb(new WritableStream<unknown>({
      write(chunk) { received.push(chunk); },
      close() { closed = true; }
    }));
    await new Promise<void>((resolve) => {
      writable.on('finish', resolve);
      writable.write(new Uint8Array([7]));
      writable.end('z');
    });
    expect(received.map((chunk) => Array.from(chunk as Uint8Array))).toEqual([[7], Array.from(new TextEncoder().encode('z'))]);
    expect(closed).toBe(true);

    const nodeWrites: string[] = [];
    const target = new stream.Writable({
      write(chunk: unknown, _encoding: string, done: () => void) {
        nodeWrites.push(String(chunk));
        done();
      }
    });
    const writer = (stream.Writable.toWeb(target) as WritableStream<unknown>).getWriter();
    await writer.write('one');
    await writer.write('two');
    await writer.close();
    expect(nodeWrites).toEqual(['one', 'two']);
    expect(target.writableFinished).toBe(true);

    const duplex = stream.Duplex.fromWeb(new TransformStream<unknown, unknown>());
    const echoed = collect(duplex);
    duplex.end(new Uint8Array([9]));
    expect((await echoed).map((chunk) => Array.from(chunk as Uint8Array))).toEqual([[9]]);
  });
});

// The builtin is exercised the way untyped Node programs use it.
type LooseStream = any;

function loadStream(): LooseStream {
  return nodeStream;
}

function construct(constructor: unknown): LooseStream {
  return new (constructor as new () => LooseStream)();
}

function collect(readable: LooseStream): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const chunks: unknown[] = [];
    readable.on('data', (chunk: unknown) => chunks.push(chunk));
    readable.on('error', reject);
    readable.on('end', () => resolve(chunks));
  });
}

async function collectText(readable: LooseStream): Promise<string[]> {
  return (await collect(readable)).map(String);
}

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
