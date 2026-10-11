export type ProcessExecutionChildSignal = 'SIGTERM' | 'SIGKILL' | 'SIGINT';
export type ProcessExecutionChildStdioMode = 'inherit' | 'pipe' | 'ignore';

export interface ProcessExecutionChildOutputSink {
  write(chunk: Uint8Array): void;
}

export interface ProcessExecutionChildStdio {
  readonly stdin: ProcessExecutionChildStdioMode;
  readonly stdout:
    | ProcessExecutionChildStdioMode
    | ProcessExecutionChildOutputSink;
  readonly stderr:
    | ProcessExecutionChildStdioMode
    | ProcessExecutionChildOutputSink;
}

interface ProcessExecutionChildRequestBase {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly parentPid: number;
}

export interface ProcessExecutionChildRequest
  extends ProcessExecutionChildRequestBase {
  readonly stdio: ProcessExecutionChildStdio;
  /**
   * The child's end of an IPC channel the parent hosted in its port relay;
   * the child, a Node program, links it as its `process` channel.
   */
  readonly ipc?: ProcessExecutionChildIpc;
}

export interface ProcessExecutionChildIpc {
  readonly port: string;
  readonly serialization: 'json' | 'advanced';
}

export interface ProcessExecutionSynchronousChildRequest
  extends ProcessExecutionChildRequestBase {
  readonly input: Uint8Array;
  readonly stdio: Readonly<{
    readonly stdin: ProcessExecutionChildStdioMode;
    readonly stdout: ProcessExecutionChildStdioMode;
    readonly stderr: ProcessExecutionChildStdioMode;
  }>;
  readonly timeout: number;
  readonly killSignal: ProcessExecutionChildSignal;
  readonly maxBuffer: number;
}

export interface ProcessExecutionSynchronousChildResult {
  readonly pid?: number;
  readonly status: number | null;
  readonly signal: ProcessExecutionChildSignal | null;
  readonly stdout: Uint8Array | null;
  readonly stderr: Uint8Array | null;
  readonly error?: Readonly<{
    readonly code: string;
    readonly message: string;
  }>;
}

export interface ThreadIdentity {
  readonly pid: number;
  readonly threadId: number;
}
