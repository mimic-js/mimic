import {
  compileFunctionInScopes,
  evaluateInScopes,
  type ScopedScriptOptions
} from './runtime-artifact-compiler/scoped-evaluation';
import { normalizePath } from '../virtual-file-system';
import {
  completionValuePrintSource,
  createRuntimeArtifactCompiler,
  type RuntimeArtifactCompiler,
  type RuntimeArtifactCompilerOptions
} from './runtime-artifact-compiler';
import {
  createModuleResolver,
  type ModuleResolver
} from './module-resolution';
import { moduleFormatFromPath } from './module-format';
import type { ModuleResolutionCommitJournal } from './module-resolution-cache';
import {
  ModuleResolutionError,
  type ModuleResolutionFailureKind
} from './module-resolution-types';
import type { ModuleFormat } from './runtime-artifact';

export type ResolutionMode = 'import' | 'require';
export type ModuleRecordState = 'linking' | 'evaluating' | 'evaluated';

export const INLINE_NODE_MODULE_ENTRY: unique symbol = Symbol('inline-node-module-entry');

export type InlineNodeModuleEntry = Readonly<{
  source: string;
  execArgv: readonly string[];
  /** Print the completion value of the source, as `node -p` does. */
  print?: boolean;
}>;

export interface ModuleAccess {
  readText(path: string): string;
  readFileSync?(path: string): Uint8Array;
  isFile(path: string): boolean;
  isDirectory(path: string): boolean;
  realpathSync(path: string): string;
  /**
   * The committed-revision view of this file system. When present, resolution
   * answers are cached and invalidated from the VFS Commit Journal.
   */
  readonly commitJournal?: ModuleResolutionCommitJournal;
  [INLINE_NODE_MODULE_ENTRY]?(path: string): InlineNodeModuleEntry | undefined;
}

export interface ModuleResolutionFailure {
  readonly kind: ModuleResolutionFailureKind;
  readonly message: string;
  /** Whether `require` or `import` asked: Node names a missing module differently for each. */
  readonly mode?: ResolutionMode;
}

export interface ModuleResolutionErrorAdapter {
  adapt(failure: ModuleResolutionFailure): Error;
}

export type BuiltinModuleLoadResult =
  | { readonly found: false }
  | { readonly found: true; readonly module: unknown };

export interface BuiltinModuleProvider {
  resolve(specifier: string): string | undefined;
  load(specifier: string): BuiltinModuleLoadResult;
}

export interface ModuleExecutionProcess {
  readonly argv: string[];
  readonly execArgv?: readonly string[];
  readonly env: Record<string, string>;
  readonly execPath?: string;
  readonly pid?: number;
  readonly version?: string;
  readonly versions?: Record<string, string>;
  cwd(): string;
  exit(code?: number): never;
}

export interface ModuleExecutionConsole {
  log(...values: unknown[]): void;
  error(...values: unknown[]): void;
  warn(...values: unknown[]): void;
}

export interface ModuleRecord {
  /** Node's `module.id`: the filename, or `'.'` for the entry module. */
  id: string;
  /** The canonical registry identity of the module. */
  readonly filename: string;
  readonly dirname: string;
  readonly path: string;
  readonly format: ModuleFormat;
  state: ModuleRecordState;
  loaded: boolean;
  readonly parent: ModuleRecord | null;
  readonly children: ModuleRecord[];
  readonly paths: string[];
  require: CommonJsRequire;
  exports: unknown;
  promise?: Promise<Record<string, unknown>>;
}

/**
 * A CommonJS module as Node code sees it: through `module`, `require.cache`,
 * `require.main` and a `require.extensions` handler. It is a view of the
 * engine's module record; the registry's evaluation state stays private.
 */
export interface CommonJsModule {
  /** Node's `module.id`: the filename, or `'.'` for the entry module. */
  readonly id: string;
  readonly filename: string;
  /** The directory of the module, as Node's `module.path`. */
  readonly path: string;
  exports: unknown;
  loaded: boolean;
  readonly parent: CommonJsModule | null;
  readonly children: readonly CommonJsModule[];
  readonly paths: readonly string[];
  readonly require: CommonJsRequire;
}

export interface CommonJsRequire {
  (specifier: string): unknown;
  readonly cache: Record<string, CommonJsModule>;
  readonly extensions: Record<string, CommonJsExtensionHandler>;
  /** The CommonJS entry module, or undefined when the entry is an ES module. */
  readonly main: CommonJsModule | undefined;
  readonly resolve: CommonJsRequireResolve;
}

export interface CommonJsRequireResolve {
  (specifier: string, options?: { readonly paths?: readonly string[] }): string;
  /** The directories searched for `specifier`, or null for a builtin. */
  paths(specifier: string): string[] | null;
}

export type CommonJsExtensionHandler = (module: CommonJsModule, filename: string) => void;

export interface NodeModuleAccess {
  readonly cache: Record<string, CommonJsModule>;
  readonly extensions: Record<string, CommonJsExtensionHandler>;
  /**
   * Runs CommonJS source as the module a program built with `new Module()`:
   * its `require` resolves from `filename`, and its exports become the module's.
   */
  compile(
    module: { exports: unknown; loaded: boolean; readonly paths?: readonly string[] },
    source: string,
    filename: string
  ): unknown;
  createRequireFunction(filename: string | URL): CommonJsRequire;
  findPath(request: string, paths: readonly string[]): string | false;
  load(request: string, parentFilename?: string): unknown;
  modulePaths(fromDirectory: string): string[];
  /** The directories `require()` searches after `node_modules`, as `Module.globalPaths` lists them. */
  readonly globalPaths: readonly string[];
  /** Computes the global paths again from `NODE_PATH` and `HOME`, as `Module._initPaths()` does. */
  initPaths(): void;
  registerCustomizationHooks(
    specifier: string | URL,
    options: ModuleCustomizationRegistrationOptions
  ): void;
  resolveFilename(request: string, parentFilename?: string): string;
  /** Re-runs ES module bindings of builtins so they observe exports patched since. */
  syncBuiltinEsmExports(): void;
}

export interface ScriptEvaluator {
  evaluate(source: string, options?: { readonly filename?: string }): unknown;
  /** Runs a script whose free identifiers resolve through `options.scopes`, for `node:vm` contexts. */
  evaluateInScopes?(
    source: string,
    options: ScopedScriptOptions
  ): { readonly result: unknown; readonly declared: readonly unknown[] };
  /** A function whose free identifiers resolve through `options.scopes`, for `vm.compileFunction`. */
  compileFunctionInScopes?(
    body: string,
    params: readonly string[],
    options: Readonly<{ filename: string; scopes: readonly object[] }>
  ): Function;
}

export interface ModuleCustomizationRegistrationOptions {
  readonly parentURL?: string | URL;
  readonly data?: unknown;
  readonly transferList?: readonly unknown[];
}

export interface ModuleEntryOptions {
  readonly require?: readonly string[];
  readonly import?: readonly string[];
}

/**
 * Recognises the `node` options the Module Execution Engine acts on. An option
 * returned without a value takes the following argument as its value.
 */
export function parseModulePreloadArgument(
  argument: string
): { readonly kind: 'require' | 'import' | 'conditions'; readonly value?: string } | undefined {
  if (argument === '-r' || argument === '--require') return { kind: 'require' };
  if (argument === '--import') return { kind: 'import' };
  if (argument === '-C' || argument === '--conditions') return { kind: 'conditions' };
  if (argument.startsWith('--conditions=')) {
    return { kind: 'conditions', value: argument.slice('--conditions='.length) };
  }
  if (argument.startsWith('-r=')) return { kind: 'require', value: argument.slice(3) };
  if (argument.startsWith('--require=')) {
    return { kind: 'require', value: argument.slice('--require='.length) };
  }
  if (argument.startsWith('--import=')) {
    return { kind: 'import', value: argument.slice('--import='.length) };
  }
  return undefined;
}

