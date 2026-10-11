import type {
  BuiltinModuleProvider,
  ModuleResolutionErrorAdapter,
  ModuleResolutionFailure,
  NodeModuleAccess,
  ScriptEvaluator
} from '../module-execution-engine';
import type { VirtualNetworkAuthority } from '../virtual-network';
import { createAssertBuiltin } from './assert';
import { createAsyncHooksBuiltin } from './async-hooks';
import { BrowserBuffer, nodeBuffer } from './buffer';
import {
  createChildProcessBuiltin,
  type ChildProcessBuiltinOptions,
  type ProcessExecutionActivityLifecycle
} from './child-process';
import { createConstantsBuiltin } from './constants';
import { createCryptoBuiltin } from './crypto';
import { createDiagnosticsChannelBuiltin } from './diagnostics-channel';
import { createDnsBuiltin } from './dns';
import { nodeEvents } from './events';
import { createNodeFileSystemBuiltins, type NodeFileSystemBuiltinsOptions } from './filesystem';
import { createHttpBuiltin, type HttpListenerClaims } from './http';
import { createHttp2Builtin } from './http2';
import { createInspectorBuiltin } from './inspector';
import { createModuleBuiltin } from './module-builtin';
import { createNodeNetworkBuiltin } from './network-adapter';
import { createOsBuiltin } from './os';
import { createPathBuiltin } from './path';
import { createPerfHooksBuiltin } from './perf-hooks';
import { createQuerystringBuiltin } from './querystring';
import { createDomainBuiltin } from './domain';
import { createPunycodeBuiltin } from './punycode';
import { NODE_PROCESS_BUILTIN_NAMES } from './process';
import {
  createClusterBuiltin,
  type ClusterAddress,
  type ClusterChildProcess,
  type ClusterListeningServer,
  type ClusterProcess
} from './cluster';
import { createReadlineBuiltin, createReadlinePromisesBuiltin } from './readline';
import {
  createDgramBuiltin,
  createReplBuiltin,
  createTraceEventsBuiltin
} from './single-process-builtins';
import { createSqliteBuiltin } from './sqlite';
import { createStreamConsumersBuiltin } from './stream-consumers';
import { nodeStream } from './streams';
import { nodeStringDecoder } from './string-decoder';
import { createTimersBuiltin, createTimersPromisesBuiltin } from './timers';
import { createTlsBuiltin } from './tls';
import { createTtyBuiltin } from './tty';
import { createUrlBuiltin } from './url';
import { createUtilBuiltin, createUtilTypesBuiltin, type UtilConsole } from './util';
import { createV8Builtin } from './v8';
import { createVmBuiltin } from './vm';
import { createWasiBuiltin, type WasiRuntimeProcess, type WasiSynchronousVfsPort } from './wasi';
import {
  createWorkerThreadsBuiltin,
  type ThreadExecutionPort,
  type WorkerThreadsBuiltinContext
} from './worker-threads';
import { createZlibBuiltin } from './zlib';

export interface NodeCompatibilityProcess {
  readonly platform: 'linux';
  readonly arch: 'wasm32';
  readonly version: 'v22.22.3';
  readonly versions: Readonly<Record<string, string>> & {
    readonly node: '22.22.3';
  };
  readonly release: Readonly<{
    name: 'node';
    lts: string;
    sourceUrl: string;
    headersUrl: string;
  }>;
}

export interface NodeCompatibilityBufferConstructor {
  from(
    input: string | ArrayBuffer | ArrayBufferView | ArrayLike<number>,
    encoding?: string
  ): Uint8Array;
  alloc(size: number, fill?: string | number | Uint8Array, encoding?: string): Uint8Array;
  isBuffer(input: unknown): boolean;
}

