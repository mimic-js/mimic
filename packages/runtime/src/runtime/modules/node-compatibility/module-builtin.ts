import type {
  CommonJsExtensionHandler,
  CommonJsModule,
  CommonJsRequire,
  ModuleCustomizationRegistrationOptions,
  NodeModuleAccess
} from '../module-execution-engine';

type NodeModuleRegisterOptions = ModuleCustomizationRegistrationOptions;

/** The function a CommonJS module's source is compiled inside, as `Module.wrapper` names it. */
const COMMONJS_WRAPPER = Object.freeze([
  '(function (exports, require, module, __filename, __dirname) { ',
  '\n});'
] as const);

const COMPILE_CACHE_STATUS = Object.freeze({
  FAILED: 0,
  ENABLED: 1,
  ALREADY_ENABLED: 2,
  DISABLED: 3
});

export interface NodeModuleInstance {
  readonly children: NodeModuleInstance[];
  exports: unknown;
  filename: string;
  id: string;
  loaded: boolean;
  readonly parent: NodeModuleInstance | null;
  paths: string[];
}

export interface NodeModuleConstructor {
  new (id?: string, parent?: NodeModuleInstance | null): NodeModuleInstance;
  readonly _cache: Record<string, CommonJsModule>;
  readonly _extensions: Record<string, CommonJsExtensionHandler>;
  _findPath(request: string, paths: readonly string[] | null | undefined): string | false;
  _load(request: string, parent?: NodeModuleInstance | null): unknown;
  _initPaths(): void;
  readonly globalPaths: string[];
  _nodeModulePaths(from: string): string[];
  _resolveFilename(request: string, parent?: NodeModuleInstance | null): string;
  readonly wrapper: readonly [string, string];
  wrap(source: string): string;
}

export interface NodeModuleBuiltin {
  readonly Module: NodeModuleConstructor;
  readonly default: NodeModuleConstructor;
  readonly _cache: Record<string, CommonJsModule>;
  readonly _extensions: Record<string, CommonJsExtensionHandler>;
  _findPath(request: string, paths: readonly string[] | null | undefined): string | false;
  _load(request: string, parent?: NodeModuleInstance | null): unknown;
  _initPaths(): void;
  readonly globalPaths: string[];
  _nodeModulePaths(from: string): string[];
  _resolveFilename(request: string, parent?: NodeModuleInstance | null): string;
  readonly wrapper: readonly [string, string];
  wrap(source: string): string;
  readonly builtinModules: readonly string[];
  readonly constants: {
    readonly compileCacheStatus: Readonly<{
      FAILED: 0;
      ENABLED: 1;
      ALREADY_ENABLED: 2;
      DISABLED: 3;
    }>;
  };
  createRequire(filename: string | URL): CommonJsRequire;
  enableCompileCache(directory?: string): { readonly status: 2; readonly message: string };
  flushCompileCache(): void;
  getCompileCacheDir(): undefined;
  isBuiltin(specifier: string): boolean;
  register(
    specifier: string | URL,
    parentURLOrOptions?: string | URL | NodeModuleRegisterOptions,
    options?: NodeModuleRegisterOptions
  ): void;
  syncBuiltinESMExports(): void;
}

/**
 * Adapts the engine-owned module registry to Node's `node:module` surface.
 *
 * The browser runtime deliberately has no compile-cache storage authority, so
 * its compile-cache methods report the disabled Node 22 status without creating
 * or advertising a cache directory.
 */