type CustomizationHookNamespace = {
  readonly initialize?: (data: unknown) => unknown;
  readonly resolve?: (
    specifier: string,
    context: CustomizationResolveContext,
    nextResolve: CustomizationResolveNext
  ) => unknown;
  readonly load?: (
    url: string,
    context: CustomizationLoadContext,
    nextLoad: CustomizationLoadNext
  ) => unknown;
};

type CustomizationHook = (...args: unknown[]) => unknown;

type CustomizationResolveContext = {
  readonly conditions: readonly string[];
  readonly importAttributes: Record<string, never>;
  readonly parentURL?: string;
};

type CustomizationLoadContext = {
  readonly conditions: readonly string[];
  readonly format?: string | null;
  readonly importAttributes: Record<string, never>;
};

type CustomizationResolveResult = {
  readonly url: string;
  readonly format?: string | null;
  readonly importAttributes?: Record<string, never>;
  readonly shortCircuit?: boolean;
};

const DEFAULT_LOAD_FORMAT = Symbol('default-load-format');

type CustomizationLoadResult = {
  readonly format: string;
  readonly source?: string | Uint8Array | ArrayBuffer;
  readonly shortCircuit?: boolean;
  readonly [DEFAULT_LOAD_FORMAT]?: Exclude<ModuleFormat, 'builtin'>;
};

type CustomizationResolveNext = (
  specifier?: string,
  context?: CustomizationResolveContext
) => Promise<CustomizationResolveResult>;

type CustomizationLoadNext = (
  url?: string,
  context?: CustomizationLoadContext
) => Promise<CustomizationLoadResult>;

type CustomizedModuleLoad = {
  readonly format: Exclude<ModuleFormat, 'builtin'>;
  readonly source?: string | Uint8Array;
};

const CUSTOMIZATION_HOOK_BOOTSTRAP = '\u0000module-customization-hook-bootstrap';

export interface ModuleExecutionEngineOptions {
  readonly cwd: string;
  readonly moduleAccess: ModuleAccess;
  readonly moduleResolution?: {
    readonly pnp?: boolean;
    readonly conditions?: readonly string[];
    readonly errorAdapter?: ModuleResolutionErrorAdapter;
  };
  readonly builtinModuleProvider: BuiltinModuleProvider;
  readonly process: ModuleExecutionProcess;
  readonly console: ModuleExecutionConsole;
  readonly global?: typeof globalThis;
  readonly runtimeArtifactCompiler: RuntimeArtifactCompilerOptions;
  readonly evaluateCommonJs?: (input: {
    readonly id: string;
    /** True for the entry module, whose evaluation is a turn of its own. */
    readonly main: boolean;
    readonly evaluate: () => unknown;
  }) => unknown;
  readonly onModuleStart?: (path: string, format: 'esm' | 'cjs') => void;
  readonly onModuleEnd?: (path: string, format: 'esm' | 'cjs') => void;
}

export interface ModuleExecutionEngine {
  readonly commonJsCache: Record<string, CommonJsModule>;
  readonly commonJsExtensions: Record<string, CommonJsExtensionHandler>;
  /** The CommonJS entry module (`require.main`), or undefined for an ES module entry. */
  readonly mainModule: CommonJsModule | undefined;
  readonly nodeModuleAccess: NodeModuleAccess;
  readonly scriptEvaluator: ScriptEvaluator;
  /**
   * Both entry methods resolve with the entry's exports, or with undefined when
   * the exports object is itself a thenable: a promise cannot carry a thenable
   * without calling its `then`, which evaluation never does to program values.
   */
  runCommonJsSource(source: string, options?: { readonly filename?: string }): Promise<unknown>;
  runEntry(entry: string, options?: ModuleEntryOptions): Promise<unknown>;
  import(specifier: string | URL, fromDirectory: string, ancestors?: ReadonlySet<string>): Promise<Record<string, unknown>>;
  require(specifier: string, fromDirectory: string): unknown;
  resolve(specifier: string | URL, fromDirectory: string, mode?: ResolutionMode): string;
  teardown(): void;
}

export function createModuleExecutionEngine(options: ModuleExecutionEngineOptions): ModuleExecutionEngine {
  return new ContextModuleExecutionEngine(options);
}

class ContextModuleExecutionEngine implements ModuleExecutionEngine {
  private readonly records = new Map<string, ModuleRecord>();
  private readonly dataSources = new Map<string, string>();
  private readonly commonJsSources = new Map<string, string>();
  /** The ES source a `module._compile` call supplied, read while that module loads. */
  private readonly compiledEsmSources = new Map<string, string>();
  private readonly customizedLoads = new Map<string, CustomizedModuleLoad>();
  private readonly customizationHooks: CustomizationHookNamespace[] = [];
  private readonly syntheticImportNamespaces = new WeakMap<ModuleRecord, Record<string, unknown>>();
  private readonly builtinImportNamespaces: Record<string, unknown>[] = [];
  /** The `_compile` of each record as the runtime made it, to tell a program's replacement from it. */
  private readonly runtimeCompiles = new WeakSet<Function>();
  /** Records of ES modules handed to a program's `require.extensions` handler, with their format. */
  private readonly esmThroughProgramHandler = new WeakMap<ModuleRecord, Extract<ModuleFormat, 'module' | 'module-typescript'>>();
  /** Which evaluating modules each importing module is currently waiting for. */
  private readonly importWaits = new Map<string, Set<string>>();
  private readonly conditions: readonly string[];
  private entryModule: ModuleRecord | undefined;
  private readonly compiler: RuntimeArtifactCompiler;
  private readonly resolver: ModuleResolver;
  /** Read by the resolver on each lookup, so `Module._initPaths()` changes it in place. */
  private readonly globalPaths: string[] = [];
  private customizationReady: Promise<void> = Promise.resolve();
  private tornDown = false;
  readonly commonJsCache: Record<string, CommonJsModule>;
  readonly nodeModuleAccess: NodeModuleAccess;
  readonly scriptEvaluator: ScriptEvaluator;

