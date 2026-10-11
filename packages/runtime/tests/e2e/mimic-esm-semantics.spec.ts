import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';

const esmSemanticsCompatibilityClaim = defineCompatibilityClaim({
  id: 'module-execution-esm-semantics-v1',
  statement: 'Mimic links and evaluates Node-shaped ESM graphs',
  target: {
    kind: 'runtime-capability',
    capability: 'module-execution-esm-semantics'
  }
});

test(esmSemanticsCompatibilityClaim.statement, async ({ page }) => {
  test.setTimeout(120_000);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => message.type() === 'error' && consoleErrors.push(message.text()));
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));

  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated), { timeout: 10_000 }).toBe(true);

  const result = await page.evaluate(async () => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const runtime = await Mimic.boot({ workdir: '/home/esm-semantics' });
    try {
      await runtime.fs.mount({
        'entry.cjs': {
          file: {
            contents: [
              "const required = require('./required.mjs');",
              "Promise.all([import('./entry.mjs'), import('./barrel.mjs')]).then(([entry, barrel]) => {",
              '  console.log(JSON.stringify({',
              '    entry,',
              '    barrelCurrent: barrel.current,',
              '    required: {',
              '      values: { default: required.default, alpha: required.alpha, zebra: required.zebra, __esModule: required.__esModule },',
              '      nullPrototype: Object.getPrototypeOf(required) === null,',
              '      extensible: Object.isExtensible(required),',
              '      tag: Object.prototype.toString.call(required),',
              '      keys: Reflect.ownKeys(required).map(String),',
              "      rejectedWrite: !Reflect.set(required, 'alpha', 'changed'),",
              '      alphaAfterWrite: required.alpha',
              '    }',
              '  }));',
              '});'
            ].join('\n')
          }
        },
        'state.mjs': {
          file: {
            contents: [
              'let count = 0;',
              'export { count as value };',
              'export function increment() { count += 1; }'
            ].join('\n')
          }
        },
        'star.mjs': {
          file: { contents: "export const star = 'star';" }
        },
        'barrel.mjs': {
          file: {
            contents: [
              "export { value as current, increment } from './state.mjs';",
              "export * from './star.mjs';"
            ].join('\n')
          }
        },
        'cycle-a.mjs': {
          file: {
            contents: [
              "import { readValue } from './cycle-b.mjs';",
              "export let value = 'linked';",
              'export function readCycle() { return readValue(); }'
            ].join('\n')
          }
        },
        'cycle-b.mjs': {
          file: {
            contents: [
              "import { value } from './cycle-a.mjs';",
              'export function readValue() { return value; }'
            ].join('\n')
          }
        },
        'lazy.mjs': {
          file: { contents: "export const value = 'lazy';" }
        },
        'entry.mjs': {
          file: {
            contents: [
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
          }
        },
        'required.mjs': {
          file: {
            contents: "export const zebra = 'last';\nexport default 42;\nexport const alpha = 'first';"
          }
        }
      });

      const process = await runtime.spawn('node', ['/home/esm-semantics/entry.cjs']);
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
    entry: {
      before: 0,
      after: 1,
      lazy: 'lazy',
      cycle: 'linked',
      current: 1,
      star: 'star'
    },
    barrelCurrent: 1,
    required: {
      values: { default: 42, alpha: 'first', zebra: 'last', __esModule: true },
      nullPrototype: true,
      extensible: false,
      tag: '[object Module]',
      keys: ['__esModule', 'alpha', 'default', 'zebra', 'Symbol(Symbol.toStringTag)'],
      rejectedWrite: true,
      alphaAfterWrite: 'first'
    }
  });
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
