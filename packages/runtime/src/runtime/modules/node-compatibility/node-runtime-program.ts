import { normalizePath } from '../virtual-file-system';
import type { ProcessExecutionSignal as ProcessSignal, RuntimeProgram } from '../process-execution';
import type { RuntimeProgramContext } from './runtime-program-context';
import {
  ExecutionContextRuntime,
  type ExecutionContextFileWatchHandle,
  type ExecutionContextFileWatchLifecycle
} from './execution-context-runtime';
import { createExecutionContextRuntimeServices } from './execution-context-runtime-services';
import {
  createExecutionContextProcessProjection,
  createReferencedChildProcessExecutionPort,
  type ChildProcessExecutionPort,
  type ExecutionContextProcessProjection
} from './child-process';
import { createNodeConsole, type NodeConsole } from './console';
import { NODE_SIGNAL_CONSTANTS } from './constants';
import { createNodeEventLoop, type NodeEventLoop } from './event-loop';
import type { NodeFileSystemWatchPort } from './filesystem';
import type { NodeMacrotaskQueue } from './node-compatibility';
import { createNodeProcess, type NodeProcess } from './process';
import { attachIpcChannel, exposeIpcChannel } from './ipc-channel';
import { parseNodeEnvFile } from './util';
import { installFetchActivity } from './fetch-activity';
import { createTimersPromisesBuiltin } from './timers';
import {
  createWorkerThreadSharedArrayBufferConstructor,
  installWorkerThreadRuntimeGlobals
} from './worker-threads';
import type { WorkerThreadSharedMemoryPool } from './worker-thread-shared-memory';
import { INLINE_NODE_MODULE_ENTRY, type RuntimeArtifactCompile } from '../module-execution-engine';
import { VIRTUAL_PLATFORM } from './runtime-platform-profile';
import { exitCodeForSignal, parseNodeCommandLine } from '../process-execution';
import {
  projectInlineNodeEntry,
  requireExecutionContextFileSystem,
  type ExecutionContextFileSystem
} from './execution-context-file-system';
import { createNodeExitSignal, isNodeExitSignal, NodeExit } from './process-exit';

/** The id of the Node Runtime Program in the program table. */
export const NODE_PROGRAM_ID = 'node';
/** The commands the Node Runtime Program owns. */
export const NODE_PROGRAM_COMMANDS = ['node', '/usr/bin/node'] as const;

const NODE_USAGE = [
  'Usage: node [options] [ script.js ] [arguments]',
  '       node [options] -e "script" [arguments]',
  '',
  'Options:',
  '  -e, --eval script        evaluate script',
  '  -p, --print script       evaluate script and print result',
  '  -r, --require module     module to preload',
  '  --import module          ES module to preload',
  '  -C, --conditions name    additional user conditions for conditional exports',
  '  --input-type type        "module" or "commonjs" for -e and -p',
  '  --env-file file          set environment variables from file',
  '  -v, --version            print Node.js version',
  '  -h, --help               print this help',
  ''
].join('\n');

export class NodeCommand implements RuntimeProgram<RuntimeProgramContext> {
  readonly id = NODE_PROGRAM_ID;
  readonly commands = NODE_PROGRAM_COMMANDS;
  readonly handlesSignals = true;

  constructor(
    /** Compiles the modules this program loads; a process worker asks the Runtime Host's compile service. */
    private readonly compile: RuntimeArtifactCompile,
    /** Queues an unclamped macrotask; the process worker passes Worker Transport's queue. */
    private readonly queueMacrotask: NodeMacrotaskQueue,
    private readonly injectedFileSystemWatch?: NodeFileSystemWatchPort
  ) {}

