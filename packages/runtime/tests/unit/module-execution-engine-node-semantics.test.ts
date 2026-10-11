import { describe, expect, test } from 'vitest';

import * as Babel from '../../src/runtime/modules/runtime-host/runtime-artifact-compiler-babel';

import {
  asyncContext,
  createModuleExecutionEngine,
  createRuntimeArtifactTranslator,
  type ModuleAccess,
  type ModuleExecutionProcess,
  type ModuleResolutionCommitJournal
} from '../../src/runtime/modules/module-execution-engine';

const compile = createRuntimeArtifactTranslator(Babel);

describe('Module Execution Engine format detection', () => {
  test('reads an ambiguous file as an ES module when it only parses as one', async () => {
    const harness = createHarness({
      '/app/entry.js': 'export async function main() { return 42; }'
    });

    const imported = await harness.engine.import('./entry.js', '/app');

    await expect((imported.main as () => Promise<number>)()).resolves.toBe(42);
  });

  test('keeps a script CommonJS when a template literal line looks like an import', async () => {
    const harness = createHarness({
      '/app/entry.js': [
        'module.exports = `',
        'import foo from "foo"',
        '`;'
      ].join('\n')
    });

    await expect(harness.engine.runEntry('/app/entry.js')).resolves.toContain('import foo from "foo"');
  });

  test('detects ES module syntax under a package.json that declares no type', async () => {
    const harness = createHarness({
      '/app/package.json': '{ "name": "typeless" }',
      '/app/index.js': "import { value } from './value.js';\nexport const answer = value + 1;",
      '/app/value.js': 'export const value = 41;'
    });

    await expect(harness.engine.runEntry('/app/index.js')).resolves.toMatchObject({ answer: 42 });
  });

  test('lets the package scope type decide a .cjs.js file', async () => {
    const harness = createHarness({
      '/app/package.json': '{ "type": "module" }',
      '/app/value.cjs.js': 'export const format = typeof module;'
    });

    await expect(harness.engine.import('./value.cjs.js', '/app')).resolves.toMatchObject({
      format: 'undefined'
    });
  });

  test("require() of an ES module returns its \"module.exports\" export when it has one", async () => {
    const harness = createHarness({
      '/app/node_modules/generator-function/package.json': JSON.stringify({
        name: 'generator-function',
        exports: { '.': [{ 'module-sync': './require.mjs', default: './index.js' }, './index.js'] }
      }),
      '/app/node_modules/generator-function/index.js': 'module.exports = function getGeneratorFunction() { return 1; };',
      '/app/node_modules/generator-function/require.mjs': [
        "import getGeneratorFunction from './index.js';",
        'export default getGeneratorFunction;',
        "export { getGeneratorFunction as 'module.exports' };"
      ].join('\n'),
      '/app/plain.mjs': 'export const value = 1;',
      '/app/entry.cjs': [
        "const required = require('generator-function');",
        "const plain = require('./plain.mjs');",
        'module.exports = {',
        '  kind: typeof required,',
        '  value: required(),',
        "  again: require('generator-function') === required,",
        '  plain: plain.value',
        '};'
      ].join('\n')
    });

    await expect(harness.engine.runEntry('/app/entry.cjs')).resolves.toEqual({
      kind: 'function',
      value: 1,
      again: true,
      plain: 1
    });
  });

  test('an ES module that require() loads resolves its own imports with the import conditions', async () => {
    const harness = createHarness({
      '/app/node_modules/import-only/package.json': JSON.stringify({
        name: 'import-only',
        type: 'module',
        exports: { node: { import: './node.js' }, default: { import: './default.js' } }
      }),
      '/app/node_modules/import-only/node.js': "export const where = 'node';",
      '/app/node_modules/import-only/default.js': "export const where = 'default';",
      '/app/lib.mjs': [
        "import { where } from 'import-only';",
        "import * as required from './dual.mjs';",
        'export const value = where;',
        "export const dualIsNamespace = typeof required === 'object' && required.default === 'dual';"
      ].join('\n'),
      '/app/dual.mjs': "const value = 'dual';\nexport default value;\nexport { value as 'module.exports' };",
      '/app/entry.cjs': "module.exports = require('./lib.mjs');"
    });

    await expect(harness.engine.runEntry('/app/entry.cjs')).resolves.toMatchObject({
      value: 'node',
      dualIsNamespace: true
    });
  });

  test('rewrites only dynamic import calls in CommonJS', async () => {
    const harness = createHarness({
      '/app/entry.cjs': [
        "const text = \"call import('x') please\";",
        "// import('./never.mjs')",
        'const lib = { import(value) { return `member:${value}`; } };',
        'exports.import = (value) => `export:${value}`;',
        'module.exports = {',
        '  text,',
        "  member: lib.import('a'),",
        "  exported: exports.import('b'),",
        "  dynamic: import('./dependency.mjs')",
        '};'
      ].join('\n'),
      '/app/dependency.mjs': 'export const loaded = true;'
    });

    const result = await harness.engine.runEntry('/app/entry.cjs') as Record<string, unknown>;

    expect(result).toMatchObject({
      text: "call import('x') please",
      member: 'member:a',
      exported: 'export:b'
    });
    await expect(result.dynamic).resolves.toMatchObject({ loaded: true });
  });
});

