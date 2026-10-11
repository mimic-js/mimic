import { asyncContext } from '../async-context';

/**
 * What a source is compiled as. A `detect` kind is a `.js` or `.ts` file that
 * neither its extension nor its package scope settles, which the compiler
 * reads as Node's syntax detection does.
 */
export type RuntimeArtifactKind =
  | 'commonjs'
  | 'commonjs-typescript'
  | 'module'
  | 'module-typescript'
  | 'detect'
  | 'detect-typescript'
  | 'eval';

/**
 * A compiled module: the text of one function expression, as
 * {@link runtimeArtifactFunctionText} writes it. It is plain text, so it can be
 * cached, shared between contexts and persisted.
 */
export interface CompiledRuntimeArtifact {
  readonly format: 'commonjs' | 'module';
  readonly code: string;
}

/**
 * Compiles one source synchronously. It throws the compiler's `SyntaxError`,
 * whose `loc` names the offending line and column, for a source that does not
 * compile.
 */
export type RuntimeArtifactCompile = (
  kind: RuntimeArtifactKind,
  source: string
) => CompiledRuntimeArtifact;

export const JSON_IMPORT_PREFIX = '\u0000mimic-json:';

/** Node's CommonJS module wrapper parameters. */
const COMMONJS_MODULE_SCOPE = ['exports', 'require', 'module', '__filename', '__dirname'] as const;

/**
 * Names the browser worker's global has and Node's does not. A program that
 * finds them takes itself for a Web Worker or a page (Prism listens for
 * messages on `self`; Angular schedules through `requestAnimationFrame`), so
 * compiled modules see them as undefined, as under Node, unless the program
 * put one on its own global (`global.self = global`, fake-indexeddb/auto,
 * happy-dom's global registrator), which modules evaluated after then see.
 */
const WORKER_ONLY_GLOBALS = [
  'self',
  'WorkerGlobalScope',
  'DedicatedWorkerGlobalScope',
  'addEventListener',
  'removeEventListener',
  'dispatchEvent',
  'onmessage',
  'onmessageerror',
  'importScripts',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'location',
  'origin',
  'isSecureContext',
  'crossOriginIsolated',
  'caches',
  'indexedDB',
  'Worker'
] as const;

/**
 * The scope every compiled module shares, ES module or CommonJS. A module's
 * own declarations may shadow any of these names.
 */
const RUNTIME_SCOPE = [
  'process',
  'Buffer',
  'console',
  'global',
  'globalThis',
  'SharedArrayBuffer',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'setImmediate',
  'clearImmediate',
  'queueMicrotask',
  'postMessage',
  'MessageChannel',
  // Node's (`Node.js/22`), not the worker's: a program that checks the user
  // agent for a browser takes its Node path.
  'navigator',
  'document',
  ...WORKER_ONLY_GLOBALS,
  '__import__',
  '__trackAsync',
  '__awaitInContext',
  '__forAwaitInContext',
  '__evalSource'
] as const;

/**
 * The one wrapper of every compiled module. The function binds the runtime
 * scope, the module's own `Function` included; an ES module's
 * `System.register` call is its body, and a CommonJS body is a nested function
 * of Node's module wrapper parameters, whose `this` is `module.exports`.
 * Everything before the body shares its first line.
 */
export function runtimeArtifactFunctionText(format: CompiledRuntimeArtifact['format'], body: string): string {
  return format === 'module'
    ? `(function (${['System', 'Function', ...RUNTIME_SCOPE].join(', ')}) {${body}\n})`
    : `(function (${['Function', ...RUNTIME_SCOPE].join(', ')}) {return function (${COMMONJS_MODULE_SCOPE.join(', ')}) {${body}\n};})`;
}

/** Evaluates compiled text into its function; `identity` names it in stack traces. */
export function instantiateRuntimeArtifact(
  compiled: CompiledRuntimeArtifact,
  identity: string
): (...bindings: unknown[]) => unknown {
  // Indirect eval runs in the global scope, as `new Function` would, but adds
  // no lines before the module's first one.
  return globalEval(`${compiled.code}\n//# sourceURL=${identity}`) as (...bindings: unknown[]) => unknown;
}

const globalEval = globalThis.eval;
const NativeFunction = globalThis.Function;

export interface RuntimeArtifactModuleScope {
  /** `import()` from this module. */
  import(specifier: unknown, options?: unknown): Promise<unknown>;
}

export type CommonJsModuleScope = Readonly<{
  exports: unknown;
  require: unknown;
  module: unknown;
  filename: string;
  dirname: string;
}>;

/**
 * Evaluates compiled modules with the values of their scope, built in one
 * place for both formats. Globals are read from the context each time a module
 * is evaluated, so a replaced timer is observed by modules evaluated after the
 * replacement.
 */