  constructor(private readonly options: ModuleExecutionEngineOptions) {
    this.commonJsCache = createCommonJsCacheProjection(this.records);
    this.conditions = [
      ...new Set([
        ...(options.moduleResolution?.conditions ?? []),
        ...moduleConditionsFromExecArgv(options.process.execArgv ?? [])
      ])
    ];
    this.globalPaths.push(...nodeGlobalPaths(options.process, options.cwd));
    this.resolver = createModuleResolver(options.moduleAccess, {
      cwd: options.cwd,
      pnp: options.moduleResolution?.pnp,
      conditions: this.conditions,
      globalPaths: this.globalPaths,
      commitJournal: options.moduleAccess.commitJournal
    });
    this.compiler = createRuntimeArtifactCompiler(
      {
        process: options.process,
        console: options.console,
        global: options.global ?? globalThis,
        readText: (path) => {
          const commonJsSource = this.commonJsSources.get(path) ?? this.compiledEsmSources.get(path);
          if (commonJsSource !== undefined) return commonJsSource;
          const inlineNodeEntry = options.moduleAccess[INLINE_NODE_MODULE_ENTRY]?.(path);
          return inlineNodeEntry
            ? inlineNodeModuleSource(inlineNodeEntry)
            : (this.customizedText(path) ?? this.dataSources.get(path) ?? options.moduleAccess.readText(path));
        },
        readBytes: (path) => {
          const customized = this.customizedBytes(path);
          if (customized) return customized;
          if (!options.moduleAccess.readFileSync) {
            throw new Error(`Module byte access is unavailable for ${path}`);
          }
          return options.moduleAccess.readFileSync(path);
        },
        requireModule: (specifier, fromDirectory) => this.requireImported(specifier, fromDirectory),
        importModule: (specifier, fromDirectory, ancestors = new Set()) => this.import(specifier, fromDirectory, ancestors),
        resolveModuleUrl: (specifier, parentIdentity, fromDirectory) =>
          this.resolveImportMeta(specifier, parentIdentity, fromDirectory),
        requireEsmInPlace: (record) => this.requireEsmInPlace(record),
        requireEsmFromSource: (record, source) => this.requireEsmFromSource(record, source),
        programCompile: (record) => {
          const compile = (record as { _compile?: unknown })._compile;
          return typeof compile === 'function' && !this.runtimeCompiles.has(compile)
            ? (compile as (source: string, filename: string) => unknown)
            : undefined;
        }
      },
      options.runtimeArtifactCompiler
    );
    const thisEngine = this;
    this.nodeModuleAccess = {
      cache: this.commonJsCache,
      get extensions() {
        return thisEngine.compiler.commonJsExtensions;
      },
      compile: (module, source, filename) => {
        const record = this.createRecord(filename, 'commonjs', module.exports, 'evaluating', null, {
          paths: module.paths
        });
        const result = this.compiler.compileCommonJsSource(record, source);
        module.exports = record.exports;
        module.loaded = true;
        return result;
      },
      createRequireFunction: (filename) => this.createRequireFrom(filename),
      findPath: (request, paths) => this.findPath(request, paths),
      load: (request, parentFilename) =>
        this.require(request, parentFilename ? dirnameWithoutNormalising(parentFilename) : this.options.cwd),
      modulePaths: (fromDirectory) => nodeModulePaths(resolveDirectory(fromDirectory, this.options.cwd)),
      globalPaths: this.globalPaths,
      initPaths: () => {
        this.globalPaths.splice(0, this.globalPaths.length, ...nodeGlobalPaths(this.options.process, this.options.process.cwd()));
      },
      registerCustomizationHooks: (specifier, registrationOptions) =>
        this.registerCustomizationHooks(specifier, registrationOptions),
      resolveFilename: (request, parentFilename) =>
        this.resolve(request, parentFilename ? dirnameWithoutNormalising(parentFilename) : this.options.cwd, 'require'),
      syncBuiltinEsmExports: () => {
        for (const namespace of this.builtinImportNamespaces) {
          this.compiler.refreshLiveExportsNamespace(namespace, { rebind: true });
        }
      }
    };
    this.scriptEvaluator = {
      evaluate: (source, evaluatorOptions = {}) =>
        this.compiler.evaluateScript(String(source), evaluatorOptions.filename ?? 'node:vm'),
      evaluateInScopes,
      compileFunctionInScopes
    };
  }

  get mainModule(): CommonJsModule | undefined {
    return this.entryModule;
  }

  get commonJsExtensions(): Record<string, CommonJsExtensionHandler> {
    return this.compiler.commonJsExtensions;
  }

  async runCommonJsSource(
    source: string,
    options: { readonly filename?: string } = {}
  ): Promise<unknown> {
    await this.prepareEntry();
    const filename = options.filename ?? '[worker eval]';
    this.commonJsSources.set(filename, source);
    const record = this.createRecord(filename, 'commonjs', {}, 'linking', null, {
      dirname: '.',
      paths: nodeModulePaths(this.options.cwd),
      requireFrom: this.options.cwd
    });
    this.records.set(filename, record);
    this.entryModule ??= record;
    try {
      const result = this.evaluateCommonJsRecord(filename, record);
      await this.compiler.drain();
      await this.drainCustomizationRegistrations();
      await this.compiler.drain();
      return entryCompletionValue(result);
    } catch (error) {
      this.evictFailedRecord(record);
      throw error;
    }
  }

  async runEntry(
    entry: string,
    entryOptions: ModuleEntryOptions = moduleEntryOptionsFromExecArgv(this.options.process.execArgv ?? [])
  ): Promise<unknown> {
    await this.prepareEntry(entryOptions);
    const resolved = await this.prepareImport(entry, this.options.cwd, new Set());
    const result = isEsmFormat(this.moduleFormat(resolved))
      ? await this.importResolved(resolved, new Set())
      : this.requireResolved(resolved, null, true);
    await this.compiler.drain();
    await this.drainCustomizationRegistrations();
    await this.compiler.drain();
    return entryCompletionValue(result);
  }

  teardown(): void {
    if (this.tornDown) return;
    this.tornDown = true;
    this.customizationHooks.length = 0;
    this.customizedLoads.clear();
    this.commonJsSources.clear();
    this.builtinImportNamespaces.length = 0;
    this.importWaits.clear();
  }

  async import(
    specifier: string | URL,
    fromDirectory: string,
    ancestors: ReadonlySet<string> = new Set()
  ): Promise<Record<string, unknown>> {
    if (!ancestors.has(CUSTOMIZATION_HOOK_BOOTSTRAP)) await this.customizationReady;
    const specifierText = moduleSpecifierText(specifier);
    this.rejectRelativeSpecifierFromDataModule(specifierText, fromDirectory);
    const resolved = await this.prepareImport(specifierText, fromDirectory, ancestors);
    const builtin = this.loadBuiltin(resolved);
    if (builtin) return this.syntheticImportNamespace(builtin);
    return this.importResolved(resolved, ancestors);
  }

  require(specifier: string, fromDirectory: string): unknown {
    return this.requireFrom(specifier, fromDirectory, null);
  }

  private requireFrom(specifier: string, fromDirectory: string, parent: ModuleRecord | null): unknown {
    this.rejectRelativeSpecifierFromDataModule(specifier, fromDirectory);
    if (isDataSpecifier(specifier)) {
      throw new Error(`Cannot require a data: module from CommonJS: ${specifier}`);
    }
    const builtin = this.loadBuiltin(specifier);
    if (builtin) return builtin.exports;
    return this.requireResolved(this.resolve(specifier, fromDirectory, 'require'), parent);
  }

  /**
   * A static import of an ES module that `require()` loaded: evaluated
   * synchronously, but resolved with the `import` conditions and handed over as
   * the imported module's namespace, as Node links a required ES module graph.
   */
  private requireImported(specifier: string, fromDirectory: string): unknown {
    this.rejectRelativeSpecifierFromDataModule(specifier, fromDirectory);
    if (isDataSpecifier(specifier)) {
      throw new Error(`Cannot synchronously import a data: module: ${specifier}`);
    }
    const builtin = this.loadBuiltin(specifier);
    if (builtin) return builtin.exports;
    return this.requireResolved(this.resolve(specifier, fromDirectory, 'import'), null, false, 'namespace');
  }

  resolve(specifier: string | URL, fromDirectory: string, mode: ResolutionMode = 'import'): string {
    const specifierText = moduleSpecifierText(specifier);
    this.rejectRelativeSpecifierFromDataModule(specifierText, fromDirectory);
    if (isDataSpecifier(specifierText)) return canonicalDataSpecifier(specifierText);
    try {
      return this.resolver.resolve(specifierText, fromDirectory, mode);
    } catch (error) {
      if (error instanceof ModuleResolutionError && this.options.moduleResolution?.errorAdapter) {
        throw this.options.moduleResolution.errorAdapter.adapt({ kind: error.kind, message: error.message, mode });
      }
      throw error;
    }
  }

  private resolveImportMeta(
    specifier: string,
    parentIdentity: string,
    fromDirectory: string
  ): string {
    const builtin = this.options.builtinModuleProvider.resolve(specifier);
    if (builtin !== undefined) return builtin;
    if (isDataSpecifier(specifier)) return canonicalDataSpecifier(specifier);
    if (specifier.startsWith('file:') || specifier.startsWith('/') || isRelativeSpecifier(specifier)) {
      this.rejectRelativeSpecifierFromDataModule(specifier, parentIdentity);
      return new URL(specifier, moduleUrlFromIdentity(parentIdentity)).href;
    }
    return moduleUrlFromIdentity(this.resolve(specifier, fromDirectory, 'import'));
  }

