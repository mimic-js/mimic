import { inspect } from './inspect';

type AssertionMessage = string | Error;
type AssertionErrorOptions = {
  actual?: unknown;
  expected?: unknown;
  operator?: string;
  message?: AssertionMessage;
};
type ErrorMatcher = RegExp | Function | object;
type CycleMemo = Map<object, Set<object>>;

const NO_EXCEPTION = Symbol('no exception');

/**
 * Node's deep equality. Strict mode compares primitives with `Object.is`,
 * prototypes, and enumerable symbol keys; loose mode compares primitives with
 * `==` and ignores prototypes. Both compare `Date`, `RegExp`, `Error`, boxed
 * primitives, typed arrays, `Map` and `Set` by value.
 */
export function isDeepEqual(actual: unknown, expected: unknown, strict: boolean): boolean {
  return valuesEqual(actual, expected, strict, new Map());
}

function valuesEqual(actual: unknown, expected: unknown, strict: boolean, memo: CycleMemo): boolean {
  if (actual === expected) return actual !== 0 || !strict || Object.is(actual, expected);
  if (strict) {
    if (typeof actual !== 'object' || typeof expected !== 'object' || actual === null || expected === null) {
      return actual !== actual && expected !== expected;
    }
    if (Object.getPrototypeOf(actual) !== Object.getPrototypeOf(expected)) return false;
  } else {
    if (actual === null || typeof actual !== 'object') {
      if (expected !== null && typeof expected === 'object') return false;
      return actual == expected || (actual !== actual && expected !== expected);
    }
    if (expected === null || typeof expected !== 'object') return false;
  }
  return objectsEqual(actual, expected, strict, memo);
}

function objectsEqual(actual: object, expected: object, strict: boolean, memo: CycleMemo): boolean {
  if (Object.prototype.toString.call(actual) !== Object.prototype.toString.call(expected)) return false;
  // Typed arrays expose every element as a key; their elements are compared directly.
  let indexedLength = 0;
  if (Array.isArray(actual)) {
    if (!Array.isArray(expected) || actual.length !== expected.length) return false;
  } else if (actual instanceof Date) {
    if (!(expected instanceof Date) || actual.getTime() !== expected.getTime()) return false;
  } else if (actual instanceof RegExp) {
    if (
      !(expected instanceof RegExp)
      || actual.source !== expected.source
      || actual.flags !== expected.flags
      || actual.lastIndex !== expected.lastIndex
    ) return false;
  } else if (actual instanceof Error || expected instanceof Error) {
    if (!(actual instanceof Error) || !(expected instanceof Error)) return false;
    // `message` and `name` are not enumerable, so the key comparison below misses them.
    if (actual.message !== expected.message || actual.name !== expected.name) return false;
    if (Object.hasOwn(actual, 'cause') !== Object.hasOwn(expected, 'cause')) return false;
    if (!valuesEqual(actual.cause, expected.cause, strict, memo)) return false;
  } else if (ArrayBuffer.isView(actual)) {
    if (!ArrayBuffer.isView(expected)) return false;
    if (actual instanceof DataView || expected instanceof DataView) {
      if (!bytesEqual(viewBytes(actual), viewBytes(expected))) return false;
    } else {
      if (!typedArraysEqual(actual as unknown as ArrayLike<unknown>, expected as unknown as ArrayLike<unknown>, strict)) return false;
      indexedLength = (actual as unknown as ArrayLike<unknown>).length;
    }
  } else if (isAnyArrayBuffer(actual)) {
    if (!isAnyArrayBuffer(expected) || !bytesEqual(new Uint8Array(actual), new Uint8Array(expected))) return false;
  } else if (actual instanceof Set) {
    if (!(expected instanceof Set) || actual.size !== expected.size) return false;
  } else if (actual instanceof Map) {
    if (!(expected instanceof Map) || actual.size !== expected.size) return false;
  } else if (isBoxedPrimitive(actual)) {
    if (!isBoxedPrimitive(expected)) return false;
    if (!Object.is(actual.valueOf(), expected.valueOf())) return false;
  } else if (actual instanceof WeakMap || actual instanceof WeakSet) {
    // Weak collections cannot be enumerated, so only the same instance is equal.
    return false;
  }

  const actualKeys = comparableKeys(actual, strict, indexedLength);
  const expectedKeys = comparableKeys(expected, strict, indexedLength);
  if (actualKeys.length !== expectedKeys.length) return false;
  for (const key of actualKeys) {
    if (!Object.prototype.propertyIsEnumerable.call(expected, key)) return false;
  }

  // A pair already being compared further up the stack is a cycle; assume it holds.
  let partners = memo.get(actual);
  if (partners?.has(expected)) return true;
  if (!partners) memo.set(actual, partners = new Set());
  partners.add(expected);
  try {
    for (const key of actualKeys) {
      if (!valuesEqual(
        (actual as Record<PropertyKey, unknown>)[key],
        (expected as Record<PropertyKey, unknown>)[key],
        strict,
        memo
      )) return false;
    }
    if (actual instanceof Set) return setsEqual(actual, expected as Set<unknown>, strict, memo);
    if (actual instanceof Map) return mapsEqual(actual, expected as Map<unknown, unknown>, strict, memo);
    return true;
  } finally {
    partners.delete(expected);
  }
}

