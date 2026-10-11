import { EventEmitter } from './events';
import { BrowserBuffer, encodeBytes } from './buffer';
import { nodeErrorCodeFromDomain } from './domain-errors';
import { nodeStream as stream } from './streams';
import {
  attachIpcChannel,
  exposeIpcChannel,
  splitIpcStdio,
  validateIpcSerialization,
  type IpcChannel,
  type IpcChannelEnd
} from './ipc-channel';
import type { WorkerThreadPorts } from './worker-threads';
import type {
  ProcessExecutionChildOutputSink,
  ProcessExecutionChildRequest,
  ProcessExecutionChildSignal,
  ProcessExecutionChildStdio,
  ProcessExecutionChildStdioMode,
  ProcessExecutionSignal,
  ProcessExecutionSynchronousChildRequest,
  ProcessExecutionSynchronousChildResult
} from '../process-execution';

export interface ProcessExecutionActivityLifecycle {
  acquire(): () => void;
}

export interface ProcessExecutionChildHandle {
  readonly pid: number;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exit: Promise<{
    readonly code: number;
    readonly signal: ProcessExecutionChildSignal | null;
  }>;
  ref?(): void;
  unref?(): void;
  hasRef?(): boolean;
}

export interface ChildProcessExecutionPort {
  spawn(
    request: ProcessExecutionChildRequest
  ): Promise<ProcessExecutionChildHandle>;
  signal(pid: number, signal: ProcessExecutionChildSignal): Promise<boolean>;
}

export interface SynchronousChildProcessExecutionPort {
  spawnSync(
    request: ProcessExecutionSynchronousChildRequest
  ): ProcessExecutionSynchronousChildResult;
}

export interface ExecutionContextProcessProjection {
  register(
    pid: number,
    parentPid: number,
    stop: (signal: ProcessExecutionSignal) => void,
    closed: Promise<void>
  ): void;
  unregister(pid: number): void;
  /** Signals a registered process, or with `0` only reports whether it exists. */
  signal(pid: number, signal: ProcessExecutionSignal | 0): boolean;
  terminateDescendants(
    parentPid: number,
    signal: ProcessExecutionSignal
  ): Promise<void>;
}

export function createReferencedChildProcessExecutionPort(
  delegate: ChildProcessExecutionPort,
  activity: ProcessExecutionActivityLifecycle
): ChildProcessExecutionPort {
  return {
    spawn: async (request) => {
      let release: (() => void) | undefined = activity.acquire();
      let handle: ProcessExecutionChildHandle;
      try {
        handle = await delegate.spawn(request);
      } catch (error) {
        release();
        throw error;
      }
      let settled = false;
      const settle = () => {
        settled = true;
        release?.();
        release = undefined;
      };
      void handle.exit.then(settle, settle);
      return {
        ...handle,
        ref() {
          handle.ref?.();
          if (!settled) release ??= activity.acquire();
        },
        unref() {
          handle.unref?.();
          release?.();
          release = undefined;
        },
        hasRef: () => !settled && release !== undefined
      };
    },
    signal: (pid, signal) => delegate.signal(pid, signal)
  };
}

export function createExecutionContextProcessProjection(): ExecutionContextProcessProjection {
  const active = new Map<
    number,
    {
      readonly parentPid: number;
      stop(signal: ProcessExecutionSignal): void;
      readonly closed: Promise<void>;
    }
  >();
  const isDescendantOf = (pid: number, ancestorPid: number): boolean => {
    let currentPid = pid;
    while (true) {
      const process = active.get(currentPid);
      if (!process) return false;
      if (process.parentPid === ancestorPid) return true;
      currentPid = process.parentPid;
    }
  };
  return {
    register: (pid, parentPid, stop, closed) => {
      active.set(pid, { parentPid, stop, closed });
    },
    unregister: (pid) => {
      active.delete(pid);
    },
    signal: (pid, signal) => {
      const process = active.get(pid);
      if (!process) return false;
      if (signal !== 0) process.stop(signal);
      return true;
    },
    async terminateDescendants(parentPid, signal) {
      const descendants = [...active]
        .filter(([pid]) => isDescendantOf(pid, parentPid))
        .map(([, process]) => process);
      for (const process of descendants) process.stop(signal);
      // A descendant may handle the signal and keep running; it ends with its
      // parent all the same, after a moment to finish what its handler started.
      const escalation = signal === 'SIGKILL'
        ? undefined
        : setTimeout(() => {
            for (const process of descendants) process.stop('SIGKILL');
          }, DESCENDANT_SIGNAL_GRACE_MS);
      await Promise.all(descendants.map((process) => process.closed));
      if (escalation !== undefined) clearTimeout(escalation);
    }
  };
}

