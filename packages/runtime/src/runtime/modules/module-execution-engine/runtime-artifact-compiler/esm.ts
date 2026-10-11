import type { ModuleRecord } from '../module-execution-engine';
import { runtimeArtifactError } from '../runtime-artifact';
import {
  instantiateRuntimeArtifact,
  JSON_IMPORT_PREFIX,
  type RuntimeArtifactCompile,
  type RuntimeArtifactModuleScope,
  type RuntimeArtifactScope
} from './artifacts';
import type { RuntimeAsyncTasks } from './async-tasks';

type EsmExecutionRuntimeOptions = {
  readText(path: string): string;
  importModule(specifier: string, fromDirectory: string, ancestors: ReadonlySet<string>): Promise<unknown>;
  requireModule(specifier: string, fromDirectory: string): unknown;
  resolveModuleUrl(specifier: string, parentIdentity: string, fromDirectory: string): string;
  moduleSourceFooter?(filename: string): string;
  asyncTasks: RuntimeAsyncTasks;
  compile: RuntimeArtifactCompile;
  scope: RuntimeArtifactScope;
  /** `import()` from `module`, shared with CommonJS. */
  moduleImport(module: ModuleRecord, ancestors: ReadonlySet<string>): RuntimeArtifactModuleScope['import'];
};

type SystemJsDeclaration = Readonly<{
  execute(): unknown;
  setters: readonly ((namespace: Record<string, unknown>) => void)[];
}>;

type SystemJsRegistration = Readonly<{
  declare(
    publish: (name: string | Readonly<Record<string, unknown>>, value?: unknown) => unknown,
    context: SystemJsContext
  ): SystemJsDeclaration;
  dependencies: readonly string[];
}>;

type SystemJsContext = Readonly<{
  id: string;
  import(specifier: string): Promise<unknown>;
  meta: ReturnType<typeof importMeta>;
}>;

const AsyncFunction: Function = (async function () {}).constructor;
const namespaceSubscribers = new WeakMap<
  Record<string, unknown>,
  Map<string, Set<(value: unknown) => void>>
>();
const namespaceTargets = new WeakMap<Record<string, unknown>, Record<string, unknown>>();
const liveNamespaceExports = new WeakMap<Record<string, unknown>, () => unknown>();
const finalizedNamespaces = new WeakSet<Record<string, unknown>>();

export class EsmExecutionRuntime {
  constructor(private readonly options: EsmExecutionRuntimeOptions) {}

  requireSynchronous(module: ModuleRecord): Record<string, unknown> {
    const { registration, namespace } = this.prepare(module, new Set());
    const declaration = this.declare(module, registration, namespace, new Set());
    if (declaration.execute instanceof AsyncFunction) throw createRequireAsyncModuleError(module.filename);
    registration.dependencies.forEach((specifier, index) => {
      const imported = commonJsInteropNamespace(
        this.options.requireModule(this.dependencySpecifier(specifier, module), module.dirname)
      );
      const setter = declaration.setters[index];
      setter?.(imported);
      if (setter) bindModuleNamespace(imported, setter);
    });
    const result = declaration.execute();
    if (result instanceof Promise) throw createRequireAsyncModuleError(module.filename);
    return namespace;
  }

  async evaluate(
    module: ModuleRecord,
    ancestors: ReadonlySet<string>
  ): Promise<Record<string, unknown>> {
    const { registration, namespace } = this.prepare(module, ancestors);
    const declaration = this.declare(module, registration, namespace, ancestors);
    for (const [index, specifier] of registration.dependencies.entries()) {
      const imported = await this.options.asyncTasks.settle(
        this.options.importModule(this.dependencySpecifier(specifier, module), module.dirname, ancestors)
      );
      const namespace = importedNamespace(imported, specifier);
      const setter = declaration.setters[index];
      setter?.(namespace);
      if (setter) bindModuleNamespace(namespace, setter);
    }
    await declaration.execute();
    return namespace;
  }

  private prepare(
    module: ModuleRecord,
    ancestors: ReadonlySet<string>
  ): Readonly<{ registration: SystemJsRegistration; namespace: Record<string, unknown> }> {
    const identity = module.filename;
    const source = this.options.readText(identity);
    const footer = this.options.moduleSourceFooter?.(identity) ?? '';
    const kind = module.format === 'module-typescript' ? 'module-typescript' : 'module';
    let instantiate: (...bindings: unknown[]) => unknown;
    try {
      instantiate = instantiateRuntimeArtifact(
        this.options.compile(kind, footer ? `${source}\n${footer}` : source),
        identity
      );
    } catch (error) {
      throw runtimeArtifactError('ERR_RUNTIME_ARTIFACT_COMPILE', { format: kind, identity }, error);
    }
    let registration: SystemJsRegistration | undefined;
    const system = {
      register(dependencies: readonly string[], declare: SystemJsRegistration['declare']): void {
        if (registration) throw new SyntaxError(`More than one System.register call for ${identity}`);
        registration = { dependencies: [...dependencies], declare };
      }
    };
    this.options.scope.runModule(instantiate, system, {
      import: this.options.moduleImport(module, ancestors)
    });
    if (!registration) throw new SyntaxError(`No System.register call for ${identity}`);
    return { registration, namespace: moduleNamespace(module) };
  }

