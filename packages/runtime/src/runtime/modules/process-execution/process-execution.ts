import type { ExecutableResolutionError, ResolvedExecutable } from './executable-resolution';

const ROOT_PID_STRIDE = 1_000_000;

/**
 * Every asynchronous child and every worker thread runs in a dedicated Web
 * Worker of the renderer that hosts the embedding page, and Execution Capacity
 * counts root processes only. Without a bound of their own, a program running
 * `for (;;) child_process.spawn('node', …)` or `new Worker(…)` creates workers
 * until the renderer dies and takes the page with it. Thirty-two per Execution
 * Context covers a package manager's parallel lifecycle scripts and a bundler's
 * worker pool; sixty-four across the epoch caps what one page holds in total.
 * Synchronous children run in a context of their own and keep the park limit.
 */
export const DEFAULT_CONTEXT_WORKER_LIMIT = 32;
export const DEFAULT_EPOCH_WORKER_LIMIT = 64;

export type ProcessExecutionSignal = 'SIGTERM' | 'SIGKILL' | 'SIGINT';

/** The exit code of a process a signal ended, which is 128 plus the signal's number. */
export function exitCodeForSignal(signal: ProcessExecutionSignal): number {
  return signal === 'SIGINT' ? 130 : signal === 'SIGKILL' ? 137 : 143;
}

export interface RuntimeProgramRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly parentPid: number;
}

export interface ResolvedRuntimeProgramRequest extends RuntimeProgramRequest {
  readonly executable: ResolvedExecutable;
}

export interface ExecutionAdmission {
  readonly pid: number;
  readonly parentPid: number;
  readonly contextId: number;
  readonly request: ResolvedRuntimeProgramRequest;
}

export interface ChildExecutionAdmission {
  readonly pid: number;
  readonly parentPid: number;
  readonly contextId: number;
}

export interface ThreadExecutionAdmission {
  readonly pid: number;
  readonly threadId: number;
  readonly parentThreadId: number;
  readonly contextId: number;
}

export type ProcessExecutionOutcome =
  | {
      readonly type: 'exit';
      readonly code: number;
      readonly signal: ProcessExecutionSignal | null;
    }
  | { readonly type: 'crash'; readonly message: string };

export type ProcessExecutionErrorCode =
  | 'CAPACITY_EXHAUSTED'
  | 'PARK_LIMIT_EXHAUSTED'
  | 'INVALID_CONTEXT'
  | 'INVALID_PARENT'
  | 'PROCESS_EXECUTION_CLOSED'
  | 'INVALID_WASM_EXECUTABLE'
  | 'WASI_EXECUTABLE_LIBRARY'
  | 'UNSUPPORTED_WASI_ABI'
  | 'UNKNOWN_WASI_IMPORT'
  | 'UNKNOWN_PROCESS'
  | ExecutableResolutionError['code'];

export class ProcessExecutionError extends Error {
  readonly code: ProcessExecutionErrorCode;

  constructor(code: ProcessExecutionErrorCode, message: string) {
    super(message);
    this.name = 'ProcessExecutionError';
    this.code = code;
  }
}

export class MimicProcessCrashError extends Error {
  readonly code = 'PROCESS_CRASH' as const;
  readonly pid: number;
  /** Why the process crashed, without the process identity the message adds. */
  readonly reason: string;
  readonly cause: unknown;

  constructor(pid: number, reason: string, cause?: unknown) {
    super(`Runtime Process ${pid} crashed: ${reason}`);
    this.name = 'MimicProcessCrashError';
    this.pid = pid;
    this.reason = reason;
    this.cause = cause;
  }
}

export interface ProcessExecutionSnapshot {
  readonly capacity: number;
  /** Live children and worker threads one Execution Context may hold, and the epoch in total. */
  readonly workerLimits: { readonly context: number; readonly epoch: number };
  readonly state: 'ready' | 'shutting-down' | 'closed';
  readonly processes: readonly ExecutionAdmission[];
  readonly children: readonly ChildExecutionAdmission[];
  readonly threads: readonly ThreadExecutionAdmission[];
}


