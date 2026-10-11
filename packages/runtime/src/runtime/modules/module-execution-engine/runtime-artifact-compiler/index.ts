import type {
  CommonJsExtensionHandler,
  ModuleExecutionConsole,
  ModuleExecutionProcess,
  ModuleRecord
} from '../module-execution-engine';
import { RuntimeArtifactScope, type RuntimeArtifactCompile } from './artifacts';
import { RuntimeAsyncTasks } from './async-tasks';
import { CommonJsExecutor } from './commonjs';
import {
  createEsmNamespace,
  createLiveExportsNamespace,
  dynamicModuleImport,
  EsmExecutionRuntime,
  finalizeEsmNamespace,
  refreshLiveExportsNamespace
} from './esm';
import { WasmExecutionRuntime } from './wasm';

export { completionValuePrintSource } from './artifacts';

export interface RuntimeArtifactCompilerBindings {
  readonly process: ModuleExecutionProcess;
  readonly console: ModuleExecutionConsole;
  readonly global: typeof globalThis;
  readText(path: string): string;
  readBytes(path: string): Uint8Array;
  requireModule(specifier: string, fromDirectory: string): unknown;
  importModule(specifier: string | URL, fromDirectory: string, ancestors?: ReadonlySet<string>): Promise<unknown>;
  resolveModuleUrl(specifier: string, parentIdentity: string, fromDirectory: string): string;
  /**
   * Loads `record` as the ES module it is when a program's `require.extensions`
   * handler passed it on to the runtime's own `.js` handler; false for any
   * other record.
   */
  requireEsmInPlace?(record: ModuleRecord): boolean;
  /**
   * Loads `record` as an ES module whose source is `source`, the ES syntax a
   * `module._compile` call was given, as require(esm) loads one; false when
   * the context cannot.
   */
  requireEsmFromSource?(record: ModuleRecord, source: string): boolean;
  /** The `_compile` a program put on `record` in place of the runtime's, if it did. */
  programCompile?(record: ModuleRecord): ((source: string, filename: string) => unknown) | undefined;
}

export interface RuntimeArtifactCompilerOptions {
  readonly buffer: unknown;
  readonly moduleSourceFooter?: (filename: string) => string;
  /**
   * Compiles a source. A process worker asks the Runtime Host's compile
   * service, which compiles each distinct source once and keeps the result.
   */
  readonly compile: RuntimeArtifactCompile;
}

export interface RuntimeArtifactCompiler {
  readonly commonJsExtensions: Record<string, CommonJsExtensionHandler>;
  createEsmNamespace(options?: { readonly commonJsInterop?: boolean }): Record<string, unknown>;
  finalizeEsmNamespace(
    namespace: Record<string, unknown>,
    options?: { readonly commonJsInterop?: boolean }
  ): Record<string, unknown>;
  /** A namespace whose named exports read through to the current CommonJS or builtin exports. */
  createLiveExportsNamespace(exports: () => unknown): Record<string, unknown>;
  /** Re-reads the export names of a live namespace and, with `rebind`, re-runs the bindings importing it. */
  refreshLiveExportsNamespace(namespace: Record<string, unknown>, options: { readonly rebind: boolean }): void;
  detectFormat(path: string, typeScript: boolean): 'commonjs' | 'module';
  /** Whether a program replaced the `require.extensions` handler for `filename`. */
  hasProgramCommonJsHandler(filename: string): boolean;
  evaluateCommonJs(record: ModuleRecord): unknown;
  /** Runs `source` as the body of `record`, for `module._compile`. */
  compileCommonJsSource(record: ModuleRecord, source: string): void;
  evaluateScript(source: string, filename: string): unknown;
  evaluateEsm(record: ModuleRecord, ancestors: ReadonlySet<string>): Promise<Record<string, unknown>>;
  evaluateEsmSynchronously(record: ModuleRecord): Record<string, unknown>;
  evaluateWasm(record: ModuleRecord): Promise<Record<string, unknown>>;
  drain(): Promise<void>;
}

export function createRuntimeArtifactCompiler(
  bindings: RuntimeArtifactCompilerBindings,
  options: RuntimeArtifactCompilerOptions
): RuntimeArtifactCompiler {
  const asyncTasks = new RuntimeAsyncTasks();
  const scope = new RuntimeArtifactScope({
    global: bindings.global,
    process: bindings.process,
    buffer: options.buffer,
    console: bindings.console,
    trackAsync: (value) => asyncTasks.track(value),
    compile: options.compile
  });
  const importModule = (specifier: string, fromDirectory: string, ancestors: ReadonlySet<string>) =>
    bindings.importModule(specifier, fromDirectory, ancestors);
  const moduleImport = (module: ModuleRecord, ancestors: ReadonlySet<string> = new Set()) =>
    dynamicModuleImport(
      { importModule, resolveModuleUrl: bindings.resolveModuleUrl, asyncTasks },
      module,
      ancestors
    );
  const commonJs = new CommonJsExecutor({
    readText: bindings.readText,
    requireEsmInPlace: (record) => bindings.requireEsmInPlace?.(record) ?? false,
    requireEsmFromSource: (record, source) => bindings.requireEsmFromSource?.(record, source) ?? false,
    programCompile: (record) => bindings.programCompile?.(record),
    compile: options.compile,
    scope,
    moduleImport
  });
  const esm = new EsmExecutionRuntime({
    readText: bindings.readText,
    importModule,
    requireModule: bindings.requireModule,
    resolveModuleUrl: bindings.resolveModuleUrl,
    moduleSourceFooter: options.moduleSourceFooter,
    asyncTasks,
    compile: options.compile,
    scope,
    moduleImport
  });
  const wasm = new WasmExecutionRuntime({
    readBytes: bindings.readBytes,
    importModule: (specifier, fromDirectory) => bindings.importModule(specifier, fromDirectory)
  });
  return {
    commonJsExtensions: commonJs.extensions,
    createEsmNamespace,
    finalizeEsmNamespace,
    createLiveExportsNamespace,
    refreshLiveExportsNamespace,
    detectFormat: (path, typeScript) => commonJs.detectFormat(path, typeScript),
    hasProgramCommonJsHandler: (filename) => commonJs.hasProgramHandler(filename),
    evaluateCommonJs: (record) => commonJs.execute(record),
    compileCommonJsSource: (record, source) => commonJs.compileSource(record, source),
    evaluateScript: (source, filename) => commonJs.evaluateScript(source, filename),
    evaluateEsm: (record, ancestors) => esm.evaluate(record, ancestors),
    evaluateEsmSynchronously: (record) => esm.requireSynchronous(record),
    evaluateWasm: (record) => wasm.evaluate(record),
    drain: () => asyncTasks.drain()
  };
}
