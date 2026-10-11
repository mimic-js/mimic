import {
  createExecutionContextRuntimeServices,
  type ExecutionContextRuntimeServices
} from './execution-context-runtime-services';
import type { VirtualNetworkAuthority } from '../virtual-network';
import { bootstrapExecutionContext, type BootstrappedExecutionContext } from './execution-context-bootstrap';
import type {
  ModuleExecutionEngine,
  RuntimeArtifactCompile
} from '../module-execution-engine';
import { BrowserBuffer } from './buffer';
import type {
  ChildProcessExecutionPort,
  ProcessExecutionActivityLifecycle,
  SynchronousChildProcessExecutionPort
} from './child-process';
import type { NodeFileSystemWatchPort, NodeFileWatchLifecycle } from './filesystem';
import {
  formatNodeFileSystemWatchTrace,
  NODE_FILE_SYSTEM_WATCH_TRACE_ENV
} from './filesystem-watchers';
import { wasiVfsPort } from './wasi';
import type { ThreadExecutionLease, ThreadExecutionPort } from './worker-threads';
import type { ThreadIdentity } from '../process-execution';
import { VIRTUAL_PLATFORM } from './runtime-platform-profile';
import type { ExecutionContextFileSystem } from './execution-context-file-system';
import type { RuntimeWorkerThreads } from './runtime-program-context';