export interface ProcessExecutionAuthority {
  readonly capacity: number;
  spawn(request: ResolvedRuntimeProgramRequest): ExecutionAdmission;
  spawnSynchronousChild(
    request: ResolvedRuntimeProgramRequest
  ): ExecutionAdmission;
  cancelSynchronousWait(
    childPid: number,
    signal: ProcessExecutionSignal
  ): boolean;
  admitChild(parentPid: number): ChildExecutionAdmission;
  completeChild(pid: number): void;
  admitThread(input: {
    readonly pid: number;
    readonly threadId: number;
    readonly parentThreadId: number;
  }): ThreadExecutionAdmission;
  completeThread(pid: number, threadId: number): void;
  replace(input: {
    readonly pid: number;
    readonly contextId: number;
    readonly request: ResolvedRuntimeProgramRequest;
  }): ExecutionAdmission;
  complete(input: {
    readonly pid: number;
    readonly contextId: number;
    readonly outcome: ProcessExecutionOutcome;
  }): void;
  signal(pid: number, signal: ProcessExecutionSignal): boolean;
  shutdown(signal?: ProcessExecutionSignal): Promise<void>;
  dispose(): void;
  snapshot(): ProcessExecutionSnapshot;
}

export interface ProcessExecutionAuthorityOptions {
  readonly capacity?: number;
  readonly hardwareConcurrency?: number;
  /** Live children plus worker threads one Execution Context may hold; `DEFAULT_CONTEXT_WORKER_LIMIT` otherwise. */
  readonly contextWorkerLimit?: number;
  /** Live children plus worker threads the epoch may hold; `DEFAULT_EPOCH_WORKER_LIMIT` otherwise. */
  readonly epochWorkerLimit?: number;
  readonly deliverSignal?: (
    pid: number,
    signal: ProcessExecutionSignal
  ) => boolean | void;
  readonly deliverCrash?: (pid: number, message: string) => void;
  readonly createExecutionContext?: (contextId: number) => ExecutionContextResource;
  readonly onProcessReleased?: (pid: number) => void;
}

export interface ExecutionContextResource {
  onCrash(listener: (reason: unknown) => void): () => void;
  terminate(signal?: ProcessExecutionSignal): void;
}