  private declare(
    module: ModuleRecord,
    registration: SystemJsRegistration,
    namespace: Record<string, unknown>,
    ancestors: ReadonlySet<string>
  ): SystemJsDeclaration {
    const publish = (name: string | Readonly<Record<string, unknown>>, value?: unknown): unknown => {
      if (typeof name === 'string') {
        setModuleExport(namespace, name, value);
        return value;
      }
      for (const [exportedName, exportedValue] of Object.entries(name)) {
        setModuleExport(namespace, exportedName, exportedValue);
      }
      return name;
    };
    return registration.declare(publish, {
      id: moduleUrl(module.filename),
      import: (specifier) => this.options.asyncTasks.settle(
        this.options.importModule(specifier, module.dirname, ancestors)
      ),
      meta: importMeta(module.filename, module.dirname, this.options.resolveModuleUrl)
    });
  }

  private dependencySpecifier(specifier: string, module: ModuleRecord): string {
    if (!specifier.startsWith(JSON_IMPORT_PREFIX)) return specifier;
    const encoded: unknown = JSON.parse(specifier.slice(JSON_IMPORT_PREFIX.length));
    if (
      !Array.isArray(encoded) ||
      typeof encoded[0] !== 'string' ||
      typeof encoded[1] !== 'number' ||
      typeof encoded[2] !== 'number'
    ) {
      throw new SyntaxError(`Invalid JSON import marker in ${module.filename}`);
    }
    const [original, line, column] = encoded;
    const resolved = this.options.resolveModuleUrl(original, module.filename, module.dirname);
    if (!new URL(resolved).pathname.endsWith('.json')) {
      throw Object.assign(
        new TypeError(`Import attribute type "json" requires a JSON module: ${original}`),
        { loc: { line, column } }
      );
    }
    return original;
  }
}

/**
 * `import()` as every compiled module calls it: only `{ with: { type: "json" } }`
 * attributes are accepted, and evaluation stays alive until the import settles.
 */
export function dynamicModuleImport(
  options: Pick<EsmExecutionRuntimeOptions, 'importModule' | 'resolveModuleUrl' | 'asyncTasks'>,
  module: ModuleRecord,
  ancestors: ReadonlySet<string>
): RuntimeArtifactModuleScope['import'] {
  return (specifier, attributes) => {
    const requested = String(specifier);
    if (attributes !== undefined) {
      if (!isJsonDynamicImportOptions(attributes)) {
        throw new TypeError('Only dynamic import attributes with { with: { type: "json" } } are supported');
      }
      const resolved = options.resolveModuleUrl(requested, module.filename, module.dirname);
      if (!new URL(resolved).pathname.endsWith('.json')) {
        throw new TypeError(`Import attribute type "json" requires a JSON module: ${requested}`);
      }
    }
    return options.asyncTasks.settle(options.importModule(requested, module.dirname, ancestors));
  };
}

function importMeta(
  identity: string,
  directory: string,
  resolveModuleUrl: (specifier: string, parentIdentity: string, fromDirectory: string) => string
): Readonly<{
  dirname?: string;
  filename?: string;
  resolve(specifier: string): string;
  url: string;
}> {
  const resolve = (specifier: string) => resolveModuleUrl(String(specifier), identity, directory);
  return identity.startsWith('data:')
    ? { url: identity, resolve }
    : { dirname: directory, filename: identity, url: moduleUrl(identity), resolve };
}

function moduleUrl(identity: string): string {
  if (identity.startsWith('data:')) return identity;
  const encodedPath = encodeURI(identity)
    .replaceAll('#', '%23')
    .replaceAll('?', '%3F')
    .replaceAll('~', '%7E');
  return `file://${encodedPath}`;
}

function moduleNamespace(module: ModuleRecord): Record<string, unknown> {
  if (isRecord(module.exports)) return module.exports;
  throw new Error(`Module registry invariant failed for ESM namespace: ${module.filename}`);
}

export function createEsmNamespace(
  options: { readonly commonJsInterop?: boolean } = {}
): Record<string, unknown> {
  const target = Object.create(null) as Record<string, unknown>;
  let namespace: Record<string, unknown>;
  namespace = new Proxy(target, {
    ownKeys() {
      const keys = Reflect.ownKeys(target);
      const names = keys.filter((key): key is string => typeof key === 'string').sort();
      const symbols = keys.filter((key): key is symbol => typeof key === 'symbol');
      return [...names, ...symbols];
    },
    set(_target, property, value) {
      if (finalizedNamespaces.has(namespace)) return false;
      return Reflect.set(target, property, value);
    }
  });
  namespaceTargets.set(namespace, target);
  namespaceSubscribers.set(namespace, new Map());
  Object.defineProperties(namespace, {
    ...(options.commonJsInterop
      ? {
          __esModule: {
            configurable: true,
            enumerable: true,
            value: true,
            writable: true
          }
        }
      : {}),
    [Symbol.toStringTag]: {
      value: 'Module'
    }
  });
  return namespace;
}

