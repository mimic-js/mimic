import { format, formatWithOptions, inspect, stripVTControlCharacters } from './inspect';
import { isDeepEqual } from './assert';
import { nodeTextDecoder } from './text-decoder';

export type UtilConsole = {
  error(...values: unknown[]): void;
  warn(...values: unknown[]): void;
};

export type UtilRuntime = {
  env?: Readonly<Record<string, string | undefined>>;
  pid?: number;
  /** The process argument vector, read when `parseArgs` is called without `args`. */
  argv?: () => readonly string[] | undefined;
};

type ParseArgsOptionConfig = {
  type: 'string' | 'boolean';
  short?: string;
  multiple?: boolean;
  default?: string | boolean | string[] | boolean[];
};

type ParseArgsConfig = {
  args?: readonly string[];
  options?: Record<string, ParseArgsOptionConfig>;
  strict?: boolean;
  allowPositionals?: boolean;
  allowNegative?: boolean;
  tokens?: boolean;
};

type ParseArgsToken =
  | { kind: 'option'; name: string; rawName: string; index: number; value: string | undefined; inlineValue: boolean | undefined }
  | { kind: 'positional'; index: number; value: string }
  | { kind: 'option-terminator'; index: number };

const promisifyCustomSymbol = Symbol.for('nodejs.util.promisify.custom');

export function createUtilTypesBuiltin() {
  const isArrayBuffer = (value: unknown): value is ArrayBuffer => value instanceof ArrayBuffer;
  const isSharedArrayBuffer = (value: unknown): boolean =>
    typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer;
  const isTypedArray = (value: unknown): value is ArrayBufferView => ArrayBuffer.isView(value) && !(value instanceof DataView);
  const hasTag = (tag: string) => (value: unknown): boolean => Object.prototype.toString.call(value) === `[object ${tag}]`;
  const typedArrayChecks = Object.fromEntries(
    [
      'Int8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
      'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array'
    ].map((name) => [`is${name}`, (value: unknown) => isTypedArray(value) && hasTag(name)(value)])
  );
  const asyncFunctionPrototype: unknown = Object.getPrototypeOf(async () => undefined);
  const isNumberObject = (value: unknown) => value instanceof Number;
  const isStringObject = (value: unknown) => value instanceof String;
  const isBooleanObject = (value: unknown) => value instanceof Boolean;
  const isBigIntObject = (value: unknown) => value instanceof BigInt;
  const isSymbolObject = (value: unknown) => value instanceof Symbol;
  const types = {
    ...typedArrayChecks,
    isAnyArrayBuffer: (value: unknown) => isArrayBuffer(value) || isSharedArrayBuffer(value),
    isArgumentsObject: hasTag('Arguments'),
    isArrayBuffer,
    isArrayBufferView: (value: unknown) => ArrayBuffer.isView(value),
    isAsyncFunction: (value: unknown) => typeof value === 'function' && Object.getPrototypeOf(value) === asyncFunctionPrototype,
    isBigIntObject,
    isBooleanObject,
    isBoxedPrimitive: (value: unknown) =>
      isNumberObject(value) || isStringObject(value) || isBooleanObject(value) || isBigIntObject(value) || isSymbolObject(value),
    isDataView: (value: unknown) => value instanceof DataView,
    isDate: (value: unknown): value is Date => value instanceof Date,
    isGeneratorFunction: (value: unknown) => hasTag('GeneratorFunction')(value) || hasTag('AsyncGeneratorFunction')(value),
    isMap: (value: unknown) => value instanceof Map,
    isNativeError: (value: unknown) => value instanceof Error,
    isNumberObject,
    isPromise: (value: unknown) => value instanceof Promise,
    // JavaScript gives a page no way to tell a Proxy from its target (Node asks
    // V8), and the runtime does not wrap the context's `Proxy` constructor to
    // track them, so no value is ever reported as one.
    isProxy: (_value: unknown) => false,
    isRegExp: (value: unknown) => value instanceof RegExp,
    isSet: (value: unknown) => value instanceof Set,
    isSharedArrayBuffer,
    isStringObject,
    isSymbolObject,
    isTypedArray,
    isUint8Array: (value: unknown): value is Uint8Array => value instanceof Uint8Array,
    isWeakMap: (value: unknown) => value instanceof WeakMap,
    isWeakSet: (value: unknown) => value instanceof WeakSet
  };
  return Object.assign(types, { default: types });
}