describe('Module Execution Engine CommonJS entry and error semantics', () => {
  test('identifies the entry module through require.main and module.id', async () => {
    const harness = createHarness({
      '/app/entry.cjs': [
        "const child = require('./child.cjs');",
        'module.exports = {',
        '  entryIsMain: require.main === module,',
        '  entryId: module.id,',
        '  child',
        '};'
      ].join('\n'),
      '/app/child.cjs': [
        'module.exports = {',
        '  childIsMain: require.main === module,',
        '  mainFilename: require.main.filename,',
        '  childId: module.id',
        '};'
      ].join('\n')
    });

    await expect(harness.engine.runEntry('/app/entry.cjs')).resolves.toEqual({
      entryIsMain: true,
      entryId: '.',
      child: {
        childIsMain: false,
        mainFilename: '/app/entry.cjs',
        childId: '/app/child.cjs'
      }
    });
    expect(harness.engine.mainModule?.filename).toBe('/app/entry.cjs');
  });

  test('leaves require.main undefined for an ES module entry', async () => {
    const harness = createHarness({
      '/app/entry.mjs': "import value from './value.cjs';\nexport default value;",
      '/app/value.cjs': 'module.exports = require.main === undefined;'
    });

    await expect(harness.engine.runEntry('/app/entry.mjs')).resolves.toMatchObject({ default: true });
    expect(harness.engine.mainModule).toBeUndefined();
  });

  test('hands a required module failure to the caller unchanged', async () => {
    const harness = createHarness({
      '/app/entry.cjs': [
        'let caught;',
        "try { require('./optional.cjs'); } catch (error) { caught = error; }",
        'module.exports = {',
        '  isTypeError: caught instanceof TypeError,',
        '  code: caught.code,',
        "  fallback: caught.code === 'MODULE_NOT_FOUND' ? 'fallback' : 'rethrown',",
        '  caught',
        '};'
      ].join('\n'),
      '/app/optional.cjs': "throw Object.assign(new TypeError('optional dependency missing'), { code: 'MODULE_NOT_FOUND' });"
    });

    const result = await harness.engine.runEntry('/app/entry.cjs') as Record<string, unknown>;

    expect(result).toMatchObject({ isTypeError: true, code: 'MODULE_NOT_FOUND', fallback: 'fallback' });
    expect(Object.keys(result.caught as object)).toEqual(['code']);
  });

  test('passes thrown primitives through evaluation untouched', () => {
    const harness = createHarness({ '/app/thrower.cjs': "throw 'plain string';" });

    expect(() => harness.engine.require('./thrower.cjs', '/app')).toThrow('plain string');
    try {
      harness.engine.require('./thrower.cjs', '/app');
    } catch (error) {
      expect(error).toBe('plain string');
    }
  });

  test('never calls then on a thenable CommonJS export', async () => {
    const harness = createHarness({
      '/app/entry.cjs': [
        'let calls = 0;',
        'module.exports = { then() { calls += 1; }, calls: () => calls };'
      ].join('\n')
    });

    // A query builder exported as the entry never resolves; the entry still completes.
    await expect(harness.engine.runEntry('/app/entry.cjs')).resolves.toBeUndefined();

    const exported = harness.engine.require('./entry.cjs', '/app') as { calls(): number };
    expect(exported.calls()).toBe(0);
  });

  test('settles an entry whose exports are a thenable that never resolves', async () => {
    const harness = createHarness({
      '/app/entry.cjs': [
        'const state = { thenCalls: 0 };',
        'const builder = { then() { state.thenCalls += 1; } };',
        'module.exports = { builder, state };',
        'builder;'
      ].join('\n'),
      '/app/entry.mjs': [
        'export const state = { thenCalls: 0 };',
        'export const builder = { then() { state.thenCalls += 1; } };',
        'builder;'
      ].join('\n')
    });

    const commonJs = await harness.engine.runEntry('/app/entry.cjs') as { state: { thenCalls: number } };
    const esm = await harness.engine.runEntry('/app/entry.mjs') as { state: { thenCalls: number } };

    expect(commonJs.state.thenCalls).toBe(0);
    expect(esm.state.thenCalls).toBe(0);
  });

  test('tracks top-level promises by the same rule in CommonJS and ESM', async () => {
    const body = [
      'const state = { done: false };',
      'async function main() {',
      '  await new Promise((resolve) => setTimeout(resolve, 5));',
      '  state.done = true;',
      '}',
      'main();'
    ];
    const harness = createHarness({
      '/app/entry.cjs': [...body, 'module.exports = state;'].join('\n'),
      '/app/entry.mjs': [...body, 'export default state;'].join('\n')
    });

    await expect(harness.engine.runEntry('/app/entry.cjs')).resolves.toEqual({ done: true });
    await expect(harness.engine.runEntry('/app/entry.mjs')).resolves.toMatchObject({
      default: { done: true }
    });
  });

  test('exposes require.resolve.paths and the paths option', async () => {
    const harness = createHarness({
      '/app/src/entry.cjs': [
        'module.exports = {',
        "  bare: require.resolve.paths('dependency'),",
        "  relative: require.resolve.paths('./sibling'),",
        "  builtin: require.resolve.paths('node:fs'),",
        "  fromOtherRoot: require.resolve('dependency', { paths: ['/other'] }),",
        "  relativeToPath: require.resolve('./tool.cjs', { paths: ['/other'] })",
        '};'
      ].join('\n'),
      '/other/node_modules/dependency/index.js': 'module.exports = 1;',
      '/other/tool.cjs': 'module.exports = 2;'
    }, { builtins: new Map([['node:fs', {}]]) });

    await expect(harness.engine.runEntry('/app/src/entry.cjs')).resolves.toEqual({
      bare: ['/app/src/node_modules', '/app/node_modules', '/node_modules'],
      relative: ['/app/src'],
      builtin: null,
      fromOtherRoot: '/other/node_modules/dependency/index.js',
      relativeToPath: '/other/tool.cjs'
    });
  });
});

