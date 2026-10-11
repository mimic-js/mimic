import {
  MimicProcessCrashError,
  ProcessExecutionError,
  createProcessExecutionAuthority,
  exitCodeForSignal,
  type ExecutionAdmission,
  type ProcessExecutionAuthority,
  type ProcessExecutionOutcome,
  type ProcessExecutionSignal,
  type ResolvedRuntimeProgramRequest,
  type RuntimeProgramRequest
} from './process-execution';
import {
  resolveExecutable,
  type ExecutableFileSystemPort,
  type ExecutableResolutionOptions,
  type ResolvedExecutable
} from './executable-resolution';
import {
  createVirtualProcess,
  type ProcessInput,
  type ProcessWriter,
  type RuntimeProgramProcess
} from './virtual-process';
import type {
  RuntimeExecutionContext,
  RuntimeExecutionWorker
} from './runtime-programs';

export type RuntimeProgramAdmission = ExecutionAdmission;
export type RuntimeProgramRunner = (
  admission: RuntimeProgramAdmission,
  stdout: ProcessWriter,
  stdin: ProcessInput,
  stderr: ProcessWriter,
  executionContext: RuntimeExecutionContext
) => Promise<number | void> | number | void;
export type RuntimeProgramKillHandler = (
  admission: RuntimeProgramAdmission,
  signal: ProcessExecutionSignal,
  writer: ProcessWriter
) => void;

/** Executable resolution without the filesystem view, which the options supply. */
export type RuntimeProgramResolution = Omit<ExecutableResolutionOptions, 'fileSystem'>;

export interface ProcessExecutionOptions {
  /** The one Runtime Program registry and interpreter policy every spawn resolves against. */
  readonly resolution: RuntimeProgramResolution;
  /** The filesystem view every spawn resolves its command in. */
  readonly fileSystem: ExecutableFileSystemPort;
  readonly capacity?: number;
  readonly hardwareConcurrency?: number;
  /** Live children plus worker threads one Execution Context may hold. */
  readonly contextWorkerLimit?: number;
  /** Live children plus worker threads the epoch may hold. */
  readonly epochWorkerLimit?: number;
}

/**
 * Runs Runtime Programs as Runtime Processes: resolves each command once,
 * admits it through the Process Execution authority, and owns the Execution
 * Context, standard streams, signals, and completion of every process.
 */
export interface ProcessExecution {
  spawn(
    request: RuntimeProgramRequest,
    runner: RuntimeProgramRunner,
    onKill?: RuntimeProgramKillHandler
  ): Promise<RuntimeProgramProcess>;
  /** Runs a child inside its parent's Execution Context. */
  spawnChild(
    request: RuntimeProgramRequest,
    runner: RuntimeProgramRunner,
    onKill?: RuntimeProgramKillHandler
  ): Promise<RuntimeProgramProcess>;
  /** Runs a child in a new Execution Context while its parent is parked. */
  spawnSynchronousChild(
    request: RuntimeProgramRequest,
    runner: RuntimeProgramRunner,
    onKill?: RuntimeProgramKillHandler
  ): Promise<RuntimeProgramProcess>;
  cancelSynchronousWait(childPid: number, signal: ProcessExecutionSignal): boolean;
  replace(pid: number, request: RuntimeProgramRequest): Promise<RuntimeProgramAdmission>;
  shutdown(signal?: ProcessExecutionSignal): Promise<void>;
  dispose(): void;
}

type ProcessProjection = {
  /** The process as Process Execution runs it, signalled without a round trip through the authority. */
  readonly local: RuntimeProgramProcess;
  readonly root: boolean;
  admission: RuntimeProgramAdmission;
  ownerReleased: boolean;
  /** A delivered SIGKILL: the process reports its exit code once its program settles. */
  killed: boolean;
};

type HostedExecutionContext = RuntimeExecutionContext & {
  readonly released: boolean;
  forceTerminate(signal: ProcessExecutionSignal): void;
  close(): void;
};

