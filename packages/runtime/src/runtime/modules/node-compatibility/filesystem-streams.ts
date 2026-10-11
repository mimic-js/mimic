import { BrowserBuffer } from './buffer';
import type {
  NodeFileSystemAsynchronousPort,
  NodeFileSystemScheduler
} from './filesystem';
import {
  fileMode,
  type FileSystemPath,
  nodeFileSystemError,
  resolveFileSystemPath
} from './filesystem-shared';
import { nodeStream as stream, type NodeReadableStream, type NodeWritableStream } from './streams';

type RuntimeReadStreamDestination = {
  destroy?(error?: unknown): unknown;
  end?(): unknown;
  write?(chunk: Uint8Array): unknown;
};

type RuntimeReadStream = NodeReadableStream & { pipe(destination: RuntimeReadStreamDestination): unknown };

export type ReadStreamOptions =
  | string
  | {
      readonly encoding?: string | null;
      readonly end?: number;
      readonly highWaterMark?: number;
      readonly start?: number;
    };

export type WriteStreamOptions =
  | string
  | {
      readonly encoding?: string | null;
      readonly flags?: string | null;
      readonly mode?: string | number | null;
    };

const READ_CHUNK_BYTES = 64 * 1024;

export function createNodeFileSystemStreamConstructors(options: {
  readonly asynchronous: NodeFileSystemAsynchronousPort;
  readonly cwd: string;
  readonly scheduler: NodeFileSystemScheduler;
}): {
  readonly ReadStream: new (path: FileSystemPath, options?: ReadStreamOptions) => RuntimeReadStream;
  readonly WriteStream: new (path: FileSystemPath, options?: WriteStreamOptions) => NodeWritableStream;
} {
  class ReadStream extends stream.Readable {
    readonly path: string;
    bytesRead = 0;

    constructor(path: FileSystemPath, streamOptions?: ReadStreamOptions) {
      const normalized = resolveFileSystemPath(path, options.cwd);
      const settings = typeof streamOptions === 'string' ? {} : streamOptions ?? {};
      const chunkBytes = Math.max(1, settings.highWaterMark ?? READ_CHUNK_BYTES);
      let position = Math.max(0, settings.start ?? 0);
      let handle: number | undefined;
      let reading = false;
      const release = (): void => {
        if (handle === undefined) return;
        const opened = handle;
        handle = undefined;
        void options.asynchronous.closeFile(opened).catch(() => undefined);
      };
      // One descriptor read per chunk keeps memory bounded by the chunk size.
      const readChunk = async (target: ReadStream): Promise<void> => {
        handle ??= await options.asynchronous.openFile(normalized, {
          append: false,
          readable: true,
          writable: false
        });
        const length =
          settings.end === undefined ? chunkBytes : Math.min(chunkBytes, settings.end + 1 - position);
        const bytes =
          length > 0
            ? await options.asynchronous.readOpenFile(handle, length, position)
            : new Uint8Array();
        // A push asks for the next chunk before it returns, so this read is over first.
        reading = false;
        if (target.destroyed) {
          release();
          return;
        }
        if (bytes.byteLength === 0) {
          release();
          target.push(null);
          return;
        }
        position += bytes.byteLength;
        target.bytesRead += bytes.byteLength;
        target.push(BrowserBuffer.from(bytes));
      };
      super({
        read() {
          const target = this as ReadStream;
          if (reading) return;
          reading = true;
          options.scheduler.setTimeout(() => {
            void readChunk(target).catch(
              (error: unknown) => {
                reading = false;
                release();
                target.destroy(error instanceof Error ? error : new Error(String(error)));
              }
            );
          }, 0);
        },
        destroy(error, callback) {
          release();
          callback(error);
        }
      });
      this.path = normalized;
    }

    /** Node's `ReadStream.close()`: destroys the stream, then calls back once it has closed. */
    close(callback?: (error?: Error | null) => void): void {
      if (callback) {
        if ((this as { closed?: boolean }).closed) queueMicrotask(() => callback(null));
        else this.once('close', () => callback(null));
      }
      this.destroy();
    }
  }

  class WriteStream extends stream.Writable {
    readonly path: string;
    bytesWritten = 0;

    constructor(path: FileSystemPath, streamOptions?: WriteStreamOptions) {
      const normalized = resolveFileSystemPath(path, options.cwd);
      const settings = typeof streamOptions === 'string' ? {} : streamOptions ?? {};
      const flags = settings.flags ?? 'w';
      const mode = fileMode(settings.mode);
      // The first write opens the file as its flags demand, and every chunk is
      // written through that one open file, as Node writes through its
      // descriptor: a rename or unlink of the path while the stream is open
      // leaves the stream writing to the file it opened.
      let handle: number | undefined;
      let opened: Promise<number> | undefined;
      const open = (): Promise<number> =>
        (opened ??= (flags.startsWith('r')
          ? Promise.resolve()
          : options.asynchronous.writeFile(normalized, new Uint8Array(), {
              // Appending nothing creates a missing file and leaves an existing one as it is.
              append: flags.startsWith('a'),
              exclusive: flags.includes('x'),
              mode
            })
        )
          .then(() =>
            options.asynchronous.openFile(normalized, {
              append: flags.startsWith('a'),
              readable: flags.includes('+'),
              writable: true
            })
          )
          .then((id) => (handle = id)));
      const release = async (): Promise<void> => {
        if (opened === undefined) return;
        const id = await opened.catch(() => undefined);
        if (id === undefined || handle !== id) return;
        handle = undefined;
        await options.asynchronous.closeFile(id);
      };
      const writeBytes = (target: WriteStream, bytes: Uint8Array, callback: (error?: Error | null) => void): void => {
        void open()
          .then((id) => options.asynchronous.writeOpenFile(id, bytes))
          .then(
            () => {
              target.bytesWritten += bytes.byteLength;
              callback();
            },
            (error: unknown) => callback(error instanceof Error ? error : new Error(String(error)))
          );
      };
      super({
        write(chunk, _encoding, callback) {
          if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) {
            callback(nodeFileSystemError('ERR_INVALID_ARG_TYPE', 'WriteStream chunks must be strings or Uint8Arrays.'));
            return;
          }
          // The write is deferred, so it keeps its own copy (a Buffer `slice()` would alias the chunk).
          const bytes = typeof chunk === 'string' ? BrowserBuffer.from(chunk) : Uint8Array.from(chunk);
          writeBytes(this as WriteStream, bytes, callback);
        },
        // The chunks buffered while a write was in flight go out as one write,
        // as Node's `fs.WriteStream` gathers them into one `fs.writev`.
        writev(chunks, callback) {
          const parts: Uint8Array[] = [];
          for (const { chunk } of chunks) {
            if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) {
              callback(nodeFileSystemError('ERR_INVALID_ARG_TYPE', 'WriteStream chunks must be strings or Uint8Arrays.'));
              return;
            }
            parts.push(typeof chunk === 'string' ? BrowserBuffer.from(chunk) : chunk);
          }
          const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
          let offset = 0;
          for (const part of parts) {
            bytes.set(part, offset);
            offset += part.byteLength;
          }
          writeBytes(this as WriteStream, bytes, callback);
        },
        final(callback) {
          options.scheduler.setTimeout(() => {
            void open().then(
              () => callback(),
              (error: unknown) => callback(error instanceof Error ? error : new Error(String(error)))
            );
          }, 0);
        },
        destroy(error, callback) {
          void release().then(
            () => callback(error),
            (closeError: unknown) => callback(error ?? (closeError instanceof Error ? closeError : new Error(String(closeError))))
          );
        }
      });
      this.path = normalized;
    }

    /** Node's `WriteStream.close()`: ends the stream, then calls back once it has closed. */
    close(callback?: (error?: Error | null) => void): void {
      if (callback) {
        if ((this as { closed?: boolean }).closed) queueMicrotask(() => callback(null));
        else this.once('close', () => callback((this as { errored?: Error | null }).errored ?? null));
      }
      if (!this.writableEnded) this.end();
      else if (!this.destroyed) this.destroy();
    }
  }

  // graceful-fs and similar wrappers construct these with `fs.ReadStream.apply(this, arguments)`.
  return {
    ReadStream: legacyCallableStream(
      ReadStream,
      (_receiver, args) => new ReadStream(args[0] as FileSystemPath, args[1] as ReadStreamOptions)
    ),
    WriteStream: legacyCallableStream(
      WriteStream,
      (_receiver, args) => new WriteStream(args[0] as FileSystemPath, args[1] as WriteStreamOptions)
    )
  } as unknown as {
    readonly ReadStream: new (path: FileSystemPath, options?: ReadStreamOptions) => RuntimeReadStream;
    readonly WriteStream: new (path: FileSystemPath, options?: WriteStreamOptions) => NodeWritableStream;
  };
}

