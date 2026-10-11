import { describe, expect, test } from 'vitest';

import { createAssertBuiltin } from '../assert';
import { createAsyncHooksBuiltin } from '../async-hooks';
import { createConstantsBuiltin, NODE_FS_CONSTANTS } from '../constants';
import { createDiagnosticsChannelBuiltin } from '../diagnostics-channel';
import { createDomainBuiltin } from '../domain';
import { EventEmitter } from '../events';
import { createPerfHooksBuiltin } from '../perf-hooks';
import { createPunycodeBuiltin } from '../punycode';
import { createClusterBuiltin, type ClusterChildProcess, type ClusterProcess } from '../cluster';
import {
  createDgramBuiltin,
  createReplBuiltin,
  createTraceEventsBuiltin
} from '../single-process-builtins';
import { createInspectorBuiltin } from '../inspector';
import { createStreamConsumersBuiltin } from '../stream-consumers';
import { createTtyBuiltin } from '../tty';
import { createQuerystringBuiltin } from '../querystring';
import { BrowserBuffer } from '../buffer';
import { createNodeConsole } from '../console';
import { inspect } from '../inspect';

const inspectCustomSymbol = Symbol.for('nodejs.util.inspect.custom');
import { createUrlBuiltin } from '../url';
import { createUtilBuiltin, createUtilTypesBuiltin } from '../util';