describe('Module Execution Engine ESM resolution and linking', () => {
  test('gives import and require the same main build of a package with a browser field', async () => {
    const harness = createHarness({
      '/app/entry.mjs': [
        "import { createRequire } from 'node:module';",
        "import imported from 'dual';",
        'const require = createRequire(import.meta.url);',
        "export const same = imported === require('dual');",
        'export const build = imported.build;'
      ].join('\n'),
      '/app/node_modules/dual/package.json': JSON.stringify({
        name: 'dual',
        main: './node.js',
        browser: './browser.js'
      }),
      '/app/node_modules/dual/node.js': "module.exports = { build: 'node' };",
      '/app/node_modules/dual/browser.js': "module.exports = { build: 'browser' };"
    }, { moduleBuiltin: true });

    await expect(harness.engine.import('./entry.mjs', '/app')).resolves.toMatchObject({
      same: true,
      build: 'node'
    });
  });

  test('settles concurrent imports of modules that import each other', async () => {
    const harness = createHarness({
      '/app/entry.mjs': [
        "const [b, c] = await Promise.all([import('./b.mjs'), import('./c.mjs')]);",
        'export const result = `${b.name}:${b.shared}:${c.name}:${c.shared}`;'
      ].join('\n'),
      '/app/b.mjs': [
        "import './c.mjs';",
        "import { shared } from './shared.mjs';",
        "export const name = 'b';",
        'export { shared };'
      ].join('\n'),
      '/app/c.mjs': [
        "import './b.mjs';",
        "import { shared } from './shared.mjs';",
        "export const name = 'c';",
        'export { shared };'
      ].join('\n'),
      '/app/shared.mjs': [
        'await new Promise((resolve) => setTimeout(resolve, 5));',
        "export const shared = 'ready';"
      ].join('\n')
    });

    await expect(harness.engine.runEntry('/app/entry.mjs')).resolves.toMatchObject({
      result: 'b:ready:c:ready'
    });
  });

  test('reads CommonJS exports through the namespace instead of copying them', async () => {
    const harness = createHarness({
      '/app/value.cjs': [
        'let lazyReads = 0;',
        "Object.defineProperty(exports, 'lazy', { enumerable: true, get() { lazyReads += 1; return 'lazy'; } });",
        "Object.defineProperty(exports, 'hidden', { enumerable: false, value: 'hidden' });",
        'exports.lazyReads = () => lazyReads;',
        "exports.addLater = () => { exports.later = 'later'; };"
      ].join('\n')
    });

    const namespace = await harness.engine.import('./value.cjs', '/app');
    const lazyReads = namespace.lazyReads as () => number;

    // Building the namespace reads no export, and a non-enumerable export is still one.
    expect(lazyReads()).toBe(0);
    expect(namespace.hidden).toBe('hidden');
    expect(namespace.lazy).toBe('lazy');
    expect(lazyReads()).toBe(1);

    (namespace.addLater as () => void)();
    // The default export is the live exports object; a new name is importable from the next import.
    expect((namespace.default as Record<string, unknown>).later).toBe('later');
    await expect(harness.engine.import('./value.cjs', '/app')).resolves.toMatchObject({ later: 'later' });
  });

  test('rebinds named imports once a CommonJS module in a cycle finishes evaluating', async () => {
    const harness = createHarness({
      '/app/entry.cjs': [
        "exports.early = 'early';",
        "exports.reader = import('./reader.mjs');",
        "exports.late = 'late';"
      ].join('\n'),
      '/app/reader.mjs': [
        "import { early, late } from './entry.cjs';",
        'export const read = () => ({ early, late });'
      ].join('\n')
    });

    const entry = await harness.engine.runEntry('/app/entry.cjs') as { reader: Promise<{ read(): unknown }> };

    expect((await entry.reader).read()).toEqual({ early: 'early', late: 'late' });
  });

  test('rebinds named builtin imports on syncBuiltinESMExports', async () => {
    const fileSystem = { readFile: () => 'original' };
    const harness = createHarness({
      '/app/reader.mjs': [
        "import fs, { readFile } from 'node:fs';",
        'export const viaNamed = () => readFile();',
        'export const viaDefault = () => fs.readFile();'
      ].join('\n')
    }, { builtins: new Map([['node:fs', fileSystem]]) });

    const reader = await harness.engine.import('./reader.mjs', '/app') as Record<string, () => string>;
    fileSystem.readFile = () => 'patched';

    // The supported subset matches Node: the default export is live, and named
    // bindings are copies that syncBuiltinESMExports() refreshes.
    expect(reader.viaDefault()).toBe('patched');
    expect(reader.viaNamed()).toBe('original');
    harness.engine.nodeModuleAccess.syncBuiltinEsmExports();
    expect(reader.viaNamed()).toBe('patched');
  });

  test('reads export conditions from process.execArgv', () => {
    const sources = {
      '/app/node_modules/conditional/package.json': JSON.stringify({
        exports: { custom: './custom.js', default: './default.js' }
      }),
      '/app/node_modules/conditional/custom.js': "module.exports = 'custom';",
      '/app/node_modules/conditional/default.js': "module.exports = 'default';"
    };

    expect(createHarness(sources).engine.require('conditional', '/app')).toBe('default');
    expect(
      createHarness(sources, { execArgv: ['--conditions=custom'] }).engine.require('conditional', '/app')
    ).toBe('custom');
    expect(
      createHarness(sources, { execArgv: ['-C', 'custom'] }).engine.require('conditional', '/app')
    ).toBe('custom');
    expect(
      createHarness(sources, { execArgv: ['--conditions', 'custom'] }).engine.require('conditional', '/app')
    ).toBe('custom');
  });

  test('falls back to NODE_PATH for require', () => {
    const harness = createHarness({
      '/global/lib/shared/index.js': "module.exports = 'from-node-path';"
    }, { env: { NODE_PATH: '/missing:/global/lib' } });

    expect(harness.engine.require('shared', '/app')).toBe('from-node-path');
  });
});