function bridgeLegacyConstructedStream(
  receiver: Record<PropertyKey, unknown>,
  delegated: object
): void {
  // A member the legacy subclass defines itself stays the subclass's.
  const overridden = (key: PropertyKey, base: unknown): boolean => {
    const existing = Reflect.get(receiver, key);
    return typeof existing === 'function' && existing !== base;
  };
  for (const key of Reflect.ownKeys(delegated)) {
    if (overridden(key, Reflect.get(delegated, key))) continue;
    Object.defineProperty(receiver, key, {
      configurable: true,
      enumerable: Object.prototype.propertyIsEnumerable.call(delegated, key),
      get: () => Reflect.get(delegated, key),
      set: (value) => {
        Reflect.set(delegated, key, value);
      }
    });
  }
  let prototype = Object.getPrototypeOf(delegated) as object | null;
  while (prototype && prototype !== Object.prototype) {
    for (const key of Reflect.ownKeys(prototype)) {
      if (key === 'constructor' || Object.prototype.hasOwnProperty.call(receiver, key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
      if (!descriptor) continue;
      if (typeof descriptor.value === 'function') {
        if (overridden(key, descriptor.value)) continue;
        Object.defineProperty(receiver, key, {
          configurable: true,
          value: descriptor.value.bind(delegated),
          writable: true
        });
      } else if (descriptor.get || descriptor.set) {
        Object.defineProperty(receiver, key, {
          configurable: true,
          enumerable: descriptor.enumerable,
          get: descriptor.get ? () => descriptor.get?.call(delegated) : undefined,
          set: descriptor.set ? (value) => descriptor.set?.call(delegated, value) : undefined
        });
      }
    }
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
}

/**
 * Makes a stream class usable the way pre-class Node code constructs streams:
 * `Base.call(this, ...args)` from a constructor wired with `util.inherits`.
 * The receiver delegates to a real instance built by `create`.
 */
function legacyCallableStream<Class extends abstract new (...args: never[]) => object>(
  StreamClass: Class,
  create: (receiver: Record<PropertyKey, unknown>, args: readonly unknown[]) => object
): Class {
  return new Proxy(StreamClass, {
    apply(target, receiver: Record<PropertyKey, unknown> | undefined, args) {
      if (receiver === undefined || receiver === null) {
        throw new TypeError(`Class constructor ${target.name} cannot be invoked without 'new'`);
      }
      bridgeLegacyConstructedStream(receiver, create(receiver, args));
      return receiver;
    }
  });
}
