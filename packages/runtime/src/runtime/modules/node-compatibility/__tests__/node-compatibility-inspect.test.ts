import { describe, expect, test } from 'vitest';

import { BrowserBuffer } from '../buffer';
import { format, inspect } from '../inspect';

const inspectCustomSymbol = Symbol.for('nodejs.util.inspect.custom');

describe('util.inspect', () => {
  test.each([
    [undefined, 'undefined'],
    [null, 'null'],
    [-0, '-0'],
    [10n, '10n'],
    ['text', "'text'"],
    ["it's", `"it's"`],
    ['line\nbreak', "'line\\nbreak'"],
    [Symbol('s'), 'Symbol(s)'],
    [[], '[]'],
    [{}, '{}'],
    [[1, 'two', [3]], "[ 1, 'two', [ 3 ] ]"],
    [{ a: 1, 'b-c': { d: [] } }, "{ a: 1, 'b-c': { d: [] } }"],
    [{ a: { b: { c: { d: 1 } } } }, '{ a: { b: { c: [Object] } } }'],
    [new Map([['k', { v: 1 }]]), "Map(1) { 'k' => { v: 1 } }"],
    [new Set([1, 'a']), "Set(2) { 1, 'a' }"],
    [new Date(0), '1970-01-01T00:00:00.000Z'],
    [/a+/gi, '/a+/gi'],
    [function named() {}, '[Function: named]'],
    [() => undefined, '[Function (anonymous)]'],
    [async function later() {}, `[${'Async'}Function: later]`],
    [class Shape {}, '[class Shape]'],
    [new (class Point { x = 1; })(), 'Point { x: 1 }'],
    [Object.create(null), '[Object: null prototype] {}'],
    [new Uint8Array([1, 2]), 'Uint8Array(2) [ 1, 2 ]'],
    [BrowserBuffer.from('hi'), '<Buffer 68 69>'],
    [[1, , 3], '[ 1, <1 empty item>, 3 ]'],
    [Object.assign([1], { extra: true }), '[ 1, extra: true ]'],
    [{ get value() { return 1; } }, '{ value: [Getter] }'],
    [{ [Symbol('key')]: 1 }, '{ [Symbol(key)]: 1 }'],
    [new Number(3), '[Number: 3]']
  ])('formats value %#', (value, expected) => {
    expect(inspect(value)).toBe(expected);
  });

  test('formats collections, dates, errors and typed arrays the way Node prints them', () => {
    const nested = new Map<unknown, unknown>([['a', 1], [{ k: 1 }, new Set([1, 'two'])]]);

    expect(inspect(nested)).toBe("Map(2) { 'a' => 1, { k: 1 } => Set(2) { 1, 'two' } }");
    expect(inspect(new Set([[1, 2], { a: 1 }]))).toBe('Set(2) { [ 1, 2 ], { a: 1 } }');
    expect(inspect(new Date(NaN))).toBe('Invalid Date');
    expect(inspect(new Float64Array([1.5, -0]))).toBe('Float64Array(2) [ 1.5, -0 ]');
    expect(inspect(new BigInt64Array([1n]))).toBe('BigInt64Array(1) [ 1n ]');
    expect(inspect(new Map([[new Map([[1, { a: { b: { c: 1 } } }]]), 1]]))).toBe(
      'Map(1) { Map(1) { 1 => { a: [Object] } } => 1 }'
    );
    expect(inspect(new Map([['k', [1, [2, [3]]]]]), { depth: 0 })).toBe("Map(1) { 'k' => [Array] }");
    expect(inspect({ a: { b: { c: { d: 1 } } } }, { depth: null })).toBe('{\n  a: { b: { c: { d: 1 } } }\n}');
    const failure = new RangeError('out of range');
    expect(inspect(failure)).toBe(failure.stack);
    expect(inspect({ [inspectCustomSymbol]: (depth: number) => ({ remaining: depth }) })).toBe('{ remaining: 2 }');
  });

  test('marks circular references', () => {
    const value: Record<string, unknown> = { name: 'root' };
    value.self = value;

    expect(inspect(value)).toBe("<ref *1> { name: 'root', self: [Circular *1] }");
  });

  test('breaks entries that do not fit on one line and groups long arrays into columns', () => {
    const wide = { first: 'a'.repeat(30), second: 'b'.repeat(30), third: 'c'.repeat(30) };

    expect(inspect(wide)).toBe(
      ['{', `  first: '${'a'.repeat(30)}',`, `  second: '${'b'.repeat(30)}',`, `  third: '${'c'.repeat(30)}'`, '}'].join('\n')
    );
    expect(inspect(Array.from({ length: 30 }, (_, index) => index))).toBe(
      [
        '[',
        '   0,  1,  2,  3,  4,  5,  6,  7,  8,',
        '   9, 10, 11, 12, 13, 14, 15, 16, 17,',
        '  18, 19, 20, 21, 22, 23, 24, 25, 26,',
        '  27, 28, 29',
        ']'
      ].join('\n')
    );
    expect(inspect(Array.from({ length: 120 }, () => 0), { breakLength: Infinity })).toContain('... 20 more items');
  });

  test('prints an error as its stack followed by its own properties', () => {
    const error = Object.assign(new Error('failed'), { code: 'E_FAILED' });
    error.stack = 'Error: failed\n    at frame';

    expect(inspect(error)).toBe("Error: failed\n    at frame {\n  code: 'E_FAILED'\n}");
    expect(inspect({ error: Object.assign(new RangeError('deep'), { stack: 'RangeError: deep\n    at frame' }) })).toBe(
      '{\n  error: RangeError: deep\n      at frame\n}'
    );
  });

  test('honours depth, colors, showHidden, and a custom inspect function', () => {
    const nested = { a: { b: { c: {} } } };

    expect(inspect(nested, { depth: 0 })).toBe('{ a: [Object] }');
    expect(inspect({ a: { b: { c: { d: { e: 1 } } } } }, { depth: null })).toBe(
      '{\n  a: {\n    b: { c: { d: { e: 1 } } }\n  }\n}'
    );
    expect(inspect({ n: 1, s: 'x' }, { colors: true })).toBe("{ n: \u001B[33m1\u001B[39m, s: \u001B[32m'x'\u001B[39m }");
    expect(inspect([1], { showHidden: true })).toBe('[ 1, [length]: 1 ]');
    expect(inspect({ [inspectCustomSymbol]: (depth: number) => `custom at ${depth}` })).toBe('custom at 2');
    expect(inspect({ [inspectCustomSymbol]: () => 'ignored' }, { customInspect: false })).toBe(
      '{\n  [Symbol(nodejs.util.inspect.custom)]: [Function: [nodejs.util.inspect.custom]]\n}'
    );
  });
});

