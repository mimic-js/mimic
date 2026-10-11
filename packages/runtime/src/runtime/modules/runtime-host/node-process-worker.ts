/// <reference lib="webworker" />

import {
  createWorkerChildProcessPort,
  exitCodeForSignal,
  WorkerProcessInput,
  type WorkerChildProcessEvents
} from '../process-execution';
import {
  combineExecutionFileSystem,
  configureSqliteEngineAssets,
  hideBrowserWorkerGlobals,
  installCallSiteFileNames,
  installNodePerformanceCompatibility,
  isNodeExitSignal,
  NodeCommand,
  projectInlineNodeEntry,
  type ProcessEventHandlers,
  type RuntimeProgramContext,
  type SynchronousChildProcessExecutionPort,
  type WorkerThreadPortsWorkerApi
} from '../node-compatibility';
import type { ProcessWriter } from '../process-execution';
import {
  RUNTIME_ARTIFACT_COMPILE_SERVICE,
  type NodeProcessHostApi,
  type NodeProcessStart,
  type NodeProcessSynchronousApi,
  type NodeProcessWorkerApi,
  type ProcessSignal,
  type PublishedListenerApi
} from './process-worker-protocol';
import {
  servePublishedWebSocket,
  type PublishedEndpointServer,
  type PublishedHttpRequest,
  type PublishedHttpResponse
} from '../published-endpoint';
import {
  createVirtualNetworkClient,
  type VirtualNetworkClient
} from '../virtual-network';
import {
  connectRpc,
  connectSynchronousRpc,
  normalizeError,
  queueMacrotask,
  serializeError,
  synchronousChannelWords,
  transfer,
  type Implementation,
  type SynchronousRemote
} from '../worker-transport';
import {
  createAsyncVirtualFileSystemClient,
  createSynchronousVirtualFileSystemClient,
  type AsyncVirtualFileSystemClient,
  type SynchronousVirtualFileSystemClient
} from '../virtual-file-system';
import { createProcessWorkerThreads } from './process-worker-threads';
import { declareRuntimeAssets } from './runtime-assets';
import {
  createRuntimeArtifactCompileClient,
  type RuntimeArtifactCompileResponse
} from '../module-execution-engine';

const scope = self as DedicatedWorkerGlobalScope;
const local = {} as Implementation<NodeProcessWorkerApi>;
const connection = connectRpc<NodeProcessHostApi>(scope, local);
const host = connection.remote;
const hostNotify = connection.notify;
const handlers = new Map<number, PublishedEndpointServer>();
const exchangeCancellations = new Map<string, AbortController>();
const processIdleWaiters = new Set<() => void>();
let activeEndpointOperations = 0;
let pendingHandlerCloses = 0;
let kill: ((signal: ProcessSignal) => void) | undefined;
let processInput: WorkerProcessInput | undefined;
let childProcessEvents: WorkerChildProcessEvents | undefined;
let network: VirtualNetworkClient | undefined;
let processEventHandlers: ProcessEventHandlers | undefined;
let workerThreadPorts: WorkerThreadPortsWorkerApi | undefined;
let workerThreadOutput: NodeProcessWorkerApi['threads']['output'] | undefined;
/**
 * The Web Lock this worker holds while it lives: a document with a published
 * WebSocket this worker serves watches it, and learns that the socket's
 * server is gone when the worker is terminated (ADR-0038).
 */
const processLock = holdProcessLock();

scope.addEventListener('unhandledrejection', (event) => {
  event.preventDefault();
  if (isNodeExitSignal(event.reason)) return;
  if (processEventHandlers) {
    const handlers = processEventHandlers;
    reportProcessEventFailure(
      'MimicWorkerUnhandledRejection',
      event.reason,
      () => handlers.onUnhandledRejection(event.reason, event.promise)
    );
    return;
  }
  hostNotify.fail(serializeError(workerDiagnosticError('MimicWorkerUnhandledRejection', event.reason)));
  scope.close();
});

scope.addEventListener('error', (event) => {
  event.preventDefault();
  const error = event.error ?? event.message;
  if (isNodeExitSignal(error)) return;
  if (processEventHandlers) {
    const handlers = processEventHandlers;
    reportProcessEventFailure(
      'MimicWorkerCrash',
      error,
      () => handlers.onUncaughtException(error)
    );
    return;
  }
  hostNotify.fail(serializeError(workerDiagnosticError('MimicWorkerCrash', error)));
  scope.close();
});

