import {
  exitCodeForSignal,
  type ProcessExecutionSignal
} from '../process-execution';
import type { ProcessInput, ProcessWriter } from '../process-execution';
import type { RuntimeExecutionContext, RuntimeProgram } from '../process-execution';
import {
  WASI_PREVIEW1_RUNTIME_PROGRAM_ID
} from '../wasi-execution';
import {
  connectRpc,
  createSynchronousChannel,
  normalizeError,
  serveSynchronousRpc,
  synchronousChannelWords,
  transfer,
  type Implementation,
  type RpcPort,
  type SynchronousChannel
} from '../worker-transport';
import type {
  SynchronousVirtualFileSystemMailboxDescriptor
} from '../virtual-file-system';

export type WasiRuntimeWorkerStart = {
  readonly bytes: ArrayBuffer;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly fileSystem: SynchronousVirtualFileSystemMailboxDescriptor;
  /** Serves {@link WasiStdinApi}; its status word is {@link WASI_STDIN_AVAILABLE_WORD}. */
  readonly stdin: SynchronousChannel;
};

/** Standard input a WASI Execution worker reads synchronously from its host. */
export interface WasiStdinApi {
  /** Blocks until input is available and returns at most `maximumBytes`, or null at end of input. */
  read(maximumBytes: number): Uint8Array | null;
}

/**
 * The stdin channel's status word: the input bytes the host holds for the
 * next read, or {@link WASI_STDIN_ENDED} once input has ended and nothing is
 * held. The host notifies it on every change, so a worker can wait on it.
 */
export const WASI_STDIN_AVAILABLE_WORD = 0;

/** The status word's value once input has ended and every byte has been read. */
export const WASI_STDIN_ENDED = -1;

/** What a WASI Execution worker serves: one command run to its exit code. */
export interface WasiRuntimeWorkerApi {
  run(start: WasiRuntimeWorkerStart): Promise<number>;
}

/** What the hosting Runtime Program serves back to the worker. */
export interface WasiRuntimeHostApi {
  output(stream: 'stdout' | 'stderr', data: ArrayBuffer): void;
}

export interface WasiRuntimeExecutionWorker extends RpcPort {
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  addEventListener(type: 'message' | 'messageerror', listener: (event: MessageEvent) => void): void;
  terminate(): void;
}

export interface WasiRuntimeProgramContext {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly pid?: number;
  readonly fs: WasiRuntimeFileSystemPort;
  readonly writer: ProcessWriter;
  readonly errorWriter?: ProcessWriter;
  readonly input?: ProcessInput;
  readonly signal?: Promise<ProcessExecutionSignal>;
  readonly executionContext?: RuntimeExecutionContext;
}

export interface WasiRuntimeFileSystemPort {
  readFile(path: string): Promise<Uint8Array>;
  openSynchronousMailbox(
    contextId: string
  ): Promise<SynchronousVirtualFileSystemMailboxDescriptor>;
  closeSynchronousMailbox(contextId: string): Promise<void>;
}

export function createWasiRuntimeProgram(options: {
  readonly createWorker: () => Worker;
}): RuntimeProgram<WasiRuntimeProgramContext> {
  return {
    id: WASI_PREVIEW1_RUNTIME_PROGRAM_ID,
    commands: [],
    classificationOnly: true,
    handlesSignals: true,
    async run(args, context) {
      const executablePath = args[0];
      if (!executablePath) {
        throw new TypeError('WASI Runtime Program requires a resolved executable path.');
      }
      if (!context.executionContext) {
        throw new TypeError('WASI Runtime Program requires an admitted Execution Context.');
      }

      let deliveredSignal: ProcessExecutionSignal | undefined;
      void context.signal?.then((signal) => {
        deliveredSignal = signal;
      });
      const bytes = await context.fs.readFile(executablePath);
      if (deliveredSignal) return exitCodeForSignal(deliveredSignal);

      const mailboxId =
        `wasi-execution-context:${context.executionContext.id}:process:${context.pid ?? 0}`;
      const fileSystem = await context.fs.openSynchronousMailbox(mailboxId);
      let worker: WasiRuntimeExecutionWorker;
      try {
        worker = context.executionContext.openWorker(options.createWorker);
      } catch (error) {
        await context.fs.closeSynchronousMailbox(mailboxId);
        throw error;
      }
      return runWorker(
        worker,
        bytes,
        args,
        context,
        context.fs,
        fileSystem,
        mailboxId
      );
    }
  };
}