describe('Module Execution Engine caches', () => {
  test('remembers manifests and resolutions until the commit journal invalidates them', () => {
    const sources: Record<string, string> = {};
    for (let index = 0; index < 50; index += 1) {
      sources[`/app/node_modules/p${index}/package.json`] = JSON.stringify({ main: './main.js' });
      sources[`/app/node_modules/p${index}/main.js`] = `module.exports = ${index};`;
    }
    const harness = createHarness(sources, { commitJournal: true });
    const manifestReads = (): number =>
      [...harness.reads].filter(([path]) => path.endsWith('/package.json')).reduce((sum, [, count]) => sum + count, 0);

    for (let round = 0; round < 3; round += 1) {
      for (let index = 0; index < 50; index += 1) {
        expect(harness.engine.resolve(`p${index}`, '/app/src', 'require')).toBe(
          `/app/node_modules/p${index}/main.js`
        );
      }
    }
    // Every manifest is parsed once, however often its package is resolved.
    expect(manifestReads()).toBe(50);
    const probes = harness.probes();
    for (let index = 0; index < 50; index += 1) harness.engine.resolve(`p${index}`, '/app/src', 'require');
    expect(harness.probes()).toBe(probes);

    harness.commit('/app/node_modules/p7/package.json', JSON.stringify({ main: './other.js' }));
    harness.commit('/app/node_modules/p7/other.js', 'module.exports = "other";');

    expect(harness.engine.resolve('p7', '/app/src', 'require')).toBe('/app/node_modules/p7/other.js');
    expect(harness.engine.resolve('p8', '/app/src', 'require')).toBe('/app/node_modules/p8/main.js');
    expect(manifestReads()).toBe(51);
  });

  test('re-resolves a specifier once a missing candidate is created', () => {
    const harness = createHarness({
      '/node_modules/dependency/index.js': 'module.exports = "outer";'
    }, { commitJournal: true });

    expect(harness.engine.resolve('dependency', '/app', 'require')).toBe('/node_modules/dependency/index.js');
    harness.commit('/app/node_modules/dependency/index.js', 'module.exports = "inner";');
    expect(harness.engine.resolve('dependency', '/app', 'require')).toBe(
      '/app/node_modules/dependency/index.js'
    );
  });

  test('drops every remembered answer when the journal requires a resynchronization', () => {
    const harness = createHarness({
      '/app/node_modules/dependency/package.json': JSON.stringify({ main: './a.js' }),
      '/app/node_modules/dependency/a.js': '',
      '/app/node_modules/dependency/b.js': ''
    }, { commitJournal: true });

    expect(harness.engine.resolve('dependency', '/app', 'require')).toBe('/app/node_modules/dependency/a.js');
    harness.commit('/app/node_modules/dependency/package.json', JSON.stringify({ main: './b.js' }));
    harness.expireJournal();
    expect(harness.engine.resolve('dependency', '/app', 'require')).toBe('/app/node_modules/dependency/b.js');
  });

  test('instruments a CommonJS module with many top-level statements in one pass', () => {
    const lines: string[] = [];
    for (let index = 0; index < 20_000; index += 1) {
      lines.push(`exports.k${index} = ${JSON.stringify('x'.repeat(24))};`);
    }
    const harness = createHarness({ '/app/large.cjs': lines.join('\n') });

    const started = performance.now();
    const exported = harness.engine.require('./large.cjs', '/app') as Record<string, string>;
    const elapsed = performance.now() - started;

    expect(Object.keys(exported)).toHaveLength(20_000);
    // The quadratic rewrite took seconds for this source; one pass stays far below that.
    expect(elapsed).toBeLessThan(2_000);
  });
});