describe('util.format', () => {
  test.each([
    [['%d items %s', 3, 'x'], '3 items x'],
    [['%s', { a: { b: 1 } }], '{ a: [Object] }'],
    [['%s', { toString: () => 'own' }], 'own'],
    [['%s %s', 5n, Symbol('s')], '5n Symbol(s)'],
    [['%i %f', '42.9px', '1.5em'], '42 1.5'],
    [['%d', '0x10'], '16'],
    [['%j', { a: [1] }], '{"a":[1]}'],
    [['%O', { a: 'b' }], "{ a: 'b' }"],
    [['%o', [1]], '[ 1, [length]: 1 ]'],
    [['%c styled', 'color: red'], ' styled'],
    [['100%% of %s', 'it'], '100% of it'],
    [['%s'], '%s'],
    [['%s %s', 'only'], 'only %s'],
    [['%x', 1], '%x 1'],
    [['a', 'b', { c: 1 }, 2], 'a b { c: 1 } 2'],
    [[{ a: 1 }, 'text'], '{ a: 1 } text'],
    [[1, 'text'], '1 text'],
    [[], '']
  ])('formats arguments %#', (args, expected) => {
    expect(format(...args)).toBe(expected);
  });

  test('%j reports a circular value instead of throwing', () => {
    const value: Record<string, unknown> = {};
    value.self = value;

    expect(format('%j', value)).toBe('[Circular]');
  });
});