export class RuntimeArtifactScope {
  private readonly boundGlobals = new WeakMap<Function, Function>();
  private readonly postMessage: (...args: unknown[]) => unknown;
  /**
   * The values the runtime itself put under the hidden worker names before
   * any module ran, such as the worker-thread `self` and `onmessage` of a
   * process's global. Modules do not see them; a value the program puts there
   * since, they do.
   */
  private readonly runtimeWorkerGlobals: readonly unknown[];
  /**
   * The source a direct `eval` runs. One that may call `import()` or `await`
   * is instrumented as a module's source is, so the call reaches the Module
   * Execution Engine (webpack's loader-runner loads an ES module loader with
   * `eval("import(url)")`) and an `await` resumes in its Async Context
   * (webpack's eval devtool runs every module of a development bundle so,
   * Next.js's server code among them); the eval stays direct, in the
   * caller's scope.
   */
  private readonly evalSource: (value: unknown) => unknown;

  constructor(
    private readonly options: Readonly<{
      global: typeof globalThis;
      process: unknown;
      buffer: unknown;
      console: unknown;
      trackAsync(value: unknown): unknown;
      compile: RuntimeArtifactCompile;
    }>
  ) {
    const runtimeGlobal = options.global;
    this.runtimeWorkerGlobals = WORKER_ONLY_GLOBALS.map((name) =>
      Object.hasOwn(runtimeGlobal, name) ? Reflect.get(runtimeGlobal, name) : undefined
    );
    this.evalSource = (value) =>
      typeof value === 'string' && /\bimport\s*\(|\bawait\b/.test(value) ? options.compile('eval', value).code : value;
    // Compiled source a program turns back into code the runtime does not
    // build (the AsyncFunction constructor, an indirect eval: a fake worker
    // that rebuilds its function from source does) reaches these helpers on
    // the process's global. They need
    // no module; `__import__` does, and stays in each module's scope.
    for (const [name, value] of [
      ['__trackAsync', (candidate: unknown) => options.trackAsync(candidate)],
      ['__awaitInContext', asyncContext.awaitValue],
      ['__forAwaitInContext', asyncContext.forAwait],
      ['__evalSource', this.evalSource]
    ] as const) {
      if (Object.prototype.hasOwnProperty.call(runtimeGlobal, name)) continue;
      Reflect.defineProperty(runtimeGlobal, name, { configurable: true, enumerable: false, writable: true, value });
    }
    this.postMessage = (...args) => {
      if (!Object.prototype.hasOwnProperty.call(runtimeGlobal, 'postMessage')) {
        throw new ReferenceError('postMessage is not defined');
      }
      const postMessage = Reflect.get(runtimeGlobal, 'postMessage', runtimeGlobal);
      if (typeof postMessage !== 'function') throw new TypeError('postMessage is not a function');
      return Reflect.apply(postMessage, runtimeGlobal, args);
    };
  }

  /** Runs a compiled CommonJS module. */
  runCommonJs(
    instantiate: (...bindings: unknown[]) => unknown,
    module: CommonJsModuleScope,
    scope: RuntimeArtifactModuleScope
  ): void {
    const wrapper = instantiate(this.functionConstructor(scope), ...this.sharedBindings(scope)) as (
      ...bindings: unknown[]
    ) => unknown;
    Reflect.apply(wrapper, module.exports, [module.exports, module.require, module.module, module.filename, module.dirname]);
  }

  /**
   * The `Function` a module sees. `new Function('specifier', 'return
   * import(specifier)')` is how packages reach ESM past a compiler that would
   * rewrite `import()`, and how some dev servers load their config, so a body that may
   * call `import()` is compiled as a module's source is: the call reaches the
   * Module Execution Engine instead of the host's native loader, and the same
   * characters inside a string or comment stay as written.
   *
   * The function built is a native one, written as the native constructor
   * writes it, inside a scope that binds `process` and the runtime helpers:
   * its `arguments`, `length`, source text and construction are the native
   * function's. The constructor stays this module's own, since `import()`
   * resolves from the module, so it is not the global `Function`; it is named
   * and sized as that one is.
   */
  private functionConstructor(scope: RuntimeArtifactModuleScope): RuntimeFunctionConstructor {
    const { compile, process, trackAsync } = this.options;
    const evalSource = this.evalSource;
    const bindings = (): unknown[] => this.sharedBindings(scope);
    const build = (parameters: readonly string[]): Function => {
      const body = parameters.at(-1) ?? '';
      const source = `return function anonymous(${parameters.slice(0, -1).join(',')}\n) {\n${body}\n}`;
      if (!/\bimport\s*\(/.test(body)) {
        // The source of a compiled function, turned back into a function (as
        // worker fallbacks do with `fn.toString()`), calls the runtime's helpers.
        const factory = new NativeFunction('process', ...RUNTIME_HELPERS, source) as (...args: unknown[]) => Function;
        return factory(process, ...RUNTIME_HELPERS.map((name) => runtimeHelper(name, scope, trackAsync, evalSource)));
      }
      const wrapper = instantiateRuntimeArtifact(compile('commonjs', source), 'anonymous')(
        runtimeFunction,
        ...bindings()
      ) as () => Function;
      return wrapper();
    };
    const runtimeFunction = {
      // The property names the function `Function`; the one declared parameter
      // makes its length 1, as the native constructor's.
      Function: function (_body?: unknown): Function {
        const built = build(Array.from(arguments, String));
        // A class that extends Function constructs its instances through here
        // (rspack-chain's callable maps do): the function built is the instance.
        if (new.target && new.target !== runtimeFunction) Object.setPrototypeOf(built, new.target.prototype);
        return built;
      }
    }.Function;
    runtimeFunction.prototype = NativeFunction.prototype;
    return runtimeFunction as unknown as RuntimeFunctionConstructor;
  }

  /** Runs a compiled ES module, which registers itself with `system`. */
  runModule(
    instantiate: (...bindings: unknown[]) => unknown,
    system: unknown,
    scope: RuntimeArtifactModuleScope
  ): void {
    instantiate(system, this.functionConstructor(scope), ...this.sharedBindings(scope));
  }

  private sharedBindings(scope: RuntimeArtifactModuleScope): unknown[] {
    const runtimeGlobal = this.options.global;
    const workerOnlyGlobals: unknown[] = [];
    for (let index = 0; index < WORKER_ONLY_GLOBALS.length; index += 1) {
      const name = WORKER_ONLY_GLOBALS[index]!;
      const value = Object.hasOwn(runtimeGlobal, name) ? Reflect.get(runtimeGlobal, name) : undefined;
      workerOnlyGlobals.push(value === this.runtimeWorkerGlobals[index] ? undefined : value);
    }
    return [
      this.options.process,
      this.options.buffer,
      this.options.console,
      runtimeGlobal,
      runtimeGlobal,
      runtimeGlobal.SharedArrayBuffer,
      this.bound(runtimeGlobal.setTimeout),
      this.bound(runtimeGlobal.clearTimeout),
      this.bound(runtimeGlobal.setInterval),
      this.bound(runtimeGlobal.clearInterval),
      this.bound(contextImmediate(runtimeGlobal, 'setImmediate')),
      this.bound(contextImmediate(runtimeGlobal, 'clearImmediate')),
      this.bound(runtimeGlobal.queueMicrotask),
      this.postMessage,
      runtimeGlobal.MessageChannel,
      runtimeGlobal.navigator,
      undefined,
      ...workerOnlyGlobals,
      scope.import,
      this.options.trackAsync,
      asyncContext.awaitValue,
      asyncContext.forAwait,
      this.evalSource
    ];
  }

  /**
   * Binds a context global once per function identity, so a replaced timer is
   * rebound. The bound function keeps the original's own properties, such as
   * the `util.promisify.custom` of `setTimeout`.
   */
  private bound<Bound extends Function>(value: Bound): Bound {
    let bound = this.boundGlobals.get(value);
    if (!bound) {
      bound = value.bind(this.options.global) as Function;
      for (const key of Reflect.ownKeys(value)) {
        if (Object.hasOwn(bound, key)) continue;
        Object.defineProperty(bound, key, Object.getOwnPropertyDescriptor(value, key)!);
      }
      this.boundGlobals.set(value, bound);
    }
    return bound as Bound;
  }
}

const timeoutImmediates = new WeakMap<Function, Function>();

/**
 * The context's `setImmediate` or `clearImmediate`. A context without a Node
 * event loop has neither, and there an immediate is a zero-delay timeout.
 */
function contextImmediate(
  runtimeGlobal: typeof globalThis,
  name: 'setImmediate' | 'clearImmediate'
): Function {
  const immediate: unknown = Reflect.get(runtimeGlobal, name);
  if (typeof immediate === 'function') return immediate;
  if (name === 'clearImmediate') return runtimeGlobal.clearTimeout;
  const setTimeout = runtimeGlobal.setTimeout;
  let setImmediate = timeoutImmediates.get(setTimeout);
  if (!setImmediate) {
    setImmediate = function (this: unknown, callback: (...args: unknown[]) => void, ...args: unknown[]) {
      return setTimeout.call(this, callback, 0, ...args);
    };
    timeoutImmediates.set(setTimeout, setImmediate);
  }
  return setImmediate;
}

/** The scope names compiled code calls besides a module's own bindings. */
const RUNTIME_HELPERS = ['__import__', '__trackAsync', '__awaitInContext', '__forAwaitInContext', '__evalSource'] as const;

function runtimeHelper(
  name: (typeof RUNTIME_HELPERS)[number],
  scope: RuntimeArtifactModuleScope,
  trackAsync: (value: unknown) => unknown,
  evalSource: (value: unknown) => unknown
): unknown {
  switch (name) {
    case '__evalSource':
      return evalSource;
    case '__import__':
      return scope.import;
    case '__trackAsync':
      return trackAsync;
    case '__awaitInContext':
      return asyncContext.awaitValue;
    case '__forAwaitInContext':
      return asyncContext.forAwait;
  }
}

type RuntimeFunctionConstructor = {
  new (...parameters: string[]): Function;
  (...parameters: string[]): Function;
};

/**
 * CommonJS source that prints the completion value of `source`, as `node -p`
 * does. The direct eval runs inside the module wrapper, so the source still
 * sees `require` and `module`.
 */
export function completionValuePrintSource(source: string): string {
  return `console.log(eval(${JSON.stringify(source)}));`;
}