describe('Module Execution Engine Async Context', () => {
  const probe = [
    '  const pair = await (1, 2);',
    '  const nested = await await Promise.resolve(Promise.resolve(3));',
    "  const imported = await import('./value.mjs');",
    '  let sum = 0;',
    '  for await (const value of [1, Promise.resolve(2)]) sum += value;',
    '  for await (const value of (async function* () { yield 3; yield 4; })()) { sum += value; if (value === 3) break; }',
    "  const text = `${await 'a'}${await 'b'} await import(`;",
    '  const arrow = await (async () => 5)();',
    '  let caught;',
    "  try { await Promise.reject(new Error('rejected')); } catch (error) { caught = [error.message, frame()]; }",
    '  return { values: [pair, nested, imported.value, sum, text, arrow], caught, frame: frame() };'
  ];
  const sources = {
    '/app/value.mjs': 'export const value = 4;',
    '/app/probe.cjs': ['module.exports = async (frame) => {', ...probe, '};'].join('\n'),
    '/app/probe.mjs': ['export default async (frame) => {', ...probe, '};'].join('\n'),
    '/app/order.cjs': [
      'module.exports = async (log) => {',
      "  await null; log('first');",
      "  await Promise.resolve(); log('second');",
      "  await { then(resolve) { resolve(); } }; log('third');",
      '};'
    ].join('\n')
  };

  test.each(['probe.cjs', 'probe.mjs'])('resumes %s in the frame each await was entered in', async (entry) => {
    const harness = createHarness(sources);
    const loaded = await harness.engine.import(`./${entry}`, '/app');
    const run = loaded.default as (frame: () => unknown) => Promise<unknown>;
    const frame = new Map([[{}, 'store']]);
    const expected = (inFrame: unknown) => ({
      values: [2, 3, 4, 6, 'ab await import(', 5],
      caught: ['rejected', inFrame],
      frame: inFrame
    });

    const [inside, other, outside] = await Promise.all([
      asyncContext.run(frame, () => run(() => asyncContext.frame())),
      asyncContext.run(new Map(), () => run(() => asyncContext.frame() === frame)),
      run(() => asyncContext.frame())
    ]);

    expect(inside).toEqual(expected(frame));
    expect(other).toEqual(expected(false));
    expect(outside).toEqual(expected(undefined));
    expect(asyncContext.frame()).toBeUndefined();
  });

  test('resumes an await of a direct eval in the frame it was entered in', async () => {
    // webpack's eval devtool runs each module of a development bundle (Next.js's server code) through eval.
    const harness = createHarness({
      '/app/evaluated.cjs': [
        'module.exports = eval(`(async (frame) => {',
        '  const before = frame();',
        '  await Promise.resolve().then(() => 1);',
        '  return [before, frame()];',
        '})`);'
      ].join('\n')
    });
    const run = harness.engine.require('./evaluated.cjs', '/app') as (frame: () => unknown) => Promise<unknown[]>;
    const frame = new Map([[{}, 'store']]);

    await expect(asyncContext.run(frame, () => run(() => asyncContext.frame()))).resolves.toEqual([frame, frame]);
    expect(asyncContext.frame()).toBeUndefined();
  });

  test('separates an await from an operand that starts with a bracket, a parenthesis or a template', async () => {
    // Minified code writes `await(0,f)()`: the rewritten operand must not join
    // the keyword into one identifier (`await__awaitInContext`).
    const body = [
      'const g = async () => 7;',
      'const values = [await(0, g)(), await[8][0], await`9`.length, await(10)];',
      'for await(const value of [11]) values.push(value);',
      'return values;'
    ].join(' ');
    const harness = createHarness({
      '/app/minified.cjs': `module.exports = async () => { ${body} };`,
      '/app/minified.mjs': `export default async () => { ${body} };`
    });
    const required = harness.engine.require('./minified.cjs', '/app') as () => Promise<unknown>;
    const imported = (await harness.engine.import('./minified.mjs', '/app')).default as () => Promise<unknown>;
    const frame = new Map([[{}, 'store']]);

    await expect(required()).resolves.toEqual([7, 8, 1, 10, 11]);
    await expect(asyncContext.run(frame, imported)).resolves.toEqual([7, 8, 1, 10, 11]);
  });

  test('resumes an await one tick later inside a frame and on the same tick outside', async () => {
    const harness = createHarness(sources);
    const run = await harness.engine.runEntry('/app/order.cjs') as (log: (entry: string) => void) => Promise<void>;
    const order = async (start: (task: () => Promise<void>) => Promise<void>) => {
      const log: string[] = [];
      const done = start(() => run((entry) => log.push(entry)));
      let tick = Promise.resolve();
      for (let index = 0; index < 6; index += 1) tick = tick.then(() => void log.push(`tick ${index}`));
      await Promise.all([done, tick]);
      return log.join(' ');
    };

    // Outside a frame the compiled await is the platform's own.
    await expect(order((task) => task())).resolves.toBe(
      'first tick 0 second tick 1 tick 2 third tick 3 tick 4 tick 5'
    );
    await expect(order((task) => asyncContext.run(new Map([[{}, 'store']]), task))).resolves.toBe(
      'tick 0 first tick 1 tick 2 second tick 3 tick 4 tick 5 third'
    );
  });
});

