import * as Babel from '../../src/runtime/modules/runtime-host/runtime-artifact-compiler-babel';
import { describe, expect, test } from 'vitest';

import {
  INLINE_NODE_MODULE_ENTRY,
  createModuleExecutionEngine,
  createRuntimeArtifactTranslator,
  type ModuleAccess,
  type ModuleCustomizationRegistrationOptions,
  type ModuleExecutionConsole,
  type ModuleExecutionProcess,
  type NodeModuleAccess
} from '../../src/runtime/modules/module-execution-engine';

const compile = createRuntimeArtifactTranslator(Babel);

describe('Module Execution Engine', () => {
  test('imports js-tokens string-named exports with Unicode regular expressions', async () => {
    const harness = createHarness({
      '/app/package.json': '{ "type": "module" }',
      '/app/index.js': [
        'var jsTokens;',
        'jsTokens = function* () { yield "token"; };',
        'export default jsTokens;',
        'export { jsTokens as "module.exports" };'
      ].join('\n')
    });

    const imported = await harness.engine.import('./index.js', '/app');

    expect(imported.default).toBe(imported['module.exports']);
  });

  test('allows ESM modules to own Rollup-style interop helper declarations', async () => {
    const harness = createHarness({
      '/app/package.json': '{ "type": "module" }',
      '/app/entry.js': [
        'export function getAugmentedNamespace(namespace) {',
        "  return { ...namespace, owner: 'module' };",
        '}',
        "export const result = getAugmentedNamespace({ value: 42 });"
      ].join('\n')
    });

    await expect(harness.engine.import('./entry.js', '/app')).resolves.toMatchObject({
      result: { owner: 'module', value: 42 }
    });
  });

  test('compiles namespace imports after mutable-export instrumentation compacts ESM', () => {
    const harness = createHarness(
      {
        '/app/package.json': '{ "type": "module" }',
        '/app/entry.js': [
          "import * as os from 'node:os';",
          'let counter = 0;',
          'counter += 1;',
          'export { counter };',
          'export const platform = os.platform;'
        ].join('\n')
      },
      { builtins: new Map([['node:os', { platform: 'browser' }]]) }
    );

    expect(harness.engine.require('./entry.js', '/app')).toMatchObject({
      counter: 1,
      platform: 'browser'
    });
  });

  test('compiles namespace re-exports', () => {
    const harness = createHarness({
      '/app/package.json': '{ "type": "module" }',
      '/app/foreign.js': "export const marker = 'foreign-content';",
      '/app/entry.js': "export * as foreignContent from './foreign.js';"
    });

    expect(harness.engine.require('./entry.js', '/app')).toMatchObject({
      foreignContent: { marker: 'foreign-content' }
    });
  });

  test('compiles re-exports after mutable-export instrumentation compacts ESM', () => {
    const harness = createHarness({
      '/app/package.json': '{ "type": "module" }',
      '/app/foreign.js': "export const marker = 'foreign-content';",
      '/app/entry.js': [
        'export var state;',
        'state = 1;',
        "export { marker } from './foreign.js';"
      ].join('\n')
    });

    expect(harness.engine.require('./entry.js', '/app')).toMatchObject({
      marker: 'foreign-content',
      state: 1
    });
  });

  test('allows CommonJS modules to shadow Node globals without colliding with the runtime wrapper', async () => {
    const harness = createHarness({
      '/app/entry.cjs': [
        'const global = globalThis;',
        'module.exports = global === globalThis;'
      ].join('\n')
    });

    await expect(harness.engine.runEntry('/app/entry.cjs')).resolves.toBe(true);
  });

  test('defaults package-scoped JavaScript to CommonJS when type is omitted', async () => {
    const harness = createHarness({
      '/app/package.json': '{ "name": "commonjs-package" }',
      '/app/entry.cjs': "module.exports = require('./manifest.js').manifest;",
      '/app/manifest.js': [
        "'use strict';",
        'exports.manifest = `',
        'export default { marker: true };',
        '`;'
      ].join('\n')
    });

    await expect(harness.engine.runEntry('/app/entry.cjs')).resolves.toContain(
      'export default'
    );
  });

  test('binds CommonJS postMessage to the Execution Context global', async () => {
    const runtimeGlobal = Object.create(globalThis) as typeof globalThis;
    const messages: unknown[] = [];
    runtimeGlobal.postMessage = (value: unknown) => messages.push(value);
    const harness = createHarness({
      '/app/entry.cjs': [
        'const send = postMessage;',
        "module.exports = () => send('worker-ready');"
      ].join('\n')
    }, { global: runtimeGlobal });

    const send = await harness.engine.runEntry('/app/entry.cjs');
    expect(send).toBeTypeOf('function');
    if (typeof send !== 'function') throw new Error('Expected CommonJS postMessage sender');
    send();
    expect(messages).toEqual(['worker-ready']);
  });

  test('executes inline CommonJS source through the public engine entry point', async () => {
    const harness = createHarness({
      '/app/helper.cjs': "module.exports = 'required-from-cwd';"
    });

    await expect(
      harness.engine.runCommonJsSource(
        "module.exports = { helper: require('./helper.cjs'), filename: __filename, dirname: __dirname };"
      )
    ).resolves.toEqual({
      helper: 'required-from-cwd',
      filename: '[worker eval]',
      dirname: '.'
    });
  });

  test('preserves CommonJS function source while instrumenting top-level async work', async () => {
    const source =
      'module.exports = function   preserved(value) { /* source-preserved */ return value; };';
    const harness = createHarness({ '/app/preserved.cjs': source });

    const exported = await harness.engine.runEntry('/app/preserved.cjs');

    expect(typeof exported).toBe('function');
    if (typeof exported !== 'function') throw new Error('Expected a CommonJS function export.');
    expect(exported.toString()).toBe(
      'function   preserved(value) { /* source-preserved */ return value; }'
    );
  });

  test('evicts a failed inline CommonJS record before the next public engine run', async () => {
    const harness = createHarness({});

    await expect(
      harness.engine.runCommonJsSource("throw new Error('inline failure');")
    ).rejects.toThrow('inline failure');
    await expect(
      harness.engine.runCommonJsSource('module.exports = "recovered";')
    ).resolves.toBe('recovered');
  });

  test('compiles inline Node entries with preserved process arguments', async () => {
    const identity = '/app/[eval].cjs';
    const source = "console.log(process.argv.join(','), process.execArgv.join(','));";
    const harness = createHarness(
      { [identity]: source },
      {
        argv: ['node', identity, 'application-arg'],
        inlineEntries: new Map([
          [identity, { source, execArgv: ['-e', source] }]
        ])
      }
    );

    await expect(harness.engine.runEntry(identity)).resolves.toBeDefined();

    expect(harness.logs).toEqual([['node,application-arg', `-e,${source}`]]);
  });

  test('loads Node-defined TypeScript formats', async () => {
    const harness = createHarness({
      '/app/package.json': '{ "type": "module" }',
      '/app/entry.mts': [
        "import config from './config.json' with { type: 'json' };",
        "import legacy from './legacy.cts';",
        "import packageTypedLegacy from './legacy/value.ts';",
        "import { answer } from './value.ts';",
        'export const summary: string = `${config.label}:${answer + legacy.offset + packageTypedLegacy.offset}`;'
      ].join('\n'),
      '/app/config.json': '{ "label": "formats" }',
      '/app/legacy.cts': [
        'const offset: number = 1;',
        'module.exports = { offset };'
      ].join('\n'),
      '/app/legacy/package.json': '{ "type": "commonjs" }',
      '/app/legacy/value.ts': 'const offset: number = 1;\nmodule.exports = { offset };',
      '/app/value.ts': 'export const answer: number = 41;'
    });

    await expect(harness.engine.import('./entry.mts', '/app')).resolves.toMatchObject({
      summary: 'formats:43'
    });
  });

  test('loads and caches WebAssembly modules through asynchronous import', async () => {
    const harness = createHarness({
      '/app/answer.wasm': Uint8Array.from([
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
        0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f,
        0x03, 0x02, 0x01, 0x00,
        0x07, 0x0a, 0x01, 0x06, 0x61, 0x6e, 0x73, 0x77, 0x65, 0x72, 0x00, 0x00,
        0x0a, 0x06, 0x01, 0x04, 0x00, 0x41, 0x2a, 0x0b
      ])
    });

    const first = await harness.engine.import('./answer.wasm', '/app');
    const second = await harness.engine.import('./answer.wasm', '/app');

    expect(second).toBe(first);
    expect(first.answer).toEqual(expect.any(Function));
    expect((first.answer as () => number)()).toBe(42);
    expect(() => harness.engine.require('./answer.wasm', '/app')).toThrow(
      'Cannot require WebAssembly module synchronously: /app/answer.wasm'
    );
  });

  test('resolves validated WebAssembly function imports through the module engine', async () => {
    const harness = createHarness({
      '/app/dependency.mjs': 'export function answer() { return 42; }',
      '/app/imported.wasm': Uint8Array.from([
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
        0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f,
        0x02, 0x1b, 0x01, 0x10, 0x2e, 0x2f, 0x64, 0x65, 0x70, 0x65, 0x6e, 0x64,
        0x65, 0x6e, 0x63, 0x79, 0x2e, 0x6d, 0x6a, 0x73, 0x06, 0x61, 0x6e, 0x73,
        0x77, 0x65, 0x72, 0x00, 0x00,
        0x03, 0x02, 0x01, 0x00,
        0x07, 0x08, 0x01, 0x04, 0x63, 0x61, 0x6c, 0x6c, 0x00, 0x01,
        0x0a, 0x06, 0x01, 0x04, 0x00, 0x10, 0x00, 0x0b
      ])
    });

    const imported = await harness.engine.import('./imported.wasm', '/app');

    expect(imported.call).toEqual(expect.any(Function));
    expect((imported.call as () => number)()).toBe(42);
  });

  test('reports the source location of a TypeScript compilation failure', async () => {
    const harness = createHarness({
      '/app/invalid.mts': [
        'export const valid: number = 1;',
        'export const broken: = 2;'
      ].join('\n')
    });

    await expect(harness.engine.import('./invalid.mts', '/app')).rejects.toMatchObject({
      code: 'ERR_RUNTIME_ARTIFACT_COMPILE',
      location: {
        source: '/app/invalid.mts',
        line: 2,
        column: expect.any(Number)
      }
    });
  });

  test('reports source line numbers in the stack traces programs see', async () => {
    const harness = createHarness({
      '/app/failed.mts': 'const answer: number = 42;\nthrow new Error(`failed:${answer}`);',
      '/app/failed.cjs': 'const answer = 42;\nthrow new Error(`failed:${answer}`);',
      '/app/failed.cts': 'const answer: number = 42;\n\nthrow new Error(`failed:${answer}`);',
      '/app/failed.mjs': '#!/usr/bin/env node\nconst answer = 42;\nthrow new Error(`failed:${answer}`);',
      '/app/dependency.mts': 'export const answer: number = 42;',
      '/app/failed-after-import.mts':
        "import {\n  answer\n} from './dependency.mts';\nthrow new Error(`failed:${answer}`);",
      '/app/failed-after-re-export.mts':
        "export {\n  answer\n} from './dependency.mts';\nthrow new Error('failed:re-export');",
      '/app/caught.cjs': [
        'function fail() {',
        "  throw new Error('caught');",
        '}',
        'try { fail(); } catch (error) { module.exports = error.stack; }'
      ].join('\n'),
      '/app/awaited.mjs': [
        'const pause = () => new Promise((resolve) => setTimeout(resolve, 0));',
        'await pause();',
        '',
        "export const stack = new Error('after await').stack;"
      ].join('\n')
    });
    const stackOf = (value: unknown): string => (value instanceof Error ? value.stack ?? '' : String(value));

    expect(stackOf(await captureRejection(harness.engine.import('./failed.mts', '/app')))).toContain(
      '/app/failed.mts:2:'
    );
    expect(stackOf(captureThrown(() => harness.engine.require('./failed.cjs', '/app')))).toContain(
      '/app/failed.cjs:2:'
    );
    expect(stackOf(captureThrown(() => harness.engine.require('./failed.cts', '/app')))).toContain(
      '/app/failed.cts:3:'
    );
    expect(stackOf(await captureRejection(harness.engine.import('./failed.mjs', '/app')))).toContain(
      '/app/failed.mjs:3:'
    );
    expect(stackOf(await captureRejection(harness.engine.import('./failed-after-import.mts', '/app')))).toContain(
      '/app/failed-after-import.mts:4:'
    );
    expect(
      stackOf(await captureRejection(harness.engine.import('./failed-after-re-export.mts', '/app')))
    ).toContain('/app/failed-after-re-export.mts:4:');
    const caught = String(harness.engine.require('./caught.cjs', '/app'));
    expect(caught).toContain('/app/caught.cjs:2:');
    expect(caught).toContain('/app/caught.cjs:4:');
    await expect(harness.engine.import('./awaited.mjs', '/app')).resolves.toMatchObject({
      stack: expect.stringContaining('/app/awaited.mjs:4:')
    });
  });

  test('rejects JSON import attributes whose resolved module is not JSON', async () => {
    const harness = createHarness({
      '/app/entry.mjs':
        "import value from './value.mjs' with { type: 'json' };\nexport const answer = value;",
      '/app/value.mjs': 'export default 42;'
    });

    const failure = await captureRejection(harness.engine.import('./entry.mjs', '/app'));
    expect(failure).toBeInstanceOf(TypeError);
    expect(failure).toMatchObject({
      message: expect.stringContaining('Import attribute type "json" requires a JSON module')
    });
  });

  test('loads extensionless package JSON exports with a JSON import attribute', async () => {
    const harness = createHarness({
      '/app/entry.mjs':
        "import value from 'fixture/data' with { type: 'json' };\nexport const answer = value.answer;",
      '/app/node_modules/fixture/package.json': JSON.stringify({
        type: 'module',
        exports: { './data': './data.json' }
      }),
      '/app/node_modules/fixture/data.json': '{ "answer": 42 }'
    });

    await expect(harness.engine.import('./entry.mjs', '/app')).resolves.toMatchObject({
      answer: 42
    });
  });

  test('validates dynamic JSON import attributes after resolution', async () => {
    const valid = createHarness({
      '/app/entry.mjs':
        "export const answer = (await import('fixture/data', { with: { type: 'json' } })).default.answer;",
      '/app/node_modules/fixture/package.json': JSON.stringify({
        type: 'module',
        exports: { './data': './data.json' }
      }),
      '/app/node_modules/fixture/data.json': '{ "answer": 42 }'
    });
    const invalid = createHarness({
      '/app/entry.mjs':
        "await import('./value.mjs', { with: { type: 'json' } });",
      '/app/value.mjs': 'export default 42;'
    });

    await expect(valid.engine.import('./entry.mjs', '/app')).resolves.toMatchObject({ answer: 42 });
    const failure = await captureRejection(invalid.engine.import('./entry.mjs', '/app'));
    expect(failure).toBeInstanceOf(TypeError);
    expect(failure).toMatchObject({
      message: expect.stringContaining('Import attribute type "json" requires a JSON module')
    });
  });

  test('shares one compiled CommonJS artifact across require and import', async () => {
    const harness = createHarness({
      '/app/value.cjs': 'module.exports = { value: 42 };'
    });

    const required = harness.engine.require('./value.cjs', '/app');
    const imported = await harness.engine.import('./value.cjs', '/app');

    expect(imported).toMatchObject({ default: required, value: 42 });
    expect(harness.starts).toEqual(['/app/value.cjs:cjs']);
    expect(harness.reads.get('/app/value.cjs')).toBe(1);
  });

  test("a module does not see the browser worker's own globals, which Node lacks", () => {
    const host = globalThis as Record<string, unknown>;
    const added = ['self', 'requestAnimationFrame', 'addEventListener', 'importScripts'].filter((name) => !(name in host));
    for (const name of added) host[name] = name === 'self' ? globalThis : () => undefined;
    try {
      // The process's global inherits the worker's, as in a process worker.
      const harness = createHarness({
        '/app/entry.cjs': [
          'module.exports = [',
          '  typeof self, typeof requestAnimationFrame, typeof addEventListener, typeof importScripts,',
          '  typeof WorkerGlobalScope, typeof location, typeof globalThis, typeof setTimeout',
          '];'
        ].join('\n')
      }, { global: Object.create(globalThis) as typeof globalThis });

      expect(harness.engine.require('./entry.cjs', '/app')).toEqual([
        'undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'object', 'function'
      ]);
    } finally {
      for (const name of added) delete host[name];
    }
  });

  test('a module sees a browser worker name the program put on its global itself, as under Node', () => {
    // fake-indexeddb/auto, happy-dom's global registrator and `global.self = global` shims define them.
    const harness = createHarness({
      '/app/poly.cjs': [
        'globalThis.self = globalThis;',
        "globalThis.location = { href: 'http://localhost/' };",
        'globalThis.Worker = function Worker() {};',
        "globalThis.addEventListener = () => 'listening';"
      ].join('\n'),
      '/app/use.cjs': [
        'module.exports = [typeof self, self === globalThis, location.href, typeof Worker, addEventListener(),',
        '  typeof indexedDB, typeof WorkerGlobalScope];'
      ].join('\n'),
      '/app/entry.cjs': "require('./poly.cjs'); module.exports = require('./use.cjs');"
    }, { global: Object.create(globalThis) as typeof globalThis });

    expect(harness.engine.require('./entry.cjs', '/app')).toEqual([
      'object', true, 'http://localhost/', 'function', 'listening', 'undefined', 'undefined'
    ]);
  });

  test('a compiled async function rebuilt from its source by new Function still runs', async () => {
    // Worker fallbacks re-create a function from `fn.toString()`, which carries the compiled helpers.
    const harness = createHarness({
      '/app/entry.mjs': [
        'async function work(value) { const doubled = await Promise.resolve(value * 2); return doubled + 1; }',
        "const rebuilt = new Function('return ' + work.toString())();",
        'export const result = await rebuilt(20);'
      ].join('\n')
    });

    await expect(harness.engine.import('./entry.mjs', '/app')).resolves.toMatchObject({ result: 41 });
  });

  test('routes import() in a Function body an ES module builds to the engine', async () => {
    // Vite 3 and 4 load their config through such a function, from an ES module chunk.
    const harness = createHarness({
      '/app/config.mjs': 'export default { value: 42 };',
      '/app/node_modules/helper/package.json': JSON.stringify({ name: 'helper', exports: './index.mjs' }),
      '/app/node_modules/helper/index.mjs': "export const name = 'helper';",
      '/app/entry.mjs': [
        "const dynamicImport = new Function('file', 'return import(file)');",
        "const plain = new Function('left', 'right', 'return left + right');",
        "const config = await dynamicImport('file:///app/config.mjs');",
        "const helper = await dynamicImport('helper');",
        'export const result = { config: config.default.value, helper: helper.name, sum: plain(1, 2) };'
      ].join('\n')
    });

    const entry = (await harness.engine.import('./entry.mjs', '/app')) as { result: unknown };

    expect(entry.result).toEqual({ config: 42, helper: 'helper', sum: 3 });
  });

  test("a function new Function builds is the native one Node's would be, in both module kinds", async () => {
    const probe = [
      "const f = new Function('a', 'b', 'return [arguments.length, arguments[0]]');",
      "const Point = new Function('x', 'this.x = x');",
      'const values = [',
      '  f(1), f.length, f.toString(), new Point(3).x, new Point(3) instanceof Point, f instanceof Function,',
      "  new Function('let __trackAsync = 1; return __trackAsync')(),",
      "  new Function('process', '\"use strict\"; return process')(5),",
      '  Function.name, Function.length',
      '];'
    ];
    const expected = [
      [1, 1], 2, 'function anonymous(a,b\n) {\nreturn [arguments.length, arguments[0]]\n}', 3, true, true, 1, 5, 'Function', 1
    ];
    const harness = createHarness({
      '/app/script.cjs': [...probe, 'module.exports = values;'].join('\n'),
      '/app/module.mjs': [...probe, 'export { values };'].join('\n')
    });

    expect(harness.engine.require('./script.cjs', '/app')).toEqual(expected);
    await expect(harness.engine.import('./module.mjs', '/app')).resolves.toMatchObject({ values: expected });
  });

  test('routes import() in a Function body to the engine and leaves the same text in its strings alone', async () => {
    const harness = createHarness({
      '/app/value.cjs': 'module.exports = { value: 42 };',
      '/app/entry.cjs': [
        "const load = new Function('specifier', 'return import(specifier)');",
        "const template = new Function('name', 'return \"loadChildren: () => import(\\'./\" + name + \"\\')\"');",
        "const plain = new Function('left', 'right', 'return left + right');",
        'module.exports = { load, template, plain, isFunction: load instanceof Function };'
      ].join('\n')
    });

    const entry = harness.engine.require('./entry.cjs', '/app') as {
      load(specifier: string): Promise<{ value: number }>;
      template(name: string): string;
      plain(left: number, right: number): number;
      isFunction: boolean;
    };

    await expect(entry.load('./value.cjs')).resolves.toMatchObject({ value: 42 });
    expect(entry.template('page')).toBe("loadChildren: () => import('./page')");
    expect(entry.plain(2, 3)).toBe(5);
    expect(entry.isFunction).toBe(true);
  });

  test('routes import() in a direct eval to the engine, and the eval keeps its caller\'s scope', async () => {
    // webpack's loader-runner loads an ES module loader with eval("import(" + JSON.stringify(url) + ")").
    const harness = createHarness({
      '/app/loader.mjs': 'export default function loader(source) { return source; }\nexport const raw = true;',
      '/app/entry.cjs': [
        "const url = 'file:///app/loader.mjs';",
        'const local = 41;',
        'module.exports = {',
        '  load: () => eval("import(" + JSON.stringify(url) + ")"),',
        "  scoped: eval('local + 1'),",
        "  text: eval('\"import(\\'./not-a-call\\')\"')",
        '};'
      ].join('\n')
    });

    const entry = harness.engine.require('./entry.cjs', '/app') as {
      load(): Promise<{ default: unknown; raw: boolean }>;
      scoped: number;
      text: string;
    };

    await expect(entry.load()).resolves.toMatchObject({ raw: true });
    expect(entry.scoped).toBe(42);
    expect(entry.text).toBe("import('./not-a-call')");
  });

  test('a direct eval of spread arguments, or of none, compiles in both module kinds', async () => {
    const harness = createHarness({
      '/app/script.cjs': "const args = ['1 + 1']; module.exports = [eval(...args), eval()];",
      '/app/module.mjs': "const args = ['2 + 2']; export const values = [eval(...args), eval()];"
    });

    expect(harness.engine.require('./script.cjs', '/app')).toEqual([2, undefined]);
    await expect(harness.engine.import('./module.mjs', '/app')).resolves.toMatchObject({ values: [4, undefined] });
  });

  test('a compiled async function rebuilt by the AsyncFunction constructor still finds the runtime helpers', async () => {
    // Vite runs Sass in a fake worker that rebuilds the worker function from its source so.
    const harness = createHarness({
      '/app/entry.cjs': [
        'async function work(value) { await null; for await (const step of [1]) value += step; return value; }',
        'const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;',
        "const source = work.toString();",
        "const rebuilt = new AsyncFunction('value', source.slice(source.indexOf('{') + 1, source.lastIndexOf('}')));",
        'module.exports = { result: rebuilt(41), global: Object.keys(globalThis).includes(\'__awaitInContext\') };'
      ].join('\n')
    });

    const entry = harness.engine.require('./entry.cjs', '/app') as { result: Promise<number>; global: boolean };

    await expect(entry.result).resolves.toBe(42);
    expect(entry.global).toBe(false);
  });

  test('a class that extends Function makes callable instances of itself', () => {
    // rspack-chain's ChainedValueMap extends Function and returns a Proxy of the instance.
    const harness = createHarness({
      '/app/entry.cjs': [
        'class Callable extends Function {',
        '  constructor(factor) {',
        '    return super(), (this.factor = factor), new Proxy(this, { apply: (target, _self, args) => target.call2(...args) });',
        '  }',
        '  call2(value) { return value * this.factor; }',
        '}',
        'class Doubler extends Callable { constructor() { super(2); } }',
        'const doubler = new Doubler();',
        'module.exports = { result: doubler(21), own: doubler instanceof Doubler, method: typeof doubler.call2 };'
      ].join('\n')
    });

    expect(harness.engine.require('./entry.cjs', '/app')).toEqual({ result: 42, own: true, method: 'function' });
  });

  test('keeps the complete CommonJS exports object as the ESM default when it owns a default property', async () => {
    const harness = createHarness({
      '/app/value.cjs': "module.exports = { default: 'inner-default', named: 42 };"
    });

    const required = harness.engine.require('./value.cjs', '/app');
    const imported = await harness.engine.import('./value.cjs', '/app');

    expect(imported.default).toBe(required);
    expect(imported.named).toBe(42);
    expect(imported.default).toEqual({ default: 'inner-default', named: 42 });
  });

  test('preserves a CommonJS-owned exports accessor across ESM import and require', async () => {
    const harness = createHarness({
      '/app/logger.cjs': [
        "const prototype = { info: () => 'logged' };",
        "Object.defineProperty(module, 'exports', {",
        '  get() { return Object.create(prototype); }',
        '});'
      ].join('\n')
    });

    const imported = await harness.engine.import('./logger.cjs', '/app');
    const required = harness.engine.require('./logger.cjs', '/app');

    expect(imported.default).toMatchObject({ info: expect.any(Function) });
    expect(required).toMatchObject({ info: expect.any(Function) });
    if (!isRecord(imported.default) || typeof imported.default.info !== 'function') {
      throw new Error('Expected an imported CommonJS logger');
    }
    if (!isRecord(required) || typeof required.info !== 'function') {
      throw new Error('Expected a required CommonJS logger');
    }
    expect(imported.default.info()).toBe('logged');
    expect(required.info()).toBe('logged');
  });

  test('publishes partial CommonJS records through cycles', () => {
    const harness = createHarness({
      '/app/a.cjs': [
        'exports.record = module;',
        "exports.name = 'a';",
        "const b = require('./b.cjs');",
        'exports.bRecord = b.record;',
        'exports.seenByB = b.seen;'
      ].join('\n'),
      '/app/b.cjs': [
        "const a = require('./a.cjs');",
        'exports.record = module;',
        'exports.aRecord = a.record;',
        'exports.seen = a.name;'
      ].join('\n')
    });

    const result = harness.engine.require('./a.cjs', '/app');
    if (!isRecord(result) || !isRecord(result.record) || !isRecord(result.bRecord)) {
      throw new Error('Expected cyclic CommonJS records');
    }
    const a = result.record;
    const b = result.bRecord;

    expect(result).toMatchObject({ name: 'a', seenByB: 'a' });
    expect(a).toMatchObject({ loaded: true, parent: null, exports: result });
    expect(b).toMatchObject({ loaded: true, parent: a });
    expect(a.children).toEqual([b]);
    expect(b.children).toEqual([a]);
    expect(b.exports).toMatchObject({ aRecord: a, seen: 'a' });
    expect(harness.starts).toEqual(['/app/a.cjs:cjs', '/app/b.cjs:cjs']);
  });

  test('exposes Node-shaped CommonJS records and links required children to their parent', () => {
    const harness = createHarness({
      '/app/entry.cjs': [
        "const child = module.require('./child.cjs');",
        'module.exports = { record: module, child };'
      ].join('\n'),
      '/app/child.cjs': [
        'module.exports = {',
        '  record: module,',
        '  loadedDuringEvaluation: module.loaded,',
        '  parentSawChild: module.parent.children.includes(module)',
        '};'
      ].join('\n')
    });

    const result = harness.engine.require('./entry.cjs', '/app');
    if (!isRecord(result) || !isRecord(result.record) || !isRecord(result.child)) {
      throw new Error('Expected CommonJS module records');
    }
    const entry = result.record;
    const child = result.child.record;

    expect(entry).toMatchObject({
      id: '/app/entry.cjs',
      filename: '/app/entry.cjs',
      dirname: '/app',
      path: '/app',
      loaded: true,
      parent: null,
      paths: ['/app/node_modules', '/node_modules']
    });
    expect(typeof entry.require).toBe('function');
    expect(child).toMatchObject({
      id: '/app/child.cjs',
      filename: '/app/child.cjs',
      dirname: '/app',
      path: '/app',
      loaded: true,
      parent: entry,
      paths: ['/app/node_modules', '/node_modules']
    });
    expect(entry.children).toEqual([child]);
    expect(result.child).toMatchObject({ loadedDuringEvaluation: false, parentSawChild: true });
  });

  test('keeps ESM live bindings stable across top-level await', async () => {
    const harness = createHarness({
      '/app/counter.mjs': [
        'export let count = 0;',
        'await Promise.resolve();',
        'count += 1;',
        'export function increment() { count += 1; }'
      ].join('\n'),
      '/app/reader.mjs': [
        "import { count, increment } from './counter.mjs';",
        'export const before = count;',
        'increment();',
        'export const after = count;'
      ].join('\n')
    });

    const reader = await harness.engine.import('./reader.mjs', '/app');
    const counter = await harness.engine.import('./counter.mjs', '/app');

    expect(reader).toMatchObject({ before: 1, after: 2 });
    expect(counter.count).toBe(2);
    expect(harness.starts).toEqual(['/app/reader.mjs:esm', '/app/counter.mjs:esm']);
    expect(harness.reads.get('/app/counter.mjs')).toBe(1);
  });

  test('links cyclic graphs and preserves live re-exports through top-level await and dynamic import', async () => {
    const harness = createHarness({
      '/app/state.mjs': [
        'let count = 0;',
        'export { count as value };',
        'export function increment() { count += 1; }'
      ].join('\n'),
      '/app/star.mjs': "export const star = 'star';",
      '/app/barrel.mjs': [
        "export { value as current, increment } from './state.mjs';",
        "export * from './star.mjs';"
      ].join('\n'),
      '/app/cycle-a.mjs': [
        "import { readValue } from './cycle-b.mjs';",
        "export let value = 'linked';",
        'export function readCycle() { return readValue(); }'
      ].join('\n'),
      '/app/cycle-b.mjs': [
        "import { value } from './cycle-a.mjs';",
        'export function readValue() { return value; }'
      ].join('\n'),
      '/app/lazy.mjs': "export const value = 'lazy';",
      '/app/entry.mjs': [
        "import { current, increment, star } from './barrel.mjs';",
        "import { readCycle } from './cycle-a.mjs';",
        'export const before = current;',
        'increment();',
        'await Promise.resolve();',
        'export const after = current;',
        "export const lazy = (await import('./lazy.mjs')).value;",
        'export const cycle = readCycle();',
        'export { current, star };'
      ].join('\n')
    });

    const entry = await harness.engine.import('./entry.mjs', '/app');
    const barrel = await harness.engine.import('./barrel.mjs', '/app');

    expect(barrel).toMatchObject({ current: 1, star: 'star' });
    expect(entry).toMatchObject({
      before: 0,
      after: 1,
      current: 1,
      star: 'star',
      lazy: 'lazy',
      cycle: 'linked'
    });
    expect(harness.starts).toEqual([
      '/app/entry.mjs:esm',
      '/app/barrel.mjs:esm',
      '/app/state.mjs:esm',
      '/app/star.mjs:esm',
      '/app/cycle-a.mjs:esm',
      '/app/cycle-b.mjs:esm',
      '/app/lazy.mjs:esm'
    ]);
  });

  test('returns Node-shaped module namespace objects from import and synchronous require', async () => {
    const harness = createHarness({
      '/app/imported.mjs': "export const zebra = 'last';\nexport default 42;\nexport let alpha = 1;",
      '/app/required.mjs': "export const zebra = 'last';\nexport default 42;\nexport const alpha = 'first';"
    });

    const imported = await harness.engine.import('./imported.mjs', '/app');
    const required = harness.engine.require('./required.mjs', '/app');

    expect(Object.getPrototypeOf(imported)).toBeNull();
    expect(Object.isExtensible(imported)).toBe(false);
    expect(Object.prototype.toString.call(imported)).toBe('[object Module]');
    expect(Reflect.ownKeys(imported)).toEqual(['alpha', 'default', 'zebra', Symbol.toStringTag]);
    expect(imported).not.toHaveProperty('__esModule');
    expect(Object.getOwnPropertyDescriptor(imported, 'default')).toMatchObject({
      configurable: false,
      enumerable: true,
      writable: true,
      value: 42
    });
    expect(Reflect.set(imported, 'default', 99)).toBe(false);
    expect(imported.default).toBe(42);

    expect(Object.getPrototypeOf(required)).toBeNull();
    expect(Object.isExtensible(required)).toBe(false);
    expect(Object.prototype.toString.call(required)).toBe('[object Module]');
    expect(Reflect.ownKeys(required)).toEqual(['__esModule', 'alpha', 'default', 'zebra', Symbol.toStringTag]);
    expect(required).toMatchObject({ __esModule: true, alpha: 'first', default: 42, zebra: 'last' });
    expect(Reflect.set(required, 'alpha', 'changed')).toBe(false);
    expect(required.alpha).toBe('first');
  });

  test('removes failed records so a corrected artifact can be retried', () => {
    const topLevelAwait = createHarness({
      '/app/async.mjs': 'await Promise.resolve();\nexport const ready = true;'
    });
    const invalid = createHarness({
      '/app/invalid.cjs': 'module.exports = ;'
    });

    let requireError: unknown;
    try {
      topLevelAwait.engine.require('./async.mjs', '/app');
    } catch (error) {
      requireError = error;
    }
    expect(requireError).toMatchObject({
      code: 'ERR_REQUIRE_ASYNC_MODULE',
      message: expect.stringContaining(
        'require() cannot be used on an ESM graph with top-level await. Use import() instead: /app/async.mjs'
      )
    });
    expect(() => invalid.engine.require('./invalid.cjs', '/app')).toThrow(
      'Cannot compile CommonJS module /app/invalid.cjs'
    );

    invalid.setSource('/app/invalid.cjs', 'module.exports = { repaired: true };');
    expect(invalid.engine.require('./invalid.cjs', '/app')).toEqual({ repaired: true });
    expect(invalid.starts).toEqual(['/app/invalid.cjs:cjs', '/app/invalid.cjs:cjs']);
  });

  test('projects require.cache mutations back into the canonical registry', () => {
    const harness = createHarness({
      '/app/entry.cjs': [
        "const first = require('./value.cjs');",
        "delete require.cache[require.resolve('./value.cjs')];",
        "const second = require('./value.cjs');",
        'module.exports = { first, second };'
      ].join('\n'),
      '/app/value.cjs': 'module.exports = { identity: {} };'
    });

    const result = harness.engine.require('./entry.cjs', '/app');
    if (!isRecord(result)) throw new Error('Expected CommonJS exports');
    expect(result.first).not.toBe(result.second);
    expect(harness.starts).toEqual(['/app/entry.cjs:cjs', '/app/value.cjs:cjs', '/app/value.cjs:cjs']);
    expect(harness.reads.get('/app/value.cjs')).toBe(2);
  });

  test('supports Node-shaped require.cache property reads, writes, and own-key enumeration', () => {
    const harness = createHarness({
      '/app/entry.cjs': [
        "const filename = require.resolve('./value.cjs');",
        "const replacement = { exports: { source: 'cache' } };",
        'require.cache[filename] = replacement;',
        'module.exports = {',
        '  exactRecord: require.cache[filename] === replacement,',
        "  keys: Object.keys(require.cache).filter((key) => key.startsWith('/app/')).sort(),",
        "  value: require('./value.cjs')",
        '};'
      ].join('\n'),
      '/app/value.cjs': "module.exports = { source: 'file' };"
    });

    expect(harness.engine.require('./entry.cjs', '/app')).toEqual({
      exactRecord: true,
      keys: ['/app/entry.cjs', '/app/value.cjs'],
      value: { source: 'cache' }
    });
    expect(harness.starts).toEqual(['/app/entry.cjs:cjs']);
    expect(harness.reads.get('/app/value.cjs')).toBeUndefined();
  });

  test('lets a require.extensions handler evaluate transformed source through module._compile', () => {
    const harness = createHarness({
      '/app/entry.cjs': [
        "const fs = { read: () => 'export-me: 41' };",
        "require.extensions['.kv'] = (target, filename) => {",
        "  const [, value] = fs.read().split(': ');",
        "  target._compile('module.exports = { value: ' + value + ' + 1, own: __filename, keys: Object.keys(module) };', filename);",
        '};',
        "module.exports = require('./value.kv');"
      ].join('\n'),
      '/app/value.kv': 'export-me: 41'
    });

    const exported = harness.engine.require('./entry.cjs', '/app') as { value: number; own: string; keys: string[] };

    expect(exported.value).toBe(42);
    expect(exported.own).toBe('/app/value.kv');
    expect(exported.keys).not.toContain('_compile');
  });

  test('runs source as a module built with new Module(): its require resolves from the given filename', () => {
    const harness = createHarness({
      '/app/lib/helper.cjs': "module.exports = 'helper';"
    });
    const built = { exports: {}, loaded: false, paths: ['/app/node_modules'] };

    harness.engine.nodeModuleAccess.compile(
      built,
      "module.exports = { helper: require('./helper.cjs'), own: __filename };",
      '/app/lib/virtual.cjs'
    );

    expect(built.exports).toEqual({ helper: 'helper', own: '/app/lib/virtual.cjs' });
    expect(built.loaded).toBe(true);
    expect(harness.engine.nodeModuleAccess.load('./lib/helper.cjs', '/app/entry.cjs')).toBe('helper');
  });

  test("a program's require.extensions handler loads a file that reads as an ES module", () => {
    // Rollup 2 requires its config through a `.js` handler that compiles the bundled CommonJS instead.
    const harness = createHarness({
      '/app/rollup.config.js': "import plugin from './plugin.cjs';\nexport default { plugin };",
      '/app/plugin.cjs': 'exports.__esModule = true;\nexports.default = function plugin() { return 1; };',
      '/app/entry.cjs': [
        "const fileName = '/app/rollup.config.js';",
        "const bundled = \"'use strict';\\nvar plugin = require('./plugin.cjs');\\nmodule.exports = { plugin: plugin.default };\";",
        "const defaultLoader = require.extensions['.js'];",
        "require.extensions['.js'] = (module, requiredFileName) => {",
        '  if (requiredFileName === fileName) module._compile(bundled, requiredFileName);',
        '  else defaultLoader(module, requiredFileName);',
        '};',
        'const config = require(fileName);',
        "require.extensions['.js'] = defaultLoader;",
        'module.exports = typeof config.plugin;'
      ].join('\n')
    });

    expect(harness.engine.require('./entry.cjs', '/app')).toBe('function');
  });

  test("an ES module a program's .js handler passes to the runtime's loads as an ES module", () => {
    // Vite's config loader wraps the .js handler while it requires the bundled config.
    const harness = createHarness({
      '/app/node_modules/esm-only/package.json': JSON.stringify({ name: 'esm-only', type: 'module', main: 'index.js' }),
      '/app/node_modules/esm-only/index.js': "export const name = 'esm-only';\nexport default 'default value';",
      '/app/entry.cjs': [
        "const original = require.extensions['.js'];",
        "require.extensions['.js'] = (module, filename) => original(module, filename);",
        "const loaded = require('esm-only');",
        "require.extensions['.js'] = original;",
        'module.exports = [loaded.name, loaded.default];'
      ].join('\n')
    });

    expect(harness.engine.require('./entry.cjs', '/app')).toEqual(['esm-only', 'default value']);
  });

  test('module._compile of a source that only parses as an ES module loads that source as one, as Node detects', () => {
    // A .js handler shaped `(m, f) => m._compile(fs.readFileSync(f, 'utf8'), f)` is given a "type": "module" package's files.
    const sources: Record<string, string> = {
      '/app/node_modules/esm-only/package.json': JSON.stringify({ name: 'esm-only', type: 'module', main: 'index.js' }),
      '/app/node_modules/esm-only/index.js': "export const name = 'esm-only';\nexport default 'default value';",
      '/app/lib/other.js': "module.exports = 'from the file';",
      '/app/entry.cjs': [
        "const fs = require('fs');",
        "const original = require.extensions['.js'];",
        "require.extensions['.js'] = (m, f) => m._compile(fs.readFileSync(f, 'utf8'), f);",
        "const loaded = require('esm-only');",
        "require.extensions['.js'] = (m, f) => m._compile('export const replaced = true;', f);",
        "const replaced = require('./lib/other.js');",
        "require.extensions['.js'] = original;",
        'module.exports = [loaded.name, loaded.default, replaced.replaced];'
      ].join('\n')
    };
    const harness = createHarness(sources, {
      builtins: new Map([['node:fs', { readFileSync: (path: string) => sources[path] }]])
    });

    expect(harness.engine.require('./entry.cjs', '/app')).toEqual(['esm-only', 'default value', true]);
  });

  test("a hook that replaces module._compile before the runtime's loader runs transforms the source", () => {
    // pirates, which umi uses to load its TypeScript config, hooks so.
    const harness = createHarness({
      '/app/config.ts': "import value from './value.cjs';\nexport default value + 1;",
      '/app/value.cjs': 'module.exports = 41;',
      '/app/entry.cjs': [
        "const oldLoader = require.extensions['.js'];",
        "require.extensions['.ts'] = (mod, filename) => {",
        '  const oldCompile = mod._compile;',
        '  mod._compile = function (code) {',
        '    mod._compile = oldCompile;',
        "    const transformed = code.replace(\"import value from './value.cjs';\", \"const value = require('./value.cjs');\").replace('export default', 'module.exports =');",
        '    return mod._compile(transformed, filename);',
        '  };',
        '  oldLoader(mod, filename);',
        '};',
        "module.exports = require('./config.ts');"
      ].join('\n')
    });

    expect(harness.engine.require('./entry.cjs', '/app')).toBe(42);
  });

  test('dispatches mutable require.extensions handlers with the current module record', () => {
    const harness = createHarness({
      '/app/entry.cjs': [
        "require.extensions['.custom'] = (target, filename) => {",
        '  target.exports = {',
        '    filename,',
        '    loadedDuringEvaluation: target.loaded,',
        '    parent: target.parent.filename',
        '  };',
        '};',
        "module.exports = require('./value.custom');"
      ].join('\n'),
      '/app/value.custom': 'this source is intentionally not JavaScript'
    });

    expect(harness.engine.require('./entry.cjs', '/app')).toEqual({
      filename: '/app/value.custom',
      loadedDuringEvaluation: false,
      parent: '/app/entry.cjs'
    });
    expect(harness.starts).toEqual(['/app/entry.cjs:cjs', '/app/value.custom:cjs']);
    expect(harness.reads.get('/app/value.custom')).toBeUndefined();
  });

  test('falls back to JavaScript when a CommonJS config extension is registered without a handler', () => {
    const harness = createHarness({
      '/app/entry.cjs': [
        "require.extensions['.cjs'] = null;",
        "module.exports = require('./webpack.config.cjs');"
      ].join('\n'),
      '/app/webpack.config.cjs': [
        "const plugin = require('./claim-plugin.cjs');",
        "module.exports = { mode: 'development', plugin };"
      ].join('\n'),
      '/app/claim-plugin.cjs': "module.exports = { name: 'claim-plugin' };"
    });

    expect(harness.engine.require('./entry.cjs', '/app')).toEqual({
      mode: 'development',
      plugin: { name: 'claim-plugin' }
    });
    expect(harness.starts).toEqual([
      '/app/entry.cjs:cjs',
      '/app/webpack.config.cjs:cjs',
      '/app/claim-plugin.cjs:cjs'
    ]);
  });

  test('evicts failed CommonJS records and parent links before retrying', () => {
    const harness = createHarness({
      '/app/entry.cjs': [
        'let attempts = 0;',
        "require.extensions['.retry'] = (target) => {",
        '  attempts += 1;',
        "  if (attempts === 1) throw new Error('first attempt failed');",
        "  target.exports = { status: 'loaded' };",
        '};',
        "const filename = require.resolve('./value.retry');",
        "try { require('./value.retry'); } catch {}",
        'module.exports = {',
        '  cachedAfterFailure: filename in require.cache,',
        '  childrenAfterFailure: module.children.length,',
        "  value: require('./value.retry'),",
        '  finalChildren: module.children.length',
        '};'
      ].join('\n'),
      '/app/value.retry': 'not evaluated by the custom extension'
    });

    expect(harness.engine.require('./entry.cjs', '/app')).toEqual({
      cachedAfterFailure: false,
      childrenAfterFailure: 0,
      value: { status: 'loaded' },
      finalChildren: 1
    });
    expect(harness.starts).toEqual([
      '/app/entry.cjs:cjs',
      '/app/value.retry:cjs',
      '/app/value.retry:cjs'
    ]);
  });

  test('keeps default JavaScript, CommonJS, JSON, and unsupported native extension behavior', () => {
    const harness = createHarness({
      '/app/entry.cjs': [
        'module.exports = {',
        "  js: require('./value.js'),",
        "  cjs: require('./value.cjs'),",
        "  namedCjs: require('./value.cjs.js'),",
        "  json: require('./value.json')",
        '};'
      ].join('\n'),
      '/app/value.js': "module.exports = { format: 'js' };",
      '/app/value.cjs': "module.exports = { format: 'cjs' };",
      '/app/value.cjs.js': "module.exports = { format: 'cjs.js', source: 'export const marker = true' };",
      '/app/value.json': '{ "format": "json" }',
      '/app/addon.node': ''
    });

    expect(harness.engine.require('./entry.cjs', '/app')).toEqual({
      js: { format: 'js' },
      cjs: { format: 'cjs' },
      namedCjs: { format: 'cjs.js', source: 'export const marker = true' },
      json: { format: 'json' }
    });
    expect(() => harness.engine.require('./addon.node', '/app')).toThrow(
      'Native CommonJS extensions are unsupported in the browser runtime'
    );
    expect(() => harness.engine.require('./addon.node', '/app')).toThrow(
      'Native CommonJS extensions are unsupported in the browser runtime'
    );
    expect(harness.starts).toEqual([
      '/app/entry.cjs:cjs',
      '/app/value.js:cjs',
      '/app/value.cjs:cjs',
      '/app/value.cjs.js:cjs',
      '/app/value.json:cjs',
      '/app/addon.node:cjs',
      '/app/addon.node:cjs'
    ]);
  });

  test('retains canonical builtin identity across require and import', async () => {
    const builtin = { platform: 'browser', default: { legacyDefault: true } };
    const harness = createHarness({}, { builtins: new Map([['node:os', builtin]]) });

    const required = harness.engine.require('os', '/app');
    const imported = await harness.engine.import('node:os', '/app');

    expect(required).toBe(builtin);
    expect(imported.default).toBe(builtin);
    expect(imported.platform).toBe('browser');
    expect(harness.starts).toEqual([]);
  });

  test('routes local require and module.require through the builtin provider', () => {
    const builtin = { platform: 'browser' };
    const harness = createHarness(
      {
        '/app/entry.cjs': [
          "module.exports = { local: require('os'), fromModule: module.require('node:os') };"
        ].join('\n')
      },
      { builtins: new Map([['node:os', builtin]]) }
    );

    const result = harness.engine.require('./entry.cjs', '/app');
    if (!isRecord(result)) throw new Error('Expected builtin require results');
    expect(result.local).toBe(builtin);
    expect(result.fromModule).toBe(builtin);
  });

  test('exposes one engine-owned module access port over the canonical registry', () => {
    const harness = createHarness({
      '/app/value.cjs': 'module.exports = { identity: {} };'
    });
    const requireFromEntry = harness.engine.nodeModuleAccess.createRequireFunction('/app/entry.cjs');
    const first = requireFromEntry('./value.cjs');
    const second = harness.engine.nodeModuleAccess.load('./value.cjs', '/app/entry.cjs');
    const resolved = requireFromEntry.resolve('./value.cjs');

    expect(second).toBe(first);
    expect(harness.engine.nodeModuleAccess.cache[resolved]?.exports).toBe(first);
    expect(harness.engine.nodeModuleAccess.modulePaths('/app/features')).toEqual([
      '/app/features/node_modules',
      '/app/node_modules',
      '/node_modules'
    ]);
    expect(harness.engine.nodeModuleAccess.findPath('./value.cjs', ['/missing', '/app'])).toBe('/app/value.cjs');
  });

  test('anchors createRequire directory inputs inside that directory', () => {
    const harness = createHarness({
      '/app/node_modules/dependency/package.json': JSON.stringify({
        name: 'dependency',
        main: 'index.cjs'
      }),
      '/app/node_modules/dependency/index.cjs': "module.exports = 'project-dependency';"
    });
    const projectRequire = harness.engine.nodeModuleAccess.createRequireFunction('/app/');

    expect(projectRequire('dependency')).toBe('project-dependency');
    expect(projectRequire.resolve('dependency')).toBe('/app/node_modules/dependency/index.cjs');
  });

  test('evaluates node:vm scripts through the Runtime Artifact Compiler evaluator', () => {
    const harness = createHarness({});

    expect(harness.engine.scriptEvaluator.evaluate('40 + 2', { filename: 'runtime-vm.js' })).toBe(42);
  });

  test('reuses synthetic import namespaces for CommonJS, JSON, and builtin aliases', async () => {
    const builtin = { platform: 'browser' };
    const harness = createHarness(
      {
        '/app/value.cjs': 'module.exports = { value: 42 };',
        '/app/value.json': '{ "value": 42 }'
      },
      { builtins: new Map([['node:os', builtin]]) }
    );

    const commonJsFirst = await harness.engine.import('./value.cjs', '/app');
    const commonJsSecond = await harness.engine.import('./value.cjs', '/app');
    const jsonFirst = await harness.engine.import('./value.json', '/app');
    const jsonSecond = await harness.engine.import('./value.json', '/app');
    const builtinFirst = await harness.engine.import('os', '/app');
    const builtinSecond = await harness.engine.import('node:os', '/app');

    expect(commonJsSecond).toBe(commonJsFirst);
    expect(jsonSecond).toBe(jsonFirst);
    expect(builtinSecond).toBe(builtinFirst);
    expect(commonJsFirst).toMatchObject({ default: { value: 42 }, value: 42 });
    expect(jsonFirst).toEqual({ default: { value: 42 } });
    expect(builtinFirst).toMatchObject({ default: builtin, platform: 'browser' });
  });

  test('loads canonical JavaScript data modules without resolving them through the VFS', async () => {
    const harness = createHarness({});
    const specifier =
      'data:text/javascript,export%20const%20value%20%3D%2042%3B%0Aexport%20const%20identity%20%3D%20import.meta.url%3B%0Aexport%20const%20filename%20%3D%20import.meta.filename%3B%0Aexport%20const%20dirname%20%3D%20import.meta.dirname%3B';

    const first = await harness.engine.import(specifier, '/app');
    const second = await harness.engine.import(new URL(specifier), '/app');

    expect(second).toBe(first);
    expect(first).toMatchObject({ value: 42, identity: specifier, filename: undefined, dirname: undefined });
    expect(harness.reads).toEqual(new Map());
    expect(harness.starts).toEqual([`${specifier}:esm`]);
    expect(harness.engine.resolve(specifier, '/app')).toBe(specifier);
  });

  test('exposes URL-encoded file identities through import.meta.url', async () => {
    const path = '/app/special ;:@&=+$,~#%?.mjs';
    const harness = createHarness({
      [path]: 'export const identity = import.meta.url;\n'
    });

    await expect(harness.engine.import(path, '/app')).resolves.toMatchObject({
      identity: 'file:///app/special%20;:@&=+$,%7E%23%25%3F.mjs'
    });
  });

  test('evaluates import.meta.resolve', async () => {
    const source = 'export const resolved = import.meta.resolve("./target.mjs");\n';
    const harness = createHarness({
      '/app/entry.mjs': source,
      '/app/target.mjs': 'export const answer = 42;'
    });

    await expect(harness.engine.import('/app/entry.mjs', '/app')).resolves.toMatchObject({
      resolved: 'file:///app/target.mjs'
    });
  });

  test('resolves missing relative paths and builtins without loading them', async () => {
    const builtins = new Map<string, unknown>([['node:fs', { marker: 'fs' }]]);
    const harness = createHarness({
      '/app/entry.mjs': [
        'export const missing = import.meta.resolve("./missing.mjs");',
        'export const prefixedBuiltin = import.meta.resolve("node:fs");',
        'export const bareBuiltin = import.meta.resolve("fs");'
      ].join('\n')
    }, { builtins });

    await expect(harness.engine.import('/app/entry.mjs', '/app')).resolves.toMatchObject({
      missing: 'file:///app/missing.mjs',
      prefixedBuiltin: 'node:fs',
      bareBuiltin: 'node:fs'
    });
    expect(harness.reads).toEqual(new Map([['/app/entry.mjs', 1]]));
    expect(harness.builtinLoads.has('node:fs')).toBe(false);
    expect(harness.builtinLoads.has('fs')).toBe(false);
  });

  test('rejects unsupported data MIME types and relative imports from data modules explicitly', async () => {
    const harness = createHarness({});

    await expect(harness.engine.import('data:text/plain,not%20javascript', '/app')).rejects.toThrow(
      'Unsupported data module MIME type: text/plain'
    );
    await expect(
      harness.engine.import('data:text/javascript,import%20%22./child.mjs%22%3B', '/app')
    ).rejects.toThrow('Cannot resolve relative specifier "./child.mjs" from a data: module');
    expect(harness.reads).toEqual(new Map());
  });

  test('runs require preloads before import preloads and the entry in declaration order', async () => {
    const harness = createHarness({
      '/app/require-first.cjs': "console.log('require:first');",
      '/app/require-second.cjs': "console.log('require:second');",
      '/app/import-first.mjs': "console.log('import:first');",
      '/app/import-second.mjs': "console.log('import:second');",
      '/app/entry.mjs': "console.log('entry');\nexport const ready = true;"
    });

    await expect(
      harness.engine.runEntry('./entry.mjs', {
        require: ['./require-first.cjs', './require-second.cjs'],
        import: ['./import-first.mjs', './import-second.mjs']
      })
    ).resolves.toMatchObject({ ready: true });

    expect(harness.logs).toEqual([
      ['require:first'],
      ['require:second'],
      ['import:first'],
      ['import:second'],
      ['entry']
    ]);
  });

  test('derives entry preloads from process.execArgv and rejects empty values', async () => {
    const harness = createHarness({
      '/app/required.cjs': "console.log('required');",
      '/app/imported.mjs': "console.log('imported');",
      '/app/entry.mjs': "console.log('entry');\nexport const ready = true;"
    }, {
      execArgv: ['--require=./required.cjs', '--import', './imported.mjs']
    });

    await expect(harness.engine.runEntry('./entry.mjs')).resolves.toMatchObject({ ready: true });
    expect(harness.logs).toEqual([['required'], ['imported'], ['entry']]);

    const invalid = createHarness({
      '/app/entry.mjs': 'export const ready = true;'
    }, {
      execArgv: ['--require=']
    });
    await expect(invalid.engine.runEntry('./entry.mjs')).rejects.toThrow(
      'process.execArgv option --require requires an argument.'
    );
  });

  test('awaits registered hook initialization and applies resolve and load hooks in LIFO order', async () => {
    const harness = createHarness({
      '/app/first-hook.mjs': [
        "export async function initialize(data) { await Promise.resolve(); console.log(`initialize:first:${data.name}`); }",
        "export async function resolve(specifier, context, nextResolve) { console.log(`resolve:first:${specifier}`); return nextResolve(specifier, context); }",
        "export async function load(url, context, nextLoad) { console.log(`load:first:${url}`); return nextLoad(url, context); }"
      ].join('\n'),
      '/app/second-hook.mjs': [
        "export function initialize(data) { console.log(`initialize:second:${data.name}`); }",
        "export async function resolve(specifier, context, nextResolve) { console.log(`resolve:second:${specifier}`); return nextResolve(specifier, context); }",
        "export async function load(url, context, nextLoad) { console.log(`load:second:${url}`); return nextLoad(url, context); }"
      ].join('\n'),
      '/app/entry.mjs': "import { answer } from './target.mjs'; export { answer };",
      '/app/target.mjs': 'export const answer = 42;'
    });

    harness.engine.nodeModuleAccess.registerCustomizationHooks('./first-hook.mjs', {
      parentURL: 'file:///app/register.mjs',
      data: { name: 'one' }
    });
    harness.engine.nodeModuleAccess.registerCustomizationHooks('./second-hook.mjs', {
      parentURL: 'file:///app/register.mjs',
      data: { name: 'two' }
    });

    await expect(harness.engine.import('./entry.mjs', '/app')).resolves.toMatchObject({ answer: 42 });

    expect(harness.logs).toEqual([
      ['initialize:first:one'],
      ['resolve:first:./second-hook.mjs'],
      ['load:first:file:///app/second-hook.mjs'],
      ['initialize:second:two'],
      ['resolve:second:./entry.mjs'],
      ['resolve:first:./entry.mjs'],
      ['load:second:file:///app/entry.mjs'],
      ['load:first:file:///app/entry.mjs'],
      ['resolve:second:./target.mjs'],
      ['resolve:first:./target.mjs'],
      ['load:second:file:///app/target.mjs'],
      ['load:first:file:///app/target.mjs']
    ]);
  });

  test('rejects customization hooks that neither continue nor short-circuit their chain', async () => {
    const harness = createHarness({
      '/app/invalid-hook.mjs': 'export function resolve() { return { url: "file:///app/entry.mjs" }; }',
      '/app/entry.mjs': 'export const answer = 42;'
    });

    harness.engine.nodeModuleAccess.registerCustomizationHooks('./invalid-hook.mjs', {
      parentURL: 'file:///app/register.mjs'
    });

    await expect(harness.engine.import('./entry.mjs', '/app')).rejects.toThrow(
      'resolve hook must call nextResolve() or return shortCircuit: true'
    );
  });

  test('uses a short-circuited load source and hands a transferred object to initialize as itself', async () => {
    const harness = createHarness({
      '/app/hook.mjs': [
        'let registration;',
        'export function initialize(data) { registration = data; }',
        "export function resolve(specifier, context, nextResolve) { return specifier === 'virtual' ? { url: 'file:///app/virtual.mjs', shortCircuit: true } : nextResolve(specifier, context); }",
        "export function load(url, context, nextLoad) { if (!url.endsWith('/virtual.mjs')) return nextLoad(url, context); registration.port.answer = registration.settings.answer; return { format: 'module', source: 'export const answer = ' + registration.settings.answer + ';', shortCircuit: true }; }"
      ].join('\n'),
      '/app/entry.mjs': "import { answer } from 'virtual';\nexport { answer };"
    });
    const port: { answer?: number } = {};
    const settings = { answer: 42 };

    harness.engine.nodeModuleAccess.registerCustomizationHooks('./hook.mjs', {
      parentURL: 'file:///app/register.mjs',
      data: { port, settings },
      transferList: [port]
    });
    settings.answer = 7;

    await expect(harness.engine.import('./entry.mjs', '/app')).resolves.toMatchObject({ answer: 42 });
    expect(port.answer).toBe(42);
  });

  test('waits for a require preload registration before import preloads and the entry', async () => {
    const builtins = new Map<string, unknown>();
    const harness = createHarness({
      '/app/register.cjs': "require('node:module').register('./hook.mjs', { parentURL: 'file:///app/register.cjs' });",
      '/app/hook.mjs': "export async function initialize() { await Promise.resolve(); console.log('hook:ready'); }",
      '/app/import-preload.mjs': "console.log('import-preload');",
      '/app/entry.mjs': "console.log('entry');\nexport const ready = true;"
    }, { builtins });
    builtins.set('node:module', moduleRegistrationBuiltin(harness.engine.nodeModuleAccess));

    await expect(
      harness.engine.runEntry('./entry.mjs', {
        require: ['./register.cjs'],
        import: ['./import-preload.mjs']
      })
    ).resolves.toMatchObject({ ready: true });

    expect(harness.logs).toEqual([['hook:ready'], ['import-preload'], ['entry']]);
  });

  test('waits for hook registration started by the entry before completing the process', async () => {
    const builtins = new Map<string, unknown>();
    const harness = createHarness({
      '/app/entry.cjs': [
        "require('node:module').register('./hook.mjs', { parentURL: 'file:///app/entry.cjs' });",
        'module.exports = { ready: true };'
      ].join('\n'),
      '/app/hook.mjs': [
        'export async function initialize() {',
        '  await Promise.resolve();',
        "  console.log('entry-hook:ready');",
        '}'
      ].join('\n')
    }, { builtins });
    builtins.set('node:module', moduleRegistrationBuiltin(harness.engine.nodeModuleAccess));

    await expect(harness.engine.runEntry('./entry.cjs')).resolves.toEqual({ ready: true });
    expect(harness.logs).toEqual([['entry-hook:ready']]);
  });

  test('uses the replacement parentURL passed to nextResolve', async () => {
    const harness = createHarness({
      '/app/hook.mjs': [
        'export function resolve(specifier, context, nextResolve) {',
        "  return specifier === './target.mjs'",
        "    ? nextResolve(specifier, { ...context, parentURL: 'file:///alternate/register.mjs' })",
        '    : nextResolve(specifier, context);',
        '}'
      ].join('\n'),
      '/app/entry.mjs': "import { answer } from './target.mjs';\nexport { answer };",
      '/alternate/target.mjs': 'export const answer = 42;'
    });
    harness.engine.nodeModuleAccess.registerCustomizationHooks('./hook.mjs', {
      parentURL: 'file:///app/register.mjs'
    });

    await expect(harness.engine.import('./entry.mjs', '/app')).resolves.toMatchObject({ answer: 42 });
  });

  test('keeps registered customization hooks local to their engine instance', async () => {
    const first = createHarness({
      '/app/hook.mjs': "export function resolve(specifier, context, nextResolve) { return specifier === 'virtual' ? { url: 'file:///app/virtual.mjs', shortCircuit: true } : nextResolve(specifier, context); }\nexport function load(url, context, nextLoad) { return url.endsWith('/virtual.mjs') ? { format: 'module', source: 'export const answer = 42;', shortCircuit: true } : nextLoad(url, context); }",
      '/app/entry.mjs': "import { answer } from 'virtual';\nexport { answer };"
    });
    const second = createHarness({
      '/app/entry.mjs': 'export const answer = 7;'
    });
    first.engine.nodeModuleAccess.registerCustomizationHooks('./hook.mjs', {
      parentURL: 'file:///app/register.mjs'
    });

    await expect(first.engine.import('./entry.mjs', '/app')).resolves.toMatchObject({ answer: 42 });
    await expect(second.engine.import('./entry.mjs', '/app')).resolves.toMatchObject({ answer: 7 });
  });

  test('preserves TypeScript runtime formats when a hook wraps the default load result', async () => {
    const harness = createHarness({
      '/app/hook.mjs': "export async function load(url, context, nextLoad) { return { ...(await nextLoad(url, context)) }; }",
      '/app/entry.mts': 'export const answer: number = 42;'
    });
    harness.engine.nodeModuleAccess.registerCustomizationHooks('./hook.mjs', {
      parentURL: 'file:///app/register.mjs'
    });

    await expect(harness.engine.import('./entry.mts', '/app')).resolves.toMatchObject({ answer: 42 });
  });

  test('rejects customization registration after engine teardown', () => {
    const harness = createHarness({});
    harness.engine.teardown();

    expect(() =>
      harness.engine.nodeModuleAccess.registerCustomizationHooks('./hook.mjs', {
        parentURL: 'file:///app/register.mjs'
      })
    ).toThrow('Cannot register module customization hooks after Execution Context teardown.');
  });
});

