import {
  createModuleExecutionEngine,
  type ModuleExecutionEngine,
  type ModuleExecutionEngineOptions,
  type ModuleExecutionProcess,
  type NodeModuleAccess,
  type ScriptEvaluator
} from '../module-execution-engine';
import {
  createNodeCompatibility,
  type NodeCompatibility,
  type NodeCompatibilityCapabilities,
  type NodeCompatibilityGlobals,
  type NodeCompatibilityProcessPort
} from './node-compatibility';
import { nodeTextDecoder } from './text-decoder';

/** The one process object both the Module Execution Engine and Node Compatibility run against. */
export type ExecutionContextProcessPort = ModuleExecutionProcess & NodeCompatibilityProcessPort;

/**
 * The Node Compatibility capabilities an Execution Context supplies. Bootstrap
 * adds the process and the module roles, which the engine it creates serves.
 */
export type ExecutionContextNodeCapabilities = Omit<
  NodeCompatibilityCapabilities,
  'nodeModuleAccess' | 'process' | 'scriptEvaluator'
>;

export interface ExecutionContextBootstrapOptions
  extends Omit<ModuleExecutionEngineOptions, 'builtinModuleProvider' | 'global' | 'process'> {
  readonly global: typeof globalThis;
  readonly process: ExecutionContextProcessPort;
  readonly nodeCompatibility: ExecutionContextNodeCapabilities;
}

export interface BootstrappedExecutionContext {
  readonly engine: ModuleExecutionEngine;
  readonly nodeCompatibility: NodeCompatibility;
  teardown(): void;
}

export function bootstrapExecutionContext(
  options: ExecutionContextBootstrapOptions
): BootstrappedExecutionContext {
  let engine: ModuleExecutionEngine | undefined;
  const requiredEngine = (): ModuleExecutionEngine => {
    if (!engine) throw new Error('Module Execution Engine is unavailable before Execution Context bootstrap');
    return engine;
  };
  const nodeModuleAccess: NodeModuleAccess = {
    get cache() {
      return requiredEngine().nodeModuleAccess.cache;
    },
    get extensions() {
      return requiredEngine().nodeModuleAccess.extensions;
    },
    compile: (module, source, filename) => requiredEngine().nodeModuleAccess.compile(module, source, filename),
    createRequireFunction: (filename) => requiredEngine().nodeModuleAccess.createRequireFunction(filename),
    findPath: (request, paths) => requiredEngine().nodeModuleAccess.findPath(request, paths),
    load: (request, parentFilename) => requiredEngine().nodeModuleAccess.load(request, parentFilename),
    modulePaths: (fromDirectory) => requiredEngine().nodeModuleAccess.modulePaths(fromDirectory),
    get globalPaths() {
      return requiredEngine().nodeModuleAccess.globalPaths;
    },
    initPaths: () => requiredEngine().nodeModuleAccess.initPaths(),
    registerCustomizationHooks: (specifier, registrationOptions) =>
      requiredEngine().nodeModuleAccess.registerCustomizationHooks(specifier, registrationOptions),
    resolveFilename: (request, parentFilename) =>
      requiredEngine().nodeModuleAccess.resolveFilename(request, parentFilename),
    syncBuiltinEsmExports: () => requiredEngine().nodeModuleAccess.syncBuiltinEsmExports()
  };
  const scriptEvaluator: ScriptEvaluator = {
    evaluate: (source, evaluatorOptions) => requiredEngine().scriptEvaluator.evaluate(source, evaluatorOptions),
    evaluateInScopes: (source, scopedOptions) => requiredEngine().scriptEvaluator.evaluateInScopes!(source, scopedOptions),
    compileFunctionInScopes: (body, params, scopedOptions) =>
      requiredEngine().scriptEvaluator.compileFunctionInScopes!(body, params, scopedOptions)
  };
  const nodeCompatibility = createNodeCompatibility({
    capabilities: {
      ...options.nodeCompatibility,
      nodeModuleAccess,
      process: options.process,
      scriptEvaluator
    },
    global: options.global,
    globals: {
      process: options.process,
      console: options.console,
      URL: requiredContextGlobal(options.global, 'URL'),
      URLSearchParams: requiredContextGlobal(options.global, 'URLSearchParams'),
      TextEncoder: requiredContextGlobal(options.global, 'TextEncoder'),
      TextDecoder: nodeTextDecoder(requiredContextGlobal(options.global, 'TextDecoder')),
      WebSocket: requiredContextGlobal(options.global, 'WebSocket'),
      MessageChannel: requiredContextGlobal(options.global, 'MessageChannel'),
      setTimeout: requiredContextGlobal(options.global, 'setTimeout'),
      clearTimeout: requiredContextGlobal(options.global, 'clearTimeout'),
      setInterval: requiredContextGlobal(options.global, 'setInterval'),
      clearInterval: requiredContextGlobal(options.global, 'clearInterval'),
      setImmediate: requiredContextGlobal(options.global, 'setImmediate'),
      clearImmediate: requiredContextGlobal(options.global, 'clearImmediate'),
      queueMicrotask: requiredContextGlobal(options.global, 'queueMicrotask')
    }
  });
  nodeCompatibility.installGlobals();
  try {
    engine = createModuleExecutionEngine({
      ...options,
      global: options.global,
      builtinModuleProvider: nodeCompatibility.builtinModuleProvider,
      // Module scopes bind the same Buffer that Node Compatibility installed as
      // the context global and exposes as node:buffer.
      runtimeArtifactCompiler: {
        ...options.runtimeArtifactCompiler,
        buffer: (options.global as { Buffer?: unknown }).Buffer ?? options.runtimeArtifactCompiler.buffer
      },
      moduleResolution: {
        ...options.moduleResolution,
        errorAdapter: nodeCompatibility.moduleResolutionErrorAdapter
      }
    });
    return {
      engine,
      nodeCompatibility,
      teardown: () => {
        engine?.teardown();
        nodeCompatibility.teardown();
      }
    };
  } catch (error) {
    nodeCompatibility.teardown();
    throw error;
  }
}

type ContextProvidedGlobal = Exclude<keyof NodeCompatibilityGlobals, 'process' | 'console' | 'Buffer'>;

function requiredContextGlobal<Name extends ContextProvidedGlobal>(
  runtimeGlobal: typeof globalThis,
  name: Name
): NodeCompatibilityGlobals[Name] {
  const value: unknown = Reflect.get(runtimeGlobal, name);
  if (value === undefined) {
    throw new Error(`Execution Context is missing required Node Compatibility global: ${name}`);
  }
  return value as NodeCompatibilityGlobals[Name];
}