  private loadBuiltin(specifier: string): ModuleRecord | undefined {
    const canonical = canonicalBuiltinSpecifier(specifier);
    const existing = this.records.get(canonical);
    if (existing) return existing;
    const loaded = this.options.builtinModuleProvider.load(specifier);
    if (!loaded.found) return undefined;
    const record = this.createRecord(canonical, 'builtin', loaded.module, 'evaluated', null);
    this.records.set(canonical, record);
    return record;
  }

  private async importResolved(resolved: string, ancestors: ReadonlySet<string>): Promise<Record<string, unknown>> {
    const importer = [...ancestors].at(-1);
    const existing = this.records.get(resolved);
    if (existing) {
      if (!isEsmFormat(existing.format)) return this.syntheticImportNamespace(existing);
      if (!existing.promise || existing.state === 'evaluated') {
        return existing.promise ?? moduleNamespace(existing);
      }
      // A module that is still evaluating and already waits, directly or
      // through other imports, for this importer is part of a cycle. Waiting
      // for it would deadlock, so the importer links to its namespace as it is.
      if (ancestors.has(resolved) || this.waitsForAny(resolved, ancestors)) {
        return moduleNamespace(existing);
      }
      return this.waitForImport(importer, resolved, existing.promise);
    }

    const format = this.moduleFormat(resolved);
    if (!isEsmFormat(format)) {
      this.requireResolved(resolved, null);
      const record = this.records.get(resolved);
      if (!record) throw new Error(`Module registry invariant failed for synthetic namespace: ${resolved}`);
      return this.syntheticImportNamespace(record);
    }

    const record = this.createRecord(resolved, format, this.compiler.createEsmNamespace(), 'linking', null);
    this.records.set(resolved, record);
    const nextAncestors = new Set([...ancestors, resolved]);
    const promise = this.withLifecycle(resolved, 'esm', async () => {
      record.state = 'evaluating';
      const exports = record.format === 'wasm'
        ? await this.compiler.evaluateWasm(record)
        : await this.compiler.evaluateEsm(record, nextAncestors);
      record.exports = this.compiler.finalizeEsmNamespace(exports);
      record.state = 'evaluated';
      record.loaded = true;
      return exports;
    }).catch((error) => {
      this.evictFailedRecord(record);
      throw error;
    });
    record.promise = promise;
    return this.waitForImport(importer, resolved, promise);
  }

  private waitForImport(
    importer: string | undefined,
    imported: string,
    promise: Promise<Record<string, unknown>>
  ): Promise<Record<string, unknown>> {
    if (importer === undefined || importer === CUSTOMIZATION_HOOK_BOOTSTRAP) return promise;
    const waits = this.importWaits.get(importer) ?? new Set<string>();
    this.importWaits.set(importer, waits);
    waits.add(imported);
    const release = (): void => {
      waits.delete(imported);
      if (waits.size === 0 && this.importWaits.get(importer) === waits) this.importWaits.delete(importer);
    };
    void promise.then(release, release);
    return promise;
  }