export function createProcessExecution(
  options: ProcessExecutionOptions
): ProcessExecution {
  const projections = new Map<number, ProcessProjection>();
  const executionContexts = new Map<number, HostedExecutionContext>();
  const authority: ProcessExecutionAuthority = createProcessExecutionAuthority({
    capacity: options.capacity,
    hardwareConcurrency: options.hardwareConcurrency,
    contextWorkerLimit: options.contextWorkerLimit,
    epochWorkerLimit: options.epochWorkerLimit,
    onProcessReleased(pid) {
      const projection = projections.get(pid);
      if (projection) projection.ownerReleased = true;
    },
    deliverSignal(pid, signal) {
      const projection = projections.get(pid);
      if (!projection) return;
      projection.local.kill(signal);
      if (signal !== 'SIGKILL') return;
      // The program settles before the authority releases its process, so a
      // forced exit never outlives the cleanup the program owes.
      projection.killed = true;
      return false;
    },
    deliverCrash(pid, message) {
      const projection = projections.get(pid);
      if (!projection) return;
      projection.ownerReleased = true;
      projection.local.crash(new MimicProcessCrashError(pid, message));
    },
    createExecutionContext(contextId) {
      const context = createHostedExecutionContext(contextId, () => authority);
      executionContexts.set(contextId, context);
      return {
        onCrash: () => () => undefined,
        terminate(signal = 'SIGKILL') {
          executionContexts.delete(contextId);
          context.forceTerminate(signal);
        }
      };
    }
  });

  const resolve = async (request: RuntimeProgramRequest): Promise<ResolvedExecutable> => {
    const resolution = await resolveExecutable(request, {
      ...options.resolution,
      fileSystem: options.fileSystem
    });
    if (!resolution.ok) {
      throw new ProcessExecutionError(
        resolution.error.code,
        resolution.error.message
      );
    }
    return resolution.value;
  };

  const requireContext = (contextId: number): HostedExecutionContext => {
    const context = executionContexts.get(contextId);
    if (!context) {
      throw new ProcessExecutionError(
        'INVALID_CONTEXT',
        `Execution Context ${contextId} is not active.`
      );
    }
    return context;
  };

  const spawnRoot = async (
    request: RuntimeProgramRequest,
    runner: RuntimeProgramRunner,
    onKill: RuntimeProgramKillHandler | undefined,
    synchronous: boolean
  ): Promise<RuntimeProgramProcess> => {
    const resolved: ResolvedRuntimeProgramRequest = {
      ...request,
      executable: await resolve(request)
    };
    const admission = synchronous
      ? authority.spawnSynchronousChild(resolved)
      : authority.spawn(resolved);
    const executionContext = requireContext(admission.contextId);
    const local = createVirtualProcess(
      admission.pid,
      (stdout, stdin, stderr) =>
        runner(admission, stdout, stdin, stderr, executionContext),
      onKill
        ? (signal, writer) => onKill(projection.admission, signal, writer)
        : undefined
    );
    const projection: ProcessProjection = {
      local,
      root: true,
      admission,
      ownerReleased: false,
      killed: false
    };
    projections.set(admission.pid, projection);
    const complete = (outcome: ProcessExecutionOutcome): void => {
      if (projection.ownerReleased) return;
      authority.complete({
        pid: admission.pid,
        contextId: admission.contextId,
        outcome
      });
    };
    let termination: { readonly code: number; readonly signal: ProcessExecutionSignal | null } | undefined;
    const exit = local.exit
      .then(
        async (code) => {
          const observed = await local.termination;
          termination = projection.killed
            ? { code: exitCodeForSignal('SIGKILL'), signal: 'SIGKILL' }
            : { code, signal: observed?.signal ?? null };
          complete({ type: 'exit', ...termination });
          return termination.code;
        },
        (error: unknown) => {
          const crash = toProcessCrashError(admission.pid, error);
          complete({ type: 'crash', message: crash.reason });
          throw crash;
        }
      )
      .finally(() => {
        projections.delete(admission.pid);
        executionContext.close();
      });
    return {
      pid: admission.pid,
      stdin: local.stdin,
      stdout: local.stdout,
      stderr: local.stderr,
      input: local.input,
      output: local.output,
      exit,
      termination: exit.then(
        () => termination,
        () => undefined
      ),
      kill(signal = 'SIGTERM') {
        authority.signal(admission.pid, signal);
      },
      crash(error) {
        local.crash(toProcessCrashError(admission.pid, error));
      }
    };
  };

  const spawnChild = async (
    request: RuntimeProgramRequest,
    runner: RuntimeProgramRunner,
    onKill: RuntimeProgramKillHandler | undefined
  ): Promise<RuntimeProgramProcess> => {
    const parent = projections.get(request.parentPid);
    if (!parent || parent.ownerReleased) {
      throw new ProcessExecutionError(
        'INVALID_PARENT',
        `Runtime Process ${request.parentPid} is not active.`
      );
    }
    const executionContext = requireContext(parent.admission.contextId);
    const executable = await resolve(request);
    const admission: RuntimeProgramAdmission = {
      ...authority.admitChild(request.parentPid),
      request: { ...request, executable }
    };
    const local = createVirtualProcess(
      admission.pid,
      (stdout, stdin, stderr) =>
        runner(admission, stdout, stdin, stderr, executionContext),
      onKill
        ? (signal, writer) => onKill(projection.admission, signal, writer)
        : undefined
    );
    const projection: ProcessProjection = {
      local,
      root: false,
      admission,
      ownerReleased: false,
      killed: false
    };
    projections.set(admission.pid, projection);
    // A child released with its Execution Context needs no completion.
    const complete = (): void => {
      if (!executionContext.released) authority.completeChild(admission.pid);
    };
    const exit = local.exit
      .then(
        (code) => {
          complete();
          return code;
        },
        (error: unknown) => {
          complete();
          throw toProcessCrashError(admission.pid, error);
        }
      )
      .finally(() => {
        projections.delete(admission.pid);
      });
    return {
      pid: local.pid,
      stdin: local.stdin,
      stdout: local.stdout,
      stderr: local.stderr,
      input: local.input,
      output: local.output,
      exit,
      termination: local.termination,
      kill(signal = 'SIGTERM') {
        local.kill(signal);
      },
      crash(error) {
        local.crash(toProcessCrashError(admission.pid, error));
      }
    };
  };

  return {
    spawn: (request, runner, onKill) => spawnRoot(request, runner, onKill, false),
    spawnSynchronousChild: (request, runner, onKill) =>
      spawnRoot(request, runner, onKill, true),
    spawnChild,
    cancelSynchronousWait: (childPid, signal) =>
      authority.cancelSynchronousWait(childPid, signal),
    async replace(pid, request) {
      const projection = projections.get(pid);
      if (!projection || projection.ownerReleased) {
        throw new ProcessExecutionError(
          'UNKNOWN_PROCESS',
          `Runtime Process ${pid} is not active.`
        );
      }
      const replacement = authority.replace({
        pid,
        contextId: projection.admission.contextId,
        request: { ...request, executable: await resolve(request) }
      });
      projection.admission = replacement;
      return replacement;
    },
    shutdown: (signal) => authority.shutdown(signal),
    dispose() {
      authority.dispose();
      for (const context of executionContexts.values()) context.close();
      executionContexts.clear();
    }
  };
}