export function createUtilBuiltin(consoleLike: UtilConsole, runtime: UtilRuntime = {}): unknown {
  const warnedDeprecationCodes = new Set<string>();
  const util = {
    callbackify: <TArgs extends unknown[], TResult>(fn: (...args: TArgs) => Promise<TResult>) => {
      if (typeof fn !== 'function') {
        throw Object.assign(new TypeError('The "original" argument must be of type function'), {
          code: 'ERR_INVALID_ARG_TYPE'
        });
      }
      function callbackified(this: unknown, ...args: unknown[]) {
        const callbackCandidate = args.pop();
        if (typeof callbackCandidate !== 'function') throw new TypeError('The last argument must be of type function');
        const callback = callbackCandidate as (error: unknown, value?: TResult) => void;
        const parameters = args as unknown as TArgs;
        Promise.resolve(fn.apply(this, parameters)).then(
          (value) => queueMicrotask(() => callback(null, value)),
          (error) => queueMicrotask(() => callback(error || Object.assign(new Error('Promise was rejected with a falsy value'), { reason: error })))
        );
      }
      // As Node's does, the wrapper carries the original's own properties
      // (`readPkgUp.sync` stays reachable), with the name and length adjusted.
      const descriptors = Object.getOwnPropertyDescriptors(fn) as Record<string, PropertyDescriptor>;
      if (typeof descriptors.length?.value === 'number') descriptors.length.value += 1;
      if (typeof descriptors.name?.value === 'string') descriptors.name.value += 'Callbackified';
      Object.defineProperties(callbackified, descriptors);
      return callbackified;
    },
    promisify,
    isDeepStrictEqual: (actual: unknown, expected: unknown) => isDeepEqual(actual, expected, true),
    parseArgs: (config: ParseArgsConfig = {}) => parseArgs(config, runtime.argv?.()?.slice(2) ?? []),
    TextDecoder: nodeTextDecoder(globalThis.TextDecoder),
    TextEncoder: globalThis.TextEncoder,
    parseEnv: (content: string) => parseNodeEnvFile(content),
    inspect,
    format,
    formatWithOptions,
    styleText: (format: string | readonly string[], text: string, options?: { validateStream?: boolean }) => {
      if (options?.validateStream !== false) return text;
      return (Array.isArray(format) ? format : [format]).reduce((styled, style) => applyTextStyle(style, styled), text);
    },
    // Deprecated (DEP0060) but present in Node 22: webpack 3's loaders still call it.
    _extend: (target: Record<string, unknown>, source: unknown) => {
      if (source === null || typeof source !== 'object') return target;
      for (const key of Object.keys(source)) target[key] = (source as Record<string, unknown>)[key];
      return target;
    },
    inherits: (ctor: Function & { super_?: Function }, superCtor: Function & { prototype: object }) => {
      if (typeof ctor !== 'function') throw new TypeError('The "ctor" argument must be of type Function');
      if (typeof superCtor !== 'function') throw new TypeError('The "superCtor" argument must be of type Function');
      ctor.super_ = superCtor;
      ctor.prototype = Object.create(superCtor.prototype, {
        constructor: {
          value: ctor,
          enumerable: false,
          writable: true,
          configurable: true
        }
      });
    },
    deprecate: <T extends (...args: never[]) => unknown>(fn: T, message: string, code?: string): T => {
      if (typeof fn !== 'function') throw invalidArgumentType('fn', 'function');
      let warned = false;
      const deprecated = function (this: unknown, ...args: unknown[]): unknown {
        if (!warned) {
          warned = true;
          // Node warns once per deprecation code, however many functions share it.
          if (code === undefined || !warnedDeprecationCodes.has(code)) {
            if (code !== undefined) warnedDeprecationCodes.add(code);
            consoleLike.warn(`${code === undefined ? '' : `[${code}] `}DeprecationWarning: ${message}`);
          }
        }
        if (new.target) return Reflect.construct(fn, args, new.target);
        return Reflect.apply(fn, this, args);
      };
      // The wrapper stands in for the original: same statics, same prototype for `new` and `instanceof`.
      Object.setPrototypeOf(deprecated, fn);
      if (fn.prototype) deprecated.prototype = fn.prototype;
      return deprecated as unknown as T;
    },
    debuglog: (section: string, callback?: (logger: (...values: unknown[]) => void) => void) => {
      const normalizedSection = String(section).toUpperCase();
      const enabled = debugSectionEnabled(normalizedSection, runtime.env?.NODE_DEBUG);
      let implementation: ((...values: unknown[]) => void) | undefined;
      const logger = (...values: unknown[]) => {
        if (!enabled) return;
        if (!implementation) {
          implementation = (message: unknown, ...details: unknown[]) => {
            consoleLike.error(`${normalizedSection} ${runtime.pid ?? 0}: ${format(message, ...details)}`);
          };
          callback?.(implementation);
        }
        implementation(...values);
      };
      return Object.assign(logger, { enabled });
    },
    types: createUtilTypesBuiltin(),
    stripVTControlCharacters
  };

  return {
    ...util,
    default: util
  };
}