export interface NodeCompatibilityGlobals {
  readonly process: NodeCompatibilityProcess;
  readonly console: Readonly<{
    log(...values: unknown[]): void;
    error(...values: unknown[]): void;
    warn(...values: unknown[]): void;
  }>;
  readonly Buffer: NodeCompatibilityBufferConstructor;
  readonly URL: typeof URL;
  readonly URLSearchParams: typeof URLSearchParams;
  readonly TextEncoder: typeof TextEncoder;
  readonly TextDecoder: typeof TextDecoder;
  readonly WebSocket: typeof WebSocket;
  readonly MessageChannel: typeof MessageChannel;
  readonly setTimeout: typeof globalThis.setTimeout;
  readonly clearTimeout: typeof globalThis.clearTimeout;
  readonly setInterval: typeof globalThis.setInterval;
  readonly clearInterval: typeof globalThis.clearInterval;
  readonly setImmediate: (callback: (...args: unknown[]) => void, ...args: unknown[]) => unknown;
  readonly clearImmediate: (handle: unknown) => void;
  readonly queueMicrotask: typeof globalThis.queueMicrotask;
}

export const NODE_COMPATIBILITY_GLOBAL_NAMES = [
  'process',
  'console',
  'Buffer',
  'URL',
  'URLSearchParams',
  'TextEncoder',
  'TextDecoder',
  'WebSocket',
  'MessageChannel',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'setImmediate',
  'clearImmediate',
  'queueMicrotask'
] as const satisfies readonly (keyof NodeCompatibilityGlobals)[];

/**
 * The process object Node Compatibility is given: installed as the `process`
 * global, served as `node:process`, read for `argv` by `util.parseArgs`, and
 * handed to `node:wasi` as the process a WASI command runs in.
 */
export interface NodeCompatibilityProcessPort extends NodeCompatibilityProcess, WasiRuntimeProcess {}

/** Where `node:util` and `node:inspector` report, and what `node:console` serves. */
export type NodeCompatibilityConsolePort = UtilConsole;

/** The listener claims a published `http` or `https` server registers through. */
export type HttpListenerClaimsProvider = (protocol: 'http' | 'https') => HttpListenerClaims | undefined;

/** Queues an unclamped macrotask and returns its cancellation. */
export type NodeMacrotaskQueue = (callback: () => void) => () => void;

/** The thread execution port `node:worker_threads` starts Worker Threads through. */
export type ThreadExecutionPortProvider = () => ThreadExecutionPort;

/** Every port Node Compatibility needs from the runtime that hosts it. */
export interface NodeCompatibilityCapabilities {
  readonly childProcess: ChildProcessBuiltinOptions;
  readonly console: NodeCompatibilityConsolePort;
  readonly fileSystem: NodeFileSystemBuiltinsOptions;
  readonly httpListenerClaims: HttpListenerClaimsProvider;
  readonly nodeModuleAccess: NodeModuleAccess;
  readonly process: NodeCompatibilityProcessPort;
  /** Keeps the process alive while referenced handles are open. */
  readonly referencedActivity: ProcessExecutionActivityLifecycle | undefined;
  readonly runtimeGlobal: typeof globalThis;
  readonly queueMacrotask: NodeMacrotaskQueue;
  readonly scriptEvaluator: ScriptEvaluator;
  readonly threadExecutionPort: ThreadExecutionPortProvider;
  readonly virtualNetwork: VirtualNetworkAuthority;
  readonly virtualNetworkOwnerId: string;
  readonly wasiVfs: WasiSynchronousVfsPort;
  readonly workerThreads: WorkerThreadsBuiltinContext;
}

export interface NodeCompatibilityOptions {
  readonly global: typeof globalThis;
  readonly globals: Omit<NodeCompatibilityGlobals, 'Buffer'>;
  readonly capabilities: NodeCompatibilityCapabilities;
}

type NodeCompatibilityBuiltinTableOptions = {
  readonly global: typeof globalThis;
  readonly globals: NodeCompatibilityGlobals;
  readonly builtins: ReadonlyMap<string, () => unknown>;
  readonly teardownResources: () => void;
}

export interface NodeCompatibility {
  readonly global: typeof globalThis;
  readonly builtinModuleProvider: BuiltinModuleProvider;
  readonly moduleResolutionErrorAdapter: ModuleResolutionErrorAdapter;
  installGlobals(): void;
  teardown(): void;
}

