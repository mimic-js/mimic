import { normalizeError, transfer, type Notify } from '../worker-transport';
import type { ProcessExecutionChildRequest } from './child-requests';
import type {
  ProcessExecutionInheritedInput,
  ProcessIoHostApi,
  ProcessIoWorkerApi
} from './process-io';
import type { ProcessInput, RuntimeProgramProcess } from './virtual-process';

/**
 * The host side of a process worker's standard input: each chunk goes to the
 * worker with a sequence number and is released once the worker acknowledges
 * that it drained it; a synchronous child borrows what the worker has not yet
 * read and hands back what it leaves.
 */
export interface ServedProcessInput {
  readonly api: Pick<ProcessIoHostApi, 'inputDrain'>;
  /** Forwards `input` to the worker until it ends or `isSettled` turns true. */
  forward(input: ProcessInput, isSettled: () => boolean): Promise<void>;
  /** Lends the input the worker handed over to a synchronous child. */
  lendToSynchronousChild(
    inherited: ProcessExecutionInheritedInput | undefined
  ): {
    readonly input: ProcessInput | undefined;
    /** The child is done; with `restore`, what it did not read goes back to the worker. */
    complete(restore: boolean): void;
  };
  /** Releases every chunk still waiting for its drain acknowledgement. */
  dispose(): void;
}

export function serveProcessInput(
  worker: Notify<ProcessIoWorkerApi>
): ServedProcessInput {
  const inputDrainWaiters = new Map<number, () => void>();
  let processInputSequence = 0;
  let synchronousInput: SynchronousProcessInput | undefined;
  return {
    api: {
      inputDrain(sequence) {
        inputDrainWaiters.get(sequence)?.();
        inputDrainWaiters.delete(sequence);
      }
    },
    forward: (input, isSettled) =>
      forwardProcessInput(
        input,
        worker,
        isSettled,
        inputDrainWaiters,
        () => synchronousInput,
        () => processInputSequence++
      ),
    lendToSynchronousChild(inherited) {
      const inheritedInput = inherited
        ? new SynchronousProcessInput(
            inherited.entries.map((entry) => entry.chunk),
            inherited.closed
          )
        : undefined;
      if (inheritedInput) {
        synchronousInput = inheritedInput;
        for (const entry of inherited?.entries ?? []) {
          const resolve = inputDrainWaiters.get(entry.sequence);
          inputDrainWaiters.delete(entry.sequence);
          resolve?.();
        }
      }
      return {
        input: inheritedInput,
        complete(restore) {
          if (synchronousInput === inheritedInput) {
            synchronousInput = undefined;
          }
          if (inheritedInput && restore) {
            restoreSynchronousProcessInput(
              inheritedInput,
              worker,
              () => processInputSequence++,
              inputDrainWaiters
            );
          }
        }
      };
    },
    dispose() {
      for (const resolve of inputDrainWaiters.values()) resolve();
      inputDrainWaiters.clear();
    }
  };
}

export function serveAsynchronousChildProcesses(
  worker: Notify<ProcessIoWorkerApi>,
  spawn: (request: ProcessExecutionChildRequest) => Promise<RuntimeProgramProcess>
): {
  readonly api: Pick<
    ProcessIoHostApi,
    'spawnChild' | 'childInput' | 'childInputClose' | 'childSignal'
  >;
  dispose(): void;
} {
  let disposed = false;
  const children = new Map<string, {
    readonly process: RuntimeProgramProcess;
    readonly input: WritableStreamDefaultWriter<Uint8Array>;
  }>();
  return {
    api: {
      spawnChild(requestId, request) {
        void spawn(request).then(
          (process) => {
            if (disposed) {
              process.kill('SIGTERM');
              return;
            }
            const input = process.stdin.getWriter();
            children.set(requestId, { process, input });
            worker.childAdmitted(requestId, process.pid);
            const outputDrained = Promise.all([
              forwardChildOutput(worker, requestId, 'stdout', process.stdout, () => disposed),
              forwardChildOutput(worker, requestId, 'stderr', process.stderr, () => disposed)
            ]);
            void process.exit.then(
              async (code) => {
                await outputDrained;
                const termination = await process.termination;
                children.delete(requestId);
                input.releaseLock();
                if (!disposed) {
                  worker.childExit(requestId, code, termination?.signal ?? null);
                }
              },
              async (error: unknown) => {
                await outputDrained;
                children.delete(requestId);
                input.releaseLock();
                if (!disposed) {
                  worker.childSpawnError(requestId, normalizeError(error).message);
                }
              }
            );
          },
          (error: unknown) => {
            if (!disposed) {
              const refusal = normalizeError(error);
              const code = (refusal as { readonly code?: unknown }).code;
              worker.childSpawnError(
                requestId,
                refusal.message,
                typeof code === 'string' ? code : undefined
              );
            }
          }
        );
      },
      childInput(requestId, sequence, data) {
        const child = children.get(requestId);
        if (!child) return;
        void child.input.write(new Uint8Array(data)).then(
          () => {
            if (!disposed) worker.childInputDrain(requestId, sequence);
          },
          () => undefined
        );
      },
      childInputClose(requestId) {
        void children.get(requestId)?.input.close().catch(() => undefined);
      },
      childSignal(requestId, signal) {
        children.get(requestId)?.process.kill(signal);
      }
    },
    dispose() {
      disposed = true;
      for (const child of children.values()) child.process.kill('SIGTERM');
      children.clear();
    }
  };
}