const DESCENDANT_SIGNAL_GRACE_MS = 1_000;

export const NODE_RUNTIME_STDIO_KIND = Symbol('Mimic.runtimeStdioKind');
export type NodeRuntimeStdioKind = 'stdin' | 'stdout' | 'stderr';

export interface ChildProcessBuiltinOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly parentPid: number;
  readonly port: ChildProcessExecutionPort;
  readonly synchronousPort?: SynchronousChildProcessExecutionPort;
  /** The thread's MessagePorts, which host the IPC channel of a child (`fork()`, `stdio: [..., 'ipc']`). */
  readonly ipc?: Readonly<{
    ports: WorkerThreadPorts;
    activity?: ProcessExecutionActivityLifecycle;
    nextTick(callback: () => void): void;
  }>;
  /** What `fork()` runs by default: `process.execPath` and `process.execArgv`. */
  readonly execPath?: string;
  readonly execArgv?: readonly string[];
}

export interface ChildProcessSpawnOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdio?: unknown;
  readonly shell?: boolean | string;
  readonly detached?: boolean;
  readonly serialization?: unknown;
}

export interface ChildProcessForkOptions extends ChildProcessSpawnOptions {
  readonly execPath?: string;
  readonly execArgv?: readonly string[];
  readonly silent?: boolean;
}

export interface ChildProcessSpawnSyncOptions
  extends ChildProcessSpawnOptions {
  readonly input?: Uint8Array | ArrayBuffer | ArrayBufferView | string;
  readonly encoding?: string | null;
  readonly timeout?: number;
  readonly killSignal?: ProcessExecutionChildSignal;
  readonly maxBuffer?: number;
}

export type NodeChildProcessSyncResult = {
  readonly pid?: number;
  readonly status: number | null;
  readonly signal: ProcessExecutionChildSignal | null;
  readonly stdout: Uint8Array | string | null;
  readonly stderr: Uint8Array | string | null;
  readonly output: readonly [null, Uint8Array | string | null, Uint8Array | string | null];
  readonly error?: NodeChildProcessError;
};

export type NodeChildProcess = EventEmitter & {
  readonly stdin: NodeChildProcessInput | null;
  readonly stdout: NodeChildProcessOutput | null;
  readonly stderr: NodeChildProcessOutput | null;
  readonly stdio: readonly [
    NodeChildProcessInput | null,
    NodeChildProcessOutput | null,
    NodeChildProcessOutput | null
  ];
  pid: number | undefined;
  killed: boolean;
  exitCode: number | null;
  signalCode: ProcessExecutionChildSignal | null;
  kill(signal?: ProcessExecutionChildSignal): boolean;
  ref(): NodeChildProcess;
  unref(): NodeChildProcess;
};

export type NodeChildProcessInput = EventEmitter & {
  write(chunk: Uint8Array | ArrayBuffer | ArrayBufferView | string, callback?: (error?: Error | null) => void): boolean;
  end(chunk?: Uint8Array | ArrayBuffer | ArrayBufferView | string, callback?: (error?: Error | null) => void): NodeChildProcessInput;
  destroy(error?: Error): NodeChildProcessInput;
};

export type NodeChildProcessOutput = EventEmitter & {
  readable: boolean;
  readableEnded: boolean;
  setEncoding(encoding: string): NodeChildProcessOutput;
  destroy(): NodeChildProcessOutput;
  pause(): NodeChildProcessOutput;
  resume(): NodeChildProcessOutput;
  pipe(destination: ChildProcessPipeDestination): unknown;
};

type ChildProcessPipeDestination = {
  write(chunk: unknown): unknown;
  end?(): unknown;
  once?(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
  off?(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
};

export type ChildProcessBuiltin = {
  readonly ChildProcess: typeof ChildProcess;
  readonly spawn: (
    command: string,
    argsOrOptions?: readonly string[] | ChildProcessSpawnOptions,
    options?: ChildProcessSpawnOptions
  ) => NodeChildProcess;
  readonly exec: (command: string, ...rest: readonly unknown[]) => NodeChildProcess;
  readonly execFile: (file: string, ...rest: readonly unknown[]) => NodeChildProcess;
  readonly execSync: (...args: readonly unknown[]) => never;
  readonly execFileSync: (
    command: string,
    argsOrOptions?: readonly string[] | ChildProcessSpawnSyncOptions,
    options?: ChildProcessSpawnSyncOptions
  ) => Uint8Array | string | null;
  readonly fork: (
    modulePath: string | URL,
    argsOrOptions?: readonly string[] | ChildProcessForkOptions,
    options?: ChildProcessForkOptions
  ) => NodeChildProcess;
  readonly spawnSync: (
    command: string,
    argsOrOptions?: readonly string[] | ChildProcessSpawnSyncOptions,
    options?: ChildProcessSpawnSyncOptions
  ) => NodeChildProcessSyncResult;
  readonly default: ChildProcessBuiltin;
};

export class NodeChildProcessError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'NodeChildProcessError';
  }
}