function moduleRegistrationBuiltin(access: NodeModuleAccess) {
  return {
    register: (specifier: string | URL, options: ModuleCustomizationRegistrationOptions = {}) =>
      access.registerCustomizationHooks(specifier, options)
  };
}

function createHarness(
  sources: Readonly<Record<string, string | Uint8Array>>,
  options: {
    readonly builtins?: ReadonlyMap<string, unknown>;
    readonly execArgv?: readonly string[];
    readonly argv?: string[];
    readonly global?: typeof globalThis;
    readonly inlineEntries?: ReadonlyMap<string, { readonly source: string; readonly execArgv: readonly string[] }>;
  } = {}
) {
  const files = new Map(Object.entries(sources));
  const starts: string[] = [];
  const logs: unknown[][] = [];
  const reads = new Map<string, number>();
  const builtinLoads = new Map<string, number>();
  const moduleAccess: ModuleAccess = {
    readText(path) {
      reads.set(path, (reads.get(path) ?? 0) + 1);
      const source = files.get(path);
      if (source === undefined) throw Object.assign(new Error(`Missing ${path}`), { code: 'ENOENT' });
      return typeof source === 'string' ? source : new TextDecoder().decode(source);
    },
    readFileSync(path) {
      reads.set(path, (reads.get(path) ?? 0) + 1);
      const source = files.get(path);
      if (source === undefined) throw Object.assign(new Error(`Missing ${path}`), { code: 'ENOENT' });
      return typeof source === 'string' ? new TextEncoder().encode(source) : source.slice();
    },
    isFile(path) {
      return files.has(path);
    },
    isDirectory: (path) => [...files.keys()].some((file) => file.startsWith(`${path.replace(/\/$/, '')}/`)),
    realpathSync: (path) => path
  };
  moduleAccess[INLINE_NODE_MODULE_ENTRY] = (path) => options.inlineEntries?.get(path);
  const process: ModuleExecutionProcess = {
    argv: options.argv ?? [],
    execArgv: options.execArgv ?? [],
    env: {},
    cwd: () => '/app',
    exit: () => {
      throw new Error('Unexpected process.exit');
    }
  };
  const console: ModuleExecutionConsole = {
    log: (...values) => logs.push(values),
    error: () => undefined,
    warn: () => undefined
  };
  const engine = createModuleExecutionEngine({
    cwd: '/app',
    moduleAccess,
    process,
    console,
    global: options.global,
    builtinModuleProvider: {
      resolve(specifier) {
        const canonical = specifier.startsWith('node:') ? specifier : `node:${specifier}`;
        return options.builtins?.has(canonical) ? canonical : undefined;
      },
      load(specifier) {
        builtinLoads.set(specifier, (builtinLoads.get(specifier) ?? 0) + 1);
        const canonical = specifier.startsWith('node:') ? specifier : `node:${specifier}`;
        const value = options.builtins?.get(canonical);
        return value === undefined ? { found: false } : { found: true, module: value };
      }
    },
    runtimeArtifactCompiler: { buffer: undefined, compile },
    onModuleStart: (path, format) => starts.push(`${path}:${format}`)
  });
  return {
    engine,
    logs,
    starts,
    reads,
    builtinLoads,
    setSource: (path: string, source: string) => files.set(path, source)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to reject');
}

function captureThrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to throw');
}