/**
 * Wraps a callback-last function so it returns a promise. The wrapper passes
 * its own `this` through, and a function that carries `util.promisify.custom`
 * supplies its own promise-returning form.
 */
const promisify = Object.assign(
  (original: Function): Function => {
    if (typeof original !== 'function') throw invalidArgumentType('original', 'function');
    const custom: unknown = (original as { [promisifyCustomSymbol]?: unknown })[promisifyCustomSymbol];
    if (custom !== undefined && custom !== null) {
      if (typeof custom !== 'function') throw invalidArgumentType('util.promisify.custom', 'function');
      return Object.defineProperty(custom, promisifyCustomSymbol, { value: custom, configurable: true });
    }
    const promisified = function (this: unknown, ...args: unknown[]): Promise<unknown> {
      return new Promise((resolve, reject) => {
        Reflect.apply(original, this, [...args, (error: unknown, value: unknown) => {
          if (error) reject(error);
          else resolve(value);
        }]);
      });
    };
    Object.setPrototypeOf(promisified, Object.getPrototypeOf(original));
    Object.defineProperty(promisified, promisifyCustomSymbol, { value: promisified, configurable: true });
    return Object.defineProperties(promisified, Object.getOwnPropertyDescriptors(original));
  },
  { custom: promisifyCustomSymbol }
);

function invalidArgumentType(name: string, type: string): TypeError & { code: string } {
  return Object.assign(new TypeError(`The "${name}" argument must be of type ${type}.`), { code: 'ERR_INVALID_ARG_TYPE' });
}

function parseArgsError(code: string, message: string): TypeError & { code: string } {
  return Object.assign(new TypeError(message), { code });
}

/** `util.parseArgs`: tokenizes an argument vector, then checks and stores each option. */
function parseArgs(config: ParseArgsConfig, defaultArgs: readonly string[]): {
  values: Record<string, string | boolean | Array<string | boolean> | undefined>;
  positionals: string[];
  tokens?: ParseArgsToken[];
} {
  const args = config.args ?? defaultArgs;
  const strict = config.strict ?? true;
  const allowPositionals = config.allowPositionals ?? !strict;
  const allowNegative = config.allowNegative ?? false;
  const options = config.options ?? {};
  for (const [name, option] of Object.entries(options)) {
    if (option === null || typeof option !== 'object') throw invalidArgumentType(`options.${name}`, 'object');
    if (option.type !== 'string' && option.type !== 'boolean') {
      throw parseArgsError('ERR_INVALID_ARG_TYPE', `The "options.${name}.type" property must be one of: 'string', 'boolean'.`);
    }
    if (option.short !== undefined && (typeof option.short !== 'string' || option.short.length !== 1)) {
      throw parseArgsError('ERR_INVALID_ARG_VALUE', `The property 'options.${name}.short' must be a single character.`);
    }
  }

  const tokens = parseArgsTokens(args, options);
  const values: Record<string, string | boolean | Array<string | boolean> | undefined> = Object.create(null);
  const positionals: string[] = [];
  for (const token of tokens) {
    if (token.kind === 'positional') {
      if (!allowPositionals) {
        throw parseArgsError(
          'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL',
          `Unexpected argument '${token.value}'. This command does not take positional arguments`
        );
      }
      positionals.push(token.value);
      continue;
    }
    if (token.kind !== 'option') continue;
    let { name } = token;
    let value: string | boolean = token.value ?? true;
    if (allowNegative && token.value === undefined && name.startsWith('no-') && options[name.slice(3)]?.type === 'boolean') {
      name = name.slice(3);
      value = false;
    }
    if (strict) {
      const option = Object.hasOwn(options, name) ? options[name] : undefined;
      if (!option) {
        throw parseArgsError(
          'ERR_PARSE_ARGS_UNKNOWN_OPTION',
          `Unknown option '${token.rawName}'${allowPositionals ? `. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- ${JSON.stringify(token.rawName)}` : ''}`
        );
      }
      const label = `${option.short ? `-${option.short}, ` : ''}--${name}`;
      if (option.type === 'string' && typeof token.value !== 'string') {
        throw parseArgsError('ERR_PARSE_ARGS_INVALID_OPTION_VALUE', `Option '${label} <value>' argument missing`);
      }
      if (option.type === 'boolean' && token.value !== undefined) {
        throw parseArgsError('ERR_PARSE_ARGS_INVALID_OPTION_VALUE', `Option '${label}' does not take an argument`);
      }
      if (token.inlineValue === false && token.value !== undefined && token.value.length > 1 && token.value.startsWith('-')) {
        throw parseArgsError(
          'ERR_PARSE_ARGS_INVALID_OPTION_VALUE',
          `Option '${label}' argument is ambiguous.\nDid you forget to specify the option argument for '${label}'?\n`
            + `To specify an option argument starting with a dash use '--${name}=-XYZ'${option.short ? ` or '-${option.short}-XYZ'` : ''}.`
        );
      }
    }
    if (name === '__proto__') continue;
    if (options[name]?.multiple) {
      const existing = values[name];
      values[name] = Array.isArray(existing) ? [...existing, value] : [value];
    } else {
      values[name] = value;
    }
  }
  for (const [name, option] of Object.entries(options)) {
    if (option.default !== undefined && !(name in values)) values[name] = option.default;
  }
  return config.tokens ? { values, positionals, tokens } : { values, positionals };
}