  private waitsForAny(start: string, targets: ReadonlySet<string>): boolean {
    const visited = new Set<string>([start]);
    const pending = [start];
    for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
      for (const awaited of this.importWaits.get(current) ?? []) {
        if (targets.has(awaited)) return true;
        if (visited.has(awaited)) continue;
        visited.add(awaited);
        pending.push(awaited);
      }
    }
    return false;
  }

  private requireResolved(
    resolved: string,
    parent: ModuleRecord | null,
    main = false,
    esmResult: 'required' | 'namespace' = 'required'
  ): unknown {
    const existing = this.records.get(resolved);
    if (existing) {
      this.linkParentAndChild(parent, existing);
      if (existing.format === 'wasm') {
        throw new Error(`Cannot require WebAssembly module synchronously: ${resolved}`);
      }
      if (isEsmFormat(existing.format) && existing.promise && existing.state !== 'evaluated') {
        throw new Error(`Cannot synchronously require an evaluating ESM module from CommonJS: ${resolved}`);
      }
      return isEsmFormat(existing.format) && esmResult === 'required'
        ? requiredEsmValue(existing.exports)
        : existing.exports;
    }

    const format = this.moduleFormat(resolved);
    if (format === 'wasm') {
      throw new Error(`Cannot require WebAssembly module synchronously: ${resolved}`);
    }
    if (format === 'json') return this.requireCommonJs(resolved, parent, 'json', main);
    // A `require.extensions` handler a program installed decides what a
    // required file is, as in Node, where it replaces the default `.js` loader:
    // a bundler can hand over compiled CommonJS in place of an ES source.
    if (isEsmFormat(format) && esmResult === 'required' && !/\.m[jt]s$/.test(resolved) &&
      this.compiler.hasProgramCommonJsHandler(resolved)) {
      return this.requireCommonJs(resolved, parent, 'commonjs', main, format);
    }
    if (isEsmFormat(format)) {
      const namespace = this.requireEsmSynchronously(resolved, parent, format);
      return esmResult === 'required' ? requiredEsmValue(namespace) : namespace;
    }
    return this.requireCommonJs(resolved, parent, format, main);
  }

  private requireCommonJs(
    resolved: string,
    parent: ModuleRecord | null,
    format: Extract<ModuleFormat, 'commonjs' | 'commonjs-typescript' | 'json'> = 'commonjs',
    main = false,
    /** The ES format of a file a program's handler is given in place of the runtime. */
    esmFormat?: Extract<ModuleFormat, 'module' | 'module-typescript'>
  ): unknown {
    const record = this.createRecord(resolved, format, {}, 'linking', parent);
    if (esmFormat) this.esmThroughProgramHandler.set(record, esmFormat);
    this.records.set(resolved, record);
    if (main && !this.entryModule) {
      record.id = '.';
      this.entryModule = record;
    }
    try {
      return this.evaluateCommonJsRecord(resolved, record);
    } catch (error) {
      this.evictFailedRecord(record);
      throw error;
    }
  }

  private evaluateCommonJsRecord(resolved: string, record: ModuleRecord): unknown {
    return this.withSynchronousLifecycle(resolved, 'cjs', () => {
      record.state = 'evaluating';
      const evaluate = () => this.compiler.evaluateCommonJs(record);
      const evaluatedExports =
        this.options.evaluateCommonJs?.({ id: resolved, main: record === this.entryModule, evaluate }) ??
        evaluate();
      const exports = replaceCommonJsExportsWhenWritable(record, evaluatedExports);
      record.state = 'evaluated';
      record.loaded = true;
      // An ES module that imported this one mid-evaluation sees what it exported since.
      const namespace = this.syntheticImportNamespaces.get(record);
      if (namespace) this.compiler.refreshLiveExportsNamespace(namespace, { rebind: true });
      return exports;
    });
  }

  /**
   * The runtime's `.js` handler, reached through a program's own for a file
   * that is an ES module: it loads as one, as Node's default loader does, and
   * the program's handler receives its `module.exports` export or namespace.
   */
  private requireEsmInPlace(record: ModuleRecord): boolean {
    const format = this.esmThroughProgramHandler.get(record);
    if (!format) return false;
    this.loadRecordAsEsm(record, format);
    return true;
  }

  /**
   * `module._compile` of a source that only parses as an ES module: the
   * module loads from that source, as Node's `_compile` loads it, and
   * `record.exports` becomes what `require()` of it returns.
   */
  private requireEsmFromSource(record: ModuleRecord, source: string): boolean {
    this.compiledEsmSources.set(record.filename, source);
    try {
      this.loadRecordAsEsm(record, this.esmThroughProgramHandler.get(record) ?? 'module');
    } finally {
      this.compiledEsmSources.delete(record.filename);
    }
    return true;
  }

  private loadRecordAsEsm(record: ModuleRecord, format: Extract<ModuleFormat, 'module' | 'module-typescript'>): void {
    this.esmThroughProgramHandler.delete(record);
    if (this.records.get(record.filename) === record) this.records.delete(record.filename);
    record.exports = requiredEsmValue(this.requireEsmSynchronously(record.filename, record.parent, format));
  }

  private requireEsmSynchronously(
    resolved: string,
    parent: ModuleRecord | null,
    format: Extract<ModuleFormat, 'module' | 'module-typescript'>
  ): unknown {
    const record = this.createRecord(
      resolved,
      format,
      this.compiler.createEsmNamespace({ commonJsInterop: true }),
      'linking',
      parent
    );
    this.records.set(resolved, record);
    try {
      return this.withSynchronousLifecycle(resolved, 'esm', () => {
        record.state = 'evaluating';
        record.exports = this.compiler.finalizeEsmNamespace(
          this.compiler.evaluateEsmSynchronously(record),
          { commonJsInterop: true }
        );
        record.state = 'evaluated';
        record.loaded = true;
        return record.exports;
      });
    } catch (error) {
      this.evictFailedRecord(record);
      throw error;
    }
  }

  private moduleFormat(resolved: string): Exclude<ModuleFormat, 'builtin'> {
    const customized = this.customizedLoads.get(resolved);
    if (customized) return customized.format;
    if (this.dataSources.has(resolved)) return 'module';
    const extensionFormat = /\.(?:json|wasm|mts|cts|tsx|mjs|cjs)$/.test(resolved)
      ? moduleFormatFromPath(resolved, undefined)
      : moduleFormatFromPath(resolved, this.resolver.packageScope(dirnameWithoutNormalising(resolved))?.manifest.type);
    if (extensionFormat !== 'detect' && extensionFormat !== 'detect-typescript') return extensionFormat;
    // Neither the extension nor the package scope settles the format, so the
    // source does, as in Node: a script is CommonJS and anything that only
    // parses as a module is an ES module.
    const typeScript = extensionFormat === 'detect-typescript';
    const detected = this.options.moduleAccess.isFile(resolved)
      ? this.compiler.detectFormat(resolved, typeScript)
      : 'commonjs';
    if (detected === 'module') return typeScript ? 'module-typescript' : 'module';
    return typeScript ? 'commonjs-typescript' : 'commonjs';
  }

  private importData(specifier: string, ancestors: ReadonlySet<string>): Promise<Record<string, unknown>> {
    const data = parseJavaScriptDataModule(specifier);
    this.dataSources.set(data.id, data.source);
    return this.importResolved(data.id, ancestors);
  }

  private registerCustomizationHooks(
    specifier: string | URL,
    registrationOptions: ModuleCustomizationRegistrationOptions
  ): void {
    if (this.tornDown) {
      throw new Error('Cannot register module customization hooks after Execution Context teardown.');
    }
    const parentDirectory = customizationParentDirectory(registrationOptions.parentURL);
    const registrationData = cloneCustomizationData(registrationOptions.data, registrationOptions.transferList);
    const readyBeforeRegistration = this.customizationReady;
    this.customizationReady = readyBeforeRegistration.then(async () => {
      const namespace = await this.import(
        hooksModuleSpecifier(specifier),
        parentDirectory,
        new Set([CUSTOMIZATION_HOOK_BOOTSTRAP])
      );
      const hooks = customizationHooks(namespace);
      if (this.tornDown) return;
      await hooks.initialize?.(registrationData);
      if (!this.tornDown) this.customizationHooks.push(hooks);
    });
    void this.customizationReady.catch(() => undefined);
  }

  private async drainCustomizationRegistrations(): Promise<void> {
    while (true) {
      const pending = this.customizationReady;
      await pending;
      if (pending === this.customizationReady) return;
    }
  }

  private async prepareImport(
    specifier: string,
    fromDirectory: string,
    ancestors: ReadonlySet<string>
  ): Promise<string> {
    if (this.customizationHooks.length === 0) {
      if (isDataSpecifier(specifier)) {
        const data = parseJavaScriptDataModule(specifier);
        this.dataSources.set(data.id, data.source);
        return data.id;
      }
      const builtin = this.loadBuiltin(specifier);
      if (builtin) return builtin.filename;
      return this.resolve(specifier, fromDirectory, 'import');
    }
    const parentIdentity = [...ancestors].at(-1);
    const parentURL = parentIdentity === undefined || parentIdentity === CUSTOMIZATION_HOOK_BOOTSTRAP
      ? undefined
      : moduleUrlFromIdentity(parentIdentity);
    const resolved = await this.runResolveHooks(specifier, {
      conditions: customizationConditions(this.conditions),
      importAttributes: {},
      parentURL
    }, fromDirectory);
    const loaded = await this.runLoadHooks(resolved.url, {
      conditions: customizationConditions(this.conditions),
      format: resolved.format,
      importAttributes: resolved.importAttributes ?? {}
    });
    const identity = customizationIdentity(resolved.url);
    if (loaded.format === 'builtin') return identity;
    this.customizedLoads.set(identity, {
      format: loaded[DEFAULT_LOAD_FORMAT] ?? customizationModuleFormat(loaded.format),
      source: normalizeCustomizationSource(loaded.source)
    });
    return identity;
  }

  private async runResolveHooks(
    specifier: string,
    context: CustomizationResolveContext,
    fromDirectory: string
  ): Promise<CustomizationResolveResult> {
    const invoke = async (
      index: number,
      nextSpecifier = specifier,
      nextContext = context
    ): Promise<CustomizationResolveResult> => {
      const hook = this.customizationHooks[index]?.resolve;
      if (!hook) return this.defaultResolve(nextSpecifier, nextContext, fromDirectory);
      let calledNext = false;
      const result = await hook(
        nextSpecifier,
        nextContext,
        async (requestedSpecifier = nextSpecifier, requestedContext = nextContext) => {
          calledNext = true;
          return invoke(index - 1, requestedSpecifier, requestedContext);
        }
      );
      return validateResolveHookResult(result, calledNext);
    };
    return invoke(this.customizationHooks.length - 1);
  }

  private async runLoadHooks(url: string, context: CustomizationLoadContext): Promise<CustomizationLoadResult> {
    const invoke = async (
      index: number,
      nextUrl = url,
      nextContext = context
    ): Promise<CustomizationLoadResult> => {
      const hook = this.customizationHooks[index]?.load;
      if (!hook) return this.defaultLoad(nextUrl, nextContext);
      let calledNext = false;
      const result = await hook(
        nextUrl,
        nextContext,
        async (requestedUrl = nextUrl, requestedContext = nextContext) => {
          calledNext = true;
          return invoke(index - 1, requestedUrl, requestedContext);
        }
      );
      return validateLoadHookResult(result, calledNext);
    };
    return invoke(this.customizationHooks.length - 1);
  }

  private defaultResolve(
    specifier: string,
    context: CustomizationResolveContext,
    fromDirectory: string
  ): CustomizationResolveResult {
    if (isDataSpecifier(specifier)) return { url: canonicalDataSpecifier(specifier), format: 'module' };
    const builtin = this.loadBuiltin(specifier);
    if (builtin) return { url: builtin.filename, format: 'builtin' };
    const resolutionDirectory = context.parentURL === undefined
      ? fromDirectory
      : customizationParentDirectory(context.parentURL);
    return { url: moduleUrlFromIdentity(this.resolve(specifier, resolutionDirectory, 'import')) };
  }

  private defaultLoad(url: string, _context: CustomizationLoadContext): CustomizationLoadResult {
    const identity = customizationIdentity(url);
    if (identity.startsWith('node:')) return { format: 'builtin' };
    if (isDataSpecifier(identity)) return { format: 'module', source: parseJavaScriptDataModule(identity).source };
    const format = this.moduleFormat(identity);
    const loaded = {
      format: hookFormat(format),
      source: format === 'wasm' && this.options.moduleAccess.readFileSync
        ? this.options.moduleAccess.readFileSync(identity)
        : this.options.moduleAccess.readText(identity),
      [DEFAULT_LOAD_FORMAT]: format
    };
    return loaded;
  }

  private customizedText(path: string): string | undefined {
    const source = this.customizedLoads.get(path)?.source;
    if (source === undefined) return undefined;
    return typeof source === 'string' ? source : new TextDecoder().decode(source);
  }

  private customizedBytes(path: string): Uint8Array | undefined {
    const source = this.customizedLoads.get(path)?.source;
    if (source === undefined) return undefined;
    return typeof source === 'string' ? new TextEncoder().encode(source) : source.slice();
  }

  private syntheticImportNamespace(record: ModuleRecord): Record<string, unknown> {
    const existing = this.syntheticImportNamespaces.get(record);
    if (existing) {
      // Names added since the namespace was built become importable from now on.
      if (record.format !== 'json' && record.state === 'evaluated') {
        this.compiler.refreshLiveExportsNamespace(existing, { rebind: false });
      }
      return existing;
    }
    const namespace = record.format === 'json'
      ? { default: record.exports }
      : this.compiler.createLiveExportsNamespace(() => record.exports);
    this.syntheticImportNamespaces.set(record, namespace);
    if (record.format === 'builtin') this.builtinImportNamespaces.push(namespace);
    return namespace;
  }

  private rejectRelativeSpecifierFromDataModule(specifier: string, fromDirectory: string): void {
    if (isDataSpecifier(fromDirectory) && isRelativeSpecifier(specifier)) {
      throw new Error(`Cannot resolve relative specifier ${JSON.stringify(specifier)} from a data: module`);
    }
  }

  private createRecord(
    id: string,
    format: ModuleFormat,
    exports: unknown,
    state: ModuleRecordState,
    parent: ModuleRecord | null,
    location: {
      readonly dirname?: string;
      readonly paths?: readonly string[];
      readonly requireFrom?: string;
    } = {}
  ): ModuleRecord {
    const recordDirectory = location.dirname ?? dirnameWithoutNormalising(id);
    const record: ModuleRecord = {
      id,
      filename: id,
      dirname: recordDirectory,
      path: recordDirectory,
      format,
      state,
      loaded: state === 'evaluated',
      parent,
      children: [],
      paths: [...(location.paths ?? nodeModulePaths(recordDirectory))],
      require: undefined as unknown as CommonJsRequire,
      exports
    };
    record.require = this.createLocalRequire(record, location.requireFrom);
    // Node keeps `_compile` on the prototype; here it is a hidden own member, so
    // a record still enumerates and clones as its public fields.
    const compile = (source: string) => this.compiler.compileCommonJsSource(record, String(source));
    this.runtimeCompiles.add(compile);
    Object.defineProperty(record, '_compile', { configurable: true, writable: true, value: compile });
    this.linkParentAndChild(parent, record);
    return record;
  }

  private async prepareEntry(
    entryOptions: ModuleEntryOptions = moduleEntryOptionsFromExecArgv(this.options.process.execArgv ?? [])
  ): Promise<void> {
    await this.drainCustomizationRegistrations();
    for (const preload of entryOptions.require ?? []) this.require(preload, this.options.cwd);
    await this.drainCustomizationRegistrations();
    for (const preload of entryOptions.import ?? []) await this.import(preload, this.options.cwd);
    await this.drainCustomizationRegistrations();
  }

  private createLocalRequire(parent: ModuleRecord, fromDirectory = parent.dirname): CommonJsRequire {
    return this.defineRequire(
      (specifier: string) => this.requireFrom(specifier, fromDirectory, parent),
      fromDirectory
    );
  }

  private defineRequire(load: (specifier: string) => unknown, fromDirectory: string): CommonJsRequire {
    const resolve = (specifier: string, options?: { readonly paths?: readonly string[] }): string => {
      // A builtin resolves to its own name, prefixed or not, as Node answers it.
      if (this.options.builtinModuleProvider.resolve(specifier) !== undefined) return specifier;
      if (options?.paths === undefined) return this.resolve(specifier, fromDirectory, 'require');
      const searchPaths = options.paths.map((path) => resolveDirectory(path, fromDirectory));
      const resolved = this.findPath(specifier, searchPaths);
      // Resolving once more from the first path reports the miss as Node does.
      return resolved === false
        ? this.resolve(specifier, searchPaths[0] ?? fromDirectory, 'require')
        : resolved;
    };
    resolve.paths = (specifier: string): string[] | null => {
      if (this.options.builtinModuleProvider.resolve(specifier) !== undefined) return null;
      return specifier.startsWith('/') || isRelativeSpecifier(specifier)
        ? [fromDirectory]
        : nodeModulePaths(resolveDirectory(fromDirectory, this.options.cwd));
    };
    return Object.defineProperties(load, {
      resolve: { configurable: true, enumerable: true, value: resolve, writable: true },
      cache: { configurable: true, enumerable: true, value: this.commonJsCache, writable: true },
      extensions: {
        configurable: true,
        enumerable: true,
        value: this.compiler.commonJsExtensions,
        writable: true
      },
      main: { configurable: true, enumerable: true, get: () => this.entryModule }
    }) as CommonJsRequire;
  }

  private createRequireFrom(filename: string | URL): CommonJsRequire {
    const source = moduleFilename(filename);
    const fromDirectory = source.endsWith('/') ? source.replace(/\/+$/u, '') || '/' : dirnameWithoutNormalising(source);
    return this.defineRequire((specifier: string) => this.require(specifier, fromDirectory), fromDirectory);
  }

  private findPath(request: string, paths: readonly string[]): string | false {
    for (const path of paths) {
      try {
        return this.resolve(request, path, 'require');
      } catch (error) {
        if (!isModuleNotFound(error)) throw error;
      }
    }
    return false;
  }

  private linkParentAndChild(parent: ModuleRecord | null, child: ModuleRecord): void {
    if (parent && !parent.children.includes(child)) parent.children.push(child);
  }

  private evictFailedRecord(failed: ModuleRecord): void {
    if (this.records.get(failed.filename) === failed) this.records.delete(failed.filename);
    for (const record of this.records.values()) {
      for (let index = record.children.indexOf(failed); index !== -1; index = record.children.indexOf(failed)) {
        record.children.splice(index, 1);
      }
    }
  }

  private async withLifecycle<Value>(path: string, format: 'esm' | 'cjs', run: () => Promise<Value>): Promise<Value> {
    this.options.onModuleStart?.(path, format);
    try {
      return await run();
    } finally {
      this.options.onModuleEnd?.(path, format);
    }
  }

  private withSynchronousLifecycle<Value>(path: string, format: 'esm' | 'cjs', run: () => Value): Value {
    this.options.onModuleStart?.(path, format);
    try {
      return run();
    } finally {
      this.options.onModuleEnd?.(path, format);
    }
  }
}