async function forwardChildOutput(
  worker: Notify<ProcessIoWorkerApi>,
  requestId: string,
  stream: 'stdout' | 'stderr',
  output: ReadableStream<Uint8Array>,
  isDisposed: () => boolean
): Promise<void> {
  const reader = output.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (isDisposed()) return;
      const data = value.slice().buffer;
      worker.childOutput(requestId, stream, transfer(data, [data]));
    }
  } finally {
    reader.releaseLock();
  }
}

async function forwardProcessInput(
  input: ProcessInput,
  worker: Notify<ProcessIoWorkerApi>,
  isSettled: () => boolean,
  drainWaiters: Map<number, () => void>,
  synchronousInput: () => SynchronousProcessInput | undefined,
  nextSequence: () => number
): Promise<void> {
  while (!isSettled()) {
    const lease = input.readLease
      ? await input.readLease()
      : await input.read().then((chunk) => chunk && ({ chunk, release: () => undefined }));
    if (!lease) {
      if (!isSettled()) {
        const synchronous = synchronousInput();
        if (synchronous) synchronous.close();
        else worker.inputClose();
      }
      return;
    }
    if (isSettled()) {
      lease.release();
      return;
    }
    const copy = new Uint8Array(lease.chunk.byteLength);
    copy.set(lease.chunk);
    const synchronous = synchronousInput();
    if (synchronous) {
      synchronous.push(copy);
      lease.release();
      continue;
    }
    const currentSequence = nextSequence();
    const drained = new Promise<void>((resolve) => drainWaiters.set(currentSequence, resolve));
    const data = copy.buffer as ArrayBuffer;
    worker.input(currentSequence, transfer(data, [data]));
    await drained;
    lease.release();
  }
}

class SynchronousProcessInput implements ProcessInput {
  private readonly chunks: Uint8Array[];
  private resolveRead:
    | ((chunk: Uint8Array | undefined) => void)
    | undefined;

  constructor(chunks: readonly Uint8Array[], private closed: boolean) {
    this.chunks = chunks.map((chunk) => chunk.slice());
  }

  push(chunk: Uint8Array): void {
    if (this.closed) return;
    const copy = chunk.slice();
    if (this.resolveRead) {
      const resolve = this.resolveRead;
      this.resolveRead = undefined;
      resolve(copy);
      return;
    }
    this.chunks.push(copy);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.chunks.length === 0) {
      this.resolveRead?.(undefined);
      this.resolveRead = undefined;
    }
  }

  read(
    options: { readonly signal?: AbortSignal } = {}
  ): Promise<Uint8Array | undefined> {
    const chunk = this.chunks.shift();
    if (chunk) return Promise.resolve(chunk);
    if (this.closed) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      const signal = options.signal;
      const finish = (value: Uint8Array | undefined): void => {
        signal?.removeEventListener('abort', abort);
        resolve(value);
      };
      const abort = (): void => {
        if (this.resolveRead === finish) this.resolveRead = undefined;
        reject(signal?.reason ?? new Error('Synchronous process input was aborted.'));
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      this.resolveRead = finish;
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  takeRemaining(): Readonly<{
    readonly chunks: readonly Uint8Array[];
    readonly closed: boolean;
  }> {
    return { chunks: this.chunks.splice(0), closed: this.closed };
  }
}

function restoreSynchronousProcessInput(
  input: SynchronousProcessInput,
  worker: Notify<ProcessIoWorkerApi>,
  nextSequence: () => number,
  drainWaiters: Map<number, () => void>
): void {
  const remaining = input.takeRemaining();
  for (const chunk of remaining.chunks) {
    const data = chunk.slice().buffer as ArrayBuffer;
    const sequence = nextSequence();
    drainWaiters.set(sequence, () => undefined);
    worker.input(sequence, transfer(data, [data]));
  }
  if (remaining.closed) worker.inputClose();
}