function createHarness(
  sources: Readonly<Record<string, string>>,
  options: {
    readonly builtins?: ReadonlyMap<string, unknown>;
    readonly commitJournal?: boolean;
    readonly env?: Record<string, string>;
    readonly execArgv?: readonly string[];
    readonly moduleBuiltin?: boolean;
  } = {}
) {
  const files = new Map(Object.entries(sources));
  const reads = new Map<string, number>();
  const journal: { revision: number; paths: string[] }[] = [];
  let revision = 0;
  let oldestRetained = 0;
  let probes = 0;
  const commitJournal: ModuleResolutionCommitJournal = {
    get revision() {
      return revision;
    },
    readCommitJournal(afterRevision) {
      if (afterRevision < oldestRetained) {
        return { status: 'resync-required', currentRevision: revision, oldestRetainedRevision: oldestRetained };
      }
      return {
        status: 'delta',
        fromRevision: afterRevision,
        toRevision: revision,
        records: journal
          .filter((record) => record.revision > afterRevision)
          .map((record) => ({
            revision: record.revision,
            invalidations: record.paths.flatMap((path) => [
              { path, scope: 'path' as const },
              { path: path.slice(0, path.lastIndexOf('/')) || '/', scope: 'directory' as const }
            ])
          }))
      };
    }
  };
  const moduleAccess: ModuleAccess = {
    commitJournal: options.commitJournal ? commitJournal : undefined,
    readText(path) {
      reads.set(path, (reads.get(path) ?? 0) + 1);
      const source = files.get(path);
      if (source === undefined) throw Object.assign(new Error(`Missing ${path}`), { code: 'ENOENT' });
      return source;
    },
    isFile(path) {
      probes += 1;
      return files.has(path);
    },
    isDirectory(path) {
      probes += 1;
      return [...files.keys()].some((file) => file.startsWith(`${path.replace(/\/$/, '')}/`));
    },
    realpathSync: (path) => path
  };
  const process: ModuleExecutionProcess = {
    argv: [],
    execArgv: options.execArgv ?? [],
    env: options.env ?? {},
    cwd: () => '/app',
    exit: () => {
      throw new Error('exit');
    }
  };
  const engine = createModuleExecutionEngine({
    cwd: '/app',
    moduleAccess,
    process,
    console: { log: () => undefined, error: () => undefined, warn: () => undefined },
    builtinModuleProvider: {
      resolve(specifier) {
        const canonical = specifier.startsWith('node:') ? specifier : `node:${specifier}`;
        if (options.moduleBuiltin && canonical === 'node:module') return canonical;
        return options.builtins?.has(canonical) ? canonical : undefined;
      },
      load(specifier) {
        const canonical = specifier.startsWith('node:') ? specifier : `node:${specifier}`;
        if (options.moduleBuiltin && canonical === 'node:module') {
          return {
            found: true,
            module: { createRequire: (filename: string | URL) => engine.nodeModuleAccess.createRequireFunction(filename) }
          };
        }
        const value = options.builtins?.get(canonical);
        return value === undefined ? { found: false } : { found: true, module: value };
      }
    },
    runtimeArtifactCompiler: { buffer: undefined, compile }
  });
  return {
    engine,
    reads,
    probes: () => probes,
    /** Writes a file the way a committed VFS mutation would, journal record included. */
    commit(path: string, source: string) {
      // The authority records every directory a write creates, then the file itself.
      const created: string[] = [];
      for (let parent = path.slice(0, path.lastIndexOf('/')); parent; parent = parent.slice(0, parent.lastIndexOf('/'))) {
        if (moduleAccess.isDirectory(parent)) break;
        created.unshift(parent);
      }
      files.set(path, source);
      revision += 1;
      journal.push({ revision, paths: [...created, path] });
    },
    /** Forgets the journal history, as the authority does once it is no longer retained. */
    expireJournal() {
      journal.length = 0;
      oldestRetained = revision;
    }
  };
}