function parseArgsTokens(args: readonly string[], options: Record<string, ParseArgsOptionConfig>): ParseArgsToken[] {
  const longNameFor = (short: string): string =>
    Object.keys(options).find((name) => options[name].short === short) ?? short;
  const takesValue = (name: string): boolean => Object.hasOwn(options, name) && options[name].type === 'string';
  const tokens: ParseArgsToken[] = [];
  const remaining = [...args];
  let index = -1;
  // Arguments expanded from one short group (`-abc`) all report the group's index.
  let groupCount = 0;
  while (remaining.length > 0) {
    const arg = String(remaining.shift());
    const next = remaining[0];
    if (groupCount > 0) groupCount -= 1;
    else index += 1;
    if (arg === '--') {
      tokens.push({ kind: 'option-terminator', index });
      for (const positional of remaining) tokens.push({ kind: 'positional', index: index += 1, value: positional });
      break;
    }
    const isLong = arg.length > 2 && arg.startsWith('--');
    const isShort = arg.length >= 2 && arg.startsWith('-') && arg[1] !== '-';
    if (isShort && arg.length === 2) {
      const name = longNameFor(arg[1]);
      const optionIndex = index;
      let value: string | undefined;
      if (takesValue(name) && next !== undefined && next !== null) {
        value = String(remaining.shift());
        index += 1;
      }
      tokens.push({ kind: 'option', name, rawName: arg, index: optionIndex, value, inlineValue: value === undefined ? undefined : false });
    } else if (isShort && !takesValue(longNameFor(arg[1]))) {
      const expanded: string[] = [];
      for (let position = 1; position < arg.length; position += 1) {
        if (!takesValue(longNameFor(arg[position])) || position === arg.length - 1) {
          expanded.push(`-${arg[position]}`);
        } else {
          // A value-taking option ends the group; the rest is its inline value.
          expanded.push(`-${arg.slice(position)}`);
          break;
        }
      }
      remaining.unshift(...expanded);
      groupCount = expanded.length;
    } else if (isShort) {
      tokens.push({ kind: 'option', name: longNameFor(arg[1]), rawName: `-${arg[1]}`, index, value: arg.slice(2), inlineValue: true });
    } else if (isLong && !arg.includes('=', 3)) {
      const name = arg.slice(2);
      const optionIndex = index;
      let value: string | undefined;
      if (takesValue(name) && next !== undefined && next !== null) {
        value = String(remaining.shift());
        index += 1;
      }
      tokens.push({ kind: 'option', name, rawName: arg, index: optionIndex, value, inlineValue: value === undefined ? undefined : false });
    } else if (isLong) {
      const separator = arg.indexOf('=');
      const name = arg.slice(2, separator);
      tokens.push({ kind: 'option', name, rawName: `--${name}`, index, value: arg.slice(separator + 1), inlineValue: true });
    } else {
      tokens.push({ kind: 'positional', index, value: arg });
    }
  }
  return tokens;
}

export function parseNodeEnvFile(content: string): Record<string, string> {
  if (typeof content !== 'string') throw new TypeError('The "content" argument must be of type string');
  const result: Record<string, string> = {};
  const assignments = /^[ \t]*(?:export[ \t]+)?([\w.-]+)[ \t]*=[ \t]*(?:(['"`])([\s\S]*?)\2|([^#\r\n]*))[ \t]*(?:#.*)?$/gm;
  for (const match of content.matchAll(assignments)) {
    let value = match[2] === undefined ? match[4].trim() : match[3];
    if (match[2] === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
    result[match[1]] = value;
  }
  return result;
}

function debugSectionEnabled(section: string, nodeDebug: string | undefined): boolean {
  if (!nodeDebug) return false;
  return nodeDebug
    .split(/[\s,]+/u)
    .filter(Boolean)
    .some((pattern) => new RegExp(`^${escapeRegExp(pattern).replace(/\\\*/g, '.*')}$`, 'iu').test(section));
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function applyTextStyle(style: string, text: string): string {
  const code = (inspect.colors as unknown as Record<string, readonly [number, number] | undefined>)[style]?.[0];
  if (code === undefined) throw new TypeError(`Invalid style: ${style}`);
  return `\u001B[${code}m${text}\u001B[0m`;
}
