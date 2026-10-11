import { transfer, type Notify, type Remote } from '../worker-transport';
import {
  MimicProcessCrashError,
  type ProcessExecutionOutcome,
  type ProcessExecutionSignal,
  type RuntimeProgramRequest
} from './process-execution';
import type { RuntimeProgramProcess } from './virtual-process';

/**
 * What Process Execution serves to the context that embeds Mimic.
 * The caller names each process by a handle it chooses, so output that arrives
 * before the spawn call returns already has a destination.
 */
export interface ProcessExecutionApi {
  /** Resolves to the pid once the process is admitted. */
  spawn(handle: number, request: RuntimeProgramRequest): Promise<number>;
  /** Resolves once the process has accepted the bytes. */
  input(handle: number, data: ArrayBuffer): Promise<void>;
  closeInput(handle: number): void;
  signal(handle: number, signal: ProcessExecutionSignal): void;
}

/** What Process Execution reports back about the processes it serves. */
export interface ProcessExecutionClientApi {
  /** Resolves once the client has taken the bytes, which applies its backpressure. */
  output(handle: number, stream: 'stdout' | 'stderr', data: ArrayBuffer): Promise<void>;
  exit(handle: number, outcome: ProcessExecutionOutcome): void;
}

/** The standard output and error of a served process, in the order the program writes them. */
export interface ServedProcessOutput {
  write(stream: 'stdout' | 'stderr', chunk: string | Uint8Array): Promise<void>;
}

export interface ProcessExecutionService {
  readonly api: ProcessExecutionApi;
  /** Resolves once every served process that has exited has reported its outcome. */
  settled(): Promise<void>;
}

const encoder = new TextEncoder();

export function serveProcessExecution(
  spawn: (
    request: RuntimeProgramRequest,
    output: ServedProcessOutput
  ) => Promise<RuntimeProgramProcess>,
  client: {
    readonly remote: Remote<ProcessExecutionClientApi>;
    readonly notify: Notify<ProcessExecutionClientApi>;
  }
): ProcessExecutionService {
  const served = new Map<
    number,
    {
      readonly process: RuntimeProgramProcess;
      readonly stdin: WritableStreamDefaultWriter<Uint8Array>;
    }
  >();
  const reports = new Set<Promise<void>>();

  return {
    api: {
      async spawn(handle, request) {
        const process = await spawn(request, {
          // Output a client can no longer take is dropped with the client.
          write: (stream, chunk) => {
            const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk.slice();
            const data = bytes.buffer as ArrayBuffer;
            return client.remote
              .output(handle, stream, transfer(data, [data]))
              .catch(() => undefined);
          }
        });
        const stdin = process.stdin.getWriter();
        served.set(handle, { process, stdin });
        const report = process.exit
          .then(
            async (code) => {
              const termination = await process.termination;
              client.notify.exit(handle, {
                type: 'exit',
                code,
                signal: termination?.signal ?? null
              });
            },
            (error: unknown) => {
              client.notify.exit(handle, {
                type: 'crash',
                message:
                  error instanceof MimicProcessCrashError
                    ? error.reason
                    : error instanceof Error
                      ? error.message
                      : String(error)
              });
            }
          )
          .finally(() => {
            served.delete(handle);
            stdin.releaseLock();
            reports.delete(report);
          });
        reports.add(report);
        return process.pid;
      },
      async input(handle, data) {
        await served.get(handle)?.stdin.write(new Uint8Array(data));
      },
      closeInput(handle) {
        void served.get(handle)?.stdin.close().catch(() => undefined);
      },
      signal(handle, signal) {
        served.get(handle)?.process.kill(signal);
      }
    },
    async settled() {
      await Promise.all(reports);
    }
  };
}