function createCommonJsCacheProjection(
  records: Map<string, ModuleRecord>
): Record<string, CommonJsModule> {
  return new Proxy(Object.create(null) as Record<string, CommonJsModule>, {
    defineProperty(_target, property, descriptor) {
      if (typeof property !== 'string' || !('value' in descriptor)) return false;
      records.set(property, cacheRecord(property, descriptor.value));
      return true;
    },
    deleteProperty(_target, property) {
      if (typeof property !== 'string') return true;
      const record = records.get(property);
      return record && isCommonJsCacheRecord(record) ? records.delete(property) : true;
    },
    get(_target, property) {
      if (typeof property !== 'string') return undefined;
      const record = records.get(property);
      return record && isCommonJsCacheRecord(record) ? record : undefined;
    },
    getOwnPropertyDescriptor(_target, property) {
      if (typeof property !== 'string') return undefined;
      const record = records.get(property);
      if (!record || !isCommonJsCacheRecord(record)) return undefined;
      return {
        configurable: true,
        enumerable: true,
        value: record,
        writable: true
      };
    },
    has(_target, property) {
      if (typeof property !== 'string') return false;
      const record = records.get(property);
      return record !== undefined && isCommonJsCacheRecord(record);
    },
    ownKeys() {
      return [...records].filter(([, record]) => isCommonJsCacheRecord(record)).map(([id]) => id);
    },
    set(_target, property, value) {
      if (typeof property !== 'string') return false;
      records.set(property, cacheRecord(property, value));
      return true;
    }
  });
}