  async run(args: readonly string[], context: RuntimeProgramContext): Promise<number> {
    const errorWriter = context.errorWriter ?? context.writer;
    const commandLine = parseNodeCommandLine(args);
    if (!commandLine.ok) {
      await errorWriter.write(`${commandLine.message}\n`);
      return commandLine.exitCode;
    }
    const invocation = commandLine.value;
    if (invocation.action.kind === 'version') {
      await context.writer.write(`v${VIRTUAL_PLATFORM.nodeVersion}\n`);
      return 0;
    }
    if (invocation.action.kind === 'help') {
      await context.writer.write(NODE_USAGE);
      return 0;
    }
    if (invocation.action.kind === 'none') {
      await errorWriter.write('node: missing entry file\n');
      return 1;
    }

    const processId = context.pid ?? 1;
    const parentProcessId = context.ppid ?? 0;
    let fileSystem = requireExecutionContextFileSystem(context.fs);
    let path: string;
    if (invocation.action.kind === 'eval') {
      const projected = projectInlineNodeEntry(fileSystem, context.cwd, processId, {
        source: invocation.action.source,
        applicationArgs: invocation.applicationArgs,
        execArgv: invocation.execArgv,
        preloadArgv: invocation.optionArgv,
        ...(invocation.action.print ? { print: true as const } : {}),
        ...(invocation.inputType ? { inputType: invocation.inputType } : {})
      });
      fileSystem = projected.fileSystem;
      path = projected.path;
    } else {
      path = normalizePath(invocation.action.entry, context.cwd);
    }
    const inlineEntry = (fileSystem as typeof fileSystem & {
      [INLINE_NODE_MODULE_ENTRY]?(candidate: string): {
        readonly source: string;
        readonly execArgv: readonly string[];
      } | undefined;
    })[INLINE_NODE_MODULE_ENTRY]?.(path);
    if (invocation.inputType && !inlineEntry) {
      await errorWriter.write(
        'node: --input-type can only be used with string input via --eval or --print\n'
      );
      return 9;
    }
    for (const envFile of invocation.envFiles) {
      const envPath = normalizePath(envFile.path, context.cwd);
      if (!fileSystem.isFile(envPath)) {
        if (!envFile.required) continue;
        await errorWriter.write(`node: ${envFile.path}: not found\n`);
        return 9;
      }
      // The environment the process was started with wins over the file.
      for (const [name, value] of Object.entries(parseNodeEnvFile(fileSystem.readText(envPath)))) {
        if (!Object.hasOwn(context.env, name)) context.env[name] = value;
      }
    }
    if (invocation.flags.has('--watch') || invocation.values.has('--watch-path')) {
      await errorWriter.write(
        'node: --watch is not supported in Mimic; running the entry once\n'
      );
    }

    const workerThreads = context.workerThreads;
    const isWorkerThread = workerThreads.current.identity.threadId !== 0;
    const inlineWorkerEntry = isWorkerThread ? inlineEntry : undefined;
    const virtualNetwork = context.virtualNetwork;
    if (!virtualNetwork) throw new Error('NodeCommand requires an injected Virtual Network authority.');
    const processProjection =
      context.processProjection ?? createExecutionContextProcessProjection();
    let executionActive = true;
    const appendOutput = (chunk: string | Uint8Array) => {
      if (executionActive) return context.writer.write(chunk);
    };
    const appendError = (chunk: string | Uint8Array) => {
      if (executionActive) return errorWriter.write(chunk);
    };
    let requestedExitCode: number | undefined;
    let resolveExitRequest: ((code: number) => void) | undefined;
    const exitRequest = new Promise<number>((resolve) => {
      resolveExitRequest = resolve;
    });
    let raiseSignal: ((signal: ProcessSignal) => void) | undefined;
    const raisedSignal = new Promise<ProcessSignal>((resolve) => {
      raiseSignal = resolve;
    });

    const requestUnhandledExit = (reason: unknown): void => {
      if (!executionActive || requestedExitCode !== undefined) return;
      const error = reason instanceof Error ? reason : new Error(String(reason));
      void Promise.resolve(
        appendError(
          `${error.stack ?? `${error.name}: ${error.message}`}\n`
        )
      ).catch((writeError: unknown) =>
        context.emitter.emitError?.(
          writeError instanceof Error
            ? writeError
            : new Error(String(writeError))
        )
      );
      requestedExitCode = 1;
      nodeProcess.exitCode = 1;
      resolveExitRequest?.(1);
    };
    const onUnhandledRejection = (
      reason: unknown,
      promise: Promise<unknown>
    ): void => {
      if (!executionActive || isNodeExitSignal(reason)) return;
      try {
        if (
          !nodeProcess.emit(
            'unhandledRejection',
            reason,
            promise
          )
        ) {
          requestUnhandledExit(reason);
        }
      } catch (error) {
        requestUnhandledExit(error);
      }
    };
    const onUncaughtException = (reason: unknown): void => {
      if (!executionActive || isNodeExitSignal(reason)) return;
      const error =
        reason instanceof Error ? reason : new Error(String(reason));
      try {
        nodeProcess.emit('uncaughtExceptionMonitor', error, 'uncaughtException');
        if (!nodeProcess.emit('uncaughtException', error, 'uncaughtException')) {
          requestUnhandledExit(error);
        }
      } catch (listenerError) {
        requestUnhandledExit(listenerError);
      }
    };
    const eventLoop = createNodeEventLoop({
      queueMacrotask: this.queueMacrotask,
      onUncaughtException,
      onUnhandledRejection,
      isExitSignal: (error) => error instanceof NodeExit
    });
    installFetchActivity(globalThis as { fetch?: typeof fetch }, () => eventLoop.acquireReferencedActivity());
    const nodeProcess: NodeProcess = createNodeProcess({
      argv: [
        'node',
        inlineWorkerEntry ? '[worker eval]' : path,
        ...invocation.applicationArgs
      ],
      execArgv: inlineEntry?.execArgv ?? invocation.execArgv,
      env: context.env,
      pid: processId,
      ppid: parentProcessId,
      cwd: context.cwd,
      title: invocation.values.get('--title'),
      nextTick: eventLoop.nextTick,
      stdio: {
        input: context.input,
        writeOutput: appendOutput,
        writeError: appendError,
        isActive: () => executionActive,
        readActivity: { acquire: () => eventLoop.acquireReferencedActivity() }
      },
      warnings: {
        disabled:
          invocation.flags.has('--no-warnings') || context.env.NODE_NO_WARNINGS === '1',
        deprecationsDisabled: invocation.flags.has('--no-deprecation')
      },
      host: {
        exit: (code) => {
          if (requestedExitCode === undefined) {
            requestedExitCode = code;
            executionActive = false;
            if (!resolveExitRequest) throw new Error('process exit lifecycle was not initialized');
            resolveExitRequest(code);
          }
          throw createNodeExitSignal(requestedExitCode);
        },
        kill: (pid, signal) =>
          processProjection.signal(pid, signal === '0' ? 0 : deliverableSignal(signal)),
        raise: (signal) => {
          // A listener takes the signal over; without one it ends the process.
          if (nodeProcess.listenerCount(signal) > 0) {
            eventLoop.nextTick(() => emitSignal(nodeProcess, signal));
            return;
          }
          raiseSignal?.(deliverableSignal(signal));
        },
        resolveDirectory: (directory, cwd) => {
          const resolved = normalizePath(directory, cwd);
          if (!fileSystem.isDirectory(resolved)) {
            throw Object.assign(
              new Error(`ENOENT: no such file or directory, chdir '${cwd}' -> '${directory}'`),
              { code: 'ENOENT', errno: -2, syscall: 'chdir', path: cwd, dest: directory }
            );
          }
          return resolved;
        }
      }
    });
    if (context.ipc && !isWorkerThread) {
      // Linked before the entry runs: what the parent sent waits in the relay until then.
      exposeIpcChannel(nodeProcess, attachIpcChannel(nodeProcess, {
        ports: workerThreads.ports,
        port: context.ipc.port,
        serialization: context.ipc.serialization,
        activity: { acquire: () => eventLoop.acquireReferencedActivity() },
        nextTick: (callback) => eventLoop.nextTick(callback)
      }));
    }
    const nodeConsole = createNodeConsole({
      stdout: nodeProcess.stdout,
      stderr: nodeProcess.stderr
    });
    const runtimeGlobal = createProcessRuntimeGlobal(
      nodeProcess,
      nodeConsole,
      eventLoop,
      workerThreads.sharedMemoryPool,
      { exposeGc: invocation.flags.has('--expose-gc') }
    );
    const disposeProcessEvents = context.processEvents?.install({
      onUnhandledRejection,
      onUncaughtException
    });
    const guardedFs = createGuardedFileSystem(
      fileSystem,
      () => executionActive,
      (promise) => eventLoop.trackPromise(promise)
    );
    const fileWatchLifecycle = new FileWatchLifecycle();
    try {
      const ownedEndpointPorts = new Set<number>();
      const publishedEndpoints = context.publishedEndpoints && {
        ...context.publishedEndpoints,
        register: (
          port: number,
          protocol: 'http' | 'https',
          handler: Parameters<
            NonNullable<RuntimeProgramContext['publishedEndpoints']>['register']
          >[2]
        ) => {
          if (!executionActive) return;
          ownedEndpointPorts.add(port);
          context.publishedEndpoints?.register(port, protocol, {
            ...handler,
            close: () => {
              ownedEndpointPorts.delete(port);
              handler.close?.();
            }
          });
        },
        close: (port: number) => {
          ownedEndpointPorts.delete(port);
          return context.publishedEndpoints?.close(port);
        }
      };
      const executionContext = new ExecutionContextRuntime(guardedFs, {
        cwd: context.cwd,
        compile: this.compile,
        process: nodeProcess,
        console: nodeConsole,
        global: runtimeGlobal,
        queueMacrotask: this.queueMacrotask,
        conditions: invocation.conditions,
        runTurn: eventLoop.runTurn,
        childProcess: createReferencedChildProcessExecutionPort(
          createProjectedChildProcessExecutionPort(context.childProcess, processProjection),
          { acquire: () => eventLoop.acquireReferencedActivity() }
        ),
        synchronousChildProcess: context.synchronousProcessAuthority,
        runtimeServices: createExecutionContextRuntimeServices({
          httpListenerClaims: publishedEndpoints
            ? (protocol) => ({
                claim: (port, handler) =>
                  publishedEndpoints.register(port, protocol, handler),
                release: (port) => publishedEndpoints.close(port)
              })
            : undefined
        }),
        virtualNetwork,
        onModuleStart: context.diagnostics?.moduleStart,
        onModuleEnd: context.diagnostics?.moduleEnd,
        fileSystemWatch: this.injectedFileSystemWatch,
        fileWatchLifecycle,
        referencedActivity: {
          acquire: () => eventLoop.acquireReferencedActivity()
        },
        workerThreads
      });
      // As Node, a process started from a file with NODE_UNIQUE_ID is a cluster
      // worker from its start, and takes the variable out of its environment so
      // that a `node` it starts does not take itself for one.
      if (!inlineEntry && !isWorkerThread && nodeProcess.env.NODE_UNIQUE_ID !== undefined) {
        executionContext.engine.require('node:cluster', context.cwd);
        delete nodeProcess.env.NODE_UNIQUE_ID;
      }
      try {
        const completed = inlineWorkerEntry
          ? executionContext.engine.runCommonJsSource(inlineWorkerEntry.source)
          : executionContext.engine.runEntry(path, invocation.preloads);
        const finishExplicitExit = (code: number): number => {
          // An exit forced by an unhandled failure still lets `exit` listeners run.
          if (executionActive) {
            try {
              nodeProcess.emitExit();
            } catch (error) {
              if (!(error instanceof NodeExit)) {
                context.emitter.emitError?.(error instanceof Error ? error : new Error(String(error)));
              }
            }
          }
          executionActive = false;
          fileWatchLifecycle.closeAll();
          eventLoop.cancel();
          void completed.catch((error: unknown) => {
            if (isNodeExitSignal(error)) return;
            context.emitter.emitError?.(error instanceof Error ? error : new Error(String(error)));
          });
          return code;
        };
        const exitForSignal = async (signal: ProcessSignal): Promise<number> => {
          await processProjection.terminateDescendants(processId, signal);
          try {
            emitSignal(nodeProcess, signal);
          } catch (error) {
            if (!(error instanceof NodeExit)) throw error;
          }
          executionActive = false;
          fileWatchLifecycle.closeAll();
          eventLoop.cancel();
          void completed.catch(() => undefined);
          return exitCodeForSignal(signal);
        };
        let signalled = context.signal
          ? Promise.race([context.signal, raisedSignal])
          : raisedSignal;
        // A SIGTERM or SIGINT listener takes the signal over, as in Node: the
        // process keeps running until the listener ends it, and a later
        // signal is delivered again.
        const handOverToListeners = (signal: ProcessSignal): boolean => {
          if (signal === 'SIGKILL' || nodeProcess.listenerCount(signal) === 0) return false;
          eventLoop.nextTick(() => emitSignal(nodeProcess, signal));
          signalled = context.nextSignal
            ? Promise.race([context.nextSignal(), raisedSignal])
            : raisedSignal;
          return true;
        };
        const waitForRuntime = async <T>(operation: Promise<T>) => {
          const settledOperation = operation.then(
            (value) => ({ type: 'value' as const, value }),
            (error: unknown) => ({ type: 'error' as const, error })
          );
          const exited = exitRequest.then((code) => ({ type: 'exit' as const, code }));
          for (;;) {
            const outcome = await Promise.race([
              settledOperation,
              exited,
              signalled.then((signal) => ({ type: 'signal' as const, signal }))
            ]);
            if (outcome.type !== 'signal' || !handOverToListeners(outcome.signal)) return outcome;
          }
        };
        const entryOutcome = await waitForRuntime(completed);
        if (entryOutcome.type === 'exit') return finishExplicitExit(entryOutcome.code);
        if (entryOutcome.type === 'signal') return await exitForSignal(entryOutcome.signal);
        if (entryOutcome.type === 'error') {
          if (entryOutcome.error instanceof NodeExit) return finishExplicitExit(entryOutcome.error.code);
          throw entryOutcome.error;
        }
        if (requestedExitCode !== undefined) {
          return finishExplicitExit(requestedExitCode);
        }

        // A CommonJS entry can start an async CLI bootstrap without exporting
        // its promise. Node exits only after the event loop remains idle; a
        // short run of idle turns lets chained callbacks register their next
        // referenced task without imposing a fixed wall-clock delay.
        const hasReferencedWork = () =>
          ownedEndpointPorts.size > 0 ||
          fileWatchLifecycle.hasReferencedWatchers() ||
          eventLoop.hasReferencedTasks() ||
          executionContext.hasReferencedWorkerThreads();
        let idleTurns = 0;
        while (idleTurns < 16) {
          if (hasReferencedWork()) {
            const waitForIdle = Promise.all([
              fileWatchLifecycle.waitForIdle(),
              eventLoop.waitForIdle(),
              executionContext.waitForWorkerThreadsIdle()
            ]);
            const outcome = await waitForRuntime(waitForIdle);
            if (outcome.type === 'exit') return finishExplicitExit(outcome.code);
            if (outcome.type === 'signal') return await exitForSignal(outcome.signal);
            if (outcome.type === 'error') {
              if (outcome.error instanceof NodeExit) return finishExplicitExit(outcome.error.code);
              throw outcome.error;
            }
            idleTurns = 0;
          }
          const turn = await waitForRuntime(new Promise<void>((resolve) => setTimeout(resolve, 0)));
          if (turn.type === 'exit') return finishExplicitExit(turn.code);
          if (turn.type === 'signal') return await exitForSignal(turn.signal);
          if (turn.type === 'error') throw turn.error;
          idleTurns = hasReferencedWork() ? 0 : idleTurns + 1;
        }
        // Node emits beforeExit whenever the referenced event loop becomes
        // idle. A listener may schedule another turn, but merely remaining
        // registered does not keep the process alive.
        while (nodeProcess.listenerCount('beforeExit') > 0) {
          try {
            nodeProcess.emit('beforeExit', nodeProcess.exitCode ?? 0);
          } catch (error) {
            if (error instanceof NodeExit) return finishExplicitExit(error.code);
            throw error;
          }
          const turn = await waitForRuntime(Promise.resolve());
          if (turn.type === 'exit') return finishExplicitExit(turn.code);
          if (turn.type === 'signal') return await exitForSignal(turn.signal);
          if (turn.type === 'error') throw turn.error;
          if (!hasReferencedWork()) break;
          const waitForIdle = Promise.all([
            fileWatchLifecycle.waitForIdle(),
            eventLoop.waitForIdle(),
            executionContext.waitForWorkerThreadsIdle()
          ]);
          const outcome = await waitForRuntime(waitForIdle);
          if (outcome.type === 'exit') return finishExplicitExit(outcome.code);
          if (outcome.type === 'signal') return await exitForSignal(outcome.signal);
          if (outcome.type === 'error') {
            if (outcome.error instanceof NodeExit) return finishExplicitExit(outcome.error.code);
            throw outcome.error;
          }
        }
        try {
          nodeProcess.emitExit();
        } catch (error) {
          if (error instanceof NodeExit) return finishExplicitExit(error.code);
          throw error;
        }
      } finally {
        executionContext.teardown();
        if (ownedEndpointPorts.size === 0) {
          executionActive = false;
          fileWatchLifecycle.closeAll();
          eventLoop.cancel();
        }
      }
    } finally {
      disposeProcessEvents?.();
      if (!executionActive) {
        fileWatchLifecycle.closeAll();
        eventLoop.cancel();
      }
      // A worker thread shares its process's sockets, which the main thread releases.
      if (!isWorkerThread) await virtualNetwork.releaseOwner(String(processId));
    }

    return nodeProcess.exitCode ?? 0;
  }
}