/**
 * Builds the namespace an ES module sees for CommonJS or builtin exports. Every
 * named export reads through to the current exports object, so a replaced
 * `module.exports`, a patched builtin and a lazy getter are all observed at the
 * point of use rather than copied when the namespace is first built.
 */
export function createLiveExportsNamespace(exports: () => unknown): Record<string, unknown> {
  const namespace: Record<string, unknown> = {};
  Object.defineProperty(namespace, 'default', { configurable: true, enumerable: true, get: exports });
  liveNamespaceExports.set(namespace, exports);
  namespaceSubscribers.set(namespace, new Map());
  syncLiveExportNames(namespace, exports);
  return namespace;
}

/**
 * Re-reads which names the exports object carries. With `rebind`, it also
 * re-runs the bindings of every module importing the namespace: named imports
 * are copied into the importer, so that is the point at which they observe
 * exports added or replaced since they were linked.
 */
export function refreshLiveExportsNamespace(
  namespace: Record<string, unknown>,
  options: { readonly rebind: boolean }
): void {
  const exports = liveNamespaceExports.get(namespace);
  if (!exports) return;
  syncLiveExportNames(namespace, exports);
  if (!options.rebind) return;
  for (const update of namespaceSubscribers.get(namespace)?.get('*') ?? []) update(namespace);
}

function syncLiveExportNames(namespace: Record<string, unknown>, exports: () => unknown): void {
  const names = liveExportNames(exports());
  for (const name of Object.keys(namespace)) {
    if (name !== 'default' && !names.has(name)) Reflect.deleteProperty(namespace, name);
  }
  for (const name of names) {
    if (name === 'default' || Object.hasOwn(namespace, name)) continue;
    Object.defineProperty(namespace, name, {
      configurable: true,
      enumerable: true,
      get: () => {
        const current = exports();
        return isRecord(current) || typeof current === 'function'
          ? (current as Record<string, unknown>)[name]
          : undefined;
      }
    });
  }
}

function liveExportNames(exports: unknown): ReadonlySet<string> {
  // A function's own non-enumerable names (length, name, prototype) are not exports.
  if (typeof exports === 'function' || Array.isArray(exports)) return new Set(Object.keys(exports));
  return isRecord(exports) ? new Set(Object.getOwnPropertyNames(exports)) : new Set();
}

function bindModuleNamespace(
  namespace: unknown,
  update: (namespace: Record<string, unknown>) => void
): void {
  if (!isRecord(namespace)) return;
  const subscribers = namespaceSubscribers.get(namespace);
  if (!subscribers) return;
  const listeners = subscribers.get('*') ?? new Set<(value: unknown) => void>();
  listeners.add(() => update(namespace));
  subscribers.set('*', listeners);
}

function publishModuleExport(namespace: Record<string, unknown>, name: string): void {
  const subscribers = namespaceSubscribers.get(namespace);
  for (const update of subscribers?.get(name) ?? []) update(namespace[name]);
  for (const update of subscribers?.get('*') ?? []) update(namespace);
}

function setModuleExport(
  namespace: Record<string, unknown>,
  name: string,
  value: unknown
): void {
  const target = namespaceTargets.get(namespace);
  if (!target || !Reflect.set(target, name, value)) {
    throw new Error(`Module namespace cannot publish export ${JSON.stringify(name)}`);
  }
  publishModuleExport(namespace, name);
}

export function finalizeEsmNamespace(
  namespace: Record<string, unknown>,
  options: { readonly commonJsInterop?: boolean } = {}
): Record<string, unknown> {
  if (options.commonJsInterop && !Object.hasOwn(namespace, 'default')) {
    Reflect.deleteProperty(namespace, '__esModule');
  }
  Object.seal(namespace);
  finalizedNamespaces.add(namespace);
  return namespace;
}

function commonJsInteropNamespace(value: unknown): Record<string, unknown> {
  if (isRecord(value) && value[Symbol.toStringTag] === 'Module') return value;
  if (typeof value === 'function') {
    const namespace: Record<string, unknown> = { default: value };
    Object.assign(namespace, value);
    return namespace;
  }
  if (isRecord(value)) return { ...value, default: value };
  return { default: value };
}

function importedNamespace(value: unknown, specifier: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new TypeError(`Imported module ${JSON.stringify(specifier)} returned no namespace object`);
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null;
}

function isJsonDynamicImportOptions(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !isRecord(value.with)) {
    return false;
  }
  return Object.keys(value.with).length === 1 && value.with.type === 'json';
}

function createRequireAsyncModuleError(
  resolved: string
): Error & { readonly code: 'ERR_REQUIRE_ASYNC_MODULE' } {
  return Object.assign(
    new Error(`require() cannot be used on an ESM graph with top-level await. Use import() instead: ${resolved}`),
    { code: 'ERR_REQUIRE_ASYNC_MODULE' as const }
  );
}
