import {
  createProcessExecution,
  createRuntimeProgramTable,
  executeSynchronousChildProcess,
  exitCodeForSignal,
  serveAsynchronousChildProcesses,
  serveProcessInput,
  type ExecutableFileSystemPort,
  type ProcessExecution,
  type ProcessExecutionChildIpc,
  type ProcessExecutionInheritedInput,
  type ProcessExecutionSignal,
  type ProcessExecutionSynchronousChildRequest,
  type ProcessExecutionSynchronousChildResult,
  type ProcessInput,
  type ProcessWriter,
  type ResolvedExecutable,
  type RuntimeExecutionContext,
  type RuntimeProgram,
  type RuntimeProgramAdmission,
  type RuntimeProgramProcess,
  type RuntimeProgramRequest,
  type ServedProcessOutput,
  type ThreadIdentity
} from '../process-execution';
import {
  isWorkerFailure,
  markWorkerFailure,
  type NodeProcessHostApi,
  type NodeProcessSynchronousApi,
  type NodeProcessWorkerApi,
  type NodeWorkerThreadStart
} from './process-worker-protocol';
import {
  createWorkerThreadPortRelay,
  createWorkerThreadSharedMemoryPool,
  NODE_PROGRAM_COMMANDS,
  NODE_PROGRAM_ID,
  PROCESS_CHANNEL_WORDS,
  type WorkerThreadPortRelay,
  type WorkerThreadSharedMemoryPool
} from '../node-compatibility';
import { asyncCoreUtilityFileSystem } from './core-utility-file-system';
import type { PublishedEndpointProtocol } from '../published-endpoint';
import {
  serveVirtualNetwork,
  type VirtualAddress,
  type VirtualNetworkAuthority
} from '../virtual-network';
import {
  connectRpc,
  createSynchronousChannel,
  normalizeError,
  reviveError,
  serveSynchronousRpc,
  synchronousChannelWords,
  type Implementation
} from '../worker-transport';
import type {
  AsyncVirtualFileSystemClient,
  VirtualFileSystemApi
} from '../virtual-file-system';
import {
  createExecutionContextWorker,
  createWasiExecutionWorker,
  declaredRuntimeAssets
} from './runtime-assets';
import { createWasiRuntimeProgram } from './wasi-runtime-program';
import {
  inspectWasiPreview1Executable,
  WASI_PREVIEW1_RUNTIME_PROGRAM_ID
} from '../wasi-execution';

/** Publishes the listeners of one Runtime Process; the endpoint port reaches its worker directly. */
export type ProcessPublishedEndpointOwner = {
  /** Resolves to the identity of this publication, which {@link abort} takes. */
  register(
    port: number,
    protocol: PublishedEndpointProtocol,
    address: VirtualAddress,
    endpoint: MessagePort
  ): string;
  /**
   * The program closed its listener: exchanges it accepted still complete.
   * Resolves once the page no longer publishes it.
   */
  close(port: number): Promise<void>;
  /** The worker that served these publications is gone: their exchanges fail. */
  abort(listenerIds: readonly string[]): void;
};

export type RuntimeProgramAdapterContext = {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly executable?: ResolvedExecutable;
  readonly executionContext?: RuntimeExecutionContext;
  readonly pid?: number;
  readonly ppid?: number;
  readonly signal?: Promise<ProcessExecutionSignal>;
  /** Subscribes to every signal sent to the process, the first included; returns the unsubscribe. */
  readonly onSignal?: (listener: (signal: ProcessExecutionSignal) => void) => () => void;
  /** Set on the Runtime Process of a Worker Thread, which shares its process's relay and memory. */
  readonly workerThread?: HostedWorkerThread;
  /**
   * Set on a process its parent forked: the child's end of the IPC channel,
   * and the relay of the parent that hosts the pair, which the child joins.
   */
  readonly ipc?: ProcessIpcChannel;
  readonly fs: AsyncVirtualFileSystemClient;
  readonly writer: ProcessWriter;
  readonly errorWriter?: ProcessWriter;
  readonly input?: ProcessInput;
  readonly emitter: {
    emitError?(error: Error): void;
  };
  readonly virtualNetwork?: VirtualNetworkAuthority;
  readonly publishedEndpoints?: ProcessPublishedEndpointOwner;
};

/** The `worker_threads` state one JavaScript Runtime Process shares with its threads. */
type ProcessWorkerThreads = {
  readonly relay: WorkerThreadPortRelay;
  readonly sharedMemoryPool: WorkerThreadSharedMemoryPool;
};