export class NodeCompatibilityError extends Error {
  readonly code: string;
  readonly path?: string;
  readonly syscall?: string;

  constructor(code: string, message: string, options: { readonly path?: string; readonly syscall?: string } = {}) {
    super(message);
    this.name = 'NodeCompatibilityError';
    this.code = code;
    this.path = options.path;
    this.syscall = options.syscall;
  }
}

export function createNodeCompatibility(options: NodeCompatibilityOptions): NodeCompatibility {
  const resourceDisposers = new Set<() => void>();
  const registerResource = (dispose: () => void): (() => void) => {
    resourceDisposers.add(dispose);
    return () => resourceDisposers.delete(dispose);
  };
  return createNodeCompatibilityFromBuiltinTable({
    builtins: createBuiltinTable(options.capabilities, registerResource),
    global: options.global,
    globals: {
      ...options.globals,
      Buffer: BrowserBuffer,
      WebSocket: createContextWebSocket(
        options.globals.WebSocket,
        options.capabilities.referencedActivity,
        registerResource
      ),
      MessageChannel: createContextMessageChannel(
        options.globals.MessageChannel,
        options.capabilities.referencedActivity
      )
    },
    teardownResources: () => {
      for (const dispose of [...resourceDisposers]) dispose();
      resourceDisposers.clear();
    }
  });
}

function createNodeCompatibilityFromBuiltinTable(
  options: NodeCompatibilityBuiltinTableOptions
): NodeCompatibility {
  const builtins = canonicalBuiltinTable(options.builtins);
  const modules = new Map<string, unknown>();
  const installedDescriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
  let globalsInstalled = false;

  const builtinModuleProvider: BuiltinModuleProvider = {
    resolve(specifier) {
      const moduleName = normalizeBuiltinName(specifier);
      return builtins.has(moduleName)
        ? specifier.startsWith('node:') ? specifier : `node:${specifier}`
        : undefined;
    },
    load(specifier) {
      const moduleName = normalizeBuiltinName(specifier);
      const factory = builtins.get(moduleName);
      if (!factory) {
        if (specifier.startsWith('node:')) {
          throw new NodeCompatibilityError(
            'ERR_UNKNOWN_BUILTIN_MODULE',
            `Unsupported builtin module: ${moduleName}`
          );
        }
        return { found: false };
      }
      if (modules.has(moduleName)) return { found: true, module: modules.get(moduleName) };
      const module = factory();
      hideDefaultExports(module);
      modules.set(moduleName, module);
      return { found: true, module };
    }
  };
  const moduleResolutionErrorAdapter: ModuleResolutionErrorAdapter = {
    adapt: nodeModuleResolutionError
  };

  return {
    global: options.global,
    builtinModuleProvider,
    moduleResolutionErrorAdapter,
    installGlobals() {
      if (globalsInstalled) return;
      assertCompleteGlobalsContract(options.globals);
      globalsInstalled = true;
      installGlobal('global', options.global);
      installGlobal('globalThis', options.global);
      for (const name of NODE_COMPATIBILITY_GLOBAL_NAMES) installGlobal(name, options.globals[name]);
    },
    teardown() {
      options.teardownResources();
      modules.clear();
      if (!globalsInstalled) return;
      globalsInstalled = false;
      for (const [name, descriptor] of [...installedDescriptors].reverse()) {
        if (descriptor) Object.defineProperty(options.global, name, descriptor);
        else Reflect.deleteProperty(options.global, name);
      }
      installedDescriptors.clear();
    }
  };

  function installGlobal(name: PropertyKey, value: unknown): void {
    if (!installedDescriptors.has(name)) {
      installedDescriptors.set(name, Object.getOwnPropertyDescriptor(options.global, name));
    }
    Object.defineProperty(options.global, name, {
      configurable: true,
      enumerable: true,
      value,
      writable: true
    });
  }
}