function comparableKeys(value: object, strict: boolean, indexedLength: number): PropertyKey[] {
  const keys: PropertyKey[] = indexedLength > 0 ? Object.keys(value).slice(indexedLength) : Object.keys(value);
  if (!strict) return keys;
  for (const symbol of Object.getOwnPropertySymbols(value)) {
    if (Object.prototype.propertyIsEnumerable.call(value, symbol)) keys.push(symbol);
  }
  return keys;
}

function typedArraysEqual(actual: ArrayLike<unknown>, expected: ArrayLike<unknown>, strict: boolean): boolean {
  if (actual.length !== expected.length) return false;
  for (let index = 0; index < actual.length; index += 1) {
    // Strict equality tells -0 from 0 and equates NaN with itself; loose equality does neither.
    if (strict ? !Object.is(actual[index], expected[index]) : actual[index] != expected[index]) return false;
  }
  return true;
}

function viewBytes(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function bytesEqual(actual: Uint8Array, expected: Uint8Array): boolean {
  if (actual.byteLength !== expected.byteLength) return false;
  for (let index = 0; index < actual.byteLength; index += 1) {
    if (actual[index] !== expected[index]) return false;
  }
  return true;
}

function isAnyArrayBuffer(value: object): value is ArrayBufferLike {
  return value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer);
}

function isBoxedPrimitive(value: object): boolean {
  return value instanceof Number
    || value instanceof String
    || value instanceof Boolean
    || value instanceof BigInt
    || value instanceof Symbol;
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}

/**
 * Members that are not found by identity are matched by deep equality, each
 * against a distinct member of the other set.
 */
function setsEqual(actual: Set<unknown>, expected: Set<unknown>, strict: boolean, memo: CycleMemo): boolean {
  let unmatched: Set<unknown> | undefined;
  for (const value of actual) {
    if (isObject(value)) {
      (unmatched ??= new Set()).add(value);
    } else if (!expected.has(value)) {
      if (strict) return false;
      (unmatched ??= new Set()).add(value);
    }
  }
  if (!unmatched) return true;
  for (const value of expected) {
    if (isObject(value)) {
      if (!takeEqualMember(unmatched, value, strict, memo)) return false;
    } else if (!strict && !actual.has(value) && !takeEqualMember(unmatched, value, strict, memo)) {
      return false;
    }
  }
  return unmatched.size === 0;
}

function takeEqualMember(candidates: Set<unknown>, value: unknown, strict: boolean, memo: CycleMemo): boolean {
  for (const candidate of candidates) {
    if (valuesEqual(candidate, value, strict, memo)) {
      candidates.delete(candidate);
      return true;
    }
  }
  return false;
}

