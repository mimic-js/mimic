import type {
  ProcessExecutionChildRequest,
  ProcessExecutionChildSignal
} from './child-requests';

export type ProcessExecutionInheritedInput = Readonly<{
  readonly entries: readonly Readonly<{
    readonly chunk: Uint8Array;
    readonly sequence: number;
  }>[];
  readonly closed: boolean;
}>;

/** Standard I/O and child processes a Runtime Process's worker asks of its host. */
export interface ProcessIoHostApi {
  ready(): void;
  /** Resolves once the host has written the bytes. */
  output(stream: 'stdout' | 'stderr', data: ArrayBuffer): Promise<void>;
  inputDrain(sequence: number): void;
  spawnChild(requestId: string, request: ProcessExecutionChildRequest): void;
  childInput(requestId: string, sequence: number, data: ArrayBuffer): void;
  childInputClose(requestId: string): void;
  childSignal(requestId: string, signal: ProcessExecutionChildSignal): void;
}

/** What the host delivers back to a Runtime Process's worker. */
export interface ProcessIoWorkerApi {
  input(sequence: number, data: ArrayBuffer): void;
  inputClose(): void;
  childAdmitted(requestId: string, pid: number): void;
  /** `code` is the Process Execution code of a refused spawn, such as `EXECUTABLE_NOT_FOUND`. */
  childSpawnError(requestId: string, message: string, code?: string): void;
  childOutput(requestId: string, stream: 'stdout' | 'stderr', data: ArrayBuffer): void;
  childInputDrain(requestId: string, sequence: number): void;
  childExit(
    requestId: string,
    code: number,
    signal: ProcessExecutionChildSignal | null
  ): void;
}