function createBuiltinTable(
  options: NodeCompatibilityCapabilities,
  registerResource: (dispose: () => void) => () => void
): ReadonlyMap<string, () => unknown> {
  const fileSystem = createNodeFileSystemBuiltins(options.fileSystem);
  // A cluster worker tells its primary of each server it listens with.
  const serverListeners = new Set<(server: ClusterListeningServer, address: ClusterAddress) => void>();
  const network = createNodeNetworkBuiltin(
    options.virtualNetwork,
    options.virtualNetworkOwnerId,
    {
      buffer: (value) => BrowserBuffer.from(value),
      from: (value, encoding) => BrowserBuffer.from(value, encoding)
    },
    options.queueMacrotask,
    {
      resolve: (path) => resolvePipePath(path, options.fileSystem.cwd),
      bind: (path) => {
        try {
          (fileSystem.fs as unknown as { writeFileSync(path: string, data: string): void }).writeFileSync(path, '');
        } catch {
          // A pipe in a directory that is gone still listens, as Node's would fail to; nothing reads the file.
        }
      },
      unbind: (path) => {
        try {
          (fileSystem.fs as unknown as { unlinkSync(path: string): void }).unlinkSync(path);
        } catch {
          // Already removed.
        }
      }
    },
    {
      listening: (server, address) => {
        for (const listener of serverListeners) listener(server as ClusterListeningServer, address);
      }
    }
  );
  let builtinNames: readonly string[];
  // `assert/strict` is the `strict` member of the one `assert` module.
  let assert: { readonly strict: unknown } | undefined;
  const loadAssert = () => (assert ??= createAssertBuiltin() as { readonly strict: unknown });
  const path = createPathBuiltin(() => options.fileSystem.cwd);
  // `dns/promises` is the `promises` member of the one `dns` module, and `sys` is `util`.
  let dns: ReturnType<typeof createDnsBuiltin> | undefined;
  const loadDns = () => (dns ??= createDnsBuiltin());
  let childProcess: ReturnType<typeof createChildProcessBuiltin> | undefined;
  const loadChildProcess = () => (childProcess ??= createChildProcessBuiltin(options.childProcess));
  let util: ReturnType<typeof createUtilBuiltin> | undefined;
  const loadUtil = () => (util ??= createUtilBuiltin(options.console, {
    env: options.childProcess.env,
    pid: options.childProcess.parentPid,
    argv: () => options.process.argv
  }));
  const builtins = new Map<string, () => unknown>([
    ['process', () => withDefaultExport(options.process)],
    ['console', () => withDefaultExport(options.console)],
    ['path', () => path],
    ['path/posix', () => path],
    ['path/win32', () => {
      const { win32 } = path as { readonly win32: object };
      return { ...win32, default: win32 };
    }],
    ['fs', () => fileSystem.fs],
    ['fs/promises', () => fileSystem.promises],
    ['perf_hooks', () => createPerfHooksBuiltin(options.runtimeGlobal)],
    ['events', () => nodeEvents],
    ['url', () => createUrlBuiltin(() => options.fileSystem.cwd)],
    ['assert', loadAssert],
    ['assert/strict', () => loadAssert().strict],
    ['async_hooks', createAsyncHooksBuiltin],
    ['v8', createV8Builtin],
    ['worker_threads', () => createWorkerThreadsBuiltin(
      extendOptions(options.workerThreads, { threads: options.threadExecutionPort() })
    )],
    ['util', loadUtil],
    ['sys', loadUtil],
    ['util/types', createUtilTypesBuiltin],
    ['crypto', createCryptoBuiltin],
    ['os', createOsBuiltin],
    ['child_process', loadChildProcess],
    ['tty', createTtyBuiltin],
    ['readline', createReadlineBuiltin],
    ['readline/promises', createReadlinePromisesBuiltin],
    ['http', () => createHttpBuiltin(
      'http',
      network,
      options.httpListenerClaims('http'),
      options.referencedActivity,
      (input, init) => globalThis.fetch(input, init),
      registerResource
    )],
    ['http2', createHttp2Builtin],
    ['https', () => createHttpBuiltin(
      'https',
      network,
      options.httpListenerClaims('https'),
      options.referencedActivity,
      (input, init) => globalThis.fetch(input, init),
      registerResource
    )],
    ['tls', () => createTlsBuiltin(network, {
      fetch: (input, init) => globalThis.fetch(input, init),
      bytes: {
        buffer: (value) => BrowserBuffer.from(value),
        from: (value, encoding) => BrowserBuffer.from(value, encoding)
      },
      queue: options.queueMacrotask
    })],
    ['net', () => network],
    ['dns', loadDns],
    ['dns/promises', () => withDefaultExport(loadDns().promises as object)],
    ['inspector', () => createInspectorBuiltin(options.console)],
    ['stream', () => nodeStream],
    ['stream/promises', () => nodeStream.promises],
    ['stream/consumers', createStreamConsumersBuiltin],
    ['stream/web', () => createStreamWebBuiltin(options.runtimeGlobal)],
    ['string_decoder', () => nodeStringDecoder],
    ['sqlite', () => createSqliteBuiltin({
      // Read through, so relative database paths follow `process.chdir()`.
      get cwd() {
        return options.fileSystem.cwd;
      },
      fileSystem: fileSystem.fs,
      scriptEvaluator: options.scriptEvaluator
    })],
    ['timers', () => createTimersBuiltin(options.runtimeGlobal)],
    ['timers/promises', () => createTimersPromisesBuiltin(options.runtimeGlobal)],
    ['zlib', createZlibBuiltin],
    ['querystring', createQuerystringBuiltin],
    ['buffer', () => nodeBuffer],
    ['constants', createConstantsBuiltin],
    ['diagnostics_channel', createDiagnosticsChannelBuiltin],
    ['module', () => createModuleBuiltin(options.nodeModuleAccess, builtinNames)],
    ['vm', () => createVmBuiltin(options.scriptEvaluator)],
    ['domain', createDomainBuiltin],
    ['punycode', createPunycodeBuiltin],
    ['cluster', () => createClusterBuiltin({
      process: options.process as unknown as ClusterProcess,
      fork: (modulePath, args, forkOptions) =>
        (loadChildProcess() as unknown as {
          fork(modulePath: string, args: readonly string[], options: Record<string, unknown>): ClusterChildProcess;
        }).fork(modulePath, args, forkOptions),
      onServerListening: (listener) => serverListeners.add(listener)
    })],
    ['dgram', createDgramBuiltin],
    ['trace_events', createTraceEventsBuiltin],
    ['repl', createReplBuiltin],
    ['wasi', () => createWasiBuiltin({ process: options.process, vfs: options.wasiVfs })]
  ]);
  builtinNames = [...builtins.keys()];
  (options.process as Partial<Record<typeof NODE_PROCESS_BUILTIN_NAMES, (names: readonly string[]) => void>>)[
    NODE_PROCESS_BUILTIN_NAMES
  ]?.(builtinNames);
  return builtins;
}