type ProcessIpcChannel = {
  readonly relay: WorkerThreadPortRelay;
  readonly end: ProcessExecutionChildIpc;
};

type HostedWorkerThread = ProcessWorkerThreads & {
  readonly start: NodeWorkerThreadStart;
};

export interface RuntimeProgramHost {
  /** Spawns a root Runtime Process; `output` receives its stdout and stderr in write order. */
  spawn(
    request: RuntimeProgramRequest,
    output?: ServedProcessOutput
  ): Promise<RuntimeProgramProcess>;
  shutdown(signal: ProcessExecutionSignal): Promise<void>;
  dispose(): void;
}

export function createRuntimeProgramHost(options: {
  /** The Virtual File System, as Runtime Programs use it. */
  readonly fileSystem: AsyncVirtualFileSystemClient;
  /**
   * The Virtual File System operations a process worker calls directly, as
   * one process bound to its own synchronous mailbox: releasing it closes
   * what that process left open.
   */
  readonly fileSystemForProcess: (binding: { readonly mailboxContextId: string }) => {
    readonly api: VirtualFileSystemApi;
    release(): void;
  };
  /** The view Process Execution resolves commands in. */
  readonly executableFileSystem: ExecutableFileSystemPort;
  readonly network: VirtualNetworkAuthority;
  readonly publishedEndpoints: {
    forOwner(ownerId: string): ProcessPublishedEndpointOwner;
  };
  readonly onBackgroundFailure: (error: Error) => void;
  /** A package manager changed the packages installed in `cwd`. */
  readonly onPackagesInstalled?: (cwd: string) => void;
  readonly capacity?: number;
  readonly hardwareConcurrency?: number;
  /** Replaces the registered Runtime Programs; a test runs its own programs this way. */
  readonly programs?: readonly RuntimeProgram<RuntimeProgramAdapterContext>[];
}): RuntimeProgramHost {
  const processWorkers = createWarmWorkerSupply(createExecutionContextWorker);
  const { registry, resolution } = createRuntimeProgramTable<RuntimeProgramAdapterContext>({
    programs: {
      javaScript: { id: NODE_PROGRAM_ID, commands: NODE_PROGRAM_COMMANDS },
      wasi: { id: WASI_PREVIEW1_RUNTIME_PROGRAM_ID, inspect: inspectWasiPreview1Executable }
    },
    implementations: [
      createWasiRuntimeProgram({
        createWorker: createWasiExecutionWorker
      }),
      new JavaScriptRuntimeProgram(
        options.fileSystemForProcess,
        options.onBackgroundFailure,
        (request, ipc) => spawnWith(processes.spawnChild, request, undefined, ipc),
        (request) => spawnWith(processes.spawnSynchronousChild, request),
        async (childPid, signal) =>
          processes.cancelSynchronousWait(childPid, signal),
        () => processWorkers.take()
      )
    ],
    replacement: options.programs,
    files: (context) => asyncCoreUtilityFileSystem(context.fs),
    fileSystem: options.fileSystem,
    spawnChild: (request) => spawnChild(request),
    replaceProgram: (request, context) => replaceProgram(request, context),
    onPackagesInstalled: options.onPackagesInstalled
  });
  const processes: ProcessExecution = createProcessExecution({
    resolution,
    fileSystem: options.executableFileSystem,
    capacity: options.capacity,
    hardwareConcurrency: options.hardwareConcurrency
  });
  const runRegisteredProgram = (
    executable: ResolvedExecutable,
    context: RuntimeProgramAdapterContext
  ): Promise<number | void> | number | void => {
    const program = registry.resolve(executable.programId);
    if (!program) {
      context.writer.write(
        `MimicUnsupportedExecutableError: Cannot execute "${executable.programId}".\n` +
          'This runtime currently supports JS entrypoints and registered browser commands only.\n'
      );
      return 127;
    }
    return program.run([...executable.argv], { ...context, executable });
  };

  function spawnChild(request: RuntimeProgramRequest): Promise<RuntimeProgramProcess> {
    return spawnWith(processes.spawnChild, request);
  }

  async function spawnWith(
    spawnProcess: ProcessExecution['spawn'],
    request: RuntimeProgramRequest,
    output?: ServedProcessOutput,
    ipc?: ProcessIpcChannel
  ): Promise<RuntimeProgramProcess> {
    return spawnProcess(
      request,
      async (
        admission,
        stdout,
        stdin,
        stderr,
        executionContext
      ) => {
        const writer = output
          ? { ...stdout, write: (chunk: string | Uint8Array) => output.write('stdout', chunk) }
          : stdout;
        const errorWriter = output
          ? { ...stderr, write: (chunk: string | Uint8Array) => output.write('stderr', chunk) }
          : stderr;
        const context: RuntimeProgramAdapterContext = {
          cwd: admission.request.cwd,
          env: { ...admission.request.env },
          pid: admission.pid,
          ppid: admission.parentPid,
          executionContext,
          signal: stdout.waitForKill(),
          ...(stdout.onSignal ? { onSignal: stdout.onSignal } : {}),
          fs: options.fileSystem,
          writer,
          errorWriter,
          input: stdin,
          emitter: { emitError: options.onBackgroundFailure },
          virtualNetwork: options.network,
          publishedEndpoints: options.publishedEndpoints.forOwner(
            `process-${admission.pid}`
          ),
          ...(ipc ? { ipc } : {})
        };
        try {
          return await runRegisteredProgram(
            admission.request.executable,
            context
          );
        } catch (error) {
          const normalized =
            error instanceof Error ? error : new Error(String(error));
          if (isWorkerFailure(normalized)) throw normalized;
          await errorWriter.write(
            `${normalized.stack ?? `${normalized.name}: ${normalized.message}`}\n`
          );
          return 1;
        }
      },
      (admission, signal, writer) => {
        if (
          registry.resolve(admission.request.executable.programId)
            ?.handlesSignals !== true
        ) {
          writer.close(exitCodeForSignal(signal));
        }
      }
    );
  }

  /** Replaces the calling Runtime Process with another program, as `exec` does. */
  async function replaceProgram(
    request: Omit<RuntimeProgramRequest, 'parentPid'>,
    context: RuntimeProgramAdapterContext
  ): Promise<number> {
    const pid = context.pid;
    if (pid === undefined) {
      throw new Error('Replacing a program requires an admitted Runtime Process.');
    }
    const admission = await processes.replace(pid, {
      ...request,
      parentPid: context.ppid ?? 0
    });
    const executable = admission.request.executable;
    const result = await runRegisteredProgram(executable, {
      ...context,
      cwd: request.cwd,
      env: { ...request.env },
      executable
    });
    return typeof result === 'number' ? result : 0;
  }

  return {
    spawn: (request, output) => spawnWith(processes.spawn, request, output),
    shutdown: (signal) => processes.shutdown(signal),
    dispose() {
      processWorkers.dispose();
      processes.dispose();
    }
  };
}

