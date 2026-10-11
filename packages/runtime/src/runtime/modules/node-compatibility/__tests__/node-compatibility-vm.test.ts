import { describe, expect, test } from 'vitest';

import { compileFunctionInScopes, evaluateInScopes } from '../../module-execution-engine';
import { createVmBuiltin, topLevelDeclarations } from '../vm';

type Context = Record<string, unknown>;
type VmBuiltin = {
  readonly Script: new (code: string, options?: { readonly filename?: string }) => {
    runInContext(context: object): unknown;
    runInNewContext(context?: object): unknown;
    runInThisContext(options?: { readonly filename?: string }): unknown;
  };
  readonly compileFunction: (
    code: string,
    params?: readonly string[],
    options?: { parsingContext?: object; contextExtensions?: readonly object[] }
  ) => (...args: unknown[]) => unknown;
  readonly createContext: <T extends object>(context?: T) => T;
  readonly default: VmBuiltin;
  readonly isContext: (context: unknown) => boolean;
  readonly runInContext: (code: string, context: object, options?: { readonly filename?: string }) => unknown;
  readonly runInNewContext: (code: string, context?: object, options?: { readonly filename?: string }) => unknown;
  readonly runInThisContext: (code: string, options?: { readonly filename?: string }) => unknown;
};

const realVm = () =>
  createVmBuiltin({ evaluate: (source) => (0, eval)(source), evaluateInScopes, compileFunctionInScopes }) as VmBuiltin;

describe('node:vm compatibility builtin', () => {
  test('evaluates current-context source through the engine evaluator and preserves filename options', () => {
    const vm = createVmBuiltin({
      evaluate(source, options) {
        return `${options?.filename ?? 'default'}:${source}`;
      }
    }) as VmBuiltin;

    expect(vm.runInThisContext('module.exports = 42', { filename: 'entry.cjs' })).toBe('entry.cjs:module.exports = 42');
    expect(new vm.Script('answer + 1', { filename: 'answer.js' }).runInThisContext()).toBe('answer.js:answer + 1');
    expect(new vm.Script('answer + 1').runInThisContext({ filename: 'override.js' })).toBe('override.js:answer + 1');
  });

  test('runs a script against a contextified object: its globals, declarations and assignments are the object\'s', () => {
    const vm = realVm();
    const context = vm.createContext<Context>({ a: 1, b: 2 });

    expect(vm.runInContext('a + b', context)).toBe(3);
    vm.runInContext('var x = a * 10; function f() { return x + 1 } y = 5; let z = 9;', context);

    expect(context.x).toBe(10);
    expect((context.f as () => number)()).toBe(11);
    expect(context.y).toBe(5);
    expect('z' in context).toBe(false);
    expect((globalThis as Context).y).toBeUndefined();
    expect((vm.runInContext('this', context) as Context).a).toBe(1);
    expect(vm.runInContext('globalThis.b', context)).toBe(2);
    expect(vm.runInContext('new Error("x") instanceof Error && Array.isArray([])', context)).toBe(true);
    expect(vm.isContext(context)).toBe(true);
    expect(vm.isContext({})).toBe(false);
  });

  test('a new context has the language\'s globals and none of the host\'s', () => {
    const vm = realVm();

    expect(vm.runInNewContext('typeof Object + typeof process + typeof setTimeout')).toBe('functionundefinedundefined');
    expect(vm.runInNewContext('n * 2', { n: 21 })).toBe(42);
  });

  test('Scripts and compiled functions run in the context they are given', () => {
    const vm = realVm();
    const context = vm.createContext<Context>({ base: 1 });
    const script = new vm.Script('counter = (typeof counter === "number" ? counter : 0) + base');
    script.runInContext(context);
    script.runInContext(context);

    const compiled = vm.compileFunction('return [base, value, typeof missing]', ['value'], { parsingContext: context });
    const extended = vm.compileFunction('return extension', [], { contextExtensions: [{ extension: 'from extension' }] });

    expect(context.counter).toBe(2);
    expect(compiled(7)).toEqual([1, 7, 'undefined']);
    expect(extended()).toBe('from extension');
  });

  test('rejects an object that was never contextified', () => {
    const vm = realVm();

    expect(() => vm.runInContext('1', {})).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    expect(() => new vm.Script('1').runInContext({})).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
  });

  test('finds the names a script declares outside any block', () => {
    expect([
      ...topLevelDeclarations(
        'var a = 1; function b() { var c } "var d"; // var e\nfor (var i = 0;;) {} async function g() {} function* h() {}'
      )
    ]).toEqual(['a', 'b', 'i', 'g', 'h']);
  });
});