type ContextWebSocketListener = {
  readonly type: string;
  readonly listener: EventListenerOrEventListenerObject;
  readonly wrapped: EventListener;
  readonly capture: boolean;
  readonly removeAbortListener?: () => void;
};

/**
 * Node's MessagePort is an event-loop handle: `port.ref()` keeps the process
 * alive until `unref()` or `close()`. Packages rely on that through the global
 * MessageChannel (emnapi holds a referenced port while N-API async work is
 * pending), so the context global projects port references onto process
 * activity while keeping the platform's transferable ports.
 */
function createContextMessageChannel(
  NativeMessageChannel: typeof MessageChannel,
  activity: ProcessExecutionActivityLifecycle | undefined
): typeof MessageChannel {
  const referencePort = (port: MessagePort): void => {
    let release: (() => void) | undefined;
    const close = port.close.bind(port);
    const unref = () => {
      release?.();
      release = undefined;
    };
    Object.defineProperties(port, {
      ref: { configurable: true, writable: true, value: () => void (release ??= activity?.acquire()) },
      unref: { configurable: true, writable: true, value: unref },
      hasRef: { configurable: true, writable: true, value: () => release !== undefined },
      close: {
        configurable: true,
        writable: true,
        value: () => {
          unref();
          close();
        }
      }
    });
  };
  return class ContextMessageChannel extends NativeMessageChannel {
    constructor() {
      super();
      referencePort(this.port1);
      referencePort(this.port2);
    }
  };
}