export function createProcessExecutionAuthority(
  options: ProcessExecutionAuthorityOptions = {}
): ProcessExecutionAuthority {
  const capacity = resolveExecutionCapacity(options.capacity, options.hardwareConcurrency);
  const workerLimits = resolveWorkerLimits(options.contextWorkerLimit, options.epochWorkerLimit);
  const processes = new Map<number, ExecutionAdmission>();
  const children = new Map<number, ChildExecutionAdmission>();
  /**
   * Each synchronous child, by pid, with the root of the Execution Context
   * whose caller waits for it. Any number of a context's processes may wait at
   * once; the context counts once as parked.
   */
  const synchronousParks = new Map<number, number>();
  const threads = new Map<string, ThreadExecutionAdmission>();
  const nextChildOffsetByContext = new Map<number, number>();
  const deliverSignal = options.deliverSignal ?? (() => undefined);
  const deliverCrash = options.deliverCrash ?? (() => undefined);
  const createExecutionContext =
    options.createExecutionContext ?? (() => ({ onCrash: () => () => undefined, terminate: () => undefined }));
  const contexts = new Map<
    number,
    {
      readonly resource: ExecutionContextResource;
      unsubscribeCrash: () => void;
    }
  >();
  let nextContextId = 1;
  let nextRootPid = 1;
  let state: ProcessExecutionSnapshot['state'] = 'ready';
  let resolveShutdown: (() => void) | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let prewarmedContext: { readonly id: number; readonly resource: ExecutionContextResource } | undefined = createContext();

  function createContext(): { readonly id: number; readonly resource: ExecutionContextResource } {
    const id = nextContextId++;
    const resource = createExecutionContext(id);
    const ownedContext: { readonly resource: ExecutionContextResource; unsubscribeCrash: () => void } = {
      resource,
      unsubscribeCrash: () => undefined
    };
    contexts.set(id, ownedContext);
    try {
      ownedContext.unsubscribeCrash = resource.onCrash((reason) => handleContextCrash(id, reason));
    } catch (error) {
      contexts.delete(id);
      resource.terminate();
      throw error;
    }
    return { id, resource };
  }

  const replenishPrewarm = (): void => {
    if (
      state !== 'ready' ||
      prewarmedContext ||
      runnableProcessCount() >= capacity
    ) {
      return;
    }
    try {
      prewarmedContext = createContext();
    } catch {
      // Prewarming is opportunistic. A later spawn retries context creation,
      // while the already-admitted process remains valid and observable.
    }
  };

  const terminateContext = (
    contextId: number,
    signal: ProcessExecutionSignal = 'SIGKILL'
  ): void => {
    const context = contexts.get(contextId);
    contexts.delete(contextId);
    context?.unsubscribeCrash();
    context?.resource.terminate(signal);
  };

  function releaseProcess(
    admitted: ExecutionAdmission,
    signal: ProcessExecutionSignal = 'SIGKILL'
  ): void {
    const releasedProcessIds = new Set<number>([admitted.pid]);
    synchronousParks.delete(admitted.pid);
    for (const [childPid, parkedRoot] of synchronousParks) {
      if (parkedRoot === admitted.pid) synchronousParks.delete(childPid);
    }
    processes.delete(admitted.pid);
    for (const [pid, child] of children) {
      if (child.contextId === admitted.contextId) {
        releasedProcessIds.add(pid);
        children.delete(pid);
      }
    }
    for (const [key, thread] of threads) {
      if (thread.contextId === admitted.contextId) threads.delete(key);
    }
    nextChildOffsetByContext.delete(admitted.contextId);
    let releaseFailure: unknown;
    let releaseFailed = false;
    try {
      options.onProcessReleased?.(admitted.pid);
    } catch (error) {
      releaseFailure = error;
      releaseFailed = true;
    }
    try {
      terminateContext(admitted.contextId, signal);
    } catch (error) {
      if (!releaseFailed) releaseFailure = error;
      releaseFailed = true;
    }
    for (const [pid, process] of processes) {
      if (releasedProcessIds.has(process.parentPid)) {
        processes.set(pid, { ...process, parentPid: 0 });
      }
    }
    replenishPrewarm();
    finishShutdownIfIdle();
    if (releaseFailed) throw releaseFailure;
  }

  function handleContextCrash(contextId: number, reason: unknown): void {
    const admitted = [...processes.values()].find((process) => process.contextId === contextId);
    if (admitted) {
      try {
        deliverCrash(admitted.pid, normalizeCrashMessage(reason));
      } finally {
        releaseProcess(admitted);
      }
      return;
    }
    if (prewarmedContext?.id !== contextId) return;
    terminateContext(contextId);
    prewarmedContext = undefined;
    replenishPrewarm();
  }

  const finishShutdownIfIdle = (): void => {
    if (state !== 'shutting-down' || processes.size > 0) return;
    state = 'closed';
    if (prewarmedContext) {
      terminateContext(prewarmedContext.id);
      prewarmedContext = undefined;
    }
    resolveShutdown?.();
    resolveShutdown = undefined;
  };

  const runnableProcessCount = (): number =>
    processes.size - new Set(synchronousParks.values()).size;

  /** Live process workers: every admitted child and worker thread, each a dedicated Web Worker. */
  const liveWorkerCount = (contextId?: number): number => {
    let count = 0;
    for (const child of children.values()) {
      if (contextId === undefined || child.contextId === contextId) count += 1;
    }
    for (const thread of threads.values()) {
      if (contextId === undefined || thread.contextId === contextId) count += 1;
    }
    return count;
  };

  /** Refuses the worker a child or thread would need once a context or the epoch holds its share. */
  const assertWorkerAdmissible = (contextId: number, kind: 'child process' | 'worker thread'): void => {
    if (liveWorkerCount(contextId) >= workerLimits.context) {
      throw new ProcessExecutionError(
        'CAPACITY_EXHAUSTED',
        `Execution Context ${contextId} holds its limit of ${workerLimits.context} child processes and worker threads; cannot start a ${kind}.`
      );
    }
    if (liveWorkerCount() >= workerLimits.epoch) {
      throw new ProcessExecutionError(
        'CAPACITY_EXHAUSTED',
        `The runtime holds its limit of ${workerLimits.epoch} child processes and worker threads; cannot start a ${kind}.`
      );
    }
  };

  const admitProcess = (
    request: ResolvedRuntimeProgramRequest
  ): ExecutionAdmission => {
    const pid = nextRootPid;
    nextRootPid += ROOT_PID_STRIDE;
    const context = prewarmedContext ?? createContext();
    prewarmedContext = undefined;
    const admission: ExecutionAdmission = {
      pid,
      parentPid: request.parentPid,
      contextId: context.id,
      request: copyRuntimeProgramRequest(request)
    };
    processes.set(pid, admission);
    nextChildOffsetByContext.set(context.id, 1);
    replenishPrewarm();
    return admission;
  };

  return {
    capacity,
    spawn(request) {
      if (state !== 'ready') {
        throw new ProcessExecutionError('PROCESS_EXECUTION_CLOSED', 'Process Execution is shutting down.');
      }
      if (runnableProcessCount() >= capacity) {
        throw new ProcessExecutionError('CAPACITY_EXHAUSTED', `Execution Capacity ${capacity} is exhausted.`);
      }
      if (
        request.parentPid !== 0 &&
        !processes.has(request.parentPid)
      ) {
        throw new ProcessExecutionError('INVALID_PARENT', `Runtime Process ${request.parentPid} is not active.`);
      }
      return admitProcess(request);
    },
    spawnSynchronousChild(request) {
      if (state !== 'ready') {
        throw new ProcessExecutionError(
          'PROCESS_EXECUTION_CLOSED',
          'Process Execution is shutting down.'
        );
      }
      const parentContextId = contextIdForProcess(
        request.parentPid,
        processes,
        children
      );
      const parent = parentContextId === undefined
        ? undefined
        : [...processes.values()].find(
            (candidate) => candidate.contextId === parentContextId
          );
      if (!parent) {
        throw new ProcessExecutionError(
          'INVALID_PARENT',
          `Runtime Process ${request.parentPid} is not active.`
        );
      }
      if (synchronousParks.size >= 8) {
        throw new ProcessExecutionError(
          'PARK_LIMIT_EXHAUSTED',
          'Synchronous Child Process Execution cannot park more than eight callers.'
        );
      }
      const admission = admitProcess(request);
      synchronousParks.set(admission.pid, parent.pid);
      return admission;
    },
    cancelSynchronousWait(childPid, signal) {
      const parkedRoot = synchronousParks.get(childPid);
      if (parkedRoot === undefined) return false;
      const parent = processes.get(parkedRoot);
      if (!parent) {
        synchronousParks.delete(childPid);
        return false;
      }
      releaseProcess(parent, signal);
      return true;
    },
    admitChild(parentPid) {
      const contextId = contextIdForProcess(parentPid, processes, children);
      if (contextId === undefined) {
        throw new ProcessExecutionError(
          'INVALID_PARENT',
          `Runtime Process ${parentPid} is not active.`
        );
      }
      const root = [...processes.values()].find(
        (process) => process.contextId === contextId
      );
      if (!root) {
        throw new ProcessExecutionError(
          'INVALID_CONTEXT',
          `Execution Context ${contextId} has no admitted root process.`
        );
      }
      assertWorkerAdmissible(contextId, 'child process');
      const offset = nextChildOffsetByContext.get(contextId) ?? 1;
      if (offset >= ROOT_PID_STRIDE) {
        throw new ProcessExecutionError(
          'CAPACITY_EXHAUSTED',
          `Execution Context ${contextId} exhausted its child PID range.`
        );
      }
      nextChildOffsetByContext.set(contextId, offset + 1);
      const child = {
        pid: root.pid + offset,
        parentPid,
        contextId
      };
      children.set(child.pid, child);
      return child;
    },
    completeChild(pid) {
      if (!children.delete(pid)) {
        throw new ProcessExecutionError(
          'UNKNOWN_PROCESS',
          `Runtime child process ${pid} is not active.`
        );
      }
      for (const [key, thread] of threads) {
        if (thread.pid === pid) threads.delete(key);
      }
    },
    admitThread(input) {
      const contextId = contextIdForProcess(input.pid, processes, children);
      if (contextId === undefined) {
        throw new ProcessExecutionError(
          'UNKNOWN_PROCESS',
          `Runtime Process ${input.pid} is not active.`
        );
      }
      if (
        input.parentThreadId !== 0 &&
        !threads.has(threadKey(input.pid, input.parentThreadId))
      ) {
        throw new ProcessExecutionError(
          'INVALID_PARENT',
          `Parent worker thread ${input.pid}:${input.parentThreadId} is not active.`
        );
      }
      if (threads.has(threadKey(input.pid, input.threadId))) {
        throw new ProcessExecutionError(
          'INVALID_CONTEXT',
          `Worker thread ${input.pid}:${input.threadId} is already active.`
        );
      }
      assertWorkerAdmissible(contextId, 'worker thread');
      const thread = { ...input, contextId };
      threads.set(threadKey(input.pid, input.threadId), thread);
      return thread;
    },
    completeThread(pid, threadId) {
      if (threads.delete(threadKey(pid, threadId))) return;
      if (contextIdForProcess(pid, processes, children) === undefined) return;
      throw new ProcessExecutionError(
        'UNKNOWN_PROCESS',
        `Worker thread ${pid}:${threadId} is not active.`
      );
    },
    replace(input) {
      const admitted = processes.get(input.pid);
      const child = children.get(input.pid);
      const current = admitted ?? child;
      if (!current) {
        throw new ProcessExecutionError(
          'UNKNOWN_PROCESS',
          `Runtime Process ${input.pid} is not active.`
        );
      }
      if (current.contextId !== input.contextId) {
        throw new ProcessExecutionError(
          'INVALID_CONTEXT',
          `Execution Context ${input.contextId} does not own Runtime Process ${input.pid}.`
        );
      }
      if (input.request.parentPid !== current.parentPid) {
        throw new ProcessExecutionError(
          'INVALID_PARENT',
          `Runtime Process ${input.pid} cannot change parent during replacement.`
        );
      }
      const replacement = {
        ...current,
        request: copyRuntimeProgramRequest(input.request)
      };
      if (admitted) processes.set(input.pid, replacement);
      return replacement;
    },
    complete(input) {
      const admitted = processes.get(input.pid);
      if (!admitted) {
        throw new ProcessExecutionError('UNKNOWN_PROCESS', `Runtime Process ${input.pid} is not active.`);
      }
      if (admitted.contextId !== input.contextId) {
        throw new ProcessExecutionError(
          'INVALID_CONTEXT',
          `Execution Context ${input.contextId} does not own Runtime Process ${input.pid}.`
        );
      }
      releaseProcess(admitted);
    },
    signal(pid, signal) {
      const admitted = processes.get(pid);
      if (!admitted) return false;
      const releaseAfterSignal = deliverSignal(pid, signal);
      if (signal === 'SIGKILL' && releaseAfterSignal !== false) {
        releaseProcess(admitted);
      }
      return true;
    },
    shutdown(signal = 'SIGKILL') {
      if (shutdownPromise) return shutdownPromise;
      state = 'shutting-down';
      shutdownPromise = new Promise<void>((resolve) => {
        resolveShutdown = resolve;
      });
      if (prewarmedContext) {
        terminateContext(prewarmedContext.id);
        prewarmedContext = undefined;
      }
      for (const admitted of [...processes.values()]) {
        const releaseAfterSignal = deliverSignal(admitted.pid, signal);
        if (signal === 'SIGKILL' && releaseAfterSignal !== false) {
          releaseProcess(admitted);
        }
      }
      finishShutdownIfIdle();
      return shutdownPromise;
    },
    dispose() {
      if (state === 'closed') return;
      state = 'closed';
      let disposeFailure: unknown;
      let disposeFailed = false;
      if (prewarmedContext) {
        try {
          terminateContext(prewarmedContext.id);
        } catch (error) {
          disposeFailure = error;
          disposeFailed = true;
        }
        prewarmedContext = undefined;
      }
      for (const process of processes.values()) {
        try {
          options.onProcessReleased?.(process.pid);
        } catch (error) {
          if (!disposeFailed) disposeFailure = error;
          disposeFailed = true;
        }
        try {
          terminateContext(process.contextId);
        } catch (error) {
          if (!disposeFailed) disposeFailure = error;
          disposeFailed = true;
        }
      }
      processes.clear();
      children.clear();
      synchronousParks.clear();
      threads.clear();
      nextChildOffsetByContext.clear();
      resolveShutdown?.();
      resolveShutdown = undefined;
      if (disposeFailed) throw disposeFailure;
    },
    snapshot() {
      return {
        capacity,
        workerLimits,
        state,
        processes: [...processes.values()],
        children: [...children.values()],
        threads: [...threads.values()]
      };
    }
  };
}

