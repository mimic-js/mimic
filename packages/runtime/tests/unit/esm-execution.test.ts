import { describe, expect, test } from 'vitest';

import * as Babel from '../../src/runtime/modules/runtime-host/runtime-artifact-compiler-babel';

import {
  createModuleExecutionEngine,
  createRuntimeArtifactTranslator,
  type ModuleAccess
} from '../../src/runtime/modules/module-execution-engine';

const compile = createRuntimeArtifactTranslator(Babel);

describe('ESM execution source transform through Module Execution Engine', () => {
  test('binds ESM postMessage to the Execution Context global', async () => {
    const runtimeGlobal = Object.create(globalThis) as typeof globalThis;
    const messages: unknown[] = [];
    runtimeGlobal.postMessage = (value: unknown) => messages.push(value);

    await run({
      '/home/project/worker.mjs': "postMessage('worker-ready'); export const ready = true;"
    }, '/home/project/worker.mjs', runtimeGlobal);

    expect(messages).toEqual(['worker-ready']);
  });

  test('lets publisher modules shadow the Node global binding', async () => {
    const module = await run({
      '/home/project/entry.mjs': [
        "import { runtimeGlobal } from './runtime-global.mjs';",
        "const global = 'publisher-owned';",
        'export { global, runtimeGlobal };',
        'export const globalThisAvailable = globalThis === globalThis.globalThis;'
      ].join('\n'),
      '/home/project/runtime-global.mjs': 'export const runtimeGlobal = global === globalThis;'
    }, '/home/project/entry.mjs');

    expect(module).toMatchObject({
      global: 'publisher-owned',
      runtimeGlobal: true,
      globalThisAvailable: true
    });
  });

  test('publishes identifiers declared by exported binding patterns', async () => {
    const module = await run({
      '/home/project/publisher.mjs': [
        'const source = { fs: 42, vol: 7, nested: { value: 3 } };',
        'export const { fs: renamedFs, vol, nested: { value } } = source;',
        'export const [first, second = 9] = [1];'
      ].join('\n')
    }, '/home/project/publisher.mjs');

    expect(module).toMatchObject({
      renamedFs: 42,
      vol: 7,
      value: 3,
      first: 1,
      second: 9
    });
  });

  test('provides Node import.meta filename and dirname fields', async () => {
    const module = await run({
      '/home/project/publisher.mjs':
        'export const metadata = [import.meta.url, import.meta.filename, import.meta.dirname];'
    }, '/home/project/publisher.mjs');

    expect(module.metadata).toEqual([
      'file:///home/project/publisher.mjs',
      '/home/project/publisher.mjs',
      '/home/project'
    ]);
  });

  test('resolves relative and package specifiers through import.meta.resolve', async () => {
    const module = await run({
      '/home/project/entry.mjs': [
        'const customizationHook = "data:text/javascript,%0Aexport { initialize, resolve };%0A";',
        'export { customizationHook };',
        "export const relative = import.meta.resolve('./target.mjs');",
        "export const packageEntry = import.meta.resolve('publisher-package');"
      ].join('\n'),
      '/home/project/node_modules/publisher-package/package.json': JSON.stringify({
        name: 'publisher-package',
        type: 'module',
        exports: './index.mjs'
      }),
      '/home/project/node_modules/publisher-package/index.mjs': 'export const answer = 42;'
    }, '/home/project/entry.mjs');

    expect(module).toMatchObject({
      customizationHook: 'data:text/javascript,%0Aexport { initialize, resolve };%0A',
      relative: 'file:///home/project/target.mjs',
      packageEntry: 'file:///home/project/node_modules/publisher-package/index.mjs'
    });
  });

  test('preserves static data imports whose encoded source contains export syntax', async () => {
    const module = await run({
      '/home/project/entry.mjs': [
        "import { answer } from 'data:text/javascript,%0Aexport%20const%20answer%20%3D%2042%3B';",
        'export { answer };'
      ].join('\n')
    }, '/home/project/entry.mjs');

    expect(module.answer).toBe(42);
  });

  test('preserves export syntax embedded in a template literal', async () => {
    const plugin = await run({
      '/home/project/virtual-plugin.mjs': [
        'export const helperCode = `',
        'export default (value) => value;',
        '`;'
      ].join('\n')
    }, '/home/project/virtual-plugin.mjs');

    expect(plugin.helperCode).toContain('export default (value) => value;');
    expect(plugin.helperCode).not.toContain('__exports.default');
  });

  test('preserves inline export syntax in an interpolated template literal', async () => {
    const plugin = await run({
      '/home/project/virtual-plugin.mjs': [
        "const exportsName = 'entry';",
        'export const helperCode = `export { ${exportsName} as __moduleExports };`;'
      ].join('\n')
    }, '/home/project/virtual-plugin.mjs');

    expect(plugin.helperCode).toBe('export { entry as __moduleExports };');
  });

  test('preserves export syntax after an escaped newline in a template literal', async () => {
    const plugin = await run({
      '/home/project/virtual-plugin.mjs': [
        "const exportsName = 'entry';",
        'export const helperCode = `\\nexport { ${exportsName} as __moduleExports };`;'
      ].join('\n')
    }, '/home/project/virtual-plugin.mjs');

    expect(plugin.helperCode).toBe('\nexport { entry as __moduleExports };');
  });

  test('preserves generated export syntax after runtime code in a template literal', async () => {
    const plugin = await run({
      '/home/project/virtual-plugin.mjs': [
        "const exportsName = 'entry';",
        'export const helperCode = `var ${exportsName} = {}; export {${exportsName} as __module}`;'
      ].join('\n')
    }, '/home/project/virtual-plugin.mjs');

    expect(plugin.helperCode).toBe('var entry = {}; export {entry as __module}');
  });

  test('preserves generated import.meta syntax inside a template interpolation', async () => {
    const plugin = await run({
      '/home/project/virtual-plugin.mjs': [
        "const modulesCode = '';",
        'export const helperCode = `${modulesCode || "import.meta.hot.accept()"}`;'
      ].join('\n')
    }, '/home/project/virtual-plugin.mjs');

    expect(plugin.helperCode).toBe('import.meta.hot.accept()');
  });

  test('preserves import syntax used as package-owned parser sentinels', async () => {
    const parser = await run({
      '/home/project/package-parser.mjs': [
        'export const importMetaSentinel = "import.meta";',
        'export const dynamicImportSentinel = "import(";',
        'export const moduleUrl = import.meta.url;'
      ].join('\n')
    }, '/home/project/package-parser.mjs');

    expect(parser).toMatchObject({
      importMetaSentinel: 'import.meta',
      dynamicImportSentinel: 'import(',
      moduleUrl: 'file:///home/project/package-parser.mjs'
    });
  });

  test('preserves shell export statements inside an interpolated template literal', async () => {
    const publisherCli = await run({
      '/home/project/publisher-cli.mjs': [
        "const nodePath = '/home/project/node_modules';",
        'export const shell = `if [ -z "$NODE_PATH" ]; then',
        '  export NODE_PATH="${nodePath}"',
        'else',
        '  export NODE_PATH="${nodePath}:$NODE_PATH"',
        'fi',
        '`;'
      ].join('\n')
    }, '/home/project/publisher-cli.mjs');

    expect(publisherCli.shell).toContain('export NODE_PATH="/home/project/node_modules"');
    expect(publisherCli.shell).toContain('export NODE_PATH="/home/project/node_modules:$NODE_PATH"');
  });

  test('executes a publisher bundle whose import shares a line with runtime code', async () => {
    const publisherBundle = await run({
      '/home/project/publisher-bundle.mjs':
        "import dependency, {} from './dependency.mjs';const suffix = 'ok';\nexport const result = `${dependency.value}-${suffix}`;",
      '/home/project/dependency.mjs': "export default { value: 'publisher' };"
    }, '/home/project/publisher-bundle.mjs');

    expect(publisherBundle.result).toBe('publisher-ok');
  });

  test('executes a compact named package import without separating whitespace', async () => {
    const publisherBundle = await run({
      '/home/project/publisher-bundle.mjs':
        "import{getLocator}from'locate-character';\nexport const location = getLocator('hello')();",
      '/home/project/node_modules/locate-character/index.mjs':
        'export const getLocator = () => () => ({ line: 1, column: 0 });'
    }, '/home/project/publisher-bundle.mjs');

    expect(publisherBundle.location).toEqual({ line: 1, column: 0 });
  });

  test('drains a top-level async publisher task when running an entry', async () => {
    const publisher = await run({
      '/home/project/async-publisher.mjs': [
        'export let completed = false;',
        '(async () => {',
        '  await new Promise((resolve) => setTimeout(resolve, 1));',
        '  completed = true;',
        '})();'
      ].join('\n')
    }, '/home/project/async-publisher.mjs');

    expect(publisher.completed).toBe(true);
  });

  test('transforms a Svelte-style export after nested diagnostic template literals', async () => {
    const warnings = await run({
      '/home/project/node_modules/svelte/src/compiler/warnings.mjs': [
        'function warning(message) { return message; }',
        'function unknown_code(code, suggestion) {',
        "  warning(`${suggestion",
        "    ? `\\`${code}\\` is not a recognised code (did you mean \\`${suggestion}\\`?)`",
        "    : `\\`${code}\\` is not a recognised code`}\\nhttps://svelte.dev/e/unknown_code`);",
        '}',
        '/** The `accessors` option is deprecated. */',
        'export function options_deprecated_accessors() {',
        "  return warning('The `accessors` option is deprecated.');",
        '}'
      ].join('\n')
    }, '/home/project/node_modules/svelte/src/compiler/warnings.mjs');

    expect(warnings.options_deprecated_accessors).toEqual(expect.any(Function));
    if (typeof warnings.options_deprecated_accessors !== 'function') throw new Error('Expected exported function');
    expect(warnings.options_deprecated_accessors()).toBe('The `accessors` option is deprecated.');
  });
});

