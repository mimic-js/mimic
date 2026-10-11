import type { ProcessInput } from '../process-execution';
import { VIRTUAL_PLATFORM } from './runtime-platform-profile';
import { BrowserBuffer } from './buffer';
import { NODE_RUNTIME_STDIO_KIND, type NodeRuntimeStdioKind } from './child-process';
import { NODE_ERRNO_CONSTANTS, NODE_FS_CONSTANTS } from './constants';
import { EventEmitter } from './events';
import { NODE_HTTP_METHODS } from './http-methods';
import { nodeStream as stream, type NodeReadableStream, type NodeWritableStream } from './streams';

type OutputSink = (chunk: string | Uint8Array) => void | Promise<void>;
type WriteCallback = (error?: Error) => void;
type HrtimeTuple = [seconds: number, nanoseconds: number];

export interface NodeProcessOptions {
  readonly argv: readonly string[];
  readonly execArgv: readonly string[];
  readonly env: Record<string, string>;
  readonly pid: number;
  readonly ppid: number;
  readonly cwd: string;
  readonly title?: string;
  readonly nextTick: (callback: (...args: unknown[]) => unknown, ...args: unknown[]) => void;
  readonly stdio: {
    readonly input?: ProcessInput;
    readonly writeOutput: OutputSink;
    readonly writeError: OutputSink;
    /** False once the process may no longer read or write. */
    isActive(): boolean;
    /** Keeps the process alive while a read of its input is pending, as Node's stdin handle does. */
    readonly readActivity?: { acquire(): () => void };
  };
  readonly warnings?: {
    readonly disabled?: boolean;
    readonly deprecationsDisabled?: boolean;
  };
  readonly host: {
    /** Ends the process; it does not return. */
    exit(code: number): never;
    /** Signals another process; false when no such process exists. */
    kill(pid: number, signal: string): boolean;
    /** Signals this process. */
    raise(signal: string): void;
    /** Resolves a `chdir` target to an existing directory, or throws. */
    resolveDirectory(path: string, cwd: string): string;
  };
}

export type NodeProcessWriteStream = NodeWritableStream & {
  readonly fd: number;
  readonly isTTY: boolean;
  columns: number;
  rows: number;
};

export type NodeProcessReadStream = NodeReadableStream & {
  readonly fd: number;
  readonly isTTY: boolean;
  isRaw: boolean;
  setRawMode(mode: boolean): NodeProcessReadStream;
  ref(): NodeProcessReadStream;
  unref(): NodeProcessReadStream;
};

/**
 * Component versions the Node release index lists for the profiled Node
 * release, and the version of the browser-hosted runtime itself under the key
 * WebContainers use, `webcontainer`, which a program reads to take the path
 * it keeps for a Node that runs in a browser (ADR-0045).
 */
const RUNTIME_VERSIONS = {
  node: VIRTUAL_PLATFORM.nodeVersion,
  v8: '12.4.254.21',
  uv: '1.51.0',
  modules: '127',
  zlib: '1.3.1',
  napi: '10',
  webcontainer: VIRTUAL_PLATFORM.runtimeVersion
} as const;

const SIGNAL_NUMBERS: Readonly<Record<string, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGABRT: 6,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
  SIGCONT: 18,
  SIGSTOP: 19,
  SIGTSTP: 20,
  SIGWINCH: 28
};

function processError(code: string, message: string, ErrorType: ErrorConstructor = Error): Error {
  return Object.assign(new ErrorType(message), { code });
}