function cacheRecord(id: string, value: unknown): ModuleRecord {
  if (isModuleRecord(value)) return value;
  if (isRecord(value) && 'exports' in value) return value as unknown as ModuleRecord;
  return {
    id,
    filename: id,
    dirname: dirnameWithoutNormalising(id),
    path: dirnameWithoutNormalising(id),
    format: 'commonjs',
    state: 'evaluated',
    loaded: true,
    parent: null,
    children: [],
    paths: nodeModulePaths(dirnameWithoutNormalising(id)),
    require: undefined as unknown as CommonJsRequire,
    exports: undefined
  };
}

function isModuleRecord(value: unknown): value is ModuleRecord {
  return isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.filename === 'string' &&
    typeof value.dirname === 'string' &&
    typeof value.path === 'string' &&
    typeof value.format === 'string' &&
    typeof value.state === 'string' &&
    'exports' in value;
}

function isCommonJsCacheRecord(record: ModuleRecord): boolean {
  return record.format === undefined ||
    record.format === 'commonjs' ||
    record.format === 'commonjs-typescript' ||
    record.format === 'json' ||
    ((record.format === 'module' || record.format === 'module-typescript') && record.promise === undefined);
}

function replaceCommonJsExportsWhenWritable(
  record: ModuleRecord,
  evaluatedExports: unknown
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, 'exports');
  const writable = descriptor === undefined ||
    ('writable' in descriptor ? descriptor.writable === true : descriptor.set !== undefined);
  if (!writable) return evaluatedExports;
  record.exports = evaluatedExports;
  return record.exports;
}

function entryCompletionValue(value: unknown): unknown {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return value;
  if (value instanceof Promise) return value;
  return typeof (value as { readonly then?: unknown }).then === 'function' ? undefined : value;
}

function isEsmFormat(
  format: ModuleFormat
): format is Extract<ModuleFormat, 'module' | 'module-typescript' | 'wasm'> {
  return format === 'module' || format === 'module-typescript' || format === 'wasm';
}

function canonicalBuiltinSpecifier(specifier: string): string {
  return specifier.startsWith('node:') ? specifier : `node:${specifier}`;
}

function moduleSpecifierText(specifier: string | URL): string {
  return typeof specifier === 'string' ? specifier : specifier.href;
}

/**
 * A hooks module named by a path may carry a query (`./hooks.mjs?<id>`), which
 * in Node asks for a separate instance of the same file. One instance serves
 * every registration here, so the query is dropped.
 */
