import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';

const runtimeFormatsClaim = defineCompatibilityClaim({
  id: 'module-execution-runtime-formats-v1',
  statement: 'Mimic loads Node-defined runtime formats with source provenance',
  target: {
    kind: 'runtime-capability',
    capability: 'module-execution-runtime-formats'
  }
});

test(runtimeFormatsClaim.statement, async ({ page }) => {
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
    const runtime = await Mimic.boot({ workdir: '/home/runtime-formats' });
    try {
      await runtime.fs.mount({
        'package.json': {
          file: { contents: '{ "name": "runtime-formats", "type": "module" }' }
        },
        'entry.mts': {
          file: {
            contents: [
              "import config from './config.json' with { type: 'json' };",
              "import legacy from './legacy.cts';",
              "import os from 'node:os';",
              "import { answer } from './value.ts';",
              "import * as wasm from './answer.wasm';",
              "const repeatedLegacy = await import('./legacy.cts');",
              'let mappedError;',
              "try { await import('./invalid.mts'); } catch (error) {",
              '  mappedError = { code: error.code, source: error.location?.source, line: error.location?.line };',
              '}',
              'let mappedRuntimeError;',
              "try { await import('./runtime-error.mts'); } catch (error) {",
              '  mappedRuntimeError = { name: error.name, message: error.message, code: error.code };',
              '}',
              'let mappedReExportError;',
              "try { await import('./re-export-error.mts'); } catch (error) {",
              '  mappedReExportError = { name: error.name, message: error.message, code: error.code };',
              '}',
              'console.log(JSON.stringify({',
              '  value: `${config.label}:${answer + legacy.offset}:${wasm.answer()}`,',
              "  builtinPlatform: os.platform(),",
              '  syntheticIdentity: repeatedLegacy.default === legacy,',
              '  mappedError,',
              '  mappedRuntimeError,',
              '  mappedReExportError',
              '}));'
            ].join('\n')
          }
        },
        'config.json': {
          file: { contents: '{ "label": "formats" }' }
        },
        'legacy.cts': {
          file: {
            contents: 'const offset: number = 1;\nmodule.exports = { offset };'
          }
        },
        'value.ts': {
          file: {
            contents: 'export interface Answer { value: number }\nexport const answer: Answer["value"] = 41;'
          }
        },
        'invalid.mts': {
          file: {
            contents: 'export const valid: number = 1;\nexport const broken: = 2;'
          }
        },
        'runtime-error.mts': {
          file: {
            contents:
              "import {\n  answer\n} from './value.ts';\nconst runtimeAnswer: number = answer;\nthrow new Error(`runtime:${runtimeAnswer}`);"
          }
        },
        're-export-error.mts': {
          file: {
            contents:
              "export {\n  answer\n} from './value.ts';\nthrow new Error('runtime:re-export');"
          }
        },
        'answer.wasm': {
          file: {
            contents: Uint8Array.from([
              0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
              0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f,
              0x03, 0x02, 0x01, 0x00,
              0x07, 0x0a, 0x01, 0x06, 0x61, 0x6e, 0x73, 0x77, 0x65, 0x72, 0x00, 0x00,
              0x0a, 0x06, 0x01, 0x04, 0x00, 0x41, 0x2a, 0x0b
            ])
          }
        }
      });

      const process = await runtime.spawn('node', ['/home/runtime-formats/entry.mts']);
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
  const summaryLine = result.output.trim().split('\n').at(-1);
  expect(summaryLine).toBeDefined();
  expect(JSON.parse(summaryLine ?? '')).toEqual({
    value: 'formats:42:42',
    builtinPlatform: 'linux',
    syntheticIdentity: true,
    mappedError: {
      code: 'ERR_RUNTIME_ARTIFACT_COMPILE',
      source: '/home/runtime-formats/invalid.mts',
      line: 2
    },
    // A value thrown while a module evaluates reaches the program's catch unchanged.
    mappedRuntimeError: { name: 'Error', message: 'runtime:41' },
    mappedReExportError: { name: 'Error', message: 'runtime:re-export' }
  });
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
