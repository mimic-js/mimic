import { SCOPED_EVALUATION_PREFIX, type ScriptEvaluator } from '../module-execution-engine';

export type VmContext = Record<PropertyKey, unknown>;

type VmFilenameOptions = {
  readonly filename?: string;
};

type CompileFunctionOptions = VmFilenameOptions & {
  readonly parsingContext?: object;
  readonly contextExtensions?: readonly object[];
};

/** The globals of a fresh V8 context: what a contextified object shows besides its own properties. */
const CONTEXT_INTRINSICS = new Set([
  'AggregateError', 'Array', 'ArrayBuffer', 'Atomics', 'BigInt', 'BigInt64Array', 'BigUint64Array',
  'Boolean', 'DataView', 'Date', 'Error', 'EvalError', 'FinalizationRegistry', 'Float16Array',
  'Float32Array', 'Float64Array', 'Function', 'Infinity', 'Int16Array', 'Int32Array', 'Int8Array',
  'Intl', 'Iterator', 'JSON', 'Map', 'Math', 'NaN', 'Number', 'Object', 'Promise', 'Proxy',
  'RangeError', 'ReferenceError', 'Reflect', 'RegExp', 'Set', 'SharedArrayBuffer', 'String', 'Symbol',
  'SyntaxError', 'TypeError', 'URIError', 'Uint16Array', 'Uint32Array', 'Uint8Array',
  'Uint8ClampedArray', 'WeakMap', 'WeakRef', 'WeakSet', 'WebAssembly', 'decodeURI',
  'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'escape', 'eval', 'isFinite', 'isNaN',
  'parseFloat', 'parseInt', 'undefined', 'unescape'
]);


type Context = {
  /** `this` and `globalThis` of code run in the context. */
  readonly global: object;
  /** The `with` scope that resolves a program's free identifiers in the context. */
  scope(declared: ReadonlySet<string>): object;
};

/**
 * `node:vm`. Code runs in this realm, so a context shares the realm's
 * intrinsics (`Object`, `Array`, `Error`, …) instead of receiving fresh ones;
 * everything else is the contextified object's. A program's free identifiers
 * resolve against that object, an assignment to an undeclared name lands on
 * it, and a script's top-level `var` and function declarations become its
 * properties, as in Node. `vm.Module`, timeouts and `measureMemory` are not
 * provided.
 */