describe('Node Compatibility builtin implementations', () => {
  test('stream/consumers reads strings and bytes of a stream into text, JSON and a Buffer', async () => {
    const consumers = createStreamConsumersBuiltin() as {
      text(stream: AsyncIterable<unknown>): Promise<string>;
      json(stream: Iterable<unknown>): Promise<unknown>;
      buffer(stream: Iterable<unknown>): Promise<Uint8Array>;
      arrayBuffer(stream: Iterable<unknown>): Promise<ArrayBuffer>;
    };
    async function* chunks(): AsyncGenerator<unknown> {
      yield '{"price":';
      yield new TextEncoder().encode('"4 €"}');
    }

    await expect(consumers.text(chunks())).resolves.toBe('{"price":"4 €"}');
    await expect(consumers.json(['[1,', '2]'])).resolves.toEqual([1, 2]);
    expect(BrowserBuffer.isBuffer(await consumers.buffer([Uint8Array.of(1, 2)]))).toBe(true);
    expect(new Uint8Array(await consumers.arrayBuffer([Uint8Array.of(1), Uint8Array.of(2)]))).toEqual(Uint8Array.of(1, 2));
    await expect(consumers.text([1])).rejects.toMatchObject({ code: 'ERR_INVALID_ARG_TYPE' });
  });

  test('inspector reports that no debugger is attached and refuses a session', () => {
    const inspector = createInspectorBuiltin(console) as {
      url(): string | undefined;
      Session: new () => { connect(): void };
      default: { url: unknown };
    };

    expect(inspector.url()).toBeUndefined();
    expect(() => new inspector.Session().connect()).toThrow(
      expect.objectContaining({ code: 'ERR_INSPECTOR_NOT_AVAILABLE' })
    );
    expect(inspector.default.url).toBe(inspector.url);
  });

  test('tty write streams answer colour queries as a stream that is not a terminal', () => {
    const tty = createTtyBuiltin() as {
      WriteStream: { prototype: { hasColors(): boolean; getColorDepth(): number } };
    };

    expect(tty.WriteStream.prototype.hasColors()).toBe(false);
    expect(tty.WriteStream.prototype.getColorDepth()).toBe(1);
  });

  test('async_hooks AsyncResource binds callbacks without changing their arguments', () => {
    const asyncHooks = createAsyncHooksBuiltin();
    const resource = new asyncHooks.AsyncResource('content-type-parser:run');
    const receiver = { prefix: 'parsed' };
    const callback = resource.bind(function (this: typeof receiver, value: string) {
      return `${this.prefix}:${value}`;
    }, receiver);

    expect(callback('body')).toBe('parsed:body');
    expect(resource.runInAsyncScope((left: number, right: number) => left + right, undefined, 2, 3)).toBe(5);
    expect(resource.asyncId()).toBeGreaterThan(0);
    expect(resource.emitDestroy()).toBe(resource);
    expect(asyncHooks.default.AsyncResource).toBe(asyncHooks.AsyncResource);
  });

  test('async_hooks owns synchronous AsyncLocalStorage scopes and inert lifecycle hooks', () => {
    const asyncHooks = createAsyncHooksBuiltin();
    const storage = new asyncHooks.AsyncLocalStorage<string>();

    expect(storage.getStore()).toBeUndefined();
    expect(storage.run('outer', () => storage.run('inner', () => `${storage.getStore()}:value`))).toBe('inner:value');
    expect(storage.getStore()).toBeUndefined();
    storage.enterWith('entered');
    expect(storage.exit(() => storage.getStore())).toBeUndefined();
    expect(storage.getStore()).toBe('entered');
    storage.disable();
    expect(storage.getStore()).toBeUndefined();
    let hookCalls = 0;
    const hook = asyncHooks.createHook({ init: () => (hookCalls += 1) });
    expect(hook.enable()).toBe(hook);
    expect(hook.disable()).toBe(hook);
    expect(hookCalls).toBe(0);
    const resource = new asyncHooks.AsyncResource('probe');
    expect(asyncHooks.executionAsyncId()).toBe(1);
    expect(resource.runInAsyncScope(() => asyncHooks.executionAsyncId(), undefined)).toBe(resource.asyncId());
    expect(resource.triggerAsyncId()).toBe(1);
  });

  test('diagnostics_channel shares named channels and publishes only to current subscribers', () => {
    const diagnostics = createDiagnosticsChannelBuiltin();
    const first = diagnostics.channel('fastify.initialization');
    const second = diagnostics.channel('fastify.initialization');
    const messages: Array<{ message: unknown; name: string | symbol }> = [];
    const subscriber = (message: unknown, name: string | symbol) => messages.push({ message, name });

    expect(second).toBe(first);
    expect(first.hasSubscribers).toBe(false);
    first.subscribe(subscriber);
    expect(diagnostics.hasSubscribers('fastify.initialization')).toBe(true);
    first.publish({ phase: 'boot' });
    expect(first.unsubscribe(subscriber)).toBe(true);
    first.publish({ phase: 'ignored' });

    expect(messages).toEqual([{ message: { phase: 'boot' }, name: 'fastify.initialization' }]);
    const tracing = diagnostics.tracingChannel('fastify.request.handler');
    const context = { phase: 'handler' };
    const receiver = { prefix: 'received' };
    expect(tracing.start.name).toBe('tracing:fastify.request.handler:start');
    expect(tracing.hasSubscribers).toBe(false);
    tracing.start.subscribe(subscriber);
    expect(tracing.hasSubscribers).toBe(true);
    expect(
      tracing.start.runStores(
        context,
        function (this: typeof receiver, value: string) {
          return `${this.prefix}:${value}`;
        },
        receiver,
        'payload'
      )
    ).toBe('received:payload');
    expect(messages.at(-1)).toEqual({ message: context, name: 'tracing:fastify.request.handler:start' });
    expect(diagnostics.default.channel).toBe(diagnostics.channel);
    expect(() => first.bindStore()).toThrow(
      expect.objectContaining({ code: 'ENOTSUP', message: expect.stringContaining('bindStore') })
    );
    expect(() => first.unbindStore()).toThrow(
      expect.objectContaining({ code: 'ENOTSUP', message: expect.stringContaining('unbindStore') })
    );
  });

  test('constants flattens the errno, signal and filesystem constants with a default namespace export', () => {
    const constants = createConstantsBuiltin() as typeof NODE_FS_CONSTANTS & {
      EBADF: number;
      ENOENT: number;
      SIGTERM: number;
      default: typeof NODE_FS_CONSTANTS;
    };

    expect(constants.F_OK).toBe(0);
    expect(constants.O_WRONLY).toBe(1);
    expect(constants.S_IFLNK).toBe(40_960);
    expect(constants).toMatchObject({ EBADF: 9, ENOENT: 2, SIGTERM: 15 });
    expect(constants.default).toMatchObject(NODE_FS_CONSTANTS);
    expect(constants.default).not.toBe(NODE_FS_CONSTANTS);
  });

  test('assert owns AssertionError metadata and default export shape', () => {
    const assert = createAssertBuiltin() as {
      strictEqual(actual: unknown, expected: unknown, message?: string): void;
      throws(block: () => unknown): void;
      AssertionError: new (options: { actual?: unknown; expected?: unknown; operator?: string; message?: string }) => Error & {
        code: string;
        actual?: unknown;
        expected?: unknown;
        operator: string;
      };
      default: unknown;
    };

    assert.strictEqual('same', 'same');
    assert.throws(() => assert.strictEqual('left', 'right'));

    const error = new assert.AssertionError({
      actual: 'left',
      expected: 'right',
      operator: 'strictEqual',
      message: 'mismatch'
    });
    expect(error.name).toBe('AssertionError');
    expect(error.code).toBe('ERR_ASSERTION');
    expect(error.actual).toBe('left');
    expect(error.expected).toBe('right');
    expect(error.operator).toBe('strictEqual');
    expect(assert.default).toBe(assert);
  });

  test('assert compares values deeply by content, prototype and identity rules', () => {
    const assert = createAssertBuiltin() as AssertBuiltin;
    const cyclic = () => {
      const value: Record<string, unknown> = { child: {} };
      (value.child as Record<string, unknown>).parent = value;
      return value;
    };
    const tagged = (value: object, properties: object) => Object.assign(value, properties);
    // [actual, expected, loosely deep-equal, strictly deep-equal], each verified against Node.
    const cases: Array<[unknown, unknown, boolean, boolean]> = [
      [new Date(0), new Date(1), false, false],
      [new Date(5), new Date(5), true, true],
      [new Date(0), {}, false, false],
      [new Date(NaN), new Date(NaN), false, false],
      [/a/g, /a/i, false, false],
      [/a/g, /a/g, true, true],
      [new Map([['a', { x: 1 }]]), new Map([['a', { x: 2 }]]), false, false],
      [new Map([['a', 1], ['b', 2]]), new Map([['b', 2], ['a', 1]]), true, true],
      [new Map([[{ a: 1 }, 1]]), new Map([[{ a: 1 }, 1]]), true, true],
      [new Map<unknown, unknown>([[1, '1']]), new Map<unknown, unknown>([['1', 1]]), true, false],
      [new Set([1, 2]), new Set([1, 3]), false, false],
      [new Set([{ a: 1 }, { a: 2 }]), new Set([{ a: 2 }, { a: 1 }]), true, true],
      [new Set([{ a: 1 }, { a: 1 }]), new Set([{ a: 1 }, { a: 2 }]), false, false],
      [new Set([1]), new Set(['1']), true, false],
      [new Uint8Array([1, 2]), new Uint8Array([1, 3]), false, false],
      [new Uint8Array([1, 2]), new Uint8Array([1, 2]), true, true],
      [new Uint8Array([1, 2]), new Int8Array([1, 2]), false, false],
      [BrowserBuffer.from([1, 2]), new Uint8Array([1, 2]), true, false],
      [new Float32Array([-0]), new Float32Array([0]), true, false],
      [new Float32Array([NaN]), new Float32Array([NaN]), false, true],
      [new Uint8Array([1, 2]).buffer, new Uint8Array([1, 3]).buffer, false, false],
      [new Number(1), new Number(2), false, false],
      [new Number(1), 1, false, false],
      [new String('a'), new String('a'), true, true],
      [new Error('a'), new Error('b'), false, false],
      [new Error('a'), new Error('a'), true, true],
      [new TypeError('a'), new Error('a'), false, false],
      [tagged(new Error('a'), { code: 1 }), tagged(new Error('a'), { code: 2 }), false, false],
      [-0, 0, true, false],
      [NaN, NaN, true, true],
      [1, '1', true, false],
      [[1], ['1'], true, false],
      [null, undefined, true, false],
      [null, {}, false, false],
      [Object.create(null), {}, true, false],
      [new (class Point {})(), {}, true, false],
      [[], {}, false, false],
      [[1, , 3], [1, undefined, 3], false, false],
      [{ a: undefined }, {}, false, false],
      [{ [Symbol.for('k')]: 1 }, { [Symbol.for('k')]: 2 }, true, false],
      [{ a: 1, b: 2 }, { b: 2, a: 1 }, true, true],
      [new WeakMap(), new WeakMap(), false, false],
      [() => 1, () => 1, false, false],
      [cyclic(), cyclic(), true, true],
      [tagged(cyclic(), { extra: 1 }), cyclic(), false, false]
    ];
    const passes = (run: () => void): boolean => {
      try {
        run();
        return true;
      } catch (error) {
        expect(error).toBeInstanceOf(assert.AssertionError);
        return false;
      }
    };

    cases.forEach(([actual, expected, loose, strict], index) => {
      expect(passes(() => assert.deepEqual(actual, expected)), `deepEqual case ${index}`).toBe(loose);
      expect(passes(() => assert.notDeepEqual(actual, expected)), `notDeepEqual case ${index}`).toBe(!loose);
      expect(passes(() => assert.deepStrictEqual(actual, expected)), `deepStrictEqual case ${index}`).toBe(strict);
      expect(passes(() => assert.notDeepStrictEqual(actual, expected)), `notDeepStrictEqual case ${index}`).toBe(!strict);
      expect(passes(() => assert.strict.deepEqual(actual, expected)), `strict.deepEqual case ${index}`).toBe(strict);
    });
  });

  test('assert.throws, rejects and doesNotThrow honor their matcher and message', async () => {
    const assert = createAssertBuiltin() as AssertBuiltin;
    const typeError = Object.assign(new TypeError('abc'), { code: 'E_ABC' });
    const throwTypeError = () => {
      throw typeError;
    };
    const failure = (run: () => unknown): { code?: string; message: string; operator?: string; generatedMessage?: boolean; actual?: unknown } => {
      try {
        run();
      } catch (error) {
        return error as Error;
      }
      throw new Error('Expected the assertion to fail.');
    };

    assert.throws(throwTypeError);
    assert.throws(throwTypeError, TypeError);
    assert.throws(throwTypeError, Error);
    assert.throws(throwTypeError, /abc/);
    assert.throws(throwTypeError, (error: unknown) => error === typeError);
    assert.throws(throwTypeError, { name: 'TypeError', message: /ab/, code: 'E_ABC' });
    assert.throws(throwTypeError, new TypeError('abc'));
    assert.doesNotThrow(() => undefined);

    expect(failure(() => assert.throws(() => undefined))).toMatchObject({
      code: 'ERR_ASSERTION', operator: 'throws', message: 'Missing expected exception.', generatedMessage: false
    });
    expect(failure(() => assert.throws(() => undefined, TypeError, 'mm')).message).toBe('Missing expected exception (TypeError): mm');
    expect(failure(() => assert.throws(() => undefined, 'mm')).message).toBe('Missing expected exception: mm');
    expect(failure(() => assert.throws(throwTypeError, RangeError))).toMatchObject({
      code: 'ERR_ASSERTION',
      operator: 'throws',
      actual: typeError,
      generatedMessage: true,
      message: 'The error is expected to be an instance of "RangeError". Received "TypeError"\n\nError message:\n\nabc'
    });
    expect(failure(() => assert.throws(throwTypeError, /xyz/)).message).toBe(
      "The input did not match the regular expression /xyz/. Input:\n\n'TypeError: abc'\n"
    );
    expect(failure(() => assert.throws(throwTypeError, /xyz/, 'custom'))).toMatchObject({ message: 'custom', generatedMessage: false });
    expect(failure(() => assert.throws(throwTypeError, () => false)).message).toBe(
      'The validation function is expected to return "true". Received false\n\nCaught error:\n\nTypeError: abc'
    );
    expect(failure(() => assert.throws(throwTypeError, { message: 'xyz' }))).toMatchObject({ code: 'ERR_ASSERTION', operator: 'throws' });
    expect(failure(() => assert.throws(throwTypeError, { code: 'E_OTHER' })).code).toBe('ERR_ASSERTION');
    expect(failure(() => assert.throws(throwTypeError, new TypeError('abd'))).code).toBe('ERR_ASSERTION');
    expect(failure(() => assert.throws(throwTypeError, {})).code).toBe('ERR_INVALID_ARG_VALUE');
    expect(failure(() => assert.throws('not a function' as unknown as () => void)).code).toBe('ERR_INVALID_ARG_TYPE');

    expect(failure(() => assert.doesNotThrow(throwTypeError))).toMatchObject({
      code: 'ERR_ASSERTION', operator: 'doesNotThrow', actual: typeError, message: 'Got unwanted exception.\nActual message: "abc"'
    });
    expect(failure(() => assert.doesNotThrow(throwTypeError, TypeError, 'mm')).message).toBe(
      'Got unwanted exception: mm\nActual message: "abc"'
    );
    // An error the matcher does not describe is rethrown untouched.
    expect(failure(() => assert.doesNotThrow(throwTypeError, RangeError))).toBe(typeError);
    expect(failure(() => assert.doesNotThrow(throwTypeError, /zzz/))).toBe(typeError);

    await assert.rejects(Promise.reject(typeError), TypeError);
    await assert.rejects(async () => { throw typeError; }, { name: 'TypeError', message: 'abc' });
    await assert.doesNotReject(Promise.resolve(1));
    await expect(assert.rejects(Promise.resolve(1))).rejects.toMatchObject({
      code: 'ERR_ASSERTION', operator: 'rejects', message: 'Missing expected rejection.'
    });
    await expect(assert.rejects(() => Promise.reject(typeError), /xyz/)).rejects.toMatchObject({
      code: 'ERR_ASSERTION', operator: 'rejects'
    });
    await expect(assert.rejects(() => { throw typeError; })).rejects.toBe(typeError);
    await expect(assert.doesNotReject(Promise.reject(typeError))).rejects.toMatchObject({
      code: 'ERR_ASSERTION', operator: 'doesNotReject', message: 'Got unwanted rejection.\nActual message: "abc"'
    });
    await expect(assert.doesNotReject(Promise.reject(typeError), RangeError)).rejects.toBe(typeError);
  });

  test('assert reports failures as AssertionErrors and exposes a strict variant', () => {
    const assert = createAssertBuiltin() as AssertBuiltin;
    const failure = (run: () => unknown): Record<string, unknown> => {
      try {
        run();
      } catch (error) {
        return error as Record<string, unknown>;
      }
      throw new Error('Expected the assertion to fail.');
    };

    expect(failure(() => assert.strictEqual(1, 2))).toMatchObject({
      name: 'AssertionError',
      code: 'ERR_ASSERTION',
      actual: 1,
      expected: 2,
      operator: 'strictEqual',
      generatedMessage: true,
      message: 'Expected values to be strictly equal:\n\n1 !== 2\n'
    });
    expect(failure(() => assert.strictEqual(1, 2, 'custom'))).toMatchObject({ message: 'custom', generatedMessage: false });
    expect(failure(() => assert.strictEqual(1, 2, new RangeError('own error')))).toBeInstanceOf(RangeError);
    expect(failure(() => assert.equal(1, 2))).toMatchObject({ operator: '==', message: '1 == 2' });
    expect(failure(() => assert.notEqual(1, '1'))).toMatchObject({ operator: '!=', message: "1 != '1'" });
    expect(failure(() => assert.notStrictEqual(1, 1)).message).toBe('Expected "actual" to be strictly unequal to: 1');
    expect(failure(() => assert.deepEqual([1], [2])).message).toBe(
      'Expected values to be loosely deep-equal:\n\n[\n  1\n]\n\nshould loosely deep-equal\n\n[\n  2\n]'
    );
    expect(failure(() => assert.deepStrictEqual({ a: 1 }, { a: 2 }))).toMatchObject({
      code: 'ERR_ASSERTION', operator: 'deepStrictEqual', actual: { a: 1 }, expected: { a: 2 }
    });
    expect(failure(() => assert(0))).toMatchObject({ operator: '==', actual: 0, expected: true });
    expect(failure(() => assert.ok(false, 'boom')).message).toBe('boom');
    expect(failure(() => (assert.ok as () => void)()).message).toBe('No value argument passed to `assert.ok()`');
    expect(failure(() => assert.fail())).toMatchObject({ message: 'Failed', operator: 'fail' });
    expect(failure(() => assert.fail('boom')).message).toBe('boom');
    expect(failure(() => assert.fail(new TypeError('own')))).toBeInstanceOf(TypeError);
    expect(failure(() => assert.ifError(0))).toMatchObject({ operator: 'ifError', message: 'ifError got unwanted exception: 0' });
    expect(failure(() => assert.ifError(new Error('e'))).message).toBe('ifError got unwanted exception: e');
    expect(failure(() => assert.match('abc', /x/))).toMatchObject({ operator: 'match', code: 'ERR_ASSERTION' });
    expect(failure(() => assert.doesNotMatch('abc', /a/)).operator).toBe('doesNotMatch');
    assert.equal(NaN, NaN);
    assert.equal(1, '1');
    assert.ifError(null);
    assert.ifError(undefined);
    assert.match('abc', /b/);

    const { strict } = assert;
    expect(typeof strict).toBe('function');
    expect(strict.strict).toBe(strict);
    expect(strict.default).toBe(strict);
    expect(strict.AssertionError).toBe(assert.AssertionError);
    expect(strict.equal).toBe(strict.strictEqual);
    expect(strict.notEqual).toBe(strict.notStrictEqual);
    expect(strict.deepEqual).toBe(strict.deepStrictEqual);
    expect(strict.notDeepEqual).toBe(strict.notDeepStrictEqual);
    expect(assert.equal).not.toBe(assert.strictEqual);
    expect(failure(() => strict.equal(1, '1'))).toMatchObject({ code: 'ERR_ASSERTION', operator: 'strictEqual' });
    expect(failure(() => strict.deepEqual([1], ['1'])).operator).toBe('deepStrictEqual');
    expect(failure(() => strict(0)).code).toBe('ERR_ASSERTION');
  });

  test('util.promisify and util.deprecate keep the receiver and honor promisify.custom', async () => {
    const warnings: string[] = [];
    const util = createUtilBuiltin({ warn: (message: unknown) => warnings.push(String(message)), error: () => undefined }) as UtilBuiltin;
    const counter = {
      count: 41,
      increment(by: number, callback: (error: unknown, value?: number) => void) {
        this.count += by;
        callback(null, this.count);
      },
      total() {
        return this.count;
      }
    };

    const increment = util.promisify(counter.increment);
    expect(await increment.call(counter, 1)).toBe(42);
    expect(await Object.assign(counter, { incrementAsync: increment }).incrementAsync(1)).toBe(43);
    await expect(util.promisify((callback: (error: unknown) => void) => callback(new Error('failed')))()).rejects.toThrow('failed');
    await expect(util.promisify(() => { throw new Error('thrown'); })()).rejects.toThrow('thrown');
    expect(() => util.promisify('nope' as unknown as () => void)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));

    expect(util.promisify.custom).toBe(Symbol.for('nodejs.util.promisify.custom'));
    const custom = () => Promise.resolve('custom');
    const original = Object.assign((callback: (error: unknown, value?: string) => void) => callback(null, 'callback'), {
      [util.promisify.custom]: custom
    });
    expect(util.promisify(original)).toBe(custom);
    expect(await util.promisify(original)()).toBe('custom');
    // Promisifying twice returns the first wrapper, as Node does.
    expect(util.promisify(increment)).toBe(increment);

    const total = util.deprecate(counter.total, 'total() is deprecated', 'DEP_TEST');
    expect(total.call(counter)).toBe(43);
    expect(Object.assign(counter, { deprecatedTotal: total }).deprecatedTotal()).toBe(43);
    class Shape {
      constructor(readonly sides: number) {}
    }
    const DeprecatedShape = util.deprecate(Shape, 'Shape is deprecated');
    const shape = new DeprecatedShape(3);
    expect(shape).toBeInstanceOf(Shape);
    expect(shape.sides).toBe(3);
    util.deprecate(() => undefined, 'same code warns once', 'DEP_TEST')();
    expect(warnings).toEqual(['[DEP_TEST] DeprecationWarning: total() is deprecated', 'DeprecationWarning: Shape is deprecated']);
  });

  test('util.isDeepStrictEqual, util.types and util.parseArgs follow Node', () => {
    const util = createUtilBuiltin({ warn: () => undefined, error: () => undefined }, { argv: () => ['node', 'script.js', '--port', '80'] }) as UtilBuiltin;

    expect(util.isDeepStrictEqual(new Map([['a', new Date(0)]]), new Map([['a', new Date(0)]]))).toBe(true);
    expect(util.isDeepStrictEqual(new Map([['a', new Date(0)]]), new Map([['a', new Date(1)]]))).toBe(false);
    expect(util.isDeepStrictEqual([1], ['1'])).toBe(false);
    expect(util.isDeepStrictEqual(-0, 0)).toBe(false);
    expect(util.isDeepStrictEqual(new Set([1, { a: 1 }]), new Set([{ a: 1 }, 1]))).toBe(true);

    expect(util.types.isMap(new Map())).toBe(true);
    expect(util.types.isSet(new Map())).toBe(false);
    expect(util.types.isRegExp(/a/)).toBe(true);
    expect(util.types.isPromise(Promise.resolve())).toBe(true);
    expect(util.types.isBoxedPrimitive(new Number(1))).toBe(true);
    expect(util.types.isBoxedPrimitive(1)).toBe(false);
    expect(util.types.isAsyncFunction(async () => undefined)).toBe(true);
    expect(util.types.isAsyncFunction(() => undefined)).toBe(false);
    expect(util.types.isFloat64Array(new Float64Array(1))).toBe(true);
    expect(util.types.isFloat64Array(new Uint8Array(1))).toBe(false);
    // A page cannot observe whether a value is a Proxy, so none is ever reported.
    expect(util.types.isProxy(new Proxy({}, {}))).toBe(false);

    expect(util.parseArgs({ options: { port: { type: 'string' } } })).toEqual({ values: { port: '80' }, positionals: [] });
    const parsed = util.parseArgs({
      args: ['-f', '--bar=b', 'pos', '-vxm1', '-m', '2', '--no-color', '--', '--literal'],
      options: {
        foo: { type: 'boolean', short: 'f' },
        bar: { type: 'string' },
        verbose: { type: 'boolean', short: 'v' },
        extra: { type: 'boolean', short: 'x' },
        multi: { type: 'string', short: 'm', multiple: true },
        color: { type: 'boolean' },
        level: { type: 'string', default: 'info' }
      },
      allowPositionals: true,
      allowNegative: true,
      tokens: true
    });
    expect({ ...parsed.values }).toEqual({
      foo: true, bar: 'b', verbose: true, extra: true, multi: ['1', '2'], color: false, level: 'info'
    });
    expect(parsed.positionals).toEqual(['pos', '--literal']);
    expect(parsed.tokens?.[0]).toEqual({ kind: 'option', name: 'foo', rawName: '-f', index: 0, value: undefined, inlineValue: undefined });
    expect(parsed.tokens?.[1]).toEqual({ kind: 'option', name: 'bar', rawName: '--bar', index: 1, value: 'b', inlineValue: true });
    expect(parsed.tokens?.at(-2)).toEqual({ kind: 'option-terminator', index: 7 });
    expect(util.parseArgs({ args: ['--unknown', 'v', '-u', '--k=v'], strict: false })).toEqual({
      values: { unknown: true, u: true, k: 'v' }, positionals: ['v']
    });
    expect(() => util.parseArgs({ args: ['--unknown'], options: {} })).toThrow(
      expect.objectContaining({ code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION' })
    );
    expect(() => util.parseArgs({ args: ['pos'], options: {} })).toThrow(
      expect.objectContaining({ code: 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL' })
    );
    expect(() => util.parseArgs({ args: ['--bar'], options: { bar: { type: 'string' } } })).toThrow(
      expect.objectContaining({ code: 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' })
    );
    expect(() => util.parseArgs({ args: ['--foo=1'], options: { foo: { type: 'boolean' } } })).toThrow(
      expect.objectContaining({ code: 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' })
    );
  });

  test('util.inspect and console share one formatter with depth, custom inspection and cycles', () => {
    const util = createUtilBuiltin({ warn: () => undefined, error: () => undefined }) as UtilBuiltin;
    const lines: string[] = [];
    const nodeConsole = createNodeConsole({ stdout: { write: (text: string) => void lines.push(text) } });
    const cyclic: Record<string, unknown> = { name: 'root', when: new Date(0), tags: new Set(['a']), bytes: new Uint8Array([1, 2]) };
    cyclic.self = cyclic;
    const custom = { [util.inspect.custom]: () => 'custom view' };
    const deep = { a: { b: { c: { d: 1 } } } };

    expect(util.inspect.custom).toBe(inspectCustomSymbol);
    expect(util.inspect(cyclic)).toBe(
      "<ref *1> {\n  name: 'root',\n  when: 1970-01-01T00:00:00.000Z,\n  tags: Set(1) { 'a' },\n  bytes: Uint8Array(2) [ 1, 2 ],\n  self: [Circular *1]\n}"
    );
    expect(util.inspect(custom)).toBe('custom view');
    expect(util.inspect(deep)).toBe('{ a: { b: { c: [Object] } } }');
    expect(util.inspect(deep, { depth: 0 })).toBe('{ a: [Object] }');
    expect(util.inspect(deep, false, null)).toBe('{\n  a: { b: { c: { d: 1 } } }\n}');
    for (const value of [cyclic, custom, deep, new Map([['k', new Error('boom').message]])]) {
      expect(util.inspect(value)).toBe(inspect(value));
      nodeConsole.log(value);
      expect(lines.pop()).toBe(`${inspect(value)}\n`);
    }
  });

  test('querystring owns parse, stringify, escaping, and default namespace behavior', () => {
    const querystring = createQuerystringBuiltin() as {
      parse(input: string, sep?: string, eq?: string): Record<string, string | string[]>;
      stringify(input: Record<string, unknown>, sep?: string, eq?: string): string;
      escape(input: string): string;
      unescape(input: string): string;
      unescapeBuffer(input: string): Uint8Array & { toString(encoding?: string): string };
      default: {
        parse: unknown;
        stringify: unknown;
      };
    };

    expect(querystring.parse('name=mimic%20runtime&tag=one&tag=two')).toEqual({
      name: 'mimic runtime',
      tag: ['one', 'two']
    });
    expect(querystring.stringify({ name: 'mimic runtime', tag: ['one', 'two'] })).toBe(
      'name=mimic%20runtime&tag=one&tag=two'
    );
    expect(querystring.escape('mimic runtime')).toBe('mimic%20runtime');
    expect(querystring.unescape('mimic+runtime')).toBe('mimic runtime');
    expect(querystring.unescapeBuffer('mimic+runtime').toString()).toBe('mimic runtime');
    expect(querystring.default.parse).toBe(querystring.parse);
    expect(querystring.default.stringify).toBe(querystring.stringify);
  });

  test('util owns the supported utility contract and default namespace export shape', async () => {
    const warnings: string[] = [];
    const errors: string[] = [];
    const util = createUtilBuiltin({
      warn(message: unknown) {
        warnings.push(String(message));
      },
      error(message: unknown) {
        errors.push(String(message));
      }
    }, { env: { NODE_DEBUG: 'avvio' }, pid: 42 }) as {
      callbackify<TArgs extends unknown[], TResult>(
        fn: (...args: TArgs) => Promise<TResult>
      ): (...args: [...TArgs, (error: unknown, value?: TResult) => void]) => void;
      promisify<TArgs extends unknown[], TResult>(
        fn: (...args: [...TArgs, (error: unknown, value?: TResult) => void]) => void
      ): (...args: TArgs) => Promise<TResult>;
      parseEnv(content: string): Record<string, string>;
      inherits(ctor: Function & { super_?: Function }, superCtor: Function & { prototype: object }): void;
      inspect: ((value: unknown) => string) & {
        colors: Readonly<Record<string, readonly [number, number]>>;
      };
      format(message: unknown, ...values: unknown[]): string;
      styleText(format: string | readonly string[], text: string, options?: { validateStream?: boolean }): string;
      deprecate<T extends (...args: unknown[]) => unknown>(fn: T, message: string): T;
      debuglog(section: string): ((message: unknown, ...values: unknown[]) => void) & { enabled: boolean };
      types: {
        isArrayBuffer(value: unknown): value is ArrayBuffer;
        isArrayBufferView(value: unknown): boolean;
        isDataView(value: unknown): boolean;
        isDate(value: unknown): value is Date;
        isNativeError(value: unknown): boolean;
        isTypedArray(value: unknown): boolean;
        isUint8Array(value: unknown): value is Uint8Array;
      };
      default: {
        callbackify: unknown;
        promisify: unknown;
        inherits: unknown;
        inspect: unknown;
        format: unknown;
      };
    };

    const callbackValue = await util.promisify((value: string, callback) => callback(null, `value:${value}`))('ok');
    const callbackifiedValue = await new Promise<string>((resolve, reject) => {
      util.callbackify(async (value: string) => `callbackified:${value}`)('ok', (error, value) => {
        if (error) reject(error);
        else resolve(value!);
      });
    });
    function Parent() {}
    Parent.prototype.kind = 'parent';
    function Child() {}
    util.inherits(Child, Parent);
    const deprecated = util.deprecate((value: string) => value.toUpperCase(), 'use the replacement');
    const debug = util.debuglog('avvio');

    expect(callbackValue).toBe('value:ok');
    expect(callbackifiedValue).toBe('callbackified:ok');
    // `is-file-esm` reaches `callbackify(require('read-pkg-up')).sync`.
    async function readUp(_options?: unknown) {
      return 'found';
    }
    readUp.sync = () => 'found synchronously';
    const callbackifiedReadUp = util.callbackify(readUp) as unknown as typeof readUp;
    expect(callbackifiedReadUp.sync()).toBe('found synchronously');
    expect(callbackifiedReadUp.name).toBe('readUpCallbackified');
    expect(callbackifiedReadUp.length).toBe(2);
    // webpack 3's loaders still merge options with the deprecated util._extend.
    const extend = (util as unknown as { _extend(target: object, source: unknown): object })._extend;
    expect(extend({ keep: 1, over: 1 }, { over: 2, added: 3 })).toEqual({ keep: 1, over: 2, added: 3 });
    expect(extend({ keep: 1 }, null)).toEqual({ keep: 1 });
    expect(new Child()).toBeInstanceOf(Parent);
    expect(util.inspect({ alpha: 1 })).toBe('{ alpha: 1 }');
    expect(util.inspect.colors.red).toEqual([31, 39]);
    expect(Object.keys(util.inspect.colors)).toContain('bold');
    expect(util.format('value:%s:%d', 'ok', 7)).toBe('value:ok:7');
    expect(util.parseEnv([
      '# ignored',
      'PLAIN = value',
      'export QUOTED="line\\nvalue"',
      "HASH='value # kept'",
      'EMPTY=',
      'PLAIN=last'
    ].join('\n'))).toEqual({
      PLAIN: 'last',
      QUOTED: 'line\nvalue',
      HASH: 'value # kept',
      EMPTY: ''
    });
    expect(util.styleText('red', 'message')).toBe('message');
    expect(util.styleText('red', 'message', { validateStream: true })).toBe('message');
    expect(util.styleText('red', 'message', { validateStream: false })).toBe('\u001B[31mmessage\u001B[0m');
    expect(util.types.isUint8Array(new Uint8Array([1, 2, 3]))).toBe(true);
    expect(util.types.isUint8Array(new ArrayBuffer(3))).toBe(false);
    expect(util.types.isArrayBuffer(new ArrayBuffer(3))).toBe(true);
    expect(util.types.isArrayBufferView(new Uint16Array(2))).toBe(true);
    expect(util.types.isDataView(new DataView(new ArrayBuffer(2)))).toBe(true);
    expect(util.types.isDate(new Date())).toBe(true);
    expect(util.types.isDate('2026-07-16')).toBe(false);
    expect(util.types.isNativeError(new Error('failure'))).toBe(true);
    expect(util.types.isTypedArray(new DataView(new ArrayBuffer(2)))).toBe(false);
    expect(createUtilTypesBuiltin().isUint8Array(new Uint8Array(1))).toBe(true);
    expect(deprecated('first')).toBe('FIRST');
    expect(deprecated('second')).toBe('SECOND');
    expect(debug.enabled).toBe(true);
    debug('value:%s:%d', 'ok', 7);
    expect(warnings).toEqual(['DeprecationWarning: use the replacement']);
    expect(errors).toEqual(['AVVIO 42: value:ok:7']);
    expect(util.default.promisify).toBe(util.promisify);
    expect(util.default.callbackify).toBe(util.callbackify);
    expect(util.default.inherits).toBe(util.inherits);
    expect(util.default.inspect).toBe(util.inspect);
    expect(util.default.format).toBe(util.format);
  });
});

type AssertionFailure = Error & { code: string; actual?: unknown; expected?: unknown; operator?: string; generatedMessage: boolean };

type AssertMethods = {
  AssertionError: new (options: { actual?: unknown; expected?: unknown; operator?: string; message?: string }) => AssertionFailure;
  ok(value?: unknown, message?: string | Error): void;
  fail(message?: string | Error): never;
  equal(actual: unknown, expected: unknown, message?: string | Error): void;
  notEqual(actual: unknown, expected: unknown, message?: string | Error): void;
  strictEqual(actual: unknown, expected: unknown, message?: string | Error): void;
  notStrictEqual(actual: unknown, expected: unknown, message?: string | Error): void;
  deepEqual(actual: unknown, expected: unknown, message?: string | Error): void;
  notDeepEqual(actual: unknown, expected: unknown, message?: string | Error): void;
  deepStrictEqual(actual: unknown, expected: unknown, message?: string | Error): void;
  notDeepStrictEqual(actual: unknown, expected: unknown, message?: string | Error): void;
  throws(block: () => unknown, expected?: unknown, message?: string | Error): void;
  doesNotThrow(block: () => unknown, expected?: unknown, message?: string | Error): void;
  rejects(block: PromiseLike<unknown> | (() => PromiseLike<unknown>), expected?: unknown, message?: string | Error): Promise<void>;
  doesNotReject(block: PromiseLike<unknown> | (() => PromiseLike<unknown>), expected?: unknown, message?: string | Error): Promise<void>;
  ifError(value: unknown): void;
  match(value: unknown, pattern: RegExp, message?: string | Error): void;
  doesNotMatch(value: unknown, pattern: RegExp, message?: string | Error): void;
  strict: AssertBuiltin;
  default: AssertBuiltin;
};

type AssertBuiltin = ((value?: unknown, message?: string | Error) => void) & AssertMethods;

type ParseArgsOption = { type: 'string' | 'boolean'; short?: string; multiple?: boolean; default?: string | boolean | string[] };

type UtilBuiltin = {
  promisify: (<T extends (...args: never[]) => unknown>(fn: T) => (...args: unknown[]) => Promise<unknown>) & { custom: symbol };
  deprecate<T extends Function>(fn: T, message: string, code?: string): T;
  inspect: ((value: unknown, options?: object | boolean, depth?: number | null) => string) & { custom: symbol };
  isDeepStrictEqual(actual: unknown, expected: unknown): boolean;
  parseArgs(config?: {
    args?: string[];
    options?: Record<string, ParseArgsOption>;
    strict?: boolean;
    allowPositionals?: boolean;
    allowNegative?: boolean;
    tokens?: boolean;
  }): { values: Record<string, unknown>; positionals: string[]; tokens?: object[] };
  types: Record<string, (value: unknown) => boolean>;
};

describe('Node Compatibility builtins of other process models', () => {
  test('domain routes the errors of what it runs, binds and intercepts to its error listeners', () => {
    const domain = createDomainBuiltin() as {
      create(): EventEmitter & {
        run(callback: () => unknown): unknown;
        bind<T extends (...args: never[]) => unknown>(callback: T): T;
        intercept<T extends (...args: never[]) => unknown>(callback: T): (error: unknown, ...args: unknown[]) => unknown;
      };
      active: unknown;
    };
    const handled: unknown[] = [];
    const scope = domain.create();
    scope.on('error', (error: unknown) => handled.push((error as Error).message));

    expect(scope.run(() => domain.active === scope)).toBe(true);
    expect(domain.active).toBeUndefined();
    scope.run(() => {
      throw new Error('ran');
    });
    scope.bind(() => {
      throw new Error('bound');
    })();
    const intercepted = scope.intercept((value: unknown) => value);
    expect(intercepted(null, 'passed')).toBe('passed');
    intercepted(new Error('intercepted'));

    expect(handled).toEqual(['ran', 'bound', 'intercepted']);
    expect(() => domain.create().run(() => {
      throw new Error('unhandled');
    })).toThrow('unhandled');
  });

  test('punycode converts domain names as Node does', () => {
    const punycode = createPunycodeBuiltin() as { toASCII(value: string): string; toUnicode(value: string): string };
    expect(punycode.toASCII('mañana.com')).toBe('xn--maana-pta.com');
    expect(punycode.toUnicode('xn--maana-pta.com')).toBe('mañana.com');
  });

  test('a cluster primary forks each worker as a child process with its id, and relays its messages and exit', async () => {
    const forked: Array<{ modulePath: string; args: readonly string[]; options: Record<string, unknown> }> = [];
    const children: Array<ClusterChildProcess & { sent: unknown[] }> = [];
    const parent = Object.assign(new EventEmitter(), {
      env: { PATH: '/bin' },
      argv: ['/usr/local/bin/node', '/home/project/main.js', '--watch'],
      execArgv: ['--inspect=0']
    }) as unknown as ClusterProcess;
    type Cluster = EventEmitter & {
      isPrimary: boolean;
      isWorker: boolean;
      workers: Record<number, { id: number; send(message: unknown): boolean; kill(): void; isDead(): boolean }>;
      setupPrimary(settings: object): void;
      fork(env?: Record<string, string>): EventEmitter & { id: number; send(message: unknown): boolean };
    };
    const cluster = createClusterBuiltin({
      process: parent,
      fork(modulePath, args, options) {
        forked.push({ modulePath, args, options });
        const child = Object.assign(new EventEmitter(), {
          pid: 50 + children.length,
          connected: true,
          exitCode: null,
          signalCode: null,
          sent: [] as unknown[],
          send(message: unknown) {
            child.sent.push(message);
            return true;
          },
          kill: () => true,
          disconnect: () => undefined
        });
        children.push(child as unknown as ClusterChildProcess & { sent: unknown[] });
        return child as unknown as ClusterChildProcess;
      }
    }) as Cluster;
    const events: unknown[] = [];
    cluster.on('online', (worker: { id: number }) => events.push(['online', worker.id]));
    cluster.on('message', (worker: { id: number }, message: unknown) => events.push(['message', worker.id, message]));
    cluster.on('exit', (worker: { id: number }, code: number) => events.push(['exit', worker.id, code]));

    cluster.setupPrimary({ exec: '/home/project/worker.js' });
    const first = cluster.fork({ ROLE: 'compile' });
    const second = cluster.fork();
    first.send({ task: 'a' });
    children[0]!.emit('spawn');
    children[0]!.emit('message', { done: 'a' });
    children[1]!.emit('exit', 0, null);

    expect(cluster).toMatchObject({ isPrimary: true, isWorker: false });
    expect(forked[0]).toEqual({
      modulePath: '/home/project/worker.js',
      args: ['--watch'],
      options: {
        env: { PATH: '/bin', ROLE: 'compile', NODE_UNIQUE_ID: '1' },
        execArgv: ['--inspect=0'],
        silent: false
      }
    });
    expect(forked[1]?.options.env).toEqual({ PATH: '/bin', NODE_UNIQUE_ID: '2' });
    expect(children[0]!.sent).toEqual([{ task: 'a' }]);
    expect(events).toEqual([['online', 1], ['message', 1, { done: 'a' }], ['exit', 2, 0]]);
    expect(Object.keys(cluster.workers)).toEqual(['1']);
    expect(second.id).toBe(2);
  });

  test('a process forked with NODE_UNIQUE_ID is a cluster worker whose messages are its own', () => {
    const sent: unknown[] = [];
    const self = Object.assign(new EventEmitter(), {
      env: { NODE_UNIQUE_ID: '3' },
      argv: ['/usr/local/bin/node', '/home/project/worker.js'],
      send: (message: unknown) => sent.push(message) > 0
    }) as unknown as ClusterProcess;
    const cluster = createClusterBuiltin({
      process: self,
      fork: () => {
        throw new Error('a worker forks no workers');
      }
    }) as { isPrimary: boolean; isWorker: boolean; worker: EventEmitter & { id: number; send(message: unknown): boolean } };
    const received: unknown[] = [];
    cluster.worker.on('message', (message: unknown) => received.push(message));

    (self as unknown as EventEmitter).emit('message', { task: 'b' });
    cluster.worker.send({ done: 'b' });

    expect(cluster).toMatchObject({ isPrimary: false, isWorker: true, worker: { id: 3 } });
    expect(received).toEqual([{ task: 'b' }]);
    expect(sent).toEqual([{ done: 'b' }]);
  });

  test('a UDP socket binds as in Node, receives nothing, and every datagram it sends fails with ENOTSUP', async () => {
    type Socket = EventEmitter & {
      bind(port?: number, callback?: () => void): Socket;
      send(message: string, port: number, address: string, callback?: (error: Error | null) => void): void;
      close(callback?: () => void): Socket;
      address(): unknown;
      setMulticastTTL(ttl: number): void;
      addMembership(group: string): void;
      setSendBufferSize(size: number): void;
      getSendBufferSize(): number;
      unref(): Socket;
    };
    const dgram = createDgramBuiltin() as {
      createSocket(options: string | { type: string; reuseAddr?: boolean }): Socket;
    };
    expect(() => dgram.createSocket('tcp')).toThrow(expect.objectContaining({ code: 'ERR_SOCKET_BAD_TYPE' }));

    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    expect(socket.unref()).toBe(socket);
    expect(() => socket.setMulticastTTL(255)).toThrow(
      expect.objectContaining({ code: 'EBADF', syscall: 'setMulticastTTL' })
    );
    expect(() => socket.address()).toThrow(expect.objectContaining({ code: 'EBADF', syscall: 'getsockname' }));
    await new Promise<void>((resolve) => socket.bind(5353, resolve));
    expect(socket.address()).toEqual({ address: '0.0.0.0', family: 'IPv4', port: 5353 });
    expect(() => socket.bind(0)).toThrow(expect.objectContaining({ code: 'ERR_SOCKET_ALREADY_BOUND' }));
    socket.setMulticastTTL(255);
    socket.setSendBufferSize(548);
    expect(socket.getSendBufferSize()).toBe(548);
    expect(() => socket.addMembership('224.0.0.251')).toThrow(
      expect.objectContaining({ code: 'ENOTSUP', syscall: 'addMembership' })
    );
    await expect(new Promise((resolve) => socket.send('ping', 5353, '224.0.0.251', resolve))).resolves.toMatchObject({
      message: 'send ENOTSUP 224.0.0.251:5353',
      code: 'ENOTSUP',
      errno: -95,
      syscall: 'send',
      address: '224.0.0.251',
      port: 5353
    });

    // Without a callback, the failure is the socket's error event; an unbound socket binds first.
    const sender = dgram.createSocket('udp6');
    const failed = new Promise((resolve) => sender.once('error', resolve));
    sender.send('ping', 5353, 'ff02::fb');
    await expect(failed).resolves.toMatchObject({ code: 'ENOTSUP', syscall: 'send', address: 'ff02::fb' });
    expect(sender.address()).toMatchObject({ address: '::', family: 'IPv6' });

    const closed = new Promise((resolve) => socket.close(() => resolve('closed')));
    expect(() => socket.close()).toThrow(expect.objectContaining({ code: 'ERR_SOCKET_DGRAM_NOT_RUNNING' }));
    await expect(closed).resolves.toBe('closed');
  });

  test('repl names what it lacks, and trace_events records nothing', () => {
    expect(() => (createReplBuiltin() as { start(): unknown }).start()).toThrow(
      expect.objectContaining({ code: 'ERR_NOT_SUPPORTED' })
    );
    const tracing = (createTraceEventsBuiltin() as {
      createTracing(options: { categories: string[] }): { enabled: boolean; categories: string; enable(): void };
    }).createTracing({ categories: ['node', 'v8'] });
    tracing.enable();
    expect(tracing).toMatchObject({ enabled: true, categories: 'node,v8' });
  });
});

describe('node:perf_hooks', () => {
  type Histogram = {
    count: number;
    min: number;
    max: number;
    mean: number;
    stddev: number;
    percentile(percentile: number): number;
    percentiles: Map<number, number>;
  };
  type PerfHooks = {
    performance: { eventLoopUtilization(first?: object, second?: object): { idle: number; active: number; utilization: number } };
    createHistogram(): Histogram & { record(value: number): void; add(other: unknown): void };
    monitorEventLoopDelay(options: { resolution: number }): Histogram & { enable(): boolean; disable(): boolean };
  };

  /** A global whose clock and interval timer the test drives. */
  function drivenGlobal() {
    let now = 0;
    let tick: (() => void) | undefined;
    const runtimeGlobal = {
      performance: { now: () => now },
      setInterval: (callback: () => void) => {
        tick = callback;
        return { unref: () => undefined };
      },
      clearInterval: () => {
        tick = undefined;
      }
    } as unknown as typeof globalThis;
    return {
      perfHooks: createPerfHooksBuiltin(runtimeGlobal) as PerfHooks,
      runAt(time: number) {
        now = time;
        tick?.();
      },
      setNow(time: number) {
        now = time;
      }
    };
  }

  test('monitorEventLoopDelay records the whole time between its timer runs, as Node does', () => {
    const { perfHooks, runAt } = drivenGlobal();
    const delay = perfHooks.monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    for (const time of [10.05, 20.15, 30.3, 40.4]) runAt(time);
    delay.disable();

    // The first run only starts the measurement; a loop that never waits records about the resolution.
    expect(delay.count).toBe(3);
    expect(delay.min / 1e6).toBeCloseTo(10.1, 1);
    expect(delay.mean / 1e6).toBeCloseTo(10.12, 1);
    expect(delay.max / 1e6).toBeCloseTo(10.15, 1);
  });

  test("a histogram counts values in buckets and reports Node's statistics of them", () => {
    const { perfHooks } = drivenGlobal();
    const small = perfHooks.createHistogram();
    for (const value of [5, 1, 3, 2, 4]) small.record(value);
    const large = perfHooks.createHistogram();
    for (const value of [1000001, 2000003, 3000007, 123456789]) large.record(value);

    expect([small.count, small.min, small.max, small.mean, small.percentile(50)]).toEqual([5, 1, 5, 3, 3]);
    expect(small.stddev).toBeCloseTo(Math.SQRT2, 10);
    expect([...small.percentiles]).toEqual([[0, 1], [50, 3], [75, 4], [87.5, 5], [100, 5]]);
    // Node's answers, from the buckets of its HDR histogram of 3 significant figures.
    expect([large.min, large.max, large.mean, large.percentile(50), large.percentile(100)]).toEqual([
      999936, 123469823, 32359232, 2000895, 123469823
    ]);
    expect(large.stddev).toBeCloseTo(52588556.04622496, 3);
    expect([...large.percentiles]).toEqual([
      [0, 999936],
      [50, 1999872],
      [75, 2998272],
      [87.5, 123404288],
      [100, 123404288]
    ]);

    // Many values in one range take no more room than a few.
    const many = perfHooks.createHistogram();
    for (let index = 0; index < 200_000; index += 1) many.record(10_000_000 + (index % 1000) * 100);
    many.add(large);
    expect(many.count).toBe(200_004);
    expect(many.percentile(50)).toBe(10_051_583);
    expect(many.max).toBe(123469823);
  });

  test('eventLoopUtilization does not report a saturated loop it cannot measure', () => {
    const { perfHooks, setNow } = drivenGlobal();
    setNow(100);
    const start = perfHooks.performance.eventLoopUtilization();
    setNow(250);
    const since = perfHooks.performance.eventLoopUtilization(start);

    expect(start.utilization).toBe(0);
    expect(since).toEqual({ idle: 150, active: 0, utilization: 0 });
  });
});

describe('node:url file URLs', () => {
  test('pathToFileURL resolves against the working directory, keeps a directory slash and escapes URL syntax', () => {
    const url = createUrlBuiltin(() => '/home/project') as {
      pathToFileURL(path: string): URL;
      fileURLToPath(url: string | URL): string;
    };

    expect(url.pathToFileURL('/home/project/').href).toBe('file:///home/project/');
    expect(url.pathToFileURL('src/a b#c?d%e.js').href).toBe('file:///home/project/src/a%20b%23c%3Fd%25e.js');
    expect(new URL('./node_modules/x/', url.pathToFileURL('/home/project/')).href).toBe(
      'file:///home/project/node_modules/x/'
    );
    expect(url.fileURLToPath(url.pathToFileURL('/tmp/a#b'))).toBe('/tmp/a#b');
    expect(() => url.fileURLToPath('file://host/x')).toThrow(expect.objectContaining({ code: 'ERR_INVALID_FILE_URL_HOST' }));
    expect(() => url.fileURLToPath('https://example.com/')).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_URL_SCHEME' })
    );
  });
});

describe('console.Console', () => {
  test('a subclass keeps its own methods and reaches the originals through super, as Jest consoles do', () => {
    const written: string[] = [];
    const { Console } = createNodeConsole({ stdout: { write: (chunk: string) => written.push(chunk) } });
    class BufferedConsole extends (Console as unknown as new (stream: { write(chunk: string): unknown }) => {
      log(...values: unknown[]): void;
    }) {
      readonly buffer: string[] = [];
      override log(...values: unknown[]): void {
        this.buffer.push(values.join(' '));
        super.log('forwarded', ...values);
      }
      getBuffer(): string[] {
        return this.buffer;
      }
    }

    const instance = new BufferedConsole({ write: (chunk: string) => written.push(chunk) });
    const { log } = instance;
    log('detached', 1);

    expect(instance.getBuffer()).toEqual(['detached 1']);
    expect(written).toEqual(['forwarded detached 1\n']);
    expect(instance).toBeInstanceOf(Console);
  });
});