function resolveExecutionCapacity(explicit: number | undefined, hardwareConcurrency: number | undefined): number {
  if (explicit !== undefined) {
    if (!Number.isInteger(explicit) || explicit < 1 || explicit > 8) {
      throw new RangeError('Execution Capacity must be an integer between 1 and 8.');
    }
    return explicit;
  }
  const available = normalizedHardwareConcurrency(hardwareConcurrency);
  return Math.min(8, Math.max(1, available - 1));
}

function resolveWorkerLimits(
  contextLimit: number | undefined,
  epochLimit: number | undefined
): { readonly context: number; readonly epoch: number } {
  const context = contextLimit ?? DEFAULT_CONTEXT_WORKER_LIMIT;
  const epoch = epochLimit ?? DEFAULT_EPOCH_WORKER_LIMIT;
  for (const [name, limit] of [['context', context], ['epoch', epoch]] as const) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`The ${name} worker limit must be a positive integer.`);
    }
  }
  if (epoch < context) {
    throw new RangeError('The epoch worker limit cannot be below the context worker limit.');
  }
  return { context, epoch };
}

function normalizedHardwareConcurrency(hardwareConcurrency: number | undefined): number {
  return Number.isFinite(hardwareConcurrency)
    ? Math.floor(hardwareConcurrency ?? 2)
    : 2;
}