function createContextWebSocket(
  NativeWebSocket: typeof WebSocket,
  activity: ProcessExecutionActivityLifecycle | undefined,
  registerResource: (dispose: () => void) => () => void
): typeof WebSocket {
  return class ContextWebSocket extends NativeWebSocket {
    readonly #releaseActivity = activity?.acquire();
    readonly #listeners: ContextWebSocketListener[] = [];
    #active = true;
    #released = false;
    #unregisterResource: (() => void) | undefined;

    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.#unregisterResource = registerResource(() => this.#teardown());
      super.addEventListener('close', () => this.#release(), { once: true });
    }

    override addEventListener<K extends keyof WebSocketEventMap>(
      type: K,
      listener: (this: WebSocket, event: WebSocketEventMap[K]) => unknown,
      options?: boolean | AddEventListenerOptions
    ): void;
    override addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions
    ): void;
    override addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions
    ): void {
      const capture = typeof options === 'boolean' ? options : options?.capture === true;
      const signal = typeof options === 'object' ? options.signal : undefined;
      if (signal?.aborted) return;
      if (
        this.#listeners.some(
          (entry) => entry.type === type && entry.listener === listener && entry.capture === capture
        )
      ) return;
      const once = typeof options === 'object' && options.once === true;
      const wrapped: EventListener = (event) => {
        if (!this.#active) return;
        if (once) this.#forgetListener(type, listener, capture);
        if (typeof listener === 'function') listener.call(this, event);
        else listener.handleEvent(event);
      };
      const abort = () => {
        const entry = this.#forgetListener(type, listener, capture);
        if (entry) super.removeEventListener(type, entry.wrapped, capture);
      };
      const removeAbortListener = signal
        ? () => signal.removeEventListener('abort', abort)
        : undefined;
      this.#listeners.push({ type, listener, wrapped, capture, removeAbortListener });
      signal?.addEventListener('abort', abort, { once: true });
      super.addEventListener(type, wrapped, options);
    }

    override removeEventListener<K extends keyof WebSocketEventMap>(
      type: K,
      listener: (this: WebSocket, event: WebSocketEventMap[K]) => unknown,
      options?: boolean | EventListenerOptions
    ): void;
    override removeEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions
    ): void;
    override removeEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions
    ): void {
      const capture = typeof options === 'boolean' ? options : options?.capture === true;
      const entry = this.#forgetListener(type, listener, capture);
      if (entry) super.removeEventListener(type, entry.wrapped, options);
    }

    #teardown(): void {
      if (!this.#active) return;
      this.#active = false;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      for (const entry of this.#listeners) {
        entry.removeAbortListener?.();
        super.removeEventListener(entry.type, entry.wrapped, entry.capture);
      }
      this.#listeners.length = 0;
      if (this.readyState === NativeWebSocket.CONNECTING || this.readyState === NativeWebSocket.OPEN) {
        this.close();
      }
      this.#release();
    }

    #release(): void {
      if (this.#released) return;
      this.#released = true;
      this.#releaseActivity?.();
      this.#unregisterResource?.();
      this.#unregisterResource = undefined;
    }

    #forgetListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
      capture: boolean
    ): ContextWebSocketListener | undefined {
      const index = this.#listeners.findIndex(
        (entry) => entry.type === type && entry.listener === listener && entry.capture === capture
      );
      if (index === -1) return undefined;
      const [entry] = this.#listeners.splice(index, 1);
      entry?.removeAbortListener?.();
      return entry;
    }
  };
}

/** Adds to an options object without reading it, so a live `cwd` stays live after `process.chdir()`. */
function extendOptions<Base extends object, Extra extends object>(base: Base, extra: Extra): Base & Extra {
  return Object.defineProperties({}, {
    ...Object.getOwnPropertyDescriptors(base),
    ...Object.getOwnPropertyDescriptors(extra)
  }) as Base & Extra;
}