function createProjectedChildProcessExecutionPort(
  delegate: ChildProcessExecutionPort,
  processProjection: ExecutionContextProcessProjection
): ChildProcessExecutionPort {
  return {
    async spawn(request) {
      const handle = await delegate.spawn(request);
      const closed = handle.exit
        .then(
          () => undefined,
          () => undefined
        )
        .finally(() => processProjection.unregister(handle.pid));
      processProjection.register(
        handle.pid,
        request.parentPid,
        (signal) => {
          void delegate.signal(handle.pid, signal);
        },
        closed
      );
      return handle;
    },
    signal: (pid, signal) => delegate.signal(pid, signal)
  };
}

type ProcessRuntimeGlobal = typeof globalThis & {
  process: unknown;
  global: ProcessRuntimeGlobal;
  globalThis: ProcessRuntimeGlobal;
  setImmediate: NodeEventLoop['setImmediate'];
  clearImmediate: NodeEventLoop['clearImmediate'];
};

function createProcessRuntimeGlobal(
  process: NodeProcess,
  runtimeConsole: NodeConsole,
  eventLoop: NodeEventLoop,
  sharedMemoryPool: WorkerThreadSharedMemoryPool,
  options: { readonly exposeGc: boolean }
): ProcessRuntimeGlobal {
  const runtimeGlobal = Object.create(globalThis) as ProcessRuntimeGlobal;
  installWorkerThreadRuntimeGlobals(runtimeGlobal);
  Object.defineProperty(runtimeGlobal, 'SharedArrayBuffer', {
    configurable: true,
    value: createWorkerThreadSharedArrayBufferConstructor(sharedMemoryPool),
    writable: true
  });
  Object.defineProperty(runtimeGlobal, 'crypto', {
    configurable: true,
    enumerable: true,
    value: globalThis.crypto,
    writable: true
  });
  Object.defineProperty(runtimeGlobal, 'navigator', {
    configurable: true,
    enumerable: true,
    value: createNodeNavigator(process),
    writable: true
  });
  const runtimePerformance = globalThis.performance
    ? new Proxy(globalThis.performance, {
        get(target, property) {
          if (property === 'markResourceTiming') return () => undefined;
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      })
    : { now: () => Date.now(), markResourceTiming: () => undefined };
  Object.defineProperty(runtimeGlobal, 'performance', {
    configurable: true,
    enumerable: true,
    value: runtimePerformance,
    writable: true
  });
  // Defined, not assigned: an assignment reaches a setter the host's global has
  // for the name (Node's global `process` is an accessor), which would replace
  // the host's own `process` with this one and outlive the process.
  for (const [name, value] of Object.entries({
    process,
    console: runtimeConsole,
    setTimeout: eventLoop.setTimeout,
    clearTimeout: eventLoop.clearTimeout,
    setInterval: eventLoop.setInterval,
    clearInterval: eventLoop.clearInterval,
    setImmediate: eventLoop.setImmediate,
    clearImmediate: eventLoop.clearImmediate,
    queueMicrotask: eventLoop.queueMicrotask,
    // The browser collects on its own schedule; the function exists for code that calls it.
    ...(options.exposeGc ? { gc: () => undefined } : {})
  })) {
    Object.defineProperty(runtimeGlobal, name, { configurable: true, enumerable: true, value, writable: true });
  }
  // `util.promisify(setTimeout)` is `timers/promises`' setTimeout, as in Node
  // (close-with-grace waits that way).
  const promised = createTimersPromisesBuiltin(runtimeGlobal) as Record<'setTimeout' | 'setImmediate', unknown>;
  for (const name of ['setTimeout', 'setImmediate'] as const) {
    Object.defineProperty(eventLoop[name], Symbol.for('nodejs.util.promisify.custom'), {
      configurable: true,
      value: promised[name]
    });
  }
  runtimeGlobal.globalThis = runtimeGlobal;
  const shared = shareNewGlobals(runtimeGlobal);
  shared.global = shared;
  shared.globalThis = shared;
  return shared;
}

/**
 * Modules see `global` and `globalThis` as the process's global, but their
 * free identifiers, and code built by `Function`, `eval` or
 * `vm.runInThisContext`, resolve against the worker's own global. A name a
 * program adds to its global is therefore defined on the worker's, which
 * belongs to this process alone, so `globalThis.name = value` in one module is
 * `name` everywhere, as in Node. A name the worker already has (`fetch`,
 * `crypto`, …) stays on the process's global, shadowing the worker's, since
 * the runtime itself goes on using the worker's.
 */
/**
 * Node's `navigator`, not the worker's: code that tells a browser from Node by
 * `navigator.userAgent` (`Node.js/22`) takes its Node path, as it does in Node.
 */
function createNodeNavigator(process: NodeProcess): object {
  const { arch, version } = process;
  const language = new Intl.Collator().resolvedOptions().locale || 'en-US';
  class Navigator {
    get hardwareConcurrency(): number {
      return globalThis.navigator?.hardwareConcurrency ?? 1;
    }

    get language(): string {
      return language;
    }

    get languages(): string[] {
      return [language];
    }

    get userAgent(): string {
      return `Node.js/${version.slice(1, version.indexOf('.'))}`;
    }

    /** As Node derives it on Linux, the platform the runtime reports (ADR-0039): `Linux <arch>`. */
    get platform(): string {
      return `Linux ${arch}`;
    }

    get [Symbol.toStringTag](): string {
      return 'Navigator';
    }
  }
  return new Navigator();
}

function shareNewGlobals(runtimeGlobal: ProcessRuntimeGlobal): ProcessRuntimeGlobal {
  const workerGlobal = globalThis as unknown as Record<PropertyKey, unknown>;
  const mirrored = new Set<PropertyKey>();
  const sharesName = (target: object, property: PropertyKey) =>
    mirrored.has(property) || (!Object.hasOwn(target, property) && !(property in workerGlobal));
  // `process` and `global` are names the worker lacks too. Node's other
  // globals stay on the process's global: the runtime's own scheduling in
  // this worker would otherwise take `setImmediate` for the program's.
  for (const property of ['process', 'global'] as const) {
    if (!Object.hasOwn(runtimeGlobal, property) || property in workerGlobal) continue;
    Reflect.defineProperty(workerGlobal, property, Reflect.getOwnPropertyDescriptor(runtimeGlobal, property)!);
    mirrored.add(property);
  }
  // A shared name is defined on both globals, so it is the process global's
  // own property as well; its value is read from the worker's, where an
  // assignment to the bare name lands.
  // An accessor the worker's global inherits from the browser (`location`,
  // `indexedDB`, …) is read only on that global itself: as `this`, the
  // process's global is an illegal invocation (lodash copying the global met
  // one). An assignment does not reach the browser's setter: as on Node's
  // global, it makes the process global's own property, so
  // `globalThis.onerror = fn` does not become the worker's error handler.
  const inheritedAccessor = (target: object, property: PropertyKey): PropertyDescriptor | undefined => {
    if (Object.hasOwn(target, property)) return undefined;
    for (
      let owner: object | null = Object.getPrototypeOf(target);
      owner && owner !== Object.prototype;
      owner = Object.getPrototypeOf(owner)
    ) {
      const descriptor = Reflect.getOwnPropertyDescriptor(owner, property);
      if (descriptor) return 'get' in descriptor || 'set' in descriptor ? descriptor : undefined;
    }
    return undefined;
  };
  return new Proxy(runtimeGlobal, {
    get(target, property, receiver) {
      if (mirrored.has(property)) return workerGlobal[property];
      const accessor = inheritedAccessor(target, property);
      if (accessor) return accessor.get?.call(workerGlobal);
      return Reflect.get(target, property, receiver);
    },
    set(target, property, value, receiver) {
      if (inheritedAccessor(target, property)) {
        return Reflect.defineProperty(target, property, { configurable: true, enumerable: true, writable: true, value });
      }
      if (!sharesName(target, property)) return Reflect.set(target, property, value, receiver);
      if (!Reflect.set(workerGlobal, property, value)) return false;
      mirrored.add(property);
      if (Object.hasOwn(target, property)) return Reflect.set(target, property, value);
      return Reflect.defineProperty(target, property, { configurable: true, enumerable: true, writable: true, value });
    },
    defineProperty(target, property, descriptor) {
      if (!sharesName(target, property)) return Reflect.defineProperty(target, property, descriptor);
      if (!Reflect.defineProperty(workerGlobal, property, descriptor)) return false;
      mirrored.add(property);
      return Reflect.defineProperty(target, property, descriptor);
    },
    deleteProperty(target, property) {
      if (!mirrored.has(property)) return Reflect.deleteProperty(target, property);
      mirrored.delete(property);
      return Reflect.deleteProperty(workerGlobal, property) && Reflect.deleteProperty(target, property);
    }
  });
}

/** Other processes take the signals Process Execution delivers; the rest end them like SIGTERM. */
function deliverableSignal(signal: string): ProcessSignal {
  return signal === 'SIGINT' || signal === 'SIGKILL' ? signal : 'SIGTERM';
}

function createGuardedFileSystem(
  fileSystem: ExecutionContextFileSystem,
  isActive: () => boolean,
  trackPromise: <T>(promise: Promise<T>) => Promise<T>
): ExecutionContextFileSystem {
  return new Proxy(fileSystem, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (!isActive()) throw processCancelledError();
        const result = value.apply(target, args);
        return result instanceof Promise ? trackPromise(result) : result;
      };
    }
  }) as ExecutionContextFileSystem;
}