function contextIdForProcess(
  pid: number,
  processes: ReadonlyMap<number, ExecutionAdmission>,
  children: ReadonlyMap<number, ChildExecutionAdmission>
): number | undefined {
  return processes.get(pid)?.contextId ?? children.get(pid)?.contextId;
}

function threadKey(pid: number, threadId: number): string {
  return `${pid}:${threadId}`;
}

function copyRuntimeProgramRequest(request: ResolvedRuntimeProgramRequest): ResolvedRuntimeProgramRequest {
  return {
    command: request.command,
    args: [...request.args],
    cwd: request.cwd,
    env: { ...request.env },
    parentPid: request.parentPid,
    executable: Object.freeze({
      programId: request.executable.programId,
      argv: Object.freeze([...request.executable.argv]),
      ...(request.executable.inlineEntry
        ? {
            inlineEntry: Object.freeze({
              source: request.executable.inlineEntry.source,
              applicationArgs: Object.freeze([...request.executable.inlineEntry.applicationArgs]),
              execArgv: Object.freeze([...request.executable.inlineEntry.execArgv]),
              preloadArgv: Object.freeze([...request.executable.inlineEntry.preloadArgv]),
              ...(request.executable.inlineEntry.print ? { print: true as const } : {}),
              ...(request.executable.inlineEntry.inputType
                ? { inputType: request.executable.inlineEntry.inputType }
                : {})
            })
          }
        : {}),
      provenance: Object.freeze({
        kind: request.executable.provenance.kind,
        command: request.executable.provenance.command,
        paths: Object.freeze([...request.executable.provenance.paths])
      })
    })
  };
}

function normalizeCrashMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