function hooksModuleSpecifier(specifier: string | URL): string {
  const text = moduleSpecifierText(specifier);
  const namesFile = isRelativeSpecifier(text) || text.startsWith('/') || text.startsWith('file:');
  return namesFile ? text.replace(/[?#].*$/u, '') : text;
}

function isDataSpecifier(specifier: string): boolean {
  return specifier.startsWith('data:');
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
}

function canonicalDataSpecifier(specifier: string): string {
  try {
    const url = new URL(specifier);
    if (url.protocol !== 'data:') throw new Error('not a data URL');
    return url.href;
  } catch {
    throw new Error(`Invalid data module specifier: ${specifier}`);
  }
}

function parseJavaScriptDataModule(specifier: string): { id: string; source: string } {
  const id = canonicalDataSpecifier(specifier);
  const dataPath = new URL(id).pathname;
  const comma = dataPath.indexOf(',');
  if (comma === -1) throw new Error(`Invalid data module specifier: ${specifier}`);
  const header = dataPath.slice(0, comma);
  const [mimeType = 'text/plain', ...parameters] = header.split(';');
  const normalizedMimeType = mimeType.toLowerCase();
  if (normalizedMimeType !== 'text/javascript' && normalizedMimeType !== 'application/javascript') {
    throw new Error(`Unsupported data module MIME type: ${normalizedMimeType}`);
  }
  const encodedSource = dataPath.slice(comma + 1);
  try {
    const source = parameters.some((parameter) => parameter.toLowerCase() === 'base64')
      ? decodeBase64DataSource(encodedSource)
      : decodeURIComponent(encodedSource);
    return { id, source };
  } catch {
    throw new Error(`Invalid data module source: ${specifier}`);
  }
}

function decodeBase64DataSource(encodedSource: string): string {
  const bytes = Uint8Array.from(atob(decodeURIComponent(encodedSource)), (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function moduleNamespace(record: ModuleRecord): Record<string, unknown> {
  if (isRecord(record.exports)) return record.exports;
  throw new Error(`Module registry invariant failed for ESM namespace: ${record.filename}`);
}

/**
 * The directory part of a module id, without normalising it. Module ids here
 * are not always VFS paths: `data:` URLs (`createRecord`), any key user code
 * puts in `require.cache` (`cacheRecord`), the parent filename user code hands
 * `Module._load()`/`Module._resolveFilename()`, the filename given to
 * `createRequire()`, an identity a customization hook returned
 * (`moduleFormat`), and a `file:` URL pathname that keeps `//`
 * (`customizationParentDirectory`). The Virtual File System's `dirname` would
 * make each of those absolute and collapse its segments, so these call sites
 * keep this one. Exported for tests only.
 */
export function dirnameWithoutNormalising(path: string): string {
  if (path === '/') return '/';
  const normalized = path.replace(/\/+$/, '');
  const slash = normalized.lastIndexOf('/');
  return slash <= 0 ? '/' : normalized.slice(0, slash);
}

/**
 * Appends one segment, without normalising. `nodeModulePaths` walks the
 * directories `dirnameWithoutNormalising` returns, so its entries keep the
 * same unnormalised prefix (`data:text/node_modules`, `/a//node_modules`).
 * Exported for tests only.
 */
export function joinPathWithoutNormalising(base: string, child: string): string {
  return base === '/' ? `/${child}` : `${base}/${child}`;
}

/**
 * Node's global module paths: the directories of `NODE_PATH`, then
 * `~/.node_modules`, `~/.node_libraries` and the installation's `lib/node`.
 */
function nodeGlobalPaths(process: ModuleExecutionProcess, cwd: string): string[] {
  const home = process.env.HOME;
  const prefix = dirnameWithoutNormalising(dirnameWithoutNormalising(process.execPath ?? '/usr/bin/node'));
  return [
    ...(process.env.NODE_PATH ?? '').split(':').filter(Boolean).map((path) => resolveDirectory(path, cwd)),
    ...(home ? [joinPathWithoutNormalising(home, '.node_modules'), joinPathWithoutNormalising(home, '.node_libraries')] : []),
    joinPathWithoutNormalising(prefix, 'lib/node')
  ];
}

/** Exported for tests only. */
export function nodeModulePaths(fromDirectory: string): string[] {
  const paths: string[] = [];
  let current = fromDirectory;
  while (true) {
    paths.push(joinPathWithoutNormalising(current, 'node_modules'));
    if (current === '/') return paths;
    current = dirnameWithoutNormalising(current);
  }
}

function moduleFilename(filename: string | URL): string {
  const value = moduleSpecifierText(filename);
  if (!value.startsWith('file:')) return value;
  const url = new URL(value);
  if (url.protocol !== 'file:') throw new TypeError(`createRequire() only supports file URLs: ${value}`);
  return decodeURIComponent(url.pathname);
}

function customizationHooks(namespace: Record<string, unknown>): CustomizationHookNamespace {
  return {
    initialize: customizationHook(namespace, 'initialize') as CustomizationHookNamespace['initialize'],
    resolve: customizationHook(namespace, 'resolve') as CustomizationHookNamespace['resolve'],
    load: customizationHook(namespace, 'load') as CustomizationHookNamespace['load']
  };
}

function customizationHook(
  namespace: Record<string, unknown>,
  name: 'initialize' | 'resolve' | 'load'
): CustomizationHook | undefined {
  const hook = namespace[name];
  if (hook === undefined) return undefined;
  if (typeof hook !== 'function') throw new TypeError(`module.register() hook ${name} must be a function.`);
  return hook as CustomizationHook;
}

function customizationParentDirectory(parentURL: string | URL | undefined): string {
  if (parentURL === undefined) return 'data:';
  const value = moduleSpecifierText(parentURL);
  if (!value.startsWith('file:')) return value;
  return dirnameWithoutNormalising(decodeURIComponent(new URL(value).pathname));
}

function customizationConditions(extra: readonly string[] | undefined): readonly string[] {
  return [...new Set(['node', 'import', 'default', ...(extra ?? [])])];
}

function validateResolveHookResult(value: unknown, calledNext: boolean): CustomizationResolveResult {
  if (!isRecord(value) || typeof value.url !== 'string') {
    throw new TypeError('resolve hook must return an object with a string url property.');
  }
  if (!calledNext && value.shortCircuit !== true) {
    throw new Error('resolve hook must call nextResolve() or return shortCircuit: true.');
  }
  if ('format' in value && value.format !== undefined && value.format !== null && typeof value.format !== 'string') {
    throw new TypeError('resolve hook format must be a string, null, or undefined.');
  }
  return value as CustomizationResolveResult;
}

function validateLoadHookResult(value: unknown, calledNext: boolean): CustomizationLoadResult {
  if (!isRecord(value) || typeof value.format !== 'string') {
    throw new TypeError('load hook must return an object with a string format property.');
  }
  if (!calledNext && value.shortCircuit !== true) {
    throw new Error('load hook must call nextLoad() or return shortCircuit: true.');
  }
  if (value.format !== 'builtin' && value.format !== 'commonjs' && !('source' in value)) {
    throw new TypeError(`load hook result for ${value.format} must include a source property.`);
  }
  if ('source' in value && !isCustomizationSource(value.source)) {
    throw new TypeError('load hook source must be a string, Uint8Array, or ArrayBuffer.');
  }
  return value as CustomizationLoadResult;
}

function customizationIdentity(url: string): string {
  if (url.startsWith('node:') || isDataSpecifier(url)) return url;
  if (!url.startsWith('file:')) throw new Error(`Unsupported module customization hook URL: ${url}`);
  return decodeURIComponent(new URL(url).pathname);
}

function moduleUrlFromIdentity(identity: string): string {
  if (identity.startsWith('node:') || isDataSpecifier(identity)) return identity;
  const encodedPath = encodeURI(identity)
    .replaceAll('#', '%23')
    .replaceAll('?', '%3F')
    .replaceAll('~', '%7E');
  return `file://${encodedPath}`;
}

function customizationModuleFormat(format: string): CustomizedModuleLoad['format'] {
  if (format === 'module' || format === 'commonjs' || format === 'json' || format === 'wasm') return format;
  throw new Error(`Unsupported module customization hook format: ${format}`);
}

function hookFormat(format: Exclude<ModuleFormat, 'builtin'>): string {
  if (format === 'module-typescript') return 'module';
  if (format === 'commonjs-typescript') return 'commonjs';
  return format;
}

function normalizeCustomizationSource(source: CustomizationLoadResult['source']): string | Uint8Array | undefined {
  if (source === undefined) return undefined;
  if (typeof source === 'string') return source;
  if (source instanceof Uint8Array) return source.slice();
  if (source instanceof ArrayBuffer) return new Uint8Array(source.slice(0));
  throw new TypeError('load hook source must be a string, Uint8Array, or ArrayBuffer.');
}

function isCustomizationSource(value: unknown): value is string | Uint8Array | ArrayBuffer | undefined {
  return value === undefined || typeof value === 'string' || value instanceof Uint8Array || value instanceof ArrayBuffer;
}

// The hooks run in this context, not on a hooks thread, but they receive the
// data as Node delivers it: cloned, except that an object named in the
// transfer list (a MessagePort, usually) arrives as itself.
function cloneCustomizationData(data: unknown, transferList: readonly unknown[] = []): unknown {
  const transferred = new Set(transferList);
  const copy = (value: unknown): unknown => {
    if (transferred.has(value)) return value;
    if (Array.isArray(value)) return value.map(copy);
    if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, copy(entry)]));
    }
    return structuredClone(value);
  };
  try {
    return copy(data);
  } catch (error) {
    throw new TypeError(
      `module.register() data must be structured-cloneable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function moduleEntryOptionsFromExecArgv(execArgv: readonly string[]): ModuleEntryOptions {
  const requiredPreloads: string[] = [];
  const importedPreloads: string[] = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const argument = execArgv[index]!;
    const preload = parseModulePreloadArgument(argument);
    if (!preload) continue;
    if (preload.kind === 'conditions') {
      if (preload.value === undefined) index += 1;
      continue;
    }
    const destination = preload.kind === 'require' ? requiredPreloads : importedPreloads;
    if (preload.value === undefined) {
      const value = execArgv[index + 1];
      if (value === undefined || value === '') {
        throw new Error(`process.execArgv option ${argument} requires an argument.`);
      }
      destination.push(value);
      index += 1;
      continue;
    }
    if (preload.value === '') {
      throw new Error(`process.execArgv option ${argument.slice(0, argument.indexOf('='))} requires an argument.`);
    }
    destination.push(preload.value);
  }
  return { require: requiredPreloads, import: importedPreloads };
}

function moduleConditionsFromExecArgv(execArgv: readonly string[]): string[] {
  const conditions: string[] = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const option = parseModulePreloadArgument(execArgv[index]!);
    if (!option) continue;
    const value = option.value ?? execArgv[index + 1];
    if (option.value === undefined) index += 1;
    if (option.kind === 'conditions' && value) conditions.push(value);
  }
  return conditions;
}

function inlineNodeModuleSource(entry: InlineNodeModuleEntry): string {
  return [
    'process.argv.splice(1, 1);',
    `process.execArgv.splice(0, process.execArgv.length, ...${JSON.stringify(entry.execArgv)});`,
    entry.print ? completionValuePrintSource(entry.source) : entry.source
  ].join('\n');
}

/**
 * `Module._nodeModulePaths()` and `require.resolve(..., { paths })` pass user
 * values straight through. Calling `startsWith` before normalising keeps the
 * TypeError a non-string directory has always thrown, rather than normalising
 * its `String()` form. Exported for tests only.
 */
export function resolveDirectory(directory: string, cwd: string): string {
  return normalizePath(directory.startsWith('/') ? directory : `${cwd}/${directory}`);
}

function isModuleNotFound(error: unknown): boolean {
  return (error instanceof ModuleResolutionError && error.kind === 'module-not-found') ||
    (typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND'));
}

/**
 * What `require()` of an ES module returns: its namespace, or the value of an
 * export named `"module.exports"` when it has one (Node 22.12+), which is how a
 * dual package hands CommonJS callers the same value its CommonJS build exports.
 */
function requiredEsmValue(namespace: unknown): unknown {
  if (namespace !== null && typeof namespace === 'object' && Object.hasOwn(namespace, 'module.exports')) {
    return (namespace as Record<string, unknown>)['module.exports'];
  }
  return namespace;
}