export function createVmBuiltin(scriptEvaluator: ScriptEvaluator): Record<string, unknown> {
  const contexts = new WeakMap<object, Context>();
  const evaluateInThisContext = (code: string, options?: VmFilenameOptions) =>
    scriptEvaluator.evaluate(String(code), options?.filename === undefined ? undefined : { filename: options.filename });
  const DONT_CONTEXTIFY = Symbol('vm_dynamic_import_no_callback');
  const USE_MAIN_CONTEXT_DEFAULT_LOADER = Symbol('vm_dynamic_import_main_context_default');

  const scopedEvaluator = (): ScriptEvaluator => {
    if (!scriptEvaluator.evaluateInScopes || !scriptEvaluator.compileFunctionInScopes) {
      throw Object.assign(new Error('vm contexts are not available in this context'), { code: 'ERR_NOT_SUPPORTED' });
    }
    return scriptEvaluator;
  };
  const contextOf = (sandbox: unknown): Context => {
    const context = typeof sandbox === 'object' && sandbox !== null ? contexts.get(sandbox) : undefined;
    if (!context) {
      throw Object.assign(new TypeError('The "contextifiedObject" argument must be an vm.Context'), {
        code: 'ERR_INVALID_ARG_TYPE'
      });
    }
    return context;
  };

  const createContext = <T extends object>(sandbox: T | symbol = {} as T): T => {
    if (sandbox === DONT_CONTEXTIFY) {
      const contextified = createContext({});
      return contextOf(contextified).global as T;
    }
    if (typeof sandbox !== 'object' || sandbox === null) {
      throw Object.assign(new TypeError('The "contextObject" argument must be of type object'), {
        code: 'ERR_INVALID_ARG_TYPE'
      });
    }
    if (contexts.has(sandbox)) return sandbox;
    const global: object = new Proxy(sandbox, {
      get(target, property) {
        if (Reflect.has(target, property)) return Reflect.get(target, property);
        if (property === 'globalThis') return global;
        if (typeof property === 'string' && CONTEXT_INTRINSICS.has(property)) {
          return (globalThis as Record<string, unknown>)[property];
        }
        return undefined;
      },
      has(target, property) {
        return (
          Reflect.has(target, property) ||
          property === 'globalThis' ||
          (typeof property === 'string' && CONTEXT_INTRINSICS.has(property))
        );
      }
    });
    const scope = (declared: ReadonlySet<string>): object =>
      new Proxy(sandbox, {
        has(target, property) {
          if (typeof property !== 'string') return false;
          if (property.startsWith(SCOPED_EVALUATION_PREFIX) || declared.has(property)) return false;
          if (Reflect.has(target, property) || property === 'globalThis') return true;
          // Intrinsics resolve to the realm's; any other name is the
          // context's, so an assignment to an undeclared name lands on it.
          return !CONTEXT_INTRINSICS.has(property);
        },
        get(target, property) {
          if (property === Symbol.unscopables) return undefined;
          if (Reflect.has(target, property)) return Reflect.get(target, property);
          if (property === 'globalThis') return global;
          return undefined;
        }
      });
    contexts.set(sandbox, { global, scope });
    // The context's global is itself a context: code may pass `this` back to vm.
    contexts.set(global, { global, scope });
    return sandbox;
  };

  const runInContext = (code: string, sandbox: object, options?: VmFilenameOptions | string): unknown => {
    const context = contextOf(sandbox);
    const filename = typeof options === 'string' ? options : options?.filename;
    const source = String(code);
    const declared = topLevelDeclarations(source);
    const names = [...declared].filter(isIdentifier);
    const { result, declared: values } = scopedEvaluator().evaluateInScopes!(source, {
      filename: filename ?? 'evalmachine.<anonymous>',
      scopes: [context.scope(declared)],
      thisValue: context.global,
      declared: names
    });
    names.forEach((name, index) => {
      if (values[index] !== undefined) Reflect.set(context.global, name, values[index]);
    });
    return result;
  };
  const runInNewContext = (code: string, sandbox: object = {}, options?: VmFilenameOptions | string) =>
    runInContext(code, createContext(sandbox), options);
  const runInThisContext = (code: string, options?: VmFilenameOptions) => evaluateInThisContext(code, options);

  const compileFunction = (
    code: string,
    params: readonly string[] = [],
    options: CompileFunctionOptions = {}
  ): Function => {
    const parameters = params.map(String);
    for (const parameter of parameters) {
      if (!isIdentifier(parameter)) throw new SyntaxError(`Invalid parameter name: ${parameter}`);
    }
    const extensions = options.contextExtensions ?? [];
    const filename = options.filename ?? '';
    const body = String(code);
    if (options.parsingContext === undefined && extensions.length === 0) {
      return evaluateInThisContext(`(function (${parameters.join(', ')}) {${body}\n})`, { filename }) as Function;
    }
    const scopes = [
      ...(options.parsingContext === undefined ? [] : [contextOf(options.parsingContext).scope(new Set(parameters))]),
      ...extensions
    ];
    return scopedEvaluator().compileFunctionInScopes!(body, parameters, { filename, scopes });
  };

  class Script {
    readonly cachedDataRejected = false;

    constructor(
      private readonly code: string,
      private readonly options?: VmFilenameOptions | string
    ) {
      this.code = String(code);
    }

    private get filename(): VmFilenameOptions | undefined {
      return typeof this.options === 'string' ? { filename: this.options } : this.options;
    }

    runInThisContext(options?: VmFilenameOptions): unknown {
      return runInThisContext(this.code, options ?? this.filename);
    }

    runInContext(context: object, options?: VmFilenameOptions): unknown {
      return runInContext(this.code, context, options ?? this.filename);
    }

    runInNewContext(context: object = {}, options?: VmFilenameOptions): unknown {
      return runInNewContext(this.code, context, options ?? this.filename);
    }

    createCachedData(): Uint8Array {
      return new Uint8Array();
    }
  }

  const vm = {
    Script,
    compileFunction,
    constants: { DONT_CONTEXTIFY, USE_MAIN_CONTEXT_DEFAULT_LOADER },
    createContext,
    createScript: (code: string, options?: VmFilenameOptions) => new Script(code, options),
    isContext: (context: unknown) => typeof context === 'object' && context !== null && contexts.has(context),
    runInContext,
    runInNewContext,
    runInThisContext
  };
  return { ...vm, default: vm };
}

function isIdentifier(name: string): boolean {
  return /^[A-Za-z_$][\w$]*$/u.test(name) && !RESERVED.has(name);
}

const RESERVED = new Set([
  'arguments', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'enum', 'eval', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if',
  'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null', 'package', 'private',
  'protected', 'public', 'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof',
  'var', 'void', 'while', 'with', 'yield'
]);

/**
 * The names a script declares with `var` or `function` outside any block,
 * which Node makes properties of the context. Strings, template literals and
 * comments are skipped; a regular expression literal holding a brace can
 * mislead the count, which only costs such a name its context property.
 */
export function topLevelDeclarations(source: string): Set<string> {
  const names = new Set<string>();
  let depth = 0;
  let index = 0;
  const length = source.length;
  const identifierAt = (start: number): [string, number] | undefined => {
    let cursor = start;
    while (cursor < length && /\s/u.test(source[cursor]!)) cursor += 1;
    if (source[cursor] === '*') {
      cursor += 1;
      while (cursor < length && /\s/u.test(source[cursor]!)) cursor += 1;
    }
    const match = /^[A-Za-z_$][\w$]*/u.exec(source.slice(cursor, cursor + 256));
    return match ? [match[0], cursor + match[0].length] : undefined;
  };
  while (index < length) {
    const character = source[index]!;
    if (character === '/' && source[index + 1] === '/') {
      index = source.indexOf('\n', index);
      if (index < 0) break;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      index = source.indexOf('*/', index + 2);
      if (index < 0) break;
      index += 2;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      index += 1;
      while (index < length && source[index] !== character) {
        if (source[index] === '\\') index += 1;
        index += 1;
      }
      index += 1;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0 && /[A-Za-z_$]/u.test(character) && !/[\w$.]/u.test(source[index - 1] ?? ' ')) {
      const word = /^[A-Za-z_$][\w$]*/u.exec(source.slice(index, index + 16))![0];
      if (word === 'var' || word === 'function') {
        const declared = identifierAt(index + word.length);
        if (declared) {
          names.add(declared[0]);
          index = declared[1];
          continue;
        }
      }
      index += word.length;
      continue;
    }
    index += 1;
  }
  return names;
}