async function run(
  sources: Readonly<Record<string, string>>,
  entry: string,
  runtimeGlobal?: typeof globalThis
): Promise<Record<string, unknown>> {
  const files = new Map(Object.entries(sources));
  const moduleAccess: ModuleAccess = {
    readText(path) {
      const source = files.get(path);
      if (source === undefined) throw new Error(`Missing ${path}`);
      return source;
    },
    isFile: (path) => files.has(path),
    isDirectory: (path) => [...files.keys()].some((file) => file.startsWith(`${path.replace(/\/$/, '')}/`)),
    realpathSync: (path) => path
  };
  const engine = createModuleExecutionEngine({
    cwd: '/home/project',
    moduleAccess,
    builtinModuleProvider: {
      resolve: () => undefined,
      load: () => ({ found: false })
    },
    process: {
      argv: [],
      env: {},
      cwd: () => '/home/project',
      exit: () => { throw new Error('Unexpected process.exit'); }
    },
    console: { log: () => undefined, error: () => undefined, warn: () => undefined },
    global: runtimeGlobal,
    runtimeArtifactCompiler: { buffer: undefined, compile }
  });
  const result = await engine.runEntry(entry);
  if (typeof result !== 'object' || result === null) throw new Error('Expected ESM namespace');
  return result;
}
