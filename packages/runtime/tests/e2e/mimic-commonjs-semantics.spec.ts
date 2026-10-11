import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';

const commonJsSemanticsCompatibilityClaim = defineCompatibilityClaim({
  id: 'module-execution-commonjs-semantics-v1',
  statement: 'Mimic preserves package-agnostic CommonJS semantics',
  target: {
    kind: 'runtime-capability',
    capability: 'module-execution-commonjs-semantics'
  }
});

test(commonJsSemanticsCompatibilityClaim.statement, async ({ page }) => {
  test.setTimeout(120_000);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => message.type() === 'error' && consoleErrors.push(message.text()));
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));

  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated), { timeout: 10_000 }).toBe(true);

  const result = await page.evaluate(async () => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const { mergeProcessOutput } = await import('/tests/e2e/process-output.ts');
    const runtime = await Mimic.boot({ workdir: '/home/commonjs-semantics' });
    try {
      await runtime.fs.mount({
        'entry.cjs': {
          file: {
            contents: [
              "const moduleRecord = require('./module-record.cjs');",
              "const requiredThroughModule = module.require('./module-require.cjs');",
              "const firstReload = require('./reload.cjs');",
              "delete require.cache[require.resolve('./reload.cjs')];",
              "const secondReload = require('./reload.cjs');",
              "const cycleA = require('./cycle-a.cjs');",
              "const cycleB = require('./cycle-b.cjs');",
              "const fs = require('node:fs');",
              "require.extensions['.probe'] = (loadedModule, filename) => {",
              "  loadedModule.exports = { filename, payload: fs.readFileSync(filename, 'utf8').trim() };",
              '};',
              "const customExtension = require('./custom.probe');",
              "delete require.extensions['.probe'];",
              "const shared = require('./shared.cjs');",
              'Promise.all([import(\'./interop.mjs\'), import(\'./shared.cjs\')]).then(([interop, sharedNamespace]) => {',
              '  console.log(JSON.stringify({',
              '    moduleRecord,',
              "    moduleRequire: requiredThroughModule.value === 'loaded-through-module-require',",
              '    cacheReload: firstReload.instance === 1 && secondReload.instance === 2 && firstReload !== secondReload,',
              "    cyclePartialExports: cycleB.observedAState === 'initializing' && cycleB.aReference === cycleA && cycleA.observedBState === 'ready',",
              "    mutableExtensions: customExtension.filename === '/home/commonjs-semantics/custom.probe' && customExtension.payload === 'loaded-by-custom-extension' && require.extensions['.probe'] === undefined,",
              "    cjsToEsmIdentity: interop.default === shared && interop.shared === shared && sharedNamespace.default === shared && shared.default === 'inner-commonjs-default'",
              '  }));',
              '}).catch((error) => { console.error(error); process.exitCode = 1; });'
            ].join('\n')
          }
        },
        'module-record.cjs': {
          file: {
            contents: [
              'module.exports = {',
              '  id: module.id,',
              '  filename: module.filename,',
              '  path: module.path,',
              '  hasModulePaths: Array.isArray(module.paths),',
              '  hasParent: module.parent !== null,',
              '  hasChildren: Array.isArray(module.children),',
              "  requireType: typeof module.require,",
              '  exportsReference: module.exports === exports,',
              '  loadedDuringEvaluation: module.loaded',
              '};'
            ].join('\n')
          }
        },
        'module-require.cjs': {
          file: { contents: "module.exports = { value: 'loaded-through-module-require' };" }
        },
        'reload.cjs': {
          file: {
            contents: [
              'globalThis.__commonJsReloadCount = (globalThis.__commonJsReloadCount ?? 0) + 1;',
              'module.exports = { instance: globalThis.__commonJsReloadCount };'
            ].join('\n')
          }
        },
        'cycle-a.cjs': {
          file: {
            contents: [
              "exports.state = 'initializing';",
              "const cycleB = require('./cycle-b.cjs');",
              'exports.observedBState = cycleB.state;',
              "exports.state = 'ready';"
            ].join('\n')
          }
        },
        'cycle-b.cjs': {
          file: {
            contents: [
              "const cycleA = require('./cycle-a.cjs');",
              'module.exports = { observedAState: cycleA.state, aReference: cycleA, state: \'ready\' };'
            ].join('\n')
          }
        },
        'custom.probe': {
          file: { contents: 'loaded-by-custom-extension\n' }
        },
        'shared.cjs': {
          file: {
            contents: "module.exports = { default: 'inner-commonjs-default', marker: 'shared-commonjs-value' };"
          }
        },
        'interop.mjs': {
          file: {
            contents: [
              "import shared from './shared.cjs';",
              'export { shared };',
              'export default shared;'
            ].join('\n')
          }
        }
      });

      const process = await runtime.spawn('node', ['/home/commonjs-semantics/entry.cjs']);
      const output = await collectOutput(mergeProcessOutput(process));
      return { exitCode: await process.exit, output };
    } finally {
      await runtime.teardown();
    }

    async function collectOutput(output: ReadableStream<Uint8Array>): Promise<string> {
      const reader = output.getReader();
      const decoder = new TextDecoder();
      let text = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) return text;
        text += decoder.decode(value, { stream: true });
      }
    }
  });

  expect(result.exitCode, result.output).toBe(0);
  expect(JSON.parse(result.output.trim().split('\n').at(-1) ?? '')).toEqual({
    moduleRecord: {
      id: '/home/commonjs-semantics/module-record.cjs',
      filename: '/home/commonjs-semantics/module-record.cjs',
      path: '/home/commonjs-semantics',
      hasModulePaths: true,
      hasParent: true,
      hasChildren: true,
      requireType: 'function',
      exportsReference: true,
      loadedDuringEvaluation: false
    },
    moduleRequire: true,
    cacheReload: true,
    cyclePartialExports: true,
    mutableExtensions: true,
    cjsToEsmIdentity: true
  });
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