Object.assign(local, {
  start(message) {
    void start(message);
  },
  kill: (signal) => kill?.(signal),
  io: {
    input: (sequence, data) => processInput?.push(new Uint8Array(data), sequence),
    inputClose: () => processInput?.close(),
    childAdmitted: (requestId, pid) => childProcessEvents?.childAdmitted(requestId, pid),
    childSpawnError: (requestId, message, code) =>
      childProcessEvents?.childSpawnError(requestId, message, code),
    childOutput: (requestId, stream, data) =>
      childProcessEvents?.childOutput(requestId, stream, data),
    childInputDrain: (requestId, sequence) =>
      childProcessEvents?.childInputDrain(requestId, sequence),
    childExit: (requestId, code, signal) =>
      childProcessEvents?.childExit(requestId, code, signal)
  },
  network: {
    listenerConnection: (listenerId, socket) =>
      network?.events.listenerConnection(listenerId, socket),
    socketEvent: (socketId, event) => network?.events.socketEvent(socketId, event),
    listenerClosed: (listenerId) => network?.events.listenerClosed(listenerId)
  },
  ports: {
    deliver: (id, seq, delivery, message) =>
      workerThreadPorts?.deliver(id, seq, delivery, message),
    closed: (id) => workerThreadPorts?.closed(id)
  },
  threads: {
    output: (threadId, stream, data) => workerThreadOutput?.(threadId, stream, data)
  }
} satisfies Implementation<NodeProcessWorkerApi>);

/**
 * Publishes a listener: its endpoint port lets the page reach this worker
 * directly. The page closes that port once its exchanges have settled.
 */
function publishListener(
  port: number,
  protocol: 'http' | 'https',
  server: PublishedEndpointServer
): void {
  closeListener(port, false);
  const channel = new MessageChannel();
  const listener: PublishedListenerApi = {
    serveHttp: (exchangeId, request) =>
      trackEndpointOperation(serveHttp(server, exchangeId, request)),
    cancelHttp(exchangeId, reason) {
      exchangeCancellations.get(exchangeId)?.abort(reason);
    },
    openWebSocket: (request, client, options) =>
      servePublishedWebSocket({
        server,
        request,
        client,
        documentLock: typeof options?.documentLock === 'string' ? options.documentLock : undefined,
        processLock: processLock.name,
        locks: processLock.locks
      }),
    close() {
      if (handlers.get(port) === server) closeListener(port, true);
    }
  };
  connectRpc(channel.port1, listener);
  handlers.set(port, server);
  hostNotify.endpoints.listen(
    port,
    { protocol, address: server.address },
    transfer(channel.port2, [channel.port2])
  );
}

function closeListener(port: number, notifyHost: boolean): void {
  const server = handlers.get(port);
  if (!server) return;
  handlers.delete(port);
  server.close();
  notifyProcessIdle();
  if (notifyHost) hostNotify.endpoints.close(port);
}

