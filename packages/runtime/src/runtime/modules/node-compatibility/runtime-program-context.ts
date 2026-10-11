import type {
  ChildProcessExecutionPort,
  ExecutionContextProcessProjection,
  SynchronousChildProcessExecutionPort
} from './child-process';
import type {
  CurrentThreadExecution,
  ThreadExecutionPort,
  WorkerThreadPorts
} from './worker-threads';
import type { WorkerThreadSharedMemoryPool } from './worker-thread-shared-memory';
import type { ProcessExecutionChildIpc, ProcessInput, ProcessWriter } from '../process-execution';
import type { ResolvedExecutable } from '../process-execution';
import type { RuntimeExecutionContext } from '../process-execution';
import type { PublishedEndpointServer } from '../published-endpoint';
import type { VirtualNetworkAuthority } from '../virtual-network';
import type { ProcessExecutionSignal as ProcessSignal } from '../process-execution';
import type { RuntimeVirtualFileSystemClient } from '../virtual-file-system';

export type RuntimeEmitter = {
  emitError?(error: Error): void;
};

export interface ProcessEventHandlers {
  onUncaughtException(error: unknown): void;
  onUnhandledRejection(
    reason: unknown,
    promise: Promise<unknown>
  ): void;
}

/** The `worker_threads` of a JavaScript Runtime Process, as its process worker provides them. */
export type RuntimeWorkerThreads = {
  readonly current: CurrentThreadExecution;
  readonly execution: ThreadExecutionPort;
  readonly ports: WorkerThreadPorts;
  readonly sharedMemoryPool: WorkerThreadSharedMemoryPool;
};

export type RuntimeProgramContext = {
  cwd: string;
  env: Record<string, string>;
  executable?: ResolvedExecutable;
  executionContext?: RuntimeExecutionContext;
  /** Children run as Runtime Processes of their own, through the process worker's host. */
  childProcess: ChildProcessExecutionPort;
  synchronousProcessAuthority: SynchronousChildProcessExecutionPort;
  pid?: number;
  ppid?: number;
  signal?: Promise<ProcessSignal>;
  /** Resolves with the next signal sent after the call, once the program handled the ones before it. */
  nextSignal?: () => Promise<ProcessSignal>;
  processProjection?: ExecutionContextProcessProjection;
  workerThreads: RuntimeWorkerThreads;
  /** The end of the IPC channel the parent opened with `fork()`, linked through `workerThreads.ports`. */
  ipc?: ProcessExecutionChildIpc;
  fs: RuntimeVirtualFileSystemClient;
  writer: ProcessWriter;
  errorWriter?: ProcessWriter;
  input?: ProcessInput;
  emitter: RuntimeEmitter;
  diagnostics?: {
    moduleStart(path: string, format: 'esm' | 'cjs'): void;
    moduleEnd?(path: string, format: 'esm' | 'cjs'): void;
  };
  processEvents?: {
    install(handlers: ProcessEventHandlers): () => void;
  };
  virtualNetwork?: VirtualNetworkAuthority;
  publishedEndpoints?: {
    register(
      port: number,
      protocol: 'http' | 'https',
      handler: PublishedEndpointServer
    ): void;
    close(port: number): void | (() => void);
  };
};