/**
 * One JavaScript process worker ahead of demand. A `Worker` fetches and
 * compiles its script while the process before it runs, so a spawn takes a
 * worker that is already loading instead of starting one, and the next spare
 * is created as soon as one is taken. A spare that fails to load is dropped:
 * the spawn that would have taken it starts a worker of its own.
 */
function createWarmWorkerSupply(create: () => Worker): {
  take(): Worker;
  dispose(): void;
} {
  let spare: Worker | undefined;
  let disposed = false;
  const warm = (): void => {
    if (disposed || spare || typeof Worker === 'undefined') return;
    const worker = create();
    worker.addEventListener(
      'error',
      (event) => {
        if (spare !== worker) return;
        // Unhandled, the event would reach this worker's own scope as an epoch failure.
        event.preventDefault();
        spare = undefined;
        worker.terminate();
      },
      { once: true }
    );
    spare = worker;
  };
  warm();
  return {
    take() {
      const worker = spare ?? create();
      spare = undefined;
      warm();
      return worker;
    },
    dispose() {
      disposed = true;
      spare?.terminate();
      spare = undefined;
    }
  };
}

export class JavaScriptRuntimeProgram
  implements RuntimeProgram<RuntimeProgramAdapterContext>
{
  readonly id = NODE_PROGRAM_ID;
  readonly commands = NODE_PROGRAM_COMMANDS;
  readonly handlesSignals = true;

  constructor(
    private readonly fileSystemForProcess: (binding: { readonly mailboxContextId: string }) => {
      readonly api: VirtualFileSystemApi;
      release(): void;
    },
    private readonly onBackgroundFailure: (error: Error) => void,
    private readonly spawnAsynchronousChild: (
      request: RuntimeProgramRequest,
      ipc?: ProcessIpcChannel
    ) => Promise<RuntimeProgramProcess>,
    private readonly spawnSynchronousChild: (
      request: RuntimeProgramRequest
    ) => Promise<RuntimeProgramProcess>,
    private readonly cancelSynchronousWait: (
      childPid: number,
      signal: ProcessExecutionSignal
    ) => Promise<boolean>,
    private readonly createWorker: () => Worker = createExecutionContextWorker
  ) {}

  async run(
    args: readonly string[],
    context: RuntimeProgramAdapterContext
  ): Promise<number> {
    const inlineEntry = context.executable?.inlineEntry;
    if (typeof Worker === 'undefined') {
      throw new Error(
        'JavaScript Runtime Program requires the package-owned browser Worker adapter.'
      );
    }
    if (!context.virtualNetwork) {
      throw new Error(
        'JavaScript Runtime Program requires a Virtual Network authority.'
      );
    }
    if (!context.executionContext) {
      throw new Error(
        'JavaScript Runtime Program requires an admitted Execution Context.'
      );
    }
    const executionContext = context.executionContext;
    const virtualNetwork = context.virtualNetwork;
    // The worker reaches the Virtual File System and Virtual Network
    // authorities of this context directly, over its own port.
    const worker = executionContext.openWorker(this.createWorker);
    const registeredPorts = new Set<number>();
    const publishedListeners: string[] = [];
    const unpublishing: Promise<void>[] = [];
    const unpublish = (port: number): void => {
      registeredPorts.delete(port);
      const closing = context.publishedEndpoints?.close(port);
      if (closing) unpublishing.push(closing);
    };
    // A Worker Thread's process shares the relay and memory of the process that
    // started it; a forked process joins the relay that hosts its IPC channel.
    const threads: ProcessWorkerThreads = context.workerThread ?? {
      relay: context.ipc?.relay ?? createWorkerThreadPortRelay(),
      sharedMemoryPool: createWorkerThreadSharedMemoryPool()
    };
    const identity: ThreadIdentity = {
      pid: context.pid ?? 1,
      threadId: context.workerThread?.start.threadId ?? 0
    };
    const threadName = `${identity.pid}:${identity.threadId}`;
    // The worker names its mailbox the same way; the host binds it to this process either way.
    const mailboxContextId =
      `execution-context:${executionContext.id}:process:${identity.pid}` +
      (context.workerThread ? `:thread:${identity.threadId}` : '');
    const runningThreads = new Map<string, (signal: ProcessExecutionSignal) => void>();
    let settled = false;
    let forceTerminated = false;
    let stopRequested = false;
    let resolveProcessIo!: () => void;
    const processIoReady = new Promise<void>((resolve) => {
      resolveProcessIo = resolve;
    });
    let settleResult!: (
      outcome: { readonly code: number } | { readonly error: Error }
    ) => void;
    const result = new Promise<number>((resolve, reject) => {
      settleResult = (outcome) => {
        if (settled) return;
        settled = true;
        if ('error' in outcome) reject(outcome.error);
        else resolve(outcome.code);
      };
    });
    const fail = (error: unknown): void => settleResult({ error: normalizeError(error) });

    const local = {} as Implementation<NodeProcessHostApi>;
    const connection = connectRpc<NodeProcessWorkerApi>(worker, local);
    const workerApi = connection.notify;
    // Everything the worker does on the network is this process's own; the
    // owner id it names is ignored. A Worker Thread shares its process's owner.
    const network = serveVirtualNetwork(workerApi.network, {
      authority: virtualNetwork,
      ownerId: String(identity.pid)
    });
    const processInput = serveProcessInput(workerApi.io);
    const asynchronousChildren = serveAsynchronousChildProcesses(
      workerApi.io,
      (request) =>
        this.spawnAsynchronousChild(
          request,
          request.ipc ? { relay: threads.relay, end: request.ipc } : undefined
        )
    );
    const reportBackgroundFailure = (error: unknown): void =>
      this.onBackgroundFailure(normalizeError(error));
    // A process waits for its host as long as the host lives, as an OS process waits for the kernel.
    const synchronous = createSynchronousChannel({ words: PROCESS_CHANNEL_WORDS, watchdogMs: Infinity });
    const relayedPorts = threads.relay.connect(threadName, {
      words: synchronousChannelWords(synchronous),
      deliver: (id, seq, delivery, message) => workerApi.ports.deliver(id, seq, delivery, message),
      closed: (id) => workerApi.ports.closed(id)
    });
    const stopWorker = (signal: ProcessExecutionSignal): void => {
      if (settled || stopRequested) return;
      if (context.workerThread) {
        stopRequested = true;
        worker.terminate();
        settleResult({ code: exitCodeForSignal(signal) });
        return;
      }
      // A process may handle SIGTERM or SIGINT and keep running, so every
      // signal reaches it until one ends it.
      workerApi.kill(signal);
    };

    const spawnSynchronousChild = (
      request: ProcessExecutionSynchronousChildRequest,
      inherited: ProcessExecutionInheritedInput | undefined
    ): Promise<ProcessExecutionSynchronousChildResult> => {
      const inheritedInput = processInput.lendToSynchronousChild(inherited);
      const complete = (
        childResult: ProcessExecutionSynchronousChildResult
      ): ProcessExecutionSynchronousChildResult => {
        inheritedInput.complete(childResult.error?.code !== 'PARENT_TERMINATED');
        return childResult;
      };
      return executeSynchronousChildProcess(request, {
        spawn: (childRequest) => this.spawnSynchronousChild(childRequest),
        parentInput: inheritedInput.input,
        parentStdout: context.writer,
        parentStderr: context.errorWriter ?? context.writer,
        parentSignal: context.signal,
        cancelWait: async (child, signal) => {
          await this.cancelSynchronousWait(child.pid, signal);
        }
      }).then(complete, (error: unknown) =>
        complete({
          status: null,
          signal: null,
          stdout: request.stdio.stdout === 'pipe' ? new Uint8Array() : null,
          stderr: request.stdio.stderr === 'pipe' ? new Uint8Array() : null,
          error: {
            code: 'EXECUTION_FAILED',
            message: error instanceof Error ? error.message : String(error)
          }
        })
      );
    };
    const synchronousServer = serveSynchronousRpc(synchronous, {
      spawnChild: spawnSynchronousChild,
      receivePortMessage: (id: string) => threads.relay.receive(threadName, id)
    } satisfies Implementation<NodeProcessSynchronousApi>);

    /** Admits a Worker Thread of this process and runs it as a Runtime Process of its own worker. */
    const startThread = async (request: NodeWorkerThreadStart): Promise<number> => {
      // The thread is this process's: its pid comes from the connection, not the request.
      const threadIdentity: ThreadIdentity = { pid: identity.pid, threadId: request.threadId };
      const name = `${threadIdentity.pid}:${threadIdentity.threadId}`;
      let terminated = false;
      let terminateThread!: (signal: ProcessExecutionSignal) => void;
      const threadSignal = new Promise<ProcessExecutionSignal>((resolve) => {
        terminateThread = resolve;
      });
      runningThreads.set(name, (signal) => {
        terminated = true;
        terminateThread(signal);
      });
      const inlineExecutable: ResolvedExecutable | undefined =
        request.entry.kind === 'inline-source'
          ? {
              programId: NODE_PROGRAM_ID,
              argv: [],
              inlineEntry: {
                source: request.entry.source,
                applicationArgs: request.argv,
                execArgv: request.execArgv,
                preloadArgv: []
              },
              provenance: {
                kind: 'runtime-program',
                command: NODE_PROGRAM_COMMANDS[0],
                paths: []
              }
            }
          : undefined;
      const threadArgs = request.entry.kind === 'inline-source'
        ? []
        : [...request.execArgv, request.entry.specifier, ...request.argv];
      // A stream the thread's Worker reads goes to the worker that holds it, not to the process's own.
      const threadWriter = (
        stream: NodeWorkerThreadStart['capturedOutput'][number],
        own: ProcessWriter
      ): ProcessWriter =>
        request.capturedOutput.includes(stream)
          ? {
              ...own,
              write: (chunk) =>
                workerApi.threads.output(
                  threadIdentity.threadId,
                  stream,
                  typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk
                )
            }
          : own;
      try {
        await executionContext.admitThread(threadIdentity, request.parentThreadId);
        try {
          const code = await this.run(threadArgs, {
            ...context,
            cwd: request.cwd,
            env: { ...request.env },
            executable: inlineExecutable,
            input: undefined,
            writer: threadWriter('stdout', context.writer),
            errorWriter: threadWriter('stderr', context.errorWriter ?? context.writer),
            pid: threadIdentity.pid,
            signal: threadSignal,
            workerThread: { ...threads, start: request }
          });
          return terminated && code === exitCodeForSignal('SIGTERM') ? 1 : code;
        } finally {
          void executionContext.completeThread(threadIdentity).catch(reportBackgroundFailure);
        }
      } finally {
        runningThreads.delete(name);
      }
    };

    const fileSystem = this.fileSystemForProcess({ mailboxContextId });
    Object.assign(local, {
      fs: fileSystem.api,
      network: network.api,
      io: {
        ready: () => resolveProcessIo(),
        async output(stream, data) {
          try {
            await (stream === 'stderr'
              ? context.errorWriter ?? context.writer
              : context.writer
            ).write(new Uint8Array(data));
          } catch (error) {
            fail(error);
            throw error;
          }
        },
        ...processInput.api,
        ...asynchronousChildren.api
      },
      threads: {
        start: startThread,
        terminate: (threadId) => runningThreads.get(`${identity.pid}:${threadId}`)?.('SIGTERM')
      },
      ports: relayedPorts,
      endpoints: {
        listen(port, publication, endpoint) {
          if (!context.publishedEndpoints) return;
          registeredPorts.add(port);
          publishedListeners.push(
            context.publishedEndpoints.register(
              port,
              publication.protocol,
              publication.address,
              endpoint
            )
          );
        },
        close: unpublish
      },
      exit: (code) => settleResult({ code }),
      fail: (error) => fail(reviveError(error)),
      // An error the program's own context reports (an `exit` listener that
      // throws, a failure after exit) is that process's failure, like `fail`:
      // the worker runs application code, so nothing it sends may end the
      // epoch, which `context.emitter.emitError` would.
      runtimeError: (error) => fail(reviveError(error))
    } satisfies Implementation<NodeProcessHostApi>);
    void connection.closed.then(() =>
      setTimeout(
        () =>
          fail(
            executionContextCrashError(
              new Error(
                'The Execution Context connection closed without an honest process exit.'
              )
            )
          ),
        0
      )
    );
    worker.addEventListener('error', (event) => {
      event.preventDefault();
      fail(executionContextCrashError(event.error ?? event.message));
    });
    if (context.onSignal && !context.workerThread) {
      const unsubscribe = context.onSignal(stopWorker);
      void result.then(unsubscribe, unsubscribe);
    } else if (context.signal) void context.signal.then((signal) => stopWorker(signal));

    const thread = context.workerThread?.start;
    workerApi.start({
      contextId: executionContext.id,
      pid: context.pid ?? 1,
      ppid: context.ppid ?? 0,
      args: [...args],
      assets: declaredRuntimeAssets(),
      inlineEntry,
      cwd: context.cwd,
      env: context.env,
      synchronous,
      sharedMemoryPool: threads.sharedMemoryPool,
      workerThread: thread && {
        identity,
        workerData: thread.workerData,
        parentPort: thread.parentPort
      },
      // A Worker Thread of a forked process is not the process: it has no channel.
      ...(context.ipc && !thread ? { ipc: context.ipc.end } : {})
    });
    if (context.input) {
      void processIoReady
        .then(() =>
          processInput.forward(context.input!, () => settled || forceTerminated)
        )
        .catch((error) => {
          if (!settled && !forceTerminated) {
            fail(executionContextCrashError(error));
          }
        });
    }

    try {
      return await Promise.race([
        result,
        executionContext.forcedTermination.then((signal) => {
          forceTerminated = true;
          return exitCodeForSignal(signal);
        })
      ]);
    } finally {
      processInput.dispose();
      for (const stop of runningThreads.values()) stop('SIGTERM');
      threads.relay.disconnect(threadName);
      synchronousServer.close();
      // The process exits only once the page has stopped publishing it.
      for (const port of [...registeredPorts]) unpublish(port);
      await Promise.all(unpublishing);
      context.publishedEndpoints?.abort(publishedListeners);
      network.dispose();
      try {
        // A Worker Thread shares its process's listeners and sockets, which the process's own exit releases.
        if (!context.workerThread) {
          await virtualNetwork
            .releaseOwner(String(identity.pid))
            .catch((error: unknown) => {
              if (!forceTerminated) throw error;
            });
        }
      } finally {
        asynchronousChildren.dispose();
        connection.close();
        fileSystem.release();
      }
    }
  }
}

function executionContextCrashError(cause: unknown): Error {
  const normalized = normalizeError(cause);
  const details = normalized.stack ? `\n${normalized.stack}` : '';
  const error = markWorkerFailure(new Error(
    `Execution Context failed: ${normalized.message}${details}`,
    { cause }
  ));
  error.name = 'MimicWorkerCrash';
  return error;
}