function mapsEqual(
  actual: Map<unknown, unknown>,
  expected: Map<unknown, unknown>,
  strict: boolean,
  memo: CycleMemo
): boolean {
  let unmatched: Set<unknown> | undefined;
  for (const [key, value] of actual) {
    if (isObject(key)) {
      (unmatched ??= new Set()).add(key);
    } else if (!expected.has(key) || !valuesEqual(value, expected.get(key), strict, memo)) {
      if (strict) return false;
      (unmatched ??= new Set()).add(key);
    }
  }
  if (!unmatched) return true;
  for (const [key, value] of expected) {
    if (isObject(key)) {
      if (!takeEqualEntry(unmatched, actual, key, value, strict, memo)) return false;
    } else if (
      !strict
      && (!actual.has(key) || !valuesEqual(actual.get(key), value, strict, memo))
      && !takeEqualEntry(unmatched, actual, key, value, strict, memo)
    ) {
      return false;
    }
  }
  return unmatched.size === 0;
}

function takeEqualEntry(
  candidates: Set<unknown>,
  source: Map<unknown, unknown>,
  key: unknown,
  value: unknown,
  strict: boolean,
  memo: CycleMemo
): boolean {
  for (const candidate of candidates) {
    if (valuesEqual(candidate, key, strict, memo) && valuesEqual(source.get(candidate), value, strict, memo)) {
      candidates.delete(candidate);
      return true;
    }
  }
  return false;
}

/** Deep comparisons print whole values, one entry per line, as Node's messages do. */
function inspectDeep(value: unknown): string {
  return inspect(value, { compact: false, customInspect: false, depth: 1000, maxArrayLength: null, sorted: true });
}

/**
 * The message of an assertion that was given none. Node prints a line diff for
 * `deepStrictEqual`; this prints both values instead.
 */
function generatedMessage(actual: unknown, expected: unknown, operator: string): string {
  switch (operator) {
    case 'strictEqual':
      return `Expected values to be strictly equal:\n\n${inspect(actual)} !== ${inspect(expected)}\n`;
    case 'notStrictEqual':
      return `Expected "actual" to be strictly unequal to: ${inspect(expected)}`;
    case 'deepStrictEqual':
      return `Expected values to be strictly deep-equal:\n\n${inspectDeep(actual)}\n\nshould equal\n\n${inspectDeep(expected)}`;
    case 'notDeepStrictEqual':
      return `Expected "actual" not to be strictly deep-equal to:\n\n${inspectDeep(expected)}\n`;
    case 'deepEqual':
      return `Expected values to be loosely deep-equal:\n\n${inspectDeep(actual)}\n\nshould loosely deep-equal\n\n${inspectDeep(expected)}`;
    case 'notDeepEqual':
      return `Expected values not to be loosely deep-equal:\n\n${inspectDeep(actual)}\n\nshould not loosely deep-equal\n\n${inspectDeep(expected)}`;
    default:
      return `${inspect(actual)} ${operator} ${inspect(expected)}`;
  }
}

function invalidArgument(code: string, message: string): TypeError & { code: string } {
  return Object.assign(new TypeError(message), { code });
}

