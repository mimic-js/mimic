import { transfer, type Notify } from '../worker-transport';
import type {
  ProcessExecutionChildOutputSink,
  ProcessExecutionChildRequest,
  ProcessExecutionChildSignal,
  ProcessExecutionChildStdioMode
} from './child-requests';
import type { ProcessIoHostApi, ProcessIoWorkerApi } from './process-io';
import { pipeProcessInput } from './process-streams';
import type { ProcessInput, ProcessWriter } from './virtual-process';

/** What the host reports to a process worker about the children it spawned. */
export type WorkerChildProcessEvents = Pick<
  ProcessIoWorkerApi,
  'childAdmitted' | 'childSpawnError' | 'childOutput' | 'childInputDrain' | 'childExit'
>;

/** A child Runtime Process as its parent's worker sees it. */
export interface WorkerChildProcessHandle {
  readonly pid: number;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exit: Promise<{
    readonly code: number;
    readonly signal: ProcessExecutionChildSignal | null;
  }>;
}

/** Spawns and signals the children of a process worker through its host. */
export interface WorkerChildProcesses {
  spawn(request: ProcessExecutionChildRequest): Promise<WorkerChildProcessHandle>;
  signal(pid: number, signal: ProcessExecutionChildSignal): Promise<boolean>;
}

/**
 * The worker side of the child-process stdio protocol: `port` spawns children
 * through the host and `events` receives what the host reports about them.
 */
export function createWorkerChildProcessPort(
  host: Notify<ProcessIoHostApi>,
  inheritedStdout: ProcessWriter,
  inheritedStderr: ProcessWriter,
  inheritedInput: ProcessInput
): { readonly port: WorkerChildProcesses; readonly events: WorkerChildProcessEvents } {
  let requestSequence = 0;
  const pending = new Map<string, {
    resolve(handle: WorkerChildProcessHandle): void;
    reject(error: Error): void;
    stdout?: ReadableStreamDefaultController<Uint8Array>;
    stderr?: ReadableStreamDefaultController<Uint8Array>;
    resolveExit(result: {
      readonly code: number;
      readonly signal: ProcessExecutionChildSignal | null;
    }): void;
    drains: Map<number, () => void>;
    inputSequence: number;
    inputAbort?: AbortController;
    outputQueue: Promise<void>;
    request: ProcessExecutionChildRequest;
  }>();
  const requestByPid = new Map<number, string>();
  const events: WorkerChildProcessEvents = {
    childSpawnError(requestId, message, code) {
      const child = pending.get(requestId);
      if (!child) return;
      const spawnError = (): Error =>
        code === undefined ? new Error(message) : Object.assign(new Error(message), { code });
      child.inputAbort?.abort(spawnError());
      pending.delete(requestId);
      void child.outputQueue.then(() => {
        child.stdout?.error(spawnError());
        child.stderr?.error(spawnError());
        child.reject(spawnError());
      });
    },
    childAdmitted(requestId, pid) {
      const child = pending.get(requestId);
      if (!child) return;
      requestByPid.set(pid, requestId);
      const stdin = new WritableStream<Uint8Array>({
        write(chunk) {
          const data = chunk.slice().buffer;
          const sequence = child.inputSequence++;
          host.childInput(requestId, sequence, transfer(data, [data]));
          return new Promise<void>((resolve) => child.drains.set(sequence, resolve));
        },
        close() {
          host.childInputClose(requestId);
        }
      });
      if (child.request.stdio.stdin === 'inherit') {
        const inputAbort = new AbortController();
        child.inputAbort = inputAbort;
        void pipeProcessInput(inheritedInput, stdin, {
          signal: inputAbort.signal
        }).catch(() => undefined);
      }
      child.resolve({
        pid,
        stdin,
        stdout: child.request.stdio.stdout === 'pipe'
          ? new ReadableStream<Uint8Array>({
              start(controller) { child.stdout = controller; }
            })
          : closedChildOutput(),
        stderr: child.request.stdio.stderr === 'pipe'
          ? new ReadableStream<Uint8Array>({
              start(controller) { child.stderr = controller; }
            })
          : closedChildOutput(),
        exit: new Promise((resolve) => { child.resolveExit = resolve; })
      });
    },
    childInputDrain(requestId, sequence) {
      const child = pending.get(requestId);
      child?.drains.get(sequence)?.();
      child?.drains.delete(sequence);
    },
    childOutput(requestId, stream, data) {
      const child = pending.get(requestId);
      if (!child) return;
      const bytes = new Uint8Array(data);
      child.outputQueue = child.outputQueue.then(() =>
        projectWorkerChildOutput(
          child,
          stream,
          bytes,
          stream === 'stdout' ? inheritedStdout : inheritedStderr
        )
      );
    },
    childExit(requestId, code, signal) {
      const child = pending.get(requestId);
      if (!child) return;
      child.inputAbort?.abort(
        new Error(`Runtime Process ${requestId} exited.`)
      );
      pending.delete(requestId);
      for (const [pid, candidate] of requestByPid) {
        if (candidate === requestId) requestByPid.delete(pid);
      }
      void child.outputQueue.then(() => {
        child.stdout?.close();
        child.stderr?.close();
        for (const resolve of child.drains.values()) resolve();
        child.resolveExit({ code, signal });
      });
    }
  };
  const port: WorkerChildProcesses = {
    spawn(request) {
      const requestId = `async-child-${++requestSequence}`;
      return new Promise((resolve, reject) => {
        pending.set(requestId, {
          resolve,
          reject,
          resolveExit: () => undefined,
          drains: new Map(),
          inputSequence: 0,
          outputQueue: Promise.resolve(),
          request
        });
        host.spawnChild(requestId, serializableChildRequest(request));
      });
    },
    async signal(pid, signal) {
      const requestId = requestByPid.get(pid);
      if (!requestId) return false;
      host.childSignal(requestId, signal);
      return true;
    }
  };
  return { port, events };
}