export type ExecutionContextProcess = {
  argv: string[];
  execArgv: string[];
  env: Record<string, string>;
  pid?: number;
  exitCode?: number;
  arch: typeof VIRTUAL_PLATFORM.architecture;
  platform: typeof VIRTUAL_PLATFORM.operatingSystem;
  version: `v${typeof VIRTUAL_PLATFORM.nodeVersion}`;
  versions: Record<string, string> & {
    node: typeof VIRTUAL_PLATFORM.nodeVersion;
  };
  release: Readonly<{
    name: 'node';
    lts: string;
    sourceUrl: string;
    headersUrl: string;
  }>;
  features?: { require_module?: boolean; typescript?: 'strip' | 'transform' | false };
  binding?(name: string): Record<string, unknown>;
  stdin?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  nextTick?(callback: (...args: unknown[]) => void, ...args: unknown[]): void;
  on?(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
  once?(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
  off?(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
  cwd(): string;
  exit(code?: number): never;
};
export type ExecutionContextConsole = {
  log(...values: unknown[]): void;
  info?(...values: unknown[]): void;
  debug?(...values: unknown[]): void;
  error(...values: unknown[]): void;
  warn(...values: unknown[]): void;
};

export type ExecutionContextFileWatchHandle = {
  close(): void;
  ref(): void;
  unref(): void;
};

export type ExecutionContextFileWatchLifecycle = NodeFileWatchLifecycle;
type PendingThreadExecution = {
  readonly lease: ThreadExecutionLease;
  referenced: boolean;
};

function threadIdentityKey(identity: ThreadIdentity): string {
  return `${identity.pid}:${identity.threadId}`;
}

export class ExecutionContextRuntime {
  readonly engine: ModuleExecutionEngine;
  private readonly executionContext: BootstrappedExecutionContext;
  /** The Worker Threads this context started that have not finished. */
  private readonly workerThreads = new Map<string, PendingThreadExecution>();
  private readonly runtimeServices: ExecutionContextRuntimeServices;
  private readonly runtimeGlobal: typeof globalThis;
  private readonly workerIdleWaiters = new Set<() => void>();
  private tornDown = false;

  constructor(
    private readonly fs: ExecutionContextFileSystem,
    private readonly options: {
      cwd: string;
      /** Compiles every module this context loads. */
      compile: RuntimeArtifactCompile;
      process: ExecutionContextProcess;
      console: ExecutionContextConsole;
      childProcess: ChildProcessExecutionPort;
      synchronousChildProcess: SynchronousChildProcessExecutionPort;
      global?: typeof globalThis;
      /** Queues an unclamped macrotask and returns its cancellation. */
      queueMacrotask(callback: () => void): () => void;
      /** Conditions named on the command line. */
      conditions?: readonly string[];
      /** Runs the entry module as one event-loop turn. */
      runTurn?<T>(task: () => T): T;
      onModuleStart?(path: string, format: 'esm' | 'cjs'): void;
      onModuleEnd?(path: string, format: 'esm' | 'cjs'): void;
      runtimeServices?: ExecutionContextRuntimeServices;
      virtualNetwork: VirtualNetworkAuthority;
      fileSystemWatch?: NodeFileSystemWatchPort;
      fileWatchLifecycle?: ExecutionContextFileWatchLifecycle;
      referencedActivity?: ProcessExecutionActivityLifecycle;
      workerThreads: RuntimeWorkerThreads;
    }
  ) {
    this.runtimeGlobal = this.options.global ?? globalThis;
    this.runtimeServices =
      this.options.runtimeServices ?? createExecutionContextRuntimeServices();
    const process = this.options.process;
    this.executionContext = bootstrapExecutionContext({
      cwd: this.options.cwd,
      moduleAccess: this.fs,
      moduleResolution: {
        pnp:
          usesPnpLoader(this.options.process.env.NODE_OPTIONS) ||
          usesPnpLoader(this.options.process.execArgv.join(' ')),
        conditions: [
          ...configuredNodeConditions(this.options.process.env.NODE_OPTIONS),
          ...(this.options.conditions ?? [])
        ]
      },
      nodeCompatibility: {
        // `cwd` is read through the process so that it follows `process.chdir()`.
        childProcess: {
          get cwd() {
            return process.cwd();
          },
          env: this.options.process.env,
          parentPid: this.options.process.pid ?? 1,
          port: this.options.childProcess,
          synchronousPort: this.options.synchronousChildProcess,
          get execArgv() {
            return process.execArgv;
          },
          execPath: (process as { execPath?: string }).execPath,
          ipc: {
            ports: this.options.workerThreads.ports,
            activity: this.options.referencedActivity,
            nextTick: (callback: () => void) =>
              process.nextTick ? process.nextTick(callback) : queueMicrotask(callback)
          }
        },
        console: this.options.console,
        fileSystem: {
          asynchronous: this.fs,
          get cwd() {
            return process.cwd();
          },
          fileWatchLifecycle: this.options.fileWatchLifecycle,
          scheduler: this.runtimeGlobal,
          standardStreams: { write: (descriptor, bytes) => writeProcessStream(process, descriptor, bytes) },
          synchronous: this.fs,
          watch: this.options.fileSystemWatch,
          watchDiagnostics:
            this.options.process.env[NODE_FILE_SYSTEM_WATCH_TRACE_ENV] === '1'
              ? (event) => this.options.console.log(formatNodeFileSystemWatchTrace(event))
              : undefined
        },
        httpListenerClaims: (protocol) => this.runtimeServices.httpListenerClaims(protocol),
        referencedActivity: this.options.referencedActivity,
        runtimeGlobal: this.runtimeGlobal,
        queueMacrotask: this.options.queueMacrotask,
        threadExecutionPort: () => this.threadExecutionPort(),
        virtualNetwork: this.options.virtualNetwork,
        virtualNetworkOwnerId: String(this.options.process.pid ?? 'legacy-runtime'),
        wasiVfs: wasiVfsPort(this.fs),
        workerThreads: {
          current: this.options.workerThreads.current,
          get cwd() {
            return process.cwd();
          },
          env: this.options.process.env,
          activity: this.options.referencedActivity,
          ports: this.options.workerThreads.ports,
          sharedMemoryPool: this.options.workerThreads.sharedMemoryPool
        }
      },
      process: this.options.process,
      console: this.options.console,
      global: this.runtimeGlobal,
      runtimeArtifactCompiler: {
        compile: this.options.compile,
        buffer: BrowserBuffer,
        moduleSourceFooter: (filename) => this.runtimeServices.moduleSourceFooter(filename)
      },
      evaluateCommonJs: ({ main, evaluate }) =>
        main && this.options.runTurn ? this.options.runTurn(evaluate) : evaluate(),
      onModuleStart: this.options.onModuleStart,
      onModuleEnd: this.options.onModuleEnd
    });
    this.engine = this.executionContext.engine;
    // A worker thread shares its parent's process projection, which keeps the parent's entry.
    if (this.options.workerThreads.current.identity.threadId === 0) {
      Object.defineProperty(this.options.process, 'mainModule', {
        configurable: true,
        enumerable: true,
        get: () => this.engine.mainModule
      });
    }
  }

  teardown(): void {
    if (this.tornDown) return;
    this.tornDown = true;
    for (const { lease } of this.workerThreads.values()) {
      void lease.terminate().catch(() => undefined);
    }
    this.workerThreads.clear();
    this.resolveWorkerIdleWaiters();
    this.executionContext.teardown();
  }

  hasReferencedWorkerThreads(): boolean {
    return [...this.workerThreads.values()].some((execution) => execution.referenced);
  }

  waitForWorkerThreadsIdle(): Promise<void> {
    if (!this.hasReferencedWorkerThreads()) return Promise.resolve();
    return new Promise((resolve) => this.workerIdleWaiters.add(resolve));
  }

  /** Starts Worker Threads through the process worker, tracking which still keep this one alive. */
  private threadExecutionPort(): ThreadExecutionPort {
    const settle = (key: string) => {
      if (this.workerThreads.delete(key)) this.resolveWorkerIdleWaiters();
    };
    const delegate = this.options.workerThreads.execution;
    return {
      start: (request) => {
        const key = threadIdentityKey(request.identity);
        const lease = delegate.start({
          ...request,
          reportFailure: (reason) => {
            settle(key);
            request.reportFailure(reason);
          },
          reportExit: (code) => {
            settle(key);
            request.reportExit(code);
          }
        });
        const pending: PendingThreadExecution = { lease, referenced: true };
        this.workerThreads.set(key, pending);
        return {
          terminate: async () => {
            try {
              return await lease.terminate();
            } finally {
              settle(key);
            }
          },
          ref: () => {
            pending.referenced = true;
            lease.ref();
          },
          unref: () => {
            pending.referenced = false;
            lease.unref();
            this.resolveWorkerIdleWaiters();
          },
          hasRef: () => pending.referenced && lease.hasRef()
        };
      }
    };
  }

  private resolveWorkerIdleWaiters(): void {
    if (this.hasReferencedWorkerThreads()) return;
    for (const resolve of this.workerIdleWaiters) resolve();
    this.workerIdleWaiters.clear();
  }
}

function usesPnpLoader(nodeOptions: string | undefined): boolean {
  return nodeOptions !== undefined &&
    /(?:^|\s)(?:--require|-r)(?:=|\s+)\S*\.pnp\.c?js(?:\s|$)/.test(nodeOptions);
}

function configuredNodeConditions(nodeOptions: string | undefined): readonly string[] {
  if (!nodeOptions) return [];
  const conditions: string[] = [];
  const pattern = /(?:^|\s)(?:--conditions(?:=|\s+)|-C\s+)([^\s]+)/g;
  for (const match of nodeOptions.matchAll(pattern)) {
    for (const condition of match[1].split(',')) if (condition) conditions.push(condition);
  }
  return conditions;
}

/** Writes through the stream's own `write`, past one a program put on the instance. */
function writeProcessStream(process: ExecutionContextProcess, descriptor: 1 | 2, bytes: Uint8Array): void {
  const stream = descriptor === 1 ? process.stdout : process.stderr;
  if (!stream || typeof stream !== 'object') return;
  const write = (Object.getPrototypeOf(stream) as { write?: unknown } | null)?.write;
  if (typeof write === 'function') write.call(stream, bytes);
}
