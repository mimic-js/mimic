import { transfer, type Remote } from '../worker-transport';
import {
  MimicProcessCrashError,
  exitCodeForSignal,
  type ProcessExecutionOutcome,
  type ProcessExecutionSignal,
  type RuntimeProgramRequest
} from './process-execution';
import type {
  ProcessExecutionApi,
  ProcessExecutionClientApi
} from './service';
import {
  createVirtualProcess,
  type ProcessInput,
  type ProcessWriter,
  type RuntimeProgramProcess,
  type RuntimeProgramTermination
} from './virtual-process';

export interface ProcessExecutionClient {
  /** What Process Execution reports back; expose it to the serving side. */
  readonly events: ProcessExecutionClientApi;
  spawn(request: RuntimeProgramRequest): Promise<RuntimeProgramProcess>;
  /** Crashes every process still running, because the runtime failed. */
  fail(error: unknown): void;
  /** Settles every process still running as killed, because the runtime closed. */
  close(): void;
}

export class RuntimeProcessExecutionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RuntimeProcessExecutionError';
    this.code = code;
  }
}

type ProcessProjection = {
  /** Output and the outcome apply in the order the serving side reported them. */
  queue: Promise<unknown>;
  readonly started: Promise<{
    readonly stdout: ProcessWriter;
    readonly stderr: ProcessWriter;
  }>;
  finish(outcome: ProcessExecutionOutcome): void;
};

/**
 * Projects the Runtime Processes another context runs as local process handles
 * with standard streams, signals, and their exit.
 */
export function createProcessExecutionClient(
  remote: Remote<ProcessExecutionApi>
): ProcessExecutionClient {
  const projections = new Map<number, ProcessProjection>();
  let nextHandle = 0;
  let closed = false;

  const events: ProcessExecutionClientApi = {
    output(handle, stream, data) {
      const projection = projections.get(handle);
      if (!projection) return Promise.resolve();
      const bytes = new Uint8Array(data);
      // A step only enqueues the bytes. Their backpressure goes back to the
      // caller and never holds later output or the exit behind a slow reader.
      const enqueued = projection.queue
        .then(() => projection.started)
        .then((writers) => ({ accepted: writers[stream].write(bytes) }));
      projection.queue = enqueued.then(
        () => undefined,
        () => undefined
      );
      return enqueued.then(async ({ accepted }) => {
        await accepted;
      });
    },
    exit(handle, outcome) {
      const projection = projections.get(handle);
      if (!projection) return;
      projection.queue = projection.queue.then(() => projection.finish(outcome));
    }
  };

  const spawn = async (
    request: RuntimeProgramRequest
  ): Promise<RuntimeProgramProcess> => {
    if (closed) {
      throw new RuntimeProcessExecutionError(
        'PROCESS_EXECUTION_CLOSED',
        'Process Execution client is closed.'
      );
    }
    const handle = ++nextHandle;
    let start!: (writers: { readonly stdout: ProcessWriter; readonly stderr: ProcessWriter }) => void;
    let settle!: (outcome: ProcessExecutionOutcome) => void;
    const outcome = new Promise<ProcessExecutionOutcome>((resolve) => {
      settle = resolve;
    });
    const projection: ProcessProjection = {
      queue: Promise.resolve(),
      started: new Promise((resolve) => {
        start = resolve;
      }),
      finish: (value) => settle(value)
    };
    projections.set(handle, projection);
    let pid: number;
    try {
      pid = await remote.spawn(handle, request);
    } catch (error) {
      projections.delete(handle);
      throw toRuntimeProcessExecutionError(error);
    }
    let termination: RuntimeProgramTermination | undefined;
    const local = createVirtualProcess(
      pid,
      async (stdout, stdin, stderr) => {
        start({ stdout, stderr });
        void forwardInput(handle, stdin);
        const result = await outcome;
        if (result.type === 'crash') {
          throw new MimicProcessCrashError(pid, result.message);
        }
        termination = { code: result.code, signal: result.signal };
        return result.code;
      },
      (signal) => {
        if (!closed) remote.signal(handle, signal).catch(() => undefined);
      }
    );
    const exit = local.exit.finally(() => projections.delete(handle));
    return {
      pid,
      stdin: local.stdin,
      stdout: local.stdout,
      stderr: local.stderr,
      input: local.input,
      output: local.output,
      exit,
      termination: exit.then(
        (code) => termination ?? { code, signal: null },
        () => undefined
      ),
      kill(signal: ProcessExecutionSignal = 'SIGTERM') {
        local.kill(signal);
      },
      crash(error) {
        local.crash(toProcessCrashError(pid, error));
      }
    };
  };

  const forwardInput = async (
    handle: number,
    input: ProcessInput
  ): Promise<void> => {
    while (true) {
      const lease = await input.readLease?.();
      if (!lease) {
        if (!closed) remote.closeInput(handle).catch(() => undefined);
        return;
      }
      const data = lease.chunk.slice().buffer as ArrayBuffer;
      try {
        await remote.input(handle, transfer(data, [data]));
      } catch {
        return;
      } finally {
        lease.release();
      }
    }
  };

  return {
    events,
    spawn,
    fail(error) {
      if (closed) return;
      closed = true;
      for (const projection of projections.values()) {
        projection.finish({
          type: 'crash',
          message: error instanceof Error ? error.message : String(error)
        });
      }
    },
    close() {
      if (closed) return;
      closed = true;
      for (const projection of projections.values()) {
        projection.finish({ type: 'exit', code: exitCodeForSignal('SIGKILL'), signal: 'SIGKILL' });
      }
    }
  };
}

function toRuntimeProcessExecutionError(error: unknown): RuntimeProcessExecutionError {
  if (error instanceof RuntimeProcessExecutionError) return error;
  const code = (error as { readonly code?: unknown } | null)?.code;
  return new RuntimeProcessExecutionError(
    typeof code === 'string' ? code : 'PROCESS_EXECUTION_CLOSED',
    error instanceof Error ? error.message : String(error)
  );
}

function toProcessCrashError(pid: number, error: unknown): MimicProcessCrashError {
  if (error instanceof MimicProcessCrashError && error.pid === pid) return error;
  const normalized = error instanceof Error ? error : new Error(String(error));
  return new MimicProcessCrashError(pid, normalized.message, error);
}