function elapsedMilliseconds(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function createHrtime(): ((previous?: HrtimeTuple) => HrtimeTuple) & { bigint(): bigint } {
  let latest = 0n;
  const bigint = () => {
    const elapsed = BigInt(Math.max(0, Math.floor(elapsedMilliseconds() * 1_000_000)));
    if (elapsed > latest) latest = elapsed;
    return latest;
  };
  return Object.assign(
    (previous?: HrtimeTuple): HrtimeTuple => {
      const now = bigint();
      const start = previous ? BigInt(previous[0]) * 1_000_000_000n + BigInt(previous[1]) : 0n;
      const elapsed = now >= start ? now - start : 0n;
      return [Number(elapsed / 1_000_000_000n), Number(elapsed % 1_000_000_000n)];
    },
    { bigint }
  );
}

function createMemoryUsage() {
  const memoryUsage = Object.assign(
    () => {
      const memory = typeof performance === 'undefined' ? undefined : Reflect.get(performance, 'memory');
      const metric = (name: string) => {
        const value = memory && typeof memory === 'object' ? Reflect.get(memory, name) : 0;
        return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
      };
      const heapTotal = metric('totalJSHeapSize');
      return {
        rss: heapTotal,
        heapTotal,
        heapUsed: metric('usedJSHeapSize'),
        external: 0,
        arrayBuffers: 0
      };
    },
    { rss: () => memoryUsage().rss }
  );
  return memoryUsage;
}

/** Text stays text for the process writer; only another encoding has to become bytes here. */
function outputChunk(chunk: unknown, encoding?: unknown): string | Uint8Array {
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  // A plain view, never the caller's Buffer: process writers copy with
  // `slice()`, which on a Buffer would only alias the caller's memory.
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const text = String(chunk);
  return typeof encoding === 'string' && encoding !== 'utf8' && encoding !== 'utf-8' && encoding !== 'buffer'
    ? BrowserBuffer.from(text, encoding)
    : text;
}

function createWriteStream(
  options: NodeProcessOptions,
  kind: Exclude<NodeRuntimeStdioKind, 'stdin'>,
  fd: number,
  sink: OutputSink
): NodeProcessWriteStream {
  let pendingBytes = 0;
  let needDrain = false;

  /**
   * Stdout and stderr hand each chunk to the process writer at once, as Node
   * does for files and terminals, so output written just before
   * `process.exit()` is not left behind in a stream queue.
   */
  class ProcessWriteStream extends stream.Writable {
    readonly [NODE_RUNTIME_STDIO_KIND] = kind;
    readonly fd = fd;
    readonly isTTY = false;
    columns = 80;
    rows = 24;

    constructor() {
      super({
        write: (chunk, encoding, callback) => {
          deliver(chunk, encoding, callback);
        }
      });
    }

    override write(chunk?: unknown, encoding?: unknown, callback?: WriteCallback): boolean {
      const done = typeof encoding === 'function' ? (encoding as WriteCallback) : callback;
      if (this.writableEnded || this.destroyed) {
        const error = processError(
          this.destroyed ? 'ERR_STREAM_DESTROYED' : 'ERR_STREAM_WRITE_AFTER_END',
          this.destroyed ? 'Cannot call write after a stream was destroyed' : 'write after end'
        );
        if (done) options.nextTick(() => done(error));
        return false;
      }
      deliver(chunk, encoding, (error) => {
        if (done) options.nextTick(() => done(error ?? undefined));
      });
      if (pendingBytes >= this.writableHighWaterMark) needDrain = true;
      return !needDrain;
    }

    getWindowSize(): [number, number] {
      return [this.columns, this.rows];
    }

    hasColors(): boolean {
      return false;
    }

    getColorDepth(): number {
      return 1;
    }
  }

  const output = new ProcessWriteStream();
  const deliver = (chunk: unknown, encoding: unknown, callback: (error?: Error | null) => void) => {
    const data = outputChunk(chunk, encoding);
    const size = typeof data === 'string' ? data.length : data.byteLength;
    let pending: void | Promise<void>;
    try {
      pending = sink(data);
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (!(pending instanceof Promise)) {
      callback();
      return;
    }
    pendingBytes += size;
    void pending.then(
      () => {
        pendingBytes -= size;
        callback();
        if (needDrain && pendingBytes === 0) {
          needDrain = false;
          output.emit('drain');
        }
      },
      (error: unknown) => {
        pendingBytes -= size;
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    );
  };
  return output;
}

function createReadStream(options: NodeProcessOptions): NodeProcessReadStream {
  const { input, isActive, readActivity } = options.stdio;
  let reading = false;
  let referenced = true;
  let paused = false;
  let releaseRead: (() => void) | undefined;
  // A pending read keeps the process alive, as the stdin handle Node reads
  // from does, until the stream is paused or unreferenced or the input ends:
  // a program asking a question waits for its answer instead of ending.
  const holdWhileReading = () => {
    if (reading && referenced && !paused) releaseRead ??= readActivity?.acquire();
  };
  const letGo = () => {
    releaseRead?.();
    releaseRead = undefined;
  };

  class ProcessReadStream extends stream.Readable {
    readonly [NODE_RUNTIME_STDIO_KIND] = 'stdin' as const;
    readonly fd = 0;
    readonly isTTY = false;
    isRaw = false;

    constructor() {
      super({
        read: () => {
          if (reading) return;
          if (!input) {
            this.push(null);
            return;
          }
          reading = true;
          holdWhileReading();
          void readChunk(input).then(
            (chunk) => {
              reading = false;
              letGo();
              if (isActive()) this.push(chunk ?? null);
            },
            (error: unknown) => {
              reading = false;
              letGo();
              if (isActive()) this.destroy(error instanceof Error ? error : new Error(String(error)));
            }
          );
        }
      });
    }

    setRawMode(mode: boolean): this {
      this.isRaw = Boolean(mode);
      return this;
    }

    override pause(): this {
      // A paused stdin no longer holds the process, as Node stops reading its handle.
      paused = true;
      letGo();
      return super.pause();
    }

    override resume(): this {
      // Resumed, it reads its handle again: a read still pending holds the process.
      paused = false;
      super.resume();
      holdWhileReading();
      return this;
    }

    ref(): this {
      referenced = true;
      holdWhileReading();
      return this;
    }

    unref(): this {
      referenced = false;
      letGo();
      return this;
    }
  }

  return new ProcessReadStream();
}

/** Reads one chunk as a Buffer of its own, since a leased chunk is only valid until it is released. */
async function readChunk(input: ProcessInput): Promise<BrowserBuffer | undefined> {
  if (!input.readLease) {
    const chunk = await input.read();
    return chunk && BrowserBuffer.from(chunk);
  }
  const lease = await input.readLease();
  if (!lease) return undefined;
  try {
    return BrowserBuffer.from(lease.chunk);
  } finally {
    lease.release();
  }
}

/** How Node Compatibility tells a process the names of its builtin modules, once its table exists. */
export const NODE_PROCESS_BUILTIN_NAMES = Symbol('node-process-builtin-names');

export class NodeProcess extends EventEmitter {
  readonly argv: string[];
  readonly argv0 = 'node';
  readonly execArgv: string[];
  readonly execPath = '/usr/bin/node';
  readonly env: Record<string, string>;
  readonly pid: number;
  readonly ppid: number;
  readonly arch = VIRTUAL_PLATFORM.architecture;
  readonly platform = VIRTUAL_PLATFORM.operatingSystem;
  readonly version = `v${VIRTUAL_PLATFORM.nodeVersion}` as const;
  readonly versions: typeof RUNTIME_VERSIONS = { ...RUNTIME_VERSIONS };
  readonly release = {
    name: 'node' as const,
    lts: 'Jod',
    sourceUrl: `https://nodejs.org/download/release/v${VIRTUAL_PLATFORM.nodeVersion}/node-v${VIRTUAL_PLATFORM.nodeVersion}.tar.gz`,
    headersUrl: `https://nodejs.org/download/release/v${VIRTUAL_PLATFORM.nodeVersion}/node-v${VIRTUAL_PLATFORM.nodeVersion}-headers.tar.gz`
  };
  // TypeScript sources are transformed by the compiler worker (ADR-0023), as
  // Node does under `--experimental-transform-types`; a program that checks
  // this (Nx) then loads `.ts` files directly instead of registering swc.
  readonly features = { require_module: false, typescript: 'transform' as const };
  readonly config = {
    target_defaults: {},
    variables: {
      host_arch: VIRTUAL_PLATFORM.architecture,
      target_arch: VIRTUAL_PLATFORM.architecture,
      napi_build_version: RUNTIME_VERSIONS.napi,
      node_prefix: '/usr'
    }
  };
  readonly report = {
    compact: false,
    directory: '',
    filename: '',
    reportOnFatalError: false,
    reportOnSignal: false,
    reportOnUncaughtException: false,
    signal: 'SIGUSR2',
    getReport: () => ({
      header: {
        nodejsVersion: this.version,
        arch: this.arch,
        platform: this.platform,
        // libc detection reads this; the runtime's Linux identity is a glibc one (ADR-0039).
        glibcVersionRuntime: '2.39',
        componentVersions: { ...this.versions },
        release: { name: this.release.name },
        cwd: this.cwd(),
        commandLine: [...this.argv],
        processId: this.pid
      },
      javascriptStack: {},
      javascriptHeap: {},
      libuv: [],
      environmentVariables: { ...this.env },
      sharedObjects: []
    }),
    writeReport: (): never => {
      throw processError('ENOTSUP', 'process.report.writeReport() is not supported in Mimic');
    }
  };
  readonly allowedNodeEnvironmentFlags = new Set<string>();
  readonly stdin: NodeProcessReadStream;
  readonly stdout: NodeProcessWriteStream;
  readonly stderr: NodeProcessWriteStream;
  readonly hrtime = createHrtime();
  readonly memoryUsage = createMemoryUsage();
  readonly nextTick: NodeProcessOptions['nextTick'];
  exitCode: number | undefined = undefined;
  title: string;
  debugPort = 9229;

  readonly #options: NodeProcessOptions;
  #builtinNames: readonly string[] = [];

  /** `String(process)` is `[object process]`: workerpool tells Node from a browser by it. */
  get [Symbol.toStringTag](): string {
    return 'process';
  }

  [NODE_PROCESS_BUILTIN_NAMES](names: readonly string[]): void {
    this.#builtinNames = names;
  }
  readonly #startedAt = elapsedMilliseconds();
  readonly #fsBinding: Record<string, unknown> = {};
  #cwd: string;
  #umask = 0o022;
  #exiting = false;

  constructor(options: NodeProcessOptions) {
    super();
    this.#options = options;
    this.argv = [...options.argv];
    this.execArgv = [...options.execArgv];
    this.env = options.env;
    this.pid = options.pid;
    this.ppid = options.ppid;
    this.title = options.title ?? 'node';
    this.#cwd = options.cwd;
    this.nextTick = options.nextTick;
    this.stdin = createReadStream(options);
    this.stdout = createWriteStream(options, 'stdout', 1, options.stdio.writeOutput);
    this.stderr = createWriteStream(options, 'stderr', 2, options.stdio.writeError);
    // Members are read off the object and called bare, as `const { cwd } = process` allows.
    for (const name of BOUND_METHODS) {
      const method = this[name] as (...args: never[]) => unknown;
      Object.defineProperty(this, name, {
        configurable: true,
        enumerable: true,
        value: method.bind(this),
        writable: true
      });
    }
  }

  cwd(): string {
    return this.#cwd;
  }

  chdir(directory: string): void {
    if (typeof directory !== 'string') {
      throw processError('ERR_INVALID_ARG_TYPE', 'The "directory" argument must be of type string.', TypeError);
    }
    this.#cwd = this.#options.host.resolveDirectory(directory, this.#cwd);
  }

  umask(mask?: number | string): number {
    const previous = this.#umask;
    if (mask !== undefined) {
      const parsed = typeof mask === 'string' ? Number.parseInt(mask, 8) : mask;
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0o777) {
        throw new TypeError('The "mask" argument must be a 32-bit unsigned integer or an octal string.');
      }
      this.#umask = parsed;
    }
    return previous;
  }

  uptime(): number {
    return (elapsedMilliseconds() - this.#startedAt) / 1_000;
  }

  cpuUsage(previous?: { user: number; system: number }): { user: number; system: number } {
    // The browser exposes no CPU accounting; wall time on this thread is the nearest measure.
    const user = Math.trunc((elapsedMilliseconds() - this.#startedAt) * 1_000);
    return previous
      ? { user: Math.max(0, user - previous.user), system: 0 }
      : { user, system: 0 };
  }

  resourceUsage(): Record<string, number> {
    const { user, system } = this.cpuUsage();
    return {
      userCPUTime: user,
      systemCPUTime: system,
      maxRSS: Math.trunc(this.memoryUsage().rss / 1024),
      sharedMemorySize: 0,
      unsharedDataSize: 0,
      unsharedStackSize: 0,
      minorPageFault: 0,
      majorPageFault: 0,
      swappedOut: 0,
      fsRead: 0,
      fsWrite: 0,
      ipcSent: 0,
      ipcReceived: 0,
      signalsCount: 0,
      voluntaryContextSwitches: 0,
      involuntaryContextSwitches: 0
    };
  }

  constrainedMemory(): number {
    return 0;
  }

  availableMemory(): number {
    return Number.MAX_SAFE_INTEGER;
  }

  getuid(): number {
    return 1000;
  }

  geteuid(): number {
    return 1000;
  }

  getgid(): number {
    return 1000;
  }

  getegid(): number {
    return 1000;
  }

  getgroups(): number[] {
    return [1000];
  }

  kill(pid: number, signal: string | number = 'SIGTERM'): true {
    if (typeof pid !== 'number' || !Number.isInteger(pid)) {
      throw processError('ERR_INVALID_ARG_TYPE', 'The "pid" argument must be of type number.', TypeError);
    }
    const name =
      typeof signal === 'number'
        ? signal === 0
          ? '0'
          : Object.keys(SIGNAL_NUMBERS).find((candidate) => SIGNAL_NUMBERS[candidate] === signal)
        : signal;
    if (name === undefined || (name !== '0' && !(name in SIGNAL_NUMBERS))) {
      throw processError('ERR_UNKNOWN_SIGNAL', `Unknown signal: ${String(signal)}`, TypeError);
    }
    if (pid === this.pid) {
      if (name !== '0') this.#options.host.raise(name);
      return true;
    }
    // Signal 0 only asks whether the process exists; the host answers that for every signal.
    if (!this.#options.host.kill(pid, name)) {
      throw Object.assign(processError('ESRCH', 'kill ESRCH'), { errno: -3, syscall: 'kill' });
    }
    return true;
  }

  exit(code?: number | string | null): never {
    if (code !== undefined && code !== null) this.exitCode = Number(code);
    if (!this.#exiting) {
      this.#exiting = true;
      this.emit('exit', this.exitCode ?? 0);
    }
    return this.#options.host.exit(this.exitCode ?? 0);
  }

  /** Emits `exit` when the process ends without `process.exit()`. */
  emitExit(): void {
    if (this.#exiting) return;
    this.#exiting = true;
    this.emit('exit', this.exitCode ?? 0);
  }

  abort(): never {
    this.#options.host.raise('SIGABRT');
    return this.#options.host.exit(134);
  }

  binding(name: string): Record<string, unknown> {
    if (name === 'fs') return this.#fsBinding;
    // Older file system polyfills read their flags from this binding.
    if (name === 'constants') {
      return {
        fs: { ...NODE_FS_CONSTANTS },
        os: { errno: { ...NODE_ERRNO_CONSTANTS }, signals: { ...SIGNAL_NUMBERS } }
      };
    }
    // libuv's error codes, which tools older than `util.getSystemErrorName` read here.
    if (name === 'uv') return uvBinding();
    if (name === 'http_parser') return httpParserBinding();
    // webpack 3 and builtin-modules read the builtin names from its keys; the
    // sources it maps them to are not available.
    if (name === 'natives') return Object.fromEntries(this.#builtinNames.map((builtin) => [builtin, '']));
    throw new Error(`Unsupported process.binding: ${name}`);
  }

  dlopen(): never {
    throw processError('ERR_DLOPEN_FAILED', 'Native addons cannot be loaded in Mimic');
  }

  emitWarning(
    warning: string | Error,
    typeOrOptions?: string | { type?: string; code?: string; detail?: string },
    code?: string
  ): void {
    const type =
      typeof typeOrOptions === 'string'
        ? typeOrOptions
        : typeOrOptions?.type ?? (warning instanceof Error ? warning.name : 'Warning');
    const warningCode = typeof typeOrOptions === 'object' ? typeOrOptions.code : code;
    const error = warning instanceof Error ? warning : new Error(String(warning));
    if (!(warning instanceof Error)) error.name = type;
    if (warningCode !== undefined) Object.assign(error, { code: warningCode });
    if (type === 'DeprecationWarning' && this.#options.warnings?.deprecationsDisabled) return;
    this.nextTick(() => {
      this.emit('warning', error);
    });
    if (this.#options.warnings?.disabled) return;
    this.stderr.write(`${type}${warningCode ? ` [${warningCode}]` : ''}: ${error.message}\n`);
  }

  getActiveResourcesInfo(): string[] {
    return [];
  }

  setUncaughtExceptionCaptureCallback(): void {}

  hasUncaughtExceptionCaptureCallback(): boolean {
    return false;
  }

  setSourceMapsEnabled(): void {}
}

// Node's process inherits from an object whose constructor is a plain
// function named `process`; Jest copies the process by calling each
// constructor of the chain on the copy, which a class constructor refuses.
Object.defineProperty(NodeProcess.prototype, 'constructor', {
  configurable: true,
  writable: true,
  value: function process(): void {}
});

const BOUND_METHODS = [
  'cwd',
  'chdir',
  'umask',
  'uptime',
  'cpuUsage',
  'resourceUsage',
  'constrainedMemory',
  'availableMemory',
  'getuid',
  'geteuid',
  'getgid',
  'getegid',
  'getgroups',
  'kill',
  'exit',
  'abort',
  'binding',
  'dlopen',
  'emitWarning',
  'on',
  'addListener',
  'once',
  'off',
  'removeListener',
  'removeAllListeners',
  'prependListener',
  'prependOnceListener',
  'emit',
  'listeners',
  'rawListeners',
  'listenerCount',
  'eventNames',
  'setMaxListeners',
  'getMaxListeners'
] as const satisfies readonly (keyof NodeProcess)[];

/** Builds the `process` object of one Node process. */
export function createNodeProcess(options: NodeProcessOptions): NodeProcess {
  return new NodeProcess(options);
}

/**
 * The parser binding `http-deceiver` (under webpack-dev-server 2 and 3, through
 * spdy) reads its method list and callback slots from when it loads. Requests
 * here are parsed by the runtime's HTTP codec, so a parser it constructs has
 * nothing to parse with and says so.
 */
function httpParserBinding(): Record<string, unknown> {
  class HTTPParser {
    static readonly REQUEST = 1;
    static readonly RESPONSE = 2;
    static readonly kOnMessageBegin = 0;
    static readonly kOnHeaders = 1;
    static readonly kOnHeadersComplete = 2;
    static readonly kOnBody = 3;
    static readonly kOnMessageComplete = 4;
    static readonly kOnExecute = 5;
    static readonly kOnTimeout = 6;
    static readonly methods = [...NODE_HTTP_METHODS];

    constructor() {
      throw Object.assign(new Error('process.binding(\'http_parser\').HTTPParser cannot parse here: the runtime parses HTTP itself.'), {
        code: 'ERR_NOT_SUPPORTED'
      });
    }
  }
  return { HTTPParser, methods: [...NODE_HTTP_METHODS] };
}

function uvBinding(): Record<string, unknown> {
  const binding: Record<string, unknown> = {
    errname: (code: number) => {
      const entry = Object.entries(NODE_ERRNO_CONSTANTS).find(([, errno]) => -errno === code);
      return entry ? entry[0] : `Unknown system error ${code}`;
    }
  };
  for (const [name, errno] of Object.entries(NODE_ERRNO_CONSTANTS)) binding[`UV_${name}`] = -errno;
  return binding;
}