function runWorker(
  worker: WasiRuntimeExecutionWorker,
  bytes: Uint8Array,
  args: readonly string[],
  context: WasiRuntimeProgramContext,
  fileSystemPort: WasiRuntimeFileSystemPort,
  fileSystem: SynchronousVirtualFileSystemMailboxDescriptor,
  mailboxId: string
): Promise<number> {
  const stdin = createSynchronousChannel({ words: 1, watchdogMs: Infinity });
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    const stdinServer = serveSynchronousRpc(
      stdin,
      createWasiStdinService(context.input, synchronousChannelWords(stdin), () => settled)
    );
    const host: WasiRuntimeHostApi = {
      output(stream, data) {
        try {
          const writer = stream === 'stderr' ? context.errorWriter : context.writer;
          writer?.write(new Uint8Array(data));
        } catch (error) {
          finish({ error: normalizeError(error) });
        }
      }
    };
    const connection = connectRpc<WasiRuntimeWorkerApi>(worker, host);
    const cleanup = (): void => {
      stdinServer.close();
      connection.close();
      worker.terminate();
    };
    const finish = (
      result: { readonly code: number } | { readonly error: Error }
    ): void => {
      if (settled) return;
      settled = true;
      cleanup();
      void fileSystemPort.closeSynchronousMailbox(mailboxId).then(
        () => {
          if ('error' in result) reject(result.error);
          else resolve(result.code);
        },
        (cleanupError: unknown) => {
          const normalizedCleanupError = normalizeError(cleanupError);
          reject(
            'error' in result
              ? new AggregateError(
                  [result.error, normalizedCleanupError],
                  'WASI Runtime Process execution and VFS cleanup failed.'
                )
              : normalizedCleanupError
          );
        }
      );
    };
    worker.addEventListener('error', (event) => {
      event.preventDefault();
      finish({
        error: new Error(
          `The WASI Execution worker failed terminally: ${
            event.error instanceof Error ? event.error.message : event.message
          }`
        )
      });
    });
    void context.signal?.then((signal) =>
      finish({ code: exitCodeForSignal(signal) })
    );

    const data = Uint8Array.from(bytes).buffer;
    connection.remote
      .run(
        transfer(
          {
            bytes: data,
            args: [...args],
            cwd: context.cwd,
            env: { ...context.env, PWD: context.cwd },
            fileSystem,
            stdin
          },
          [data]
        )
      )
      .then(
        (code) => finish({ code }),
        (error: unknown) => finish({ error: normalizeError(error) })
      );
  });
}

/**
 * Serves standard input to a WASI worker. The host reads ahead one chunk of
 * the process input and holds it, publishing its size in the status word,
 * or that input has ended, so a polling program sees input arrive without a
 * call and can wait for it; the next chunk is read only once that one is
 * consumed.
 */
function createWasiStdinService(
  input: ProcessInput | undefined,
  words: Int32Array,
  stopped: () => boolean
): Implementation<WasiStdinApi> {
  let held: Uint8Array = new Uint8Array();
  let ended = input === undefined;
  let arrival: (() => void) | undefined;
  let drained: (() => void) | undefined;
  const hold = (bytes: Uint8Array): void => {
    held = bytes;
    Atomics.store(
      words,
      WASI_STDIN_AVAILABLE_WORD,
      held.byteLength === 0 && ended ? WASI_STDIN_ENDED : held.byteLength
    );
    Atomics.notify(words, WASI_STDIN_AVAILABLE_WORD);
    arrival?.();
    arrival = undefined;
  };
  // Without process input, standard input has already ended.
  hold(held);
  if (input) {
    void (async () => {
      try {
        while (!stopped()) {
          const lease = input.readLease
            ? await input.readLease()
            : await input.read().then((chunk) => chunk && { chunk, release: () => undefined });
          if (!lease) return;
          const chunk = lease.chunk.slice();
          lease.release();
          await new Promise<void>((resolve) => {
            drained = resolve;
            hold(chunk);
          });
        }
      } finally {
        ended = true;
        hold(held);
      }
    })();
  }
  return {
    async read(maximumBytes) {
      while (held.byteLength === 0 && !ended && !stopped()) {
        await new Promise<void>((resolve) => {
          arrival = resolve;
        });
      }
      if (held.byteLength === 0) return null;
      const bytes = held.slice(0, maximumBytes);
      hold(held.subarray(bytes.byteLength));
      if (held.byteLength === 0) {
        drained?.();
        drained = undefined;
      }
      return bytes;
    }
  };
}
