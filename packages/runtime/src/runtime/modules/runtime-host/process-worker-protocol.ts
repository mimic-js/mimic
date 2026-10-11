import type {
  PublishedEndpointProtocol,
  PublishedHttpRequest,
  PublishedHttpResponseHead,
  PublishedHttpResponse
} from '../published-endpoint';
import type { VirtualFileSystemApi } from '../virtual-file-system';
import type { VirtualNetworkApi, VirtualNetworkEvents } from '../virtual-network';
import type {
  InlineNodeEntry,
  ProcessExecutionChildIpc,
  ProcessExecutionInheritedInput,
  ProcessExecutionSynchronousChildRequest,
  ProcessExecutionSynchronousChildResult,
  ProcessIoHostApi,
  ProcessIoWorkerApi,
  ThreadIdentity
} from '../process-execution';
import type {
  ReceivedPortMessage,
  ThreadEntry,
  ThreadOutputStream,
  WorkerThreadMessage,
  WorkerThreadPortsHostApi,
  WorkerThreadPortsWorkerApi,
  WorkerThreadSharedMemoryPool
} from '../node-compatibility';
import type { SerializedError, SynchronousChannel } from '../worker-transport';
import type { RuntimeAssetManifest } from './runtime-assets';

export type ProcessSignal = 'SIGTERM' | 'SIGKILL' | 'SIGINT';

/** The Runtime Host service a process worker's mailbox calls to compile a module. */
export const RUNTIME_ARTIFACT_COMPILE_SERVICE = 'compile';

export type NodeProcessStart = {
  contextId: number;
  pid: number;
  ppid: number;
  args: string[];
  /** The runtime's assets as the embedding page resolved them (ADR-0033). */
  assets: RuntimeAssetManifest;
  inlineEntry?: InlineNodeEntry;
  cwd: string;
  env: Record<string, string>;
  /**
   * Serves {@link NodeProcessSynchronousApi}; its status words are the
   * relay's PORT_NOTIFICATIONS_SENT_WORD and PORT_DELIVERY_SEEN_WORD.
   */
  synchronous: SynchronousChannel;
  /** Shared by every thread of the process. */
  sharedMemoryPool: WorkerThreadSharedMemoryPool;
  workerThread?: Readonly<{
    identity: ThreadIdentity;
    workerData: WorkerThreadMessage;
    parentPort: string;
  }>;
  /** The process's end of the IPC channel its parent opened with `fork()`. */
  ipc?: ProcessExecutionChildIpc;
};

/**
 * A Worker Thread the process asks its host to run as another process worker.
 * The thread belongs to the process whose connection carries the request: the
 * host supplies the pid, so the request names only thread ids.
 */
export type NodeWorkerThreadStart = {
  readonly entry: ThreadEntry;
  /** Drawn by the process from its shared-memory pool. */
  readonly threadId: number;
  /** The thread that created the Worker. */
  readonly parentThreadId: number;
  readonly workerData: WorkerThreadMessage;
  readonly parentPort: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly argv: readonly string[];
  readonly execArgv: readonly string[];
  /** The streams the starting Worker reads itself; the others are written to the process's own. */
  readonly capturedOutput: readonly ThreadOutputStream[];
};

/** What a process worker asks of its host synchronously, blocking until the answer. */
export interface NodeProcessSynchronousApi {
  /** Runs a child to completion while the calling process waits. */
  spawnChild(
    request: ProcessExecutionSynchronousChildRequest,
    inheritedInput?: ProcessExecutionInheritedInput
  ): ProcessExecutionSynchronousChildResult;
  /** Takes the next message for a relayed MessagePort end, as `receiveMessageOnPort` does. */
  receivePortMessage(id: string): ReceivedPortMessage | undefined;
}

/**
 * Brands an error that reports the failure of a process worker itself, not of
 * the program it ran, so that the host rethrows it as a crash rather than
 * printing it as the program's failure. The brand is a symbol-keyed property,
 * which Worker Transport's error serialisation never carries: only the
 * context that observed the failure can brand it, so a process worker, which
 * runs untrusted code, cannot report an ordinary exit as a crash.
 */
const workerFailure = Symbol('mimicWorkerFailure');

export function markWorkerFailure<ErrorType extends Error>(error: ErrorType): ErrorType {
  return Object.assign(error, { [workerFailure]: true as const });
}

export function isWorkerFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    Reflect.get(error, workerFailure) === true
  );
}

/** What a JavaScript Runtime Process's host serves to its Execution Context worker. */
export interface NodeProcessHostApi {
  /**
   * The Virtual File System as this process: the synchronous mailbox it opens
   * is the process's own, whatever context id it names.
   */
  readonly fs: VirtualFileSystemApi;
  /** The Virtual Network as this process: every listener, socket and release is the process's own. */
  readonly network: VirtualNetworkApi;
  readonly io: ProcessIoHostApi;
  readonly threads: {
    /** Admits and runs a Worker Thread of this process to completion, resolving its exit code. */
    start(request: NodeWorkerThreadStart): Promise<number>;
    terminate(threadId: number): void;
  };
  readonly ports: WorkerThreadPortsHostApi;
  readonly endpoints: {
    listen(
      port: number,
      publication: {
        readonly protocol: PublishedEndpointProtocol;
        readonly address: { readonly host: string; readonly port: number };
      },
      /** Served by the worker with the listener's {@link PublishedListenerApi}. */
      endpoint: MessagePort
    ): void;
    close(port: number): void;
  };
  exit(code: number): void;
  /** An error crosses as a value rather than a rejected call. */
  fail(error: SerializedError): void;
  runtimeError(error: SerializedError): void;
}

/** What an Execution Context worker serves to its host. */
export interface NodeProcessWorkerApi {
  start(start: NodeProcessStart): void;
  kill(signal: ProcessSignal): void;
  readonly io: ProcessIoWorkerApi;
  readonly network: VirtualNetworkEvents;
  readonly ports: WorkerThreadPortsWorkerApi;
  readonly threads: {
    /** Output of a thread this worker started, on a stream its Worker reads itself. */
    output(threadId: number, stream: ThreadOutputStream, data: Uint8Array): void;
  };
}

/**
 * What a process worker serves for one published listener, over a port the
 * Runtime Host hands to the page's Published Endpoint host: a published
 * request reaches the `http.Server` that owns the listener as a structured
 * request, and its response returns the same way, without HTTP/1 bytes.
 */
export interface PublishedListenerApi {
  /** Resolves with the response head once the server sends it; the body streams. */
  serveHttp(exchangeId: string, request: PublishedHttpRequest): Promise<PublishedHttpResponse>;
  cancelHttp(exchangeId: string, reason: string): void;
  /**
   * Serves a WebSocket to the document on `client` (ADR-0038); resolves with
   * the server's response head, or `undefined` when the socket closed first.
   */
  openWebSocket(
    request: PublishedHttpRequest,
    client: MessagePort,
    options: { readonly documentLock?: string }
  ): Promise<PublishedHttpResponseHead | undefined>;
  close(): void;
}