async function start(message: NodeProcessStart): Promise<void> {
  let committedFileSystem: AsyncVirtualFileSystemClient | undefined;
  let synchronousFileSystem: SynchronousVirtualFileSystemClient | undefined;
  const mailboxContextId =
    `execution-context:${message.contextId}:process:${message.pid}` +
    (message.workerThread ? `:thread:${message.workerThread.identity.threadId}` : '');
  try {
    declareRuntimeAssets(message.assets);
    configureSqliteEngineAssets({
      glue: message.assets['node-sqlite3-wasm.js'],
      wasm: message.assets['node-sqlite3-wasm.wasm']
    });
    installNodePerformanceCompatibility();
    hideBrowserWorkerGlobals();
    installCallSiteFileNames();
    const signalWaiters = new Set<(signal: ProcessSignal) => void>();
    // Resolves with the first signal sent after the call.
    const nextSignal = (): Promise<ProcessSignal> =>
      new Promise<ProcessSignal>((resolve) => signalWaiters.add(resolve));
    const killed = nextSignal();
    kill = (signal) => {
      const waiters = [...signalWaiters];
      signalWaiters.clear();
      for (const resolve of waiters) resolve(signal);
    };
    committedFileSystem = await createAsyncVirtualFileSystemClient(host.fs);
    synchronousFileSystem = createSynchronousVirtualFileSystemClient(
      await committedFileSystem.openSynchronousMailbox(mailboxContextId)
    );
    const authoritativeFileSystem = combineExecutionFileSystem(
      committedFileSystem,
      synchronousFileSystem
    );
    const committedFileSystemWatch: Pick<AsyncVirtualFileSystemClient, 'watchCommitted'> = {
      watchCommitted(listener, options = {}) {
        const revision = synchronousFileSystem!.revision;
        committedFileSystem!.observeRevision(revision);
        return committedFileSystem!.watchCommitted(listener, {
          ...options,
          afterRevision: options.afterRevision ?? revision
        });
      }
    };
    const projectedInlineEntry = message.inlineEntry
      ? projectInlineNodeEntry(
          authoritativeFileSystem,
          message.cwd,
          message.pid,
          message.inlineEntry
        )
      : undefined;
    const executionFileSystem =
      projectedInlineEntry?.fileSystem ?? authoritativeFileSystem;
    const synchronous = connectSynchronousRpc<NodeProcessSynchronousApi>(message.synchronous).remote;
    const synchronousProcessAuthority = createWorkerSynchronousProcessAuthority(synchronous);
    const identity = {
      pid: message.pid,
      threadId: message.workerThread?.identity.threadId ?? 0
    };
    const threads = createProcessWorkerThreads({
      identity,
      host,
      hostNotify,
      synchronous,
      words: synchronousChannelWords(message.synchronous)
    });
    workerThreadPorts = threads.delivered;
    workerThreadOutput = threads.output;
    processInput = new WorkerProcessInput(hostNotify.io);
    hostNotify.io.ready();
    const writer = createWorkerProcessWriter('stdout', killed);
    const errorWriter = createWorkerProcessWriter('stderr', killed);
    const children = createWorkerChildProcessPort(
      hostNotify.io,
      writer,
      errorWriter,
      processInput
    );
    childProcessEvents = children.events;
    const childProcess = children.port;
    network = createVirtualNetworkClient(host.network);
    const context: RuntimeProgramContext = {
      cwd: message.cwd,
      env: message.env,
      pid: message.pid,
      ppid: message.ppid,
      signal: killed,
      nextSignal,
      fs: executionFileSystem,
      writer,
      errorWriter,
      input: processInput,
      workerThreads: {
        current: {
          identity,
          workerData: message.workerThread?.workerData,
          parentPort: message.workerThread?.parentPort
        },
        execution: threads.execution,
        ports: threads.ports,
        sharedMemoryPool: message.sharedMemoryPool
      },
      childProcess,
      ...(message.ipc ? { ipc: message.ipc } : {}),
      synchronousProcessAuthority,
      emitter: {
        emitError: (error) => hostNotify.runtimeError(serializeError(error))
      },
      processEvents: {
        install(handlers) {
          processEventHandlers = handlers;
          return () => {
            if (processEventHandlers === handlers) {
              processEventHandlers = undefined;
            }
          };
        }
      },
      virtualNetwork: network,
      publishedEndpoints: {
        register: publishListener,
        close(port) {
          pendingHandlerCloses += 1;
          closeListener(port, true);
          let completed = false;
          return () => {
            if (completed) return;
            completed = true;
            pendingHandlerCloses = Math.max(0, pendingHandlerCloses - 1);
            notifyProcessIdle();
          };
        },
      }
    };

    const synchronousCalls = synchronousFileSystem;
    const compile = createRuntimeArtifactCompileClient(
      (request) => synchronousCalls.callSync(RUNTIME_ARTIFACT_COMPILE_SERVICE, request) as RuntimeArtifactCompileResponse
    );
    let code = await new NodeCommand(compile, queueMacrotask, committedFileSystemWatch).run(
      [...(projectedInlineEntry?.args ?? message.args)],
      context
    );
    // The program ended, by itself, by `process.exit()` or by a signal: as
    // in Node its servers end with it. Only the closes and requests already
    // under way are waited for, until another signal ends the wait.
    for (const port of [...handlers.keys()]) closeListener(port, true);
    if (activeEndpointOperations > 0 || pendingHandlerCloses > 0) {
      const outcome = await Promise.race([
        nextSignal().then((signal) => ({ type: 'signal' as const, signal })),
        waitForProcessIdle().then(() => ({ type: 'idle' as const }))
      ]);
      if (outcome.type === 'signal') code = exitCodeForSignal(outcome.signal);
    }
    notifyProcessIdle();
    hostNotify.exit(code);
    await yieldProcessOutcome();
  } catch (error) {
    hostNotify.fail(serializeError(normalizeError(error)));
    await yieldProcessOutcome();
  } finally {
    synchronousFileSystem?.close();
    if (committedFileSystem) {
      await committedFileSystem
        .closeSynchronousMailbox(mailboxContextId)
        .catch(() => undefined);
    }
    committedFileSystem?.close();
    network?.close();
  }
}