type TrackedFileWatchHandle = ExecutionContextFileWatchHandle & {
  isReferenced(): boolean;
};

class FileWatchLifecycle implements ExecutionContextFileWatchLifecycle {
  private readonly handles = new Set<TrackedFileWatchHandle>();
  private readonly idleWaiters = new Set<() => void>();

  open(cleanup: () => void): ExecutionContextFileWatchHandle {
    let closed = false;
    let referenced = true;
    const handle: TrackedFileWatchHandle = {
      close: () => {
        if (closed) return;
        closed = true;
        this.handles.delete(handle);
        cleanup();
        this.resolveIdleWaiters();
      },
      ref: () => {
        if (closed) return;
        referenced = true;
      },
      unref: () => {
        if (closed) return;
        referenced = false;
        this.resolveIdleWaiters();
      },
      isReferenced: () => !closed && referenced
    };
    this.handles.add(handle);
    return handle;
  }

  hasReferencedWatchers(): boolean {
    return [...this.handles].some((handle) => handle.isReferenced());
  }

  waitForIdle(): Promise<void> {
    if (!this.hasReferencedWatchers()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  closeAll(): void {
    for (const handle of [...this.handles]) handle.close();
  }

  private resolveIdleWaiters(): void {
    if (this.hasReferencedWatchers()) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}

function processCancelledError(): Error {
  return Object.assign(new Error('Mimic process execution was cancelled'), { code: 'ABORT_ERR' });
}

/** Node calls a signal's listeners with its name and its number. */
function emitSignal(target: NodeProcess, signal: string): void {
  target.emit(signal, signal, (NODE_SIGNAL_CONSTANTS as Readonly<Record<string, number>>)[signal]);
}
