import { normalizeError } from '../worker-transport';
import { exitCodeForSignal } from './process-execution';

const encoder = new TextEncoder();
const PROCESS_STREAM_HIGH_WATER_MARK = 64 * 1024;

export interface RuntimeProgramProcess {
  readonly pid: number;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly input: WritableStream<Uint8Array>;
  readonly output: ReadableStream<Uint8Array>;
  readonly exit: Promise<number>;
  readonly termination: Promise<RuntimeProgramTermination | undefined>;
  kill(signal?: VirtualProcessSignal): void;
  crash(error: unknown): void;
}

export interface RuntimeProgramTermination {
  readonly code: number;
  readonly signal: VirtualProcessSignal | null;
}

export type ProcessWriter = {
  write(chunk: string | Uint8Array): void | Promise<void>;
  close(code?: number): void;
  fail(error: unknown): void;
  waitForKill(): Promise<'SIGTERM' | 'SIGKILL' | 'SIGINT'>;
  /** Calls `listener` with every signal sent after it subscribed; a handled signal does not end a process. */
  onSignal?(listener: (signal: 'SIGTERM' | 'SIGKILL' | 'SIGINT') => void): () => void;
};

export type ProcessInput = {
  read(options?: { readonly signal?: AbortSignal }): Promise<Uint8Array | undefined>;
  readLease?(options?: { readonly signal?: AbortSignal }): Promise<
    | {
        readonly chunk: Uint8Array;
        release(): void;
      }
    | undefined
  >;
};

export type ManagedMimicProcess = RuntimeProgramProcess;

export type VirtualProcessSignal = 'SIGTERM' | 'SIGKILL' | 'SIGINT';

export type VirtualProcessRunner = (
  stdout: ProcessWriter,
  stdin: ProcessInput,
  stderr: ProcessWriter
) => Promise<number | void> | number | void;

export type VirtualProcessKillHandler = (signal: VirtualProcessSignal, writer: ProcessWriter) => void;