export class ChildProcess extends EventEmitter implements NodeChildProcess {
  readonly stdin: NodeChildProcessInput | null = null;
  readonly stdout: NodeChildProcessOutput | null = null;
  readonly stderr: NodeChildProcessOutput | null = null;
  readonly stdio: readonly [
    NodeChildProcessInput | null,
    NodeChildProcessOutput | null,
    NodeChildProcessOutput | null
  ] = [null, null, null];
  pid: number | undefined;
  killed = false;
  exitCode: number | null = null;
  signalCode: ProcessExecutionChildSignal | null = null;
  /** True while an IPC channel to the child is open; a child spawned without one has none. */
  connected = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}

/** Creates the context-local Node-shaped child_process builtin over Process Execution. */
export function createChildProcessBuiltin(options: ChildProcessBuiltinOptions): ChildProcessBuiltin {
  const unsupported = (operation: string): never => {
    throw new NodeChildProcessError('ENOTSUP', `child_process.${operation}() is not supported in Mimic yet.`);
  };
  const spawn = (
    command: string,
    argsOrOptions: readonly string[] | ChildProcessSpawnOptions = [],
    suppliedOptions: ChildProcessSpawnOptions = {}
  ): NodeChildProcess => {
    const usesArgumentList = isStringArray(argsOrOptions);
    const spawnOptions = usesArgumentList ? suppliedOptions : argsOrOptions;
    assertSupportedSpawnOptions(spawnOptions);
    const invocation = shellInvocation(command, usesArgumentList ? argsOrOptions : [], spawnOptions.shell);
    const requested = splitIpcStdio(spawnOptions.stdio);
    const serialization = validateIpcSerialization(spawnOptions.serialization);
    const stdio = normalizeChildStdio(requested.stdio);
    const ipc = requested.ipc ? hostIpcChannel(serialization) : undefined;
    const child = new ChildProcessProjection(options.port, stdio, ipc?.attach);
    void child.admit({
      command: invocation.command,
      args: invocation.args,
      cwd: spawnOptions.cwd ?? options.cwd,
      env: { ...(spawnOptions.env ?? options.env) },
      stdio,
      parentPid: options.parentPid,
      ...(ipc ? { ipc: ipc.end } : {})
    });
    return child;
  };
  /**
   * Hosts the pair of an IPC channel in this thread's port relay before the
   * child exists, so what the parent sends at once waits for the child there.
   */
  const hostIpcChannel = (serialization: IpcChannelEnd['serialization']): {
    readonly end: IpcChannelEnd;
    attach(target: EventEmitter): IpcChannel;
  } => {
    const ports = options.ipc;
    if (!ports) {
      throw new NodeChildProcessError('ENOTSUP', 'child_process IPC channels are not available in this context.');
    }
    const parentEnd = ports.ports.createId();
    const childEnd = ports.ports.createId();
    ports.ports.host(parentEnd, childEnd, []);
    return {
      end: { port: childEnd, serialization },
      attach: (target) =>
        attachIpcChannel(target, {
          ports: ports.ports,
          port: parentEnd,
          serialization,
          activity: ports.activity,
          nextTick: ports.nextTick
        })
    };
  };
  const fork = (
    modulePath: string | URL,
    argsOrOptions: readonly string[] | ChildProcessForkOptions = [],
    suppliedOptions: ChildProcessForkOptions = {}
  ): NodeChildProcess => {
    const path = modulePath instanceof URL ? decodeURIComponent(modulePath.pathname) : modulePath;
    if (typeof path !== 'string') {
      throw Object.assign(
        new TypeError('The "modulePath" argument must be of type string or an instance of URL.'),
        { code: 'ERR_INVALID_ARG_TYPE' }
      );
    }
    const usesArgumentList = Array.isArray(argsOrOptions);
    const args = usesArgumentList ? argsOrOptions : [];
    const forkOptions = (usesArgumentList ? suppliedOptions : argsOrOptions) as ChildProcessForkOptions;
    if (!isStringArray(args)) {
      throw new NodeChildProcessError('ERR_INVALID_ARG_TYPE', 'The "args" argument must be an array of strings.');
    }
    // Node's defaults: the parent's stdio, or pipes when silent, and the IPC channel.
    let stdio = forkOptions.stdio ?? (forkOptions.silent ? 'pipe' : 'inherit');
    if (typeof stdio === 'string') stdio = [stdio, stdio, stdio, 'ipc'];
    if (!Array.isArray(stdio) || !stdio.includes('ipc')) {
      throw new NodeChildProcessError('ERR_CHILD_PROCESS_IPC_REQUIRED', "Forked processes must have an IPC channel, missing value 'ipc' in options.stdio");
    }
    return spawn(
      forkOptions.execPath ?? options.execPath ?? 'node',
      [...(forkOptions.execArgv ?? options.execArgv ?? []), path, ...args],
      { ...forkOptions, stdio, shell: false }
    );
  };
  const spawnSync = (
    command: string,
    argsOrOptions: readonly string[] | ChildProcessSpawnSyncOptions = [],
    suppliedOptions: ChildProcessSpawnSyncOptions = {}
  ): NodeChildProcessSyncResult => {
    const synchronousPort = options.synchronousPort;
    if (!synchronousPort) return unsupported('spawnSync');
    const usesArgumentList = isStringArray(argsOrOptions);
    const spawnOptions = usesArgumentList ? suppliedOptions : argsOrOptions;
    assertSupportedSpawnOptions(spawnOptions);
    const invocation = shellInvocation(command, usesArgumentList ? argsOrOptions : [], spawnOptions.shell);
    const { stdio, sinks } = normalizeSynchronousChildStdio(spawnOptions.stdio);
    const result = synchronousPort.spawnSync({
      command: invocation.command,
      args: invocation.args,
      cwd: spawnOptions.cwd ?? options.cwd,
      env: { ...(spawnOptions.env ?? options.env) },
      input:
        spawnOptions.input === undefined
          ? new Uint8Array()
          : bytes(spawnOptions.input, spawnOptions.encoding),
      stdio,
      timeout: nonNegativeInteger(spawnOptions.timeout, 0, 'timeout'),
      killSignal: spawnOptions.killSignal ?? 'SIGTERM',
      maxBuffer: positiveInteger(spawnOptions.maxBuffer, 1024 * 1024, 'maxBuffer'),
      parentPid: options.parentPid
    });
    return projectSynchronousResult(deliverSynchronousOutput(result, sinks), spawnOptions.encoding);
  };
  const execFileSync = (
    command: string,
    argsOrOptions: readonly string[] | ChildProcessSpawnSyncOptions = [],
    suppliedOptions: ChildProcessSpawnSyncOptions = {}
  ): Uint8Array | string | null => {
    const result = spawnSync(command, argsOrOptions, suppliedOptions);
    if (result.error || result.status !== 0 || result.signal !== null) {
      throw execFileSyncError(command, result);
    }
    return result.stdout;
  };
  // `execFile(file[, args][, options][, callback])`: a spawn whose whole output
  // is handed to the callback once the child has closed.
  const execFile = (file: string, ...rest: readonly unknown[]): NodeChildProcess => {
    const callback = rest.find((entry): entry is ExecCallback => typeof entry === 'function');
    const args = rest.find(isExecArguments) ?? [];
    const execOptions = (rest.find(
      (entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    ) ?? {}) as ChildProcessSpawnOptions & { readonly encoding?: string | null };
    const { encoding = 'utf8', ...spawnOptions } = execOptions;
    const child = spawn(file, args, spawnOptions);
    const chunks = { stdout: [] as Uint8Array[], stderr: [] as Uint8Array[] };
    const collect = (name: 'stdout' | 'stderr'): void => {
      child[name]?.on('data', (chunk: Uint8Array | string) => {
        chunks[name].push(typeof chunk === 'string' ? BrowserBuffer.from(chunk) : chunk);
      });
    };
    collect('stdout');
    collect('stderr');
    const output = (name: 'stdout' | 'stderr'): Uint8Array | string => {
      const all = BrowserBuffer.concat(chunks[name]);
      return encoding === null || encoding === 'buffer' ? all : all.toString(encoding);
    };
    let failure: Error | undefined;
    child.once('error', (error: Error) => {
      failure = error;
    });
    child.once('close', (code: number | null, signal: ProcessExecutionChildSignal | null) => {
      const command = [file, ...args].join(' ');
      const error =
        failure ??
        (code === 0 && signal === null
          ? null
          : Object.assign(new Error(`Command failed: ${command}\n${String(output('stderr'))}`), {
              code,
              killed: child.killed,
              signal,
              cmd: command
            }));
      callback?.(error, output('stdout'), output('stderr'));
    });
    return child;
  };
  const exec = (command: string, ...rest: readonly unknown[]): NodeChildProcess =>
    execFile('sh', ['-c', command], ...rest.filter((entry) => !isExecArguments(entry)));
  const builtin = {
    ChildProcess,
    spawn,
    exec,
    execFile,
    // `execSync(command[, options])`: the command line through a shell, as `exec` runs it.
    execSync: (command: string, execOptions: ChildProcessSpawnSyncOptions = {}) =>
      execFileSync(command, [], { ...execOptions, shell: execOptions.shell ?? true }),
    execFileSync,
    fork,
    spawnSync
  } as Omit<ChildProcessBuiltin, 'default'>;
  return Object.assign(builtin, { default: builtin }) as ChildProcessBuiltin;
}

type ChildProcessInputProjection = NodeChildProcessInput & {
  attach(stream: WritableStream<Uint8Array>): void;
  fail(error: Error): void;
};

type ChildProcessOutputProjection = NodeChildProcessOutput & {
  readonly finished: Promise<void>;
  attach(stream: ReadableStream<Uint8Array>): void;
  fail(): void;
};

class ChildProcessProjection extends ChildProcess {
  override readonly stdin: ChildProcessInputProjection | null;
  override readonly stdout: ChildProcessOutputProjection | null;
  override readonly stderr: ChildProcessOutputProjection | null;
  override readonly stdio: readonly [
    ChildProcessInputProjection | null,
    ChildProcessOutputProjection | null,
    ChildProcessOutputProjection | null
  ];
  override pid: number | undefined = undefined;
  override killed = false;
  override exitCode: number | null = null;
  override signalCode: ProcessExecutionChildSignal | null = null;
  #settled = false;
  #pendingSignal: ProcessExecutionChildSignal | undefined;
  #handle: ProcessExecutionChildHandle | undefined;
  #referenced = true;
  readonly #ipc: IpcChannel | undefined;

  constructor(
    private readonly port: ChildProcessExecutionPort,
    stdio: ProcessExecutionChildStdio,
    ipc?: (target: EventEmitter) => IpcChannel
  ) {
    super();
    this.stdin = stdio.stdin === 'pipe' ? createChildProcessInputProjection() : null;
    this.stdout = stdio.stdout === 'pipe' ? createChildProcessOutputProjection() : null;
    this.stderr = stdio.stderr === 'pipe' ? createChildProcessOutputProjection() : null;
    this.stdio = [this.stdin, this.stdout, this.stderr];
    this.#ipc = ipc?.(this);
    if (this.#ipc) exposeIpcChannel(this, this.#ipc);
  }

  async admit(request: ProcessExecutionChildRequest): Promise<void> {
    let outcome: Awaited<ProcessExecutionChildHandle['exit']>;
    try {
      const handle = await this.port.spawn(request);
      if (this.#settled) return;
      this.#handle = handle;
      if (!this.#referenced) handle.unref?.();
      this.pid = handle.pid;
      this.stdin?.attach(handle.stdin);
      this.stdout?.attach(handle.stdout);
      this.stderr?.attach(handle.stderr);
      if (this.#pendingSignal) this.requestSignal(handle.pid, this.#pendingSignal);
      this.emitFromLoop('spawn');
      outcome = await handle.exit;
      await Promise.all([this.stdout?.finished, this.stderr?.finished]);
    } catch (error) {
      this.fail(toNodeChildProcessError(error, request.command));
      return;
    }
    this.close(outcome.code, outcome.signal);
  }

  /**
   * Emits a lifecycle event as the event loop does in Node: what a listener
   * throws is an uncaught exception of the process, never a failure of the
   * child (node-pre-gyp continues its build from a 'close' listener).
   */
  private emitFromLoop(event: string, ...args: unknown[]): void {
    try {
      this.emit(event, ...args);
    } catch (error) {
      queueMicrotask(() => {
        throw error;
      });
    }
  }

  override kill(signal: ProcessExecutionChildSignal = 'SIGTERM'): boolean {
    if (this.#settled || this.#pendingSignal) return false;
    this.killed = true;
    this.#pendingSignal = signal;
    if (this.pid !== undefined) this.requestSignal(this.pid, signal);
    return true;
  }

  override ref(): this {
    this.#referenced = true;
    this.#handle?.ref?.();
    return this;
  }

  override unref(): this {
    this.#referenced = false;
    this.#handle?.unref?.();
    return this;
  }

  private close(code: number, signal: ProcessExecutionChildSignal | null): void {
    if (this.#settled) return;
    this.#settled = true;
    // The channel ends with the child, whether or not the child listened to it;
    // as in Node, `close` waits for it as it waits for the child's stdio.
    const disconnected = this.#ipc?.close();
    this.exitCode = signal ? null : code;
    this.signalCode = signal;
    this.emitFromLoop('exit', this.exitCode, signal);
    if (!disconnected) {
      this.emitFromLoop('close', this.exitCode, signal);
      return;
    }
    void disconnected.then(() => this.emitFromLoop('close', this.exitCode, signal));
  }

  private fail(error: NodeChildProcessError): void {
    if (this.#settled) return;
    this.#settled = true;
    void this.#ipc?.close();
    this.exitCode = 1;
    this.stdin?.fail(error);
    this.stdout?.fail();
    this.stderr?.fail();
    this.emitFromLoop('error', error);
    this.emitFromLoop('close', 1, null);
  }

  private requestSignal(pid: number, signal: ProcessExecutionChildSignal): void {
    void this.port.signal(pid, signal).then(
      (accepted) => {
        if (!accepted) this.reportSignalError(new NodeChildProcessError('ESRCH', `Process Execution rejected ${signal} for child ${pid}.`));
      },
      (error: unknown) => this.reportSignalError(toNodeChildProcessError(error))
    );
  }

  private reportSignalError(error: NodeChildProcessError): void {
    if (this.#settled) return;
    this.killed = false;
    this.#pendingSignal = undefined;
    this.emit('error', error);
  }
}

function createChildProcessInputProjection(): ChildProcessInputProjection {
  class ChildProcessInputProjection extends stream.Writable implements NodeChildProcessInput {
    #writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
    #writerResolve!: (writer: WritableStreamDefaultWriter<Uint8Array>) => void;
    #writerReject!: (error: Error) => void;
    readonly #writerReady = new Promise<WritableStreamDefaultWriter<Uint8Array>>((resolve, reject) => {
      this.#writerResolve = resolve;
      this.#writerReject = reject;
    });

    constructor() {
      super({
        highWaterMark: 16 * 1024,
        write(chunk, _encoding, callback) {
          void (this as ChildProcessInputProjection).writeToChild(chunk, callback);
        },
        final(callback) {
          void (this as ChildProcessInputProjection).closeChildInput(callback);
        },
        destroy(error, callback) {
          const writer = (this as ChildProcessInputProjection).#writer;
          if (!writer) {
            callback(error);
            return;
          }
          void writer.abort(error).catch((abortError: unknown) => {
            (this as ChildProcessInputProjection).emit('error', toNodeChildProcessError(abortError));
          });
          callback(error);
        }
      });
    }

    attach(target: WritableStream<Uint8Array>): void {
      const writer = target.getWriter();
      if (this.destroyed) {
        void writer.abort().catch((error: unknown) => this.emit('error', toNodeChildProcessError(error)));
        return;
      }
      this.#writer = writer;
      this.#writerResolve(writer);
    }

    /** Fails the writes waiting for admission with the admission's error. */
    fail(error: Error): void {
      if (this.listenerCount('error') === 0) this.once('error', () => undefined);
      this.#writerReady.catch(() => undefined);
      this.#writerReject(error);
      this.destroy(error);
    }

    private async writeToChild(chunk: unknown, callback: (error?: Error | null) => void): Promise<void> {
      try {
        const writer = await this.#writerReady;
        if (this.destroyed) throw new NodeChildProcessError('EPIPE', 'Child process stdin is closed.');
        await writer.write(bytes(chunk, undefined));
        // A write the child took after its stdin was destroyed did not reach it.
        if (this.destroyed) throw new NodeChildProcessError('EPIPE', 'Child process stdin is closed.');
        callback();
      } catch (error) {
        callback(toNodeChildProcessError(error));
      }
    }

    private async closeChildInput(callback: (error?: Error | null) => void): Promise<void> {
      try {
        const writer = await this.#writerReady;
        if (this.destroyed) throw new NodeChildProcessError('EPIPE', 'Child process stdin is closed.');
        await writer.close();
        callback();
      } catch (error) {
        callback(toNodeChildProcessError(error));
      }
    }
  }
  return new ChildProcessInputProjection();
}

function createChildProcessOutputProjection(): ChildProcessOutputProjection {
  class ChildProcessOutputProjection extends stream.Readable implements NodeChildProcessOutput {
    #reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    #pumping = false;
    #finished = false;
    #finishedResolve!: () => void;
    readonly finished = new Promise<void>((resolve) => {
      this.#finishedResolve = resolve;
    });

    constructor() {
      super({
        highWaterMark: 64 * 1024,
        read() {
          void (this as ChildProcessOutputProjection).pump();
        },
        destroy(error, callback) {
          const target = this as ChildProcessOutputProjection;
          const reader = target.#reader;
          callback(error);
          if (!reader) return;
          void reader.cancel().then(
            () => target.finish(),
            (cancelError: unknown) => {
              if (!(target as typeof target & { errored?: Error | null }).errored) {
                target.emit('error', toNodeChildProcessError(cancelError));
              }
              target.finish();
            }
          );
        }
      });
    }

    attach(source: ReadableStream<Uint8Array>): void {
      if (this.destroyed) {
        void source.cancel().then(
          () => this.finish(),
          (error: unknown) => {
            this.emit('error', toNodeChildProcessError(error));
            this.finish();
          }
        );
        return;
      }
      this.#reader = source.getReader();
      void this.pump();
    }

    fail(): void {
      this.destroy();
      this.finish();
    }

    private async pump(): Promise<void> {
      if (this.#pumping || !this.#reader || this.destroyed || this.readableEnded) return;
      this.#pumping = true;
      try {
        while (!this.destroyed) {
          const { done, value } = await this.#reader.read();
          if (done) {
            this.push(null);
            this.finish();
            return;
          }
          if (!this.push(BrowserBuffer.from(value))) return;
        }
      } catch (error) {
        this.destroy(toNodeChildProcessError(error));
        this.finish();
      } finally {
        this.#pumping = false;
      }
    }

    private finish(): void {
      if (this.#finished) return;
      this.#finished = true;
      this.#finishedResolve();
    }
  }
  return new ChildProcessOutputProjection();
}

/**
 * `shell: true` runs the command line through `sh -c`, with the arguments
 * joined by spaces as Node joins them; the only shell here is `sh`, whatever
 * path the caller names. `detached` asks for a process group of the child's
 * own; processes have no groups here, so it changes nothing.
 */
function assertSupportedSpawnOptions(_options: ChildProcessSpawnOptions): void {}

function shellInvocation(
  command: string,
  args: readonly string[],
  shell: boolean | string | undefined
): { readonly command: string; readonly args: readonly string[] } {
  if (!shell) return { command, args: [...args] };
  return { command: 'sh', args: ['-c', [command, ...args].join(' ')] };
}

function normalizeChildStdio(stdio: unknown): ProcessExecutionChildStdio {
  const entries = stdio === undefined ? ['pipe', 'pipe', 'pipe'] : typeof stdio === 'string' ? [stdio, stdio, stdio] : stdio;
  if (!Array.isArray(entries) || entries.length > 3) {
    throw new NodeChildProcessError('ENOTSUP', `child_process stdio is not supported: ${String(stdio)}`);
  }
  return {
    stdin: normalizeStdioEntry(entries[0], 0) as ProcessExecutionChildStdioMode,
    stdout: normalizeStdioEntry(entries[1], 1),
    stderr: normalizeStdioEntry(entries[2], 2)
  };
}

/**
 * The modes a synchronous child runs with. An output given as a stream (the
 * parent's stderr for the child's stdout, say) is piped, and what the child
 * wrote is written to that stream once it ended: nothing of the parent runs
 * meanwhile, so nothing else could have written between.
 */
function normalizeSynchronousChildStdio(
  stdio: unknown
): Readonly<{
  readonly stdio: Readonly<{
    readonly stdin: ProcessExecutionChildStdioMode;
    readonly stdout: ProcessExecutionChildStdioMode;
    readonly stderr: ProcessExecutionChildStdioMode;
  }>;
  readonly sinks: Readonly<{
    readonly stdout?: ProcessExecutionChildOutputSink;
    readonly stderr?: ProcessExecutionChildOutputSink;
  }>;
}> {
  const normalized = normalizeChildStdio(stdio);
  const mode = (entry: ProcessExecutionChildStdioMode | ProcessExecutionChildOutputSink) =>
    typeof entry === 'object' ? 'pipe' : entry;
  return {
    stdio: { stdin: normalized.stdin, stdout: mode(normalized.stdout), stderr: mode(normalized.stderr) },
    sinks: {
      ...(typeof normalized.stdout === 'object' ? { stdout: normalized.stdout } : {}),
      ...(typeof normalized.stderr === 'object' ? { stderr: normalized.stderr } : {})
    }
  };
}

/** Writes a synchronous child's output to the streams it was given, which then hold none of it. */
function deliverSynchronousOutput(
  result: ProcessExecutionSynchronousChildResult,
  sinks: Readonly<{ readonly stdout?: ProcessExecutionChildOutputSink; readonly stderr?: ProcessExecutionChildOutputSink }>
): ProcessExecutionSynchronousChildResult {
  let delivered = result;
  for (const name of ['stdout', 'stderr'] as const) {
    const sink = sinks[name];
    if (!sink) continue;
    const output = result[name];
    if (output && output.byteLength > 0) sink.write(output);
    delivered = { ...delivered, [name]: null };
  }
  return delivered;
}

function projectSynchronousResult(
  result: ProcessExecutionSynchronousChildResult,
  encoding: string | null | undefined
): NodeChildProcessSyncResult {
  const projectOutput = (value: Uint8Array | null): Uint8Array | string | null => {
    if (value === null) return null;
    return encoding === undefined || encoding === null || encoding === 'buffer'
      ? BrowserBuffer.from(value)
      : encodeBytes(value, encoding);
  };
  const stdout = projectOutput(result.stdout);
  const stderr = projectOutput(result.stderr);
  return {
    ...(result.pid === undefined ? {} : { pid: result.pid }),
    status: result.status,
    signal: result.signal,
    stdout,
    stderr,
    output: [null, stdout, stderr],
    ...(result.error
      ? {
          error: new NodeChildProcessError(
            nodeErrorCodeFromDomain('process-execution', result.error.code) ??
              result.error.code,
            result.error.message
          )
        }
      : {})
  };
}

function execFileSyncError(
  command: string,
  result: NodeChildProcessSyncResult
): Error {
  const stderr = result.stderr === null ? '' : String(result.stderr);
  const error = new Error(
    result.error?.message ??
      `Command failed: ${command}${stderr ? `\n${stderr}` : ''}`
  );
  return Object.assign(error, {
    ...(result.error ? { code: result.error.code } : {}),
    pid: result.pid,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    output: result.output
  });
}

function nonNegativeInteger(
  value: number | undefined,
  fallback: number,
  name: string
): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < 0) {
    throw new NodeChildProcessError(
      'ERR_OUT_OF_RANGE',
      `The "${name}" option must be a non-negative integer.`
    );
  }
  return normalized;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string
): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < 1) {
    throw new NodeChildProcessError(
      'ERR_OUT_OF_RANGE',
      `The "${name}" option must be a positive integer.`
    );
  }
  return normalized;
}

function normalizeStdioEntry(
  entryOrUndefined: unknown,
  index: 0 | 1 | 2
): ProcessExecutionChildStdioMode | ProcessExecutionChildOutputSink {
  const entry = entryOrUndefined ?? 'pipe';
  if (entry === 'pipe' || entry === 'inherit' || entry === 'ignore') return entry;
  if (entry === index) return 'inherit';
  const expectedKind: NodeRuntimeStdioKind = index === 0 ? 'stdin' : index === 1 ? 'stdout' : 'stderr';
  if (
    entry !== null &&
    typeof entry === 'object' &&
    (entry as { [NODE_RUNTIME_STDIO_KIND]?: unknown })[NODE_RUNTIME_STDIO_KIND] === expectedKind
  ) {
    return 'inherit';
  }
  if (
    index > 0 &&
    entry !== null &&
    typeof entry === 'object' &&
    typeof (entry as { write?: unknown }).write === 'function'
  ) {
    const output = entry as { write(chunk: unknown): unknown };
    return {
      write(chunk) {
        output.write(BrowserBuffer.from(chunk));
      }
    };
  }
  throw new NodeChildProcessError('ENOTSUP', `child_process stdio is not supported: ${String(entry)}`);
}

function isStringArray(value: readonly string[] | ChildProcessSpawnOptions): value is readonly string[] {
  if (!Array.isArray(value)) return false;
  if (value.every((entry) => typeof entry === 'string')) return true;
  throw new NodeChildProcessError('ERR_INVALID_ARG_TYPE', 'The "args" argument must be an array of strings.');
}

function bytes(
  value: unknown,
  encoding: string | null | undefined
): Uint8Array {
  if (typeof value === 'string') {
    return new Uint8Array(BrowserBuffer.from(value, encoding ?? 'utf8'));
  }
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  throw new NodeChildProcessError('ERR_INVALID_ARG_TYPE', 'The stream chunk must be a string, Buffer, ArrayBuffer, or ArrayBufferView.');
}

function isExecArguments(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

type ExecCallback = (error: Error | null, stdout: Uint8Array | string, stderr: Uint8Array | string) => void;

function toNodeChildProcessError(error: unknown, command?: string): NodeChildProcessError {
  if (error instanceof NodeChildProcessError) return error;
  const message = error instanceof Error ? error.message : String(error);
  // A refused spawn carries its Process Execution code; a missing executable
  // (`EXECUTABLE_NOT_FOUND`) becomes Node's `spawn <command> ENOENT`, which
  // callers test for before falling back to another tool.
  const domainCode =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'ERR_PROCESS_EXECUTION';
  const code = nodeErrorCodeFromDomain('process-execution', domainCode) ?? domainCode;
  if (code !== 'ENOENT' || command === undefined) return new NodeChildProcessError(code, message);
  return Object.assign(new NodeChildProcessError(code, `spawn ${command} ENOENT`), {
    errno: -2,
    syscall: `spawn ${command}`,
    path: command
  });
}