function yieldProcessOutcome(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createWorkerSynchronousProcessAuthority(
  synchronous: SynchronousRemote<NodeProcessSynchronousApi>
): SynchronousChildProcessExecutionPort {
  return {
    spawnSync(request) {
      const inheritedInput =
        request.stdio.stdin === 'inherit'
          ? processInput?.takeForSynchronousChild()
          : undefined;
      return synchronous.spawnChild(request, inheritedInput);
    }
  };
}

function createWorkerProcessWriter(
  stream: 'stdout' | 'stderr',
  killed: Promise<ProcessSignal>
): ProcessWriter {
  return {
    write(chunk) {
      const source = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
      const copy = new Uint8Array(source.byteLength);
      copy.set(source);
      // Output the host can no longer accept never drains.
      return host.io
        .output(stream, transfer(copy.buffer, [copy.buffer]))
        .catch(() => new Promise<void>(() => undefined));
    },
    close: () => undefined,
    fail: (error) => hostNotify.runtimeError(serializeError(normalizeError(error))),
    waitForKill: () => killed
  };
}

function waitForProcessIdle(): Promise<void> {
  if (handlers.size === 0 && activeEndpointOperations === 0 && pendingHandlerCloses === 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => processIdleWaiters.add(resolve));
}

function notifyProcessIdle(): void {
  if (handlers.size > 0 || activeEndpointOperations > 0 || pendingHandlerCloses > 0) return;
  for (const resolve of processIdleWaiters) resolve();
  processIdleWaiters.clear();
}

async function trackEndpointOperation<Value>(operation: Promise<Value>): Promise<Value> {
  activeEndpointOperations += 1;
  try {
    return await operation;
  } finally {
    activeEndpointOperations -= 1;
    notifyProcessIdle();
  }
}

async function serveHttp(
  handler: PublishedEndpointServer,
  exchangeId: string,
  request: PublishedHttpRequest
): Promise<PublishedHttpResponse> {
  const cancellation = new AbortController();
  exchangeCancellations.set(exchangeId, cancellation);
  try {
    const response = await handler.serveHttp(request, {
      signal: cancellation.signal
    });
    return transfer(response, [response.body]);
  } finally {
    exchangeCancellations.delete(exchangeId);
  }
}

/**
 * A failure of this worker outside the program's own handlers. The host
 * reports it as the process's failure: only a crash the host observes itself
 * (the worker's `error` event, a connection closed without an exit) is a
 * worker crash, since this worker runs untrusted code.
 */
function workerDiagnosticError(name: string, reason: unknown): Error {
  const cause = reason instanceof Error ? reason : undefined;
  const message = cause?.message ?? String(reason);
  const error = new Error(`${name}: ${message}`);
  error.name = name;
  if (cause?.stack) error.stack = `${name}: ${message}\nCaused by: ${cause.stack}`;
  return error;
}

function reportProcessEventFailure(
  name: string,
  reason: unknown,
  report: () => void
): void {
  try {
    report();
  } catch (reportingError) {
    const diagnostic = workerDiagnosticError(name, reason);
    const reporting = workerDiagnosticError('MimicWorkerErrorReportingFailure', reportingError);
    diagnostic.stack = `${diagnostic.stack ?? diagnostic.message}\n${reporting.stack ?? reporting.message}`;
    hostNotify.fail(serializeError(diagnostic));
    scope.close();
  }
}

function holdProcessLock(): { name?: string; readonly locks?: LockManager } {
  const locks = (globalThis.navigator as { locks?: LockManager } | undefined)?.locks;
  const lock: { name?: string; readonly locks?: LockManager } = { locks };
  if (!locks) return lock;
  const name = `mimic:process:${crypto.randomUUID()}`;
  void locks
    .request(name, () => {
      lock.name = name;
      return new Promise<never>(() => undefined);
    })
    .catch(() => undefined);
  return lock;
}