export function createAssertBuiltin(): unknown {
  class AssertionError extends Error {
    actual: unknown;
    expected: unknown;
    operator: string | undefined;
    code = 'ERR_ASSERTION';
    generatedMessage: boolean;

    constructor(options: AssertionErrorOptions) {
      if (options === null || typeof options !== 'object') {
        throw invalidArgument('ERR_INVALID_ARG_TYPE', 'The "options" argument must be of type object.');
      }
      const { message } = options;
      super(
        message === undefined
          ? generatedMessage(options.actual, options.expected, options.operator ?? 'fail')
          : message instanceof Error ? message.message : String(message)
      );
      this.name = 'AssertionError';
      this.generatedMessage = message === undefined;
      this.actual = options.actual;
      this.expected = options.expected;
      this.operator = options.operator;
    }
  }

  /** `generated` marks a message this module wrote on the caller's behalf. */
  const fail = (options: AssertionErrorOptions, generated = false): never => {
    if (options.message instanceof Error) throw options.message;
    const error = new AssertionError(options);
    if (generated) error.generatedMessage = true;
    throw error;
  };

  const errorMatches = (actual: unknown, expected: ErrorMatcher): boolean => {
    if (typeof expected !== 'function') {
      if (expected instanceof RegExp) return expected.exec(String(actual)) !== null;
      throw invalidArgument('ERR_INVALID_ARG_TYPE', 'The "expected" argument must be of type function or an instance of RegExp.');
    }
    if (expected.prototype !== undefined && actual instanceof expected) return true;
    if (Object.prototype.isPrototypeOf.call(Error, expected)) return false;
    return Reflect.apply(expected, {}, [actual]) === true;
  };

  /** Checks a thrown value against the class, RegExp, validation function or object given to `throws`. */
  const assertErrorMatches = (
    actual: unknown,
    expected: ErrorMatcher,
    message: AssertionMessage | undefined,
    operator: string
  ): void => {
    let generated: string;
    if (typeof expected === 'function') {
      if (expected.prototype !== undefined && actual instanceof expected) return;
      if (Object.prototype.isPrototypeOf.call(Error, expected)) {
        const received = isObject(actual) ? actual.constructor?.name : inspect(actual);
        generated = `The error is expected to be an instance of "${expected.name}". Received "${received}"`;
        if (actual instanceof Error) generated += `\n\nError message:\n\n${actual.message}`;
      } else {
        const result: unknown = Reflect.apply(expected, {}, [actual]);
        if (result === true) return;
        generated = `The ${expected.name ? `"${expected.name}" ` : ''}validation function is expected to return "true". `
          + `Received ${inspect(result)}\n\nCaught error:\n\n${String(actual)}`;
      }
    } else if (expected instanceof RegExp) {
      const text = String(actual);
      if (expected.exec(text) !== null) return;
      generated = `The input did not match the regular expression ${inspect(expected)}. Input:\n\n${inspect(text)}\n`;
    } else if (isObject(expected)) {
      const keys = Object.keys(expected);
      // An Error used as the pattern also pins its non-enumerable name and message.
      if (expected instanceof Error) keys.push('name', 'message');
      if (keys.length === 0) {
        throw invalidArgument('ERR_INVALID_ARG_VALUE', `The argument 'error' may not be an empty object. Received {}`);
      }
      const mismatched = keys.find((key) => {
        if (!isObject(actual) || !(key in actual)) return true;
        const actualValue = (actual as Record<string, unknown>)[key];
        const expectedValue = (expected as Record<string, unknown>)[key];
        if (typeof actualValue === 'string' && expectedValue instanceof RegExp) return expectedValue.exec(actualValue) === null;
        return !isDeepEqual(actualValue, expectedValue, true);
      });
      if (mismatched === undefined) return;
      const actualValue = isObject(actual) ? (actual as Record<string, unknown>)[mismatched] : undefined;
      generated = `Expected values to be strictly deep-equal:\n\n${mismatched}: ${inspect(actualValue)}\n\nshould equal\n\n`
        + `${mismatched}: ${inspect((expected as Record<string, unknown>)[mismatched])}`;
    } else {
      throw invalidArgument(
        'ERR_INVALID_ARG_TYPE',
        'The "expected" argument must be of type function or an instance of Error, RegExp, or Object.'
      );
    }
    fail({ actual, expected, operator, message: message ?? generated }, message === undefined);
  };

  const expectError = (
    operator: 'throws' | 'rejects',
    actual: unknown,
    expected?: ErrorMatcher | string,
    message?: AssertionMessage
  ): void => {
    let matcher: ErrorMatcher | undefined;
    if (typeof expected === 'string') message = expected;
    else matcher = expected;
    if (actual === NO_EXCEPTION) {
      const matcherName = typeof matcher === 'function' && matcher.name ? ` (${matcher.name})` : '';
      const detail = message === undefined ? '.' : `: ${message instanceof Error ? message.message : message}`;
      fail({
        actual: undefined,
        expected: matcher,
        operator,
        message: `Missing expected ${operator === 'rejects' ? 'rejection' : 'exception'}${matcherName}${detail}`
      });
    }
    if (matcher !== undefined) assertErrorMatches(actual, matcher, message, operator);
  };

  const expectNoError = (
    operator: 'doesNotThrow' | 'doesNotReject',
    actual: unknown,
    expected?: ErrorMatcher | string,
    message?: AssertionMessage
  ): void => {
    if (actual === NO_EXCEPTION) return;
    let matcher: ErrorMatcher | undefined;
    if (typeof expected === 'string') message = expected;
    else matcher = expected;
    // An error the matcher does not describe is not the one being ruled out; it propagates.
    if (matcher !== undefined && !errorMatches(actual, matcher)) throw actual;
    const detail = message === undefined ? '.' : `: ${message instanceof Error ? message.message : message}`;
    fail({
      actual,
      expected: matcher,
      operator,
      message: `Got unwanted ${operator === 'doesNotReject' ? 'rejection' : 'exception'}${detail}\n`
        + `Actual message: "${isObject(actual) ? (actual as { message?: unknown }).message : actual}"`
    });
  };

  const thrownBy = (block: unknown): unknown => {
    if (typeof block !== 'function') {
      throw invalidArgument('ERR_INVALID_ARG_TYPE', 'The "fn" argument must be of type function.');
    }
    try {
      block();
    } catch (error) {
      return error;
    }
    return NO_EXCEPTION;
  };

  const rejectionOf = async (promiseOrFunction: unknown): Promise<unknown> => {
    let promise = promiseOrFunction;
    if (typeof promiseOrFunction === 'function') {
      promise = promiseOrFunction();
      if (!isObject(promise) || typeof (promise as { then?: unknown }).then !== 'function') {
        throw invalidArgument(
          'ERR_INVALID_RETURN_VALUE',
          'Expected instance of Promise to be returned from the "promiseFn" function.'
        );
      }
    } else if (!isObject(promise) || typeof (promise as { then?: unknown }).then !== 'function') {
      throw invalidArgument('ERR_INVALID_ARG_TYPE', 'The "promiseFn" argument must be of type function or an instance of Promise.');
    }
    try {
      await promise;
    } catch (error) {
      return error;
    }
    return NO_EXCEPTION;
  };

  const looselyEqual = (actual: unknown, expected: unknown): boolean =>
    actual == expected || (actual !== actual && expected !== expected);

  const createAssert = (strict: boolean) => {
    function ok(...args: [value?: unknown, message?: AssertionMessage]): void {
      const [value, message] = args;
      if (value) return;
      if (args.length === 0) fail({ actual: value, expected: true, operator: '==', message: 'No value argument passed to `assert.ok()`' }, true);
      fail({ actual: value, expected: true, operator: '==', message });
    }
    const assert = Object.assign(
      function assert(...args: [value?: unknown, message?: AssertionMessage]): void {
        ok(...args);
      },
      {
        AssertionError,
        ok,
        fail(...args: [message?: AssertionMessage] | [actual: unknown, expected: unknown, message?: AssertionMessage, operator?: string]): never {
          if (args.length === 0) return fail({ operator: 'fail', message: 'Failed' }, true);
          if (args.length === 1) return fail({ operator: 'fail', message: args[0] as AssertionMessage });
          // The deprecated four-argument form: fail(actual, expected, message, operator).
          const [actual, expected, message, operator = 'fail'] = args;
          return fail({ actual, expected, message, operator });
        },
        strictEqual(actual: unknown, expected: unknown, message?: AssertionMessage): void {
          if (!Object.is(actual, expected)) fail({ actual, expected, message, operator: 'strictEqual' });
        },
        notStrictEqual(actual: unknown, expected: unknown, message?: AssertionMessage): void {
          if (Object.is(actual, expected)) fail({ actual, expected, message, operator: 'notStrictEqual' });
        },
        deepStrictEqual(actual: unknown, expected: unknown, message?: AssertionMessage): void {
          if (!isDeepEqual(actual, expected, true)) fail({ actual, expected, message, operator: 'deepStrictEqual' });
        },
        notDeepStrictEqual(actual: unknown, expected: unknown, message?: AssertionMessage): void {
          if (isDeepEqual(actual, expected, true)) fail({ actual, expected, message, operator: 'notDeepStrictEqual' });
        },
        equal(actual: unknown, expected: unknown, message?: AssertionMessage): void {
          if (!looselyEqual(actual, expected)) fail({ actual, expected, message, operator: '==' });
        },
        notEqual(actual: unknown, expected: unknown, message?: AssertionMessage): void {
          if (looselyEqual(actual, expected)) fail({ actual, expected, message, operator: '!=' });
        },
        deepEqual(actual: unknown, expected: unknown, message?: AssertionMessage): void {
          if (!isDeepEqual(actual, expected, false)) fail({ actual, expected, message, operator: 'deepEqual' });
        },
        notDeepEqual(actual: unknown, expected: unknown, message?: AssertionMessage): void {
          if (isDeepEqual(actual, expected, false)) fail({ actual, expected, message, operator: 'notDeepEqual' });
        },
        throws(block: () => unknown, expected?: ErrorMatcher | string, message?: AssertionMessage): void {
          expectError('throws', thrownBy(block), expected, message);
        },
        doesNotThrow(block: () => unknown, expected?: ErrorMatcher | string, message?: AssertionMessage): void {
          expectNoError('doesNotThrow', thrownBy(block), expected, message);
        },
        async rejects(
          promiseOrFunction: PromiseLike<unknown> | (() => PromiseLike<unknown>),
          expected?: ErrorMatcher | string,
          message?: AssertionMessage
        ): Promise<void> {
          expectError('rejects', await rejectionOf(promiseOrFunction), expected, message);
        },
        async doesNotReject(
          promiseOrFunction: PromiseLike<unknown> | (() => PromiseLike<unknown>),
          expected?: ErrorMatcher | string,
          message?: AssertionMessage
        ): Promise<void> {
          expectNoError('doesNotReject', await rejectionOf(promiseOrFunction), expected, message);
        },
        ifError(value: unknown): void {
          if (value === null || value === undefined) return;
          const text = isObject(value) && typeof (value as { message?: unknown }).message === 'string'
            ? (value as { message: string }).message || value.constructor?.name || ''
            : inspect(value);
          fail({ actual: value, expected: null, operator: 'ifError', message: `ifError got unwanted exception: ${text}` });
        },
        match(value: unknown, pattern: RegExp, message?: AssertionMessage): void {
          matchPattern(value, pattern, message, 'match');
        },
        doesNotMatch(value: unknown, pattern: RegExp, message?: AssertionMessage): void {
          matchPattern(value, pattern, message, 'doesNotMatch');
        },
        strict: undefined as unknown,
        default: undefined as unknown
      }
    );
    if (strict) {
      assert.equal = assert.strictEqual;
      assert.notEqual = assert.notStrictEqual;
      assert.deepEqual = assert.deepStrictEqual;
      assert.notDeepEqual = assert.notDeepStrictEqual;
    }
    assert.default = assert;
    return assert;
  };

  const matchPattern = (
    value: unknown,
    pattern: RegExp,
    message: AssertionMessage | undefined,
    operator: 'match' | 'doesNotMatch'
  ): void => {
    if (!(pattern instanceof RegExp)) {
      throw invalidArgument('ERR_INVALID_ARG_TYPE', 'The "regexp" argument must be an instance of RegExp.');
    }
    const expectMatch = operator === 'match';
    if (typeof value === 'string' && (pattern.exec(value) !== null) === expectMatch) return;
    fail({
      actual: value,
      expected: pattern,
      operator,
      message: message ?? (
        typeof value !== 'string'
          ? `The "string" argument must be of type string. Received type ${typeof value} (${inspect(value)})`
          : `The input ${expectMatch ? 'did not match' : 'was expected to not match'} the regular expression `
            + `${inspect(pattern)}. Input:\n\n${inspect(value)}\n`
      )
    }, message === undefined);
  };

  const assert = createAssert(false);
  const strict = createAssert(true);
  assert.strict = strict;
  strict.strict = strict;
  return assert;
}