export function createModuleBuiltin(
  access: NodeModuleAccess,
  builtinModules: readonly string[]
): NodeModuleBuiltin {
  const supportedBuiltins = Object.freeze(
    [...new Set(builtinModules.map(normalizeBuiltinName))]
  );
  const supportedBuiltinSet = new Set(supportedBuiltins);

  class RuntimeNodeModule implements NodeModuleInstance {
    static readonly _cache = access.cache;
    static readonly _extensions = access.extensions;

    static _findPath(request: string, paths: readonly string[] | null | undefined): string | false {
      return access.findPath(request, paths ?? []);
    }

    static _load(request: string, parent?: NodeModuleInstance | null): unknown {
      return access.load(request, parent?.filename);
    }

    static _nodeModulePaths(from: string): string[] {
      return access.modulePaths(from);
    }

    /**
     * A copy, as Node's is: a plain property a program may change or replace,
     * which changes no lookup; `_initPaths()` does, and replaces it.
     */
    static globalPaths: string[] = [...access.globalPaths];

    static _initPaths(): void {
      access.initPaths();
      RuntimeNodeModule.globalPaths = [...access.globalPaths];
    }

    static _resolveFilename(request: string, parent?: NodeModuleInstance | null): string {
      return access.resolveFilename(request, parent?.filename);
    }

    static readonly wrapper = COMMONJS_WRAPPER;

    static wrap(source: string): string {
      return `${COMMONJS_WRAPPER[0]}${source}${COMMONJS_WRAPPER[1]}`;
    }

    readonly children: NodeModuleInstance[] = [];
    exports: unknown = {};
    filename: string;
    id: string;
    loaded = false;
    readonly parent: NodeModuleInstance | null;
    paths: string[];

    constructor(id = '', parent: NodeModuleInstance | null = null) {
      this.id = id;
      this.filename = id;
      this.parent = parent;
      this.paths = access.modulePaths(id);
    }

    /** Loads `request` as this module would: relative to its filename. */
    require(request: string): unknown {
      return access.load(request, this.filename || undefined);
    }

    _compile(source: string, filename: string): unknown {
      this.filename = filename;
      return access.compile(this, String(source), filename);
    }
  }

  // Node assigns these to Module, so they are enumerable: an interop that
  // copies a namespace's enumerable keys (Babel's `_interopRequireWildcard`)
  // keeps them. `wrap` and `wrapper` are not, as in Node.
  for (const key of [
    '_cache',
    '_extensions',
    'globalPaths',
    '_findPath',
    '_nodeModulePaths',
    '_load',
    '_resolveFilename',
    '_initPaths'
  ] as const) {
    Object.defineProperty(RuntimeNodeModule, key, {
      ...Object.getOwnPropertyDescriptor(RuntimeNodeModule, key),
      enumerable: true
    });
  }

  // Every module is already compiled once per machine and the result kept
  // across processes and reloads by the Runtime Host's compile cache. It lives
  // outside the program's file system, so there is no directory to report and
  // nothing for the program to flush.
  const enabledCompileCache = (): { readonly status: 2; readonly message: string } => ({
    status: COMPILE_CACHE_STATUS.ALREADY_ENABLED,
    message: 'Compiled modules are always cached, outside the program file system.'
  });
  const moduleBuiltin = Object.assign(RuntimeNodeModule, {
    Module: RuntimeNodeModule,
    default: RuntimeNodeModule,
    builtinModules: supportedBuiltins,
    constants: { compileCacheStatus: COMPILE_CACHE_STATUS },
    createRequire: (filename: string | URL) => access.createRequireFunction(filename),
    enableCompileCache: (_directory?: string) => enabledCompileCache(),
    flushCompileCache: () => undefined,
    getCompileCacheDir: () => undefined,
    isBuiltin: (specifier: string) => supportedBuiltinSet.has(normalizeBuiltinName(specifier)),
    register: (
      specifier: string | URL,
      parentURLOrOptions?: string | URL | NodeModuleRegisterOptions,
      options?: NodeModuleRegisterOptions
    ) => {
      const normalizedOptions =
        typeof parentURLOrOptions === 'string' || parentURLOrOptions instanceof URL
          ? { ...options, parentURL: parentURLOrOptions }
          : parentURLOrOptions ?? options ?? {};
      access.registerCustomizationHooks(specifier, normalizedOptions);
    },
    syncBuiltinESMExports: () => access.syncBuiltinEsmExports(),
    // Source maps are not tracked (`--enable-source-maps` is off): no module has one.
    findSourceMap: (_path: string) => undefined,
    SourceMap: NodeSourceMap
  });

  return moduleBuiltin;
}

/** `module.SourceMap` over a source map payload, which it keeps as given. */
class NodeSourceMap {
  constructor(readonly payload: unknown) {}

  findEntry(): Record<string, never> {
    return {};
  }

  findOrigin(): Record<string, never> {
    return {};
  }
}

function normalizeBuiltinName(specifier: string): string {
  return specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
}
