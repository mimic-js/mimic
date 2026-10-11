import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';

const moduleRegistryCompatibilityClaim = defineCompatibilityClaim({
  id: 'module-execution-canonical-registry-v1',
  statement: 'Mimic uses one canonical CJS and ESM registry in each execution context',
  target: {
    kind: 'runtime-capability',
    capability: 'module-execution-canonical-registry'
  }
});

test(moduleRegistryCompatibilityClaim.statement, async ({ page }) => {
  test.setTimeout(120_000);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => message.type() === 'error' && consoleErrors.push(message.text()));
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));

  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated), { timeout: 10_000 }).toBe(true);

  const result = await page.evaluate(async () => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const runtime = await Mimic.boot({ workdir: '/home/module-registry' });
    try {
      await runtime.fs.mount({
        'entry.cjs': {
          file: {
            contents: [
              "const fs = require('node:fs');",
              "const cycle = require('./a.cjs');",
              "const first = require('./identity.cjs');",
              "delete require.cache[require.resolve('./identity.cjs')];",
              "const second = require('./identity.cjs');",
              "let failure; try { require('./repair.cjs'); } catch (error) { failure = error.message; }",
              "fs.writeFileSync('/home/module-registry/repair.cjs', 'module.exports = { repaired: true };');",
              "const repaired = require('./repair.cjs');",
              "Promise.all([import('./reader.mjs'), import('./counter.mjs'), import('./identity.cjs')]).then(([reader, counter, importedIdentity]) => {",
              '  console.log(JSON.stringify({',
              '    cycle,',
              '    cacheInvalidated: first !== second,',
              '    repaired: repaired.repaired,',
              "    mappedFailure: failure.includes('Cannot compile CommonJS module /home/module-registry/repair.cjs'),",
              '    liveBindings: { before: reader.before, after: reader.after, count: counter.count },',
              '    cjsInterop: importedIdentity.default === second && importedIdentity.identity === second.identity',
              '  }));',
              '});'
            ].join('\n')
          }
        },
        'a.cjs': {
          file: {
            contents: "exports.name = 'a'; const b = require('./b.cjs'); exports.seenByB = b.seen;"
          }
        },
        'b.cjs': {
          file: { contents: "const a = require('./a.cjs'); exports.seen = a.name;" }
        },
        'identity.cjs': {
          file: { contents: 'module.exports = { identity: {} };' }
        },
        'repair.cjs': {
          file: { contents: 'module.exports = ;' }
        },
        'counter.mjs': {
          file: {
            contents: [
              'export let count = 0;',
              'await Promise.resolve();',
              'count += 1;',
              'export function increment() { count += 1; }'
            ].join('\n')
          }
        },
        'reader.mjs': {
          file: {
            contents: [
              "import { count, increment } from './counter.mjs';",
              'export const before = count;',
              'increment();',
              'export const after = count;'
            ].join('\n')
          }
        }
      });

      const process = await runtime.spawn('node', ['/home/module-registry/entry.cjs']);
      const output = await collectOutput(process.output);
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
  const summaryLine = result.output.trim().split('\n').at(-1);
  expect(summaryLine).toBeDefined();
  expect(JSON.parse(summaryLine ?? '')).toEqual({
    cycle: { name: 'a', seenByB: 'a' },
    cacheInvalidated: true,
    repaired: true,
    mappedFailure: true,
    liveBindings: { before: 1, after: 2, count: 2 },
    cjsInterop: true
  });
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