/** `node:stream/web`: the web streams the browser already provides. */
function createStreamWebBuiltin(runtimeGlobal: typeof globalThis): object {
  const names = [
    'ByteLengthQueuingStrategy',
    'CompressionStream',
    'CountQueuingStrategy',
    'DecompressionStream',
    'ReadableByteStreamController',
    'ReadableStream',
    'ReadableStreamBYOBReader',
    'ReadableStreamBYOBRequest',
    'ReadableStreamDefaultController',
    'ReadableStreamDefaultReader',
    'TextDecoderStream',
    'TextEncoderStream',
    'TransformStream',
    'TransformStreamDefaultController',
    'WritableStream',
    'WritableStreamDefaultController',
    'WritableStreamDefaultWriter'
  ] as const;
  const global = runtimeGlobal as unknown as Record<string, unknown>;
  return withDefaultExport(Object.fromEntries(names.map((name) => [name, global[name]])));
}

/**
 * A builtin, and each object it holds as a plain member (`fs.promises`,
 * `path.posix`), keeps the `default` it carries for `import` out of its keys:
 * Node's `require('fs')` has none, so `Object.keys` and `JSON.stringify` of a
 * builtin, or of a copy such as graceful-fs makes, must not meet one. webpack
 * stringifies resolver options that hold its input file system, `fs` within.
 */
function hideDefaultExports(module: unknown): void {
  if (!isObjectLike(module)) return;
  hideDefaultExport(module);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(module))) {
    if ('value' in descriptor && isObjectLike(descriptor.value)) hideDefaultExport(descriptor.value);
  }
}

function hideDefaultExport(value: object): void {
  const descriptor = Object.getOwnPropertyDescriptor(value, 'default');
  if (!descriptor?.enumerable || !descriptor.configurable) return;
  Object.defineProperty(value, 'default', { ...descriptor, enumerable: false });
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === 'object' || typeof value === 'function') && value !== null;
}

function withDefaultExport<T extends object>(value: T): T & { default: T } {
  return Object.assign(value, { default: value });
}

function nodeModuleResolutionError(failure: ModuleResolutionFailure): NodeCompatibilityError {
  const codeByKind = {
    'invalid-package-target': 'ERR_INVALID_PACKAGE_TARGET',
    'module-not-found': 'ERR_MODULE_NOT_FOUND',
    'package-import-not-defined': 'ERR_PACKAGE_IMPORT_NOT_DEFINED',
    'package-path-not-exported': 'ERR_PACKAGE_PATH_NOT_EXPORTED'
  } as const satisfies Record<ModuleResolutionFailure['kind'], string>;
  // `require` reports a missing module as MODULE_NOT_FOUND; only `import` uses the ERR_ form.
  const code =
    failure.kind === 'module-not-found' && failure.mode === 'require' ? 'MODULE_NOT_FOUND' : codeByKind[failure.kind];
  return new NodeCompatibilityError(code, failure.message);
}

function assertCompleteGlobalsContract(globals: NodeCompatibilityGlobals): void {
  for (const name of NODE_COMPATIBILITY_GLOBAL_NAMES) {
    if (!Object.hasOwn(globals, name) || globals[name] === undefined) {
      throw new NodeCompatibilityError(
        'ERR_MISSING_NODE_COMPATIBILITY_GLOBAL',
        `Missing required Node Compatibility global: ${name}`
      );
    }
  }
}

function canonicalBuiltinTable(builtins: ReadonlyMap<string, () => unknown>): Map<string, () => unknown> {
  const canonical = new Map<string, () => unknown>();
  for (const [specifier, factory] of builtins) {
    const name = normalizeBuiltinName(specifier);
    if (canonical.has(name)) {
      throw new NodeCompatibilityError(
        'ERR_DUPLICATE_BUILTIN_MODULE',
        `Duplicate builtin module: ${name}`
      );
    }
    canonical.set(name, factory);
  }
  return canonical;
}

function normalizeBuiltinName(specifier: string): string {
  return specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
}

function resolvePipePath(path: string, cwd: string): string {
  return path.startsWith('/') ? path : `${cwd.replace(/\/$/u, '')}/${path}`;
}