function serializableChildRequest(
  request: ProcessExecutionChildRequest
): ProcessExecutionChildRequest {
  return {
    ...request,
    stdio: {
      stdin: request.stdio.stdin,
      stdout: serializableChildStdio(request.stdio.stdout),
      stderr: serializableChildStdio(request.stdio.stderr)
    }
  };
}

function serializableChildStdio(
  stdio: ProcessExecutionChildStdioMode | ProcessExecutionChildOutputSink
): ProcessExecutionChildStdioMode {
  return typeof stdio === 'object' ? 'pipe' : stdio;
}

function projectWorkerChildOutput(
  child: {
    readonly request: ProcessExecutionChildRequest;
    readonly stdout?: ReadableStreamDefaultController<Uint8Array>;
    readonly stderr?: ReadableStreamDefaultController<Uint8Array>;
  },
  stream: 'stdout' | 'stderr',
  bytes: Uint8Array,
  inherited: ProcessWriter
): Promise<void> {
  const target = child.request.stdio[stream];
  if (target === 'ignore') return Promise.resolve();
  if (target === 'inherit') return Promise.resolve(inherited.write(bytes));
  if (target === 'pipe') {
    child[stream]?.enqueue(bytes);
    return Promise.resolve();
  }
  target.write(bytes);
  return Promise.resolve();
}

function closedChildOutput(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) { controller.close(); }
  });
}

/**
 * A process worker's standard input: chunks the host sent, each acknowledged
 * to the host once the program reads it.
 */
export class WorkerProcessInput implements ProcessInput {
  private readonly chunks: Array<{ readonly chunk: Uint8Array; readonly sequence: number }> = [];
  private closed = false;
  private resolveRead: ((chunk: Uint8Array | undefined) => void) | undefined;

  constructor(private readonly host: Notify<Pick<ProcessIoHostApi, 'inputDrain'>>) {}

  push(chunk: Uint8Array, sequence: number): void {
    if (this.closed) return;
    const copy = new Uint8Array(chunk.byteLength);
    copy.set(chunk);
    if (this.resolveRead) {
      const resolve = this.resolveRead;
      this.resolveRead = undefined;
      resolve(copy);
      this.host.inputDrain(sequence);
      return;
    }
    this.chunks.push({ chunk: copy, sequence });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.resolveRead?.(undefined);
    this.resolveRead = undefined;
  }

  read(
    options: { readonly signal?: AbortSignal } = {}
  ): Promise<Uint8Array | undefined> {
    const entry = this.chunks.shift();
    if (entry) {
      this.host.inputDrain(entry.sequence);
      return Promise.resolve(entry.chunk);
    }
    if (this.closed) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      const signal = options.signal;
      const finish = (chunk: Uint8Array | undefined): void => {
        signal?.removeEventListener('abort', abort);
        resolve(chunk);
      };
      const abort = (): void => {
        if (this.resolveRead === finish) this.resolveRead = undefined;
        reject(signal?.reason ?? new Error('Process input read was aborted.'));
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      this.resolveRead = finish;
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  takeForSynchronousChild(): Readonly<{
    readonly entries: readonly Readonly<{
      readonly chunk: Uint8Array;
      readonly sequence: number;
    }>[];
    readonly closed: boolean;
  }> {
    const entries = this.chunks.splice(0);
    const closed = this.closed;
    if (closed) this.closed = false;
    return { entries, closed };
  }
}