export function createVirtualProcess(
  pid: number,
  runner: VirtualProcessRunner,
  onKill?: VirtualProcessKillHandler
): ManagedMimicProcess {
  let settled = false;
  let terminationSignal: VirtualProcessSignal | null = null;
  let settleExit!: (code: number) => void;
  let rejectExit!: (error: unknown) => void;
  let killResolver!: (signal: VirtualProcessSignal) => void;
  const inputChunks: Array<{ readonly chunk: Uint8Array; released: boolean }> = [];
  const inputDrainWaiters = new Set<() => void>();
  let inputQueuedBytes = 0;
  let inputClosed = false;
  let resolveInputRead: (() => void) | undefined;
  const stdout = createProcessOutput();
  const stderr = createProcessOutput();
  const output = createProcessOutput({ boundedProjection: true });

  const exit = new Promise<number>((resolve, reject) => {
    settleExit = resolve;
    rejectExit = reject;
  });

  const killed = new Promise<VirtualProcessSignal>((resolve) => {
    killResolver = resolve;
  });
  const signalListeners = new Set<(signal: VirtualProcessSignal) => void>();
  // A signal ended the process only when its exit says so: a program that
  // handled the signal and then exited reports its own status, as in Node.
  const termination = exit.then(
    (code) => ({
      code,
      signal: terminationSignal !== null && code === exitCodeForSignal(terminationSignal) ? terminationSignal : null
    }),
    () => undefined
  );

  const closeInput = () => {
    if (inputClosed) return;
    inputClosed = true;
    if (inputChunks.length === 0) {
      resolveInputRead?.();
      resolveInputRead = undefined;
    }
    releaseInputBackpressure();
  };

  const abortInput = () => {
    inputClosed = true;
    inputChunks.length = 0;
    inputQueuedBytes = 0;
    resolveInputRead?.();
    resolveInputRead = undefined;
    releaseInputBackpressure();
  };

  const processInput: ProcessInput = {
    async read(options) {
      const lease = await readInputLease(options);
      lease?.release();
      return lease?.chunk;
    },
    readLease: readInputLease
  };

  async function readInputLease(
    options: { readonly signal?: AbortSignal } = {}
  ): Promise<{ readonly chunk: Uint8Array; release(): void } | undefined> {
    while (inputChunks.length === 0 && !inputClosed) {
      await new Promise<void>((resolve, reject) => {
        const signal = options.signal;
        const settle = (): void => {
          signal?.removeEventListener('abort', abort);
          resolve();
        };
        const abort = (): void => {
          if (resolveInputRead === settle) resolveInputRead = undefined;
          reject(signal?.reason ?? new Error('Process input read was aborted.'));
        };
        if (signal?.aborted) {
          abort();
          return;
        }
        resolveInputRead = settle;
        signal?.addEventListener('abort', abort, { once: true });
      });
    }
    const entry = inputChunks.shift();
    if (!entry) return undefined;
    return {
      chunk: entry.chunk,
      release() {
        if (entry.released) return;
        entry.released = true;
        inputQueuedBytes -= entry.chunk.byteLength;
        releaseInputBackpressure();
      }
    };
  }

  const stdin = new WritableStream<Uint8Array>({
    write(chunk) {
      if (inputClosed) throw new Error(`Process ${pid} stdin is closed`);
      const copy = new Uint8Array(chunk.byteLength);
      copy.set(chunk);
      inputChunks.push({ chunk: copy, released: false });
      inputQueuedBytes += copy.byteLength;
      resolveInputRead?.();
      resolveInputRead = undefined;
      if (inputQueuedBytes < PROCESS_STREAM_HIGH_WATER_MARK) return;
      return new Promise<void>((resolve) => inputDrainWaiters.add(resolve));
    },
    close: closeInput,
    abort: abortInput
  }, new ByteLengthQueuingStrategy({ highWaterMark: PROCESS_STREAM_HIGH_WATER_MARK }));

  const stdoutWriter: ProcessWriter = {
    write(chunk) {
      if (settled) return;
      void output.write(chunk);
      return stdout.write(chunk);
    },
    close(code = 0) {
      finish({ type: 'exit', code });
    },
    fail(error) {
      finish({ type: 'crash', error });
    },
    waitForKill() {
      return killed;
    },
    onSignal(listener) {
      signalListeners.add(listener);
      return () => signalListeners.delete(listener);
    }
  };
  const stderrWriter: ProcessWriter = {
    write(chunk) {
      if (settled) return;
      void output.write(chunk);
      return stderr.write(chunk);
    },
    close: stdoutWriter.close,
    fail: stdoutWriter.fail,
    waitForKill: stdoutWriter.waitForKill,
    onSignal: stdoutWriter.onSignal
  };

  queueMicrotask(async () => {
    try {
      const code = await runner(stdoutWriter, processInput, stderrWriter);
      if (!settled && typeof code === 'number') stdoutWriter.close(code);
      if (!settled && code === undefined) stdoutWriter.close(0);
    } catch (error) {
      stdoutWriter.fail(error);
    }
  });

  return {
    pid,
    stdin,
    stdout: stdout.stream,
    stderr: stderr.stream,
    input: stdin,
    output: output.stream,
    exit,
    termination,
    kill(signal = 'SIGTERM') {
      if (settled) return;
      terminationSignal ??= signal;
      onKill?.(signal, stdoutWriter);
      killResolver(signal);
      for (const listener of [...signalListeners]) listener(signal);
    },
    crash(error) {
      stdoutWriter.fail(error);
    }
  };

  function releaseInputBackpressure(): void {
    if (inputQueuedBytes >= PROCESS_STREAM_HIGH_WATER_MARK) return;
    for (const resolve of inputDrainWaiters) resolve();
    inputDrainWaiters.clear();
  }

  function finish(outcome: { readonly type: 'exit'; readonly code: number } | { readonly type: 'crash'; readonly error: unknown }): void {
    if (settled) return;
    settled = true;
    abortInput();
    if (outcome.type === 'exit') {
      stdout.close();
      stderr.close();
      output.close();
      queueMicrotask(() => settleExit(outcome.code));
      return;
    }
    const error = normalizeError(outcome.error);
    stdout.fail(error);
    stderr.fail(error);
    output.fail(error);
    queueMicrotask(() => rejectExit(error));
  }
}

type ProcessOutput = {
  readonly stream: ReadableStream<Uint8Array>;
  write(chunk: string | Uint8Array): void | Promise<void>;
  close(): void;
  fail(error: Error): void;
};

function createProcessOutput(options: { readonly boundedProjection?: boolean } = {}): ProcessOutput {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const drainWaiters = new Set<() => void>();
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    pull() {
      releaseBackpressure();
    },
    cancel() {
      closed = true;
      releaseAll();
    }
  }, new ByteLengthQueuingStrategy({ highWaterMark: PROCESS_STREAM_HIGH_WATER_MARK }));

  return {
    stream,
    write(chunk) {
      if (closed) return;
      const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      if (options.boundedProjection) {
        const available = Math.max(0, controller.desiredSize ?? 0);
        if (available === 0) return;
        controller.enqueue(copy.byteLength <= available ? copy : copy.slice(0, available));
        return;
      }
      controller.enqueue(copy);
      if ((controller.desiredSize ?? 1) > 0) return;
      return new Promise<void>((resolve) => drainWaiters.add(resolve));
    },
    close() {
      if (closed) return;
      closed = true;
      controller.close();
      releaseAll();
    },
    fail(error) {
      if (closed) return;
      closed = true;
      controller.error(error);
      releaseAll();
    }
  };

  function releaseBackpressure(): void {
    if ((controller.desiredSize ?? 0) <= 0) return;
    releaseAll();
  }

  function releaseAll(): void {
    for (const resolve of drainWaiters) resolve();
    drainWaiters.clear();
  }
}