function createHostedExecutionContext(
  contextId: number,
  authority: () => ProcessExecutionAuthority
): HostedExecutionContext {
  const workers = new Set<RuntimeExecutionWorker>();
  let closed = false;
  let released = false;
  let resolveForcedTermination!: (signal: ProcessExecutionSignal) => void;
  const forcedTermination = new Promise<ProcessExecutionSignal>((resolve) => {
    resolveForcedTermination = resolve;
  });
  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const worker of workers) worker.terminate();
    workers.clear();
  };
  return {
    id: contextId,
    forcedTermination,
    get released() {
      return released;
    },
    openWorker(createWorker) {
      if (closed) {
        throw new ProcessExecutionError(
          'PROCESS_EXECUTION_CLOSED',
          `Execution Context ${contextId} is closed.`
        );
      }
      const worker = createWorker();
      workers.add(worker);
      return worker;
    },
    async admitThread(identity, parentThreadId) {
      authority().admitThread({
        pid: identity.pid,
        threadId: identity.threadId,
        parentThreadId
      });
    },
    async completeThread(identity) {
      authority().completeThread(identity.pid, identity.threadId);
    },
    forceTerminate(signal) {
      released = true;
      if (closed) return;
      resolveForcedTermination(signal);
      close();
    },
    close
  };
}

function toProcessCrashError(
  pid: number,
  error: unknown
): MimicProcessCrashError {
  if (error instanceof MimicProcessCrashError && error.pid === pid) {
    return error;
  }
  const normalized = error instanceof Error ? error : new Error(String(error));
  return new MimicProcessCrashError(pid, normalized.message, error);
}
