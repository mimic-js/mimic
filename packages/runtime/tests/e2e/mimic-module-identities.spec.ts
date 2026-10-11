import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';

const moduleIdentityCompatibilityClaim = defineCompatibilityClaim({
  id: 'module-execution-node-22-identities-v1',
  statement: 'Mimic preserves canonical Node 22 module identities',
  target: {
    kind: 'runtime-capability',
    capability: 'module-execution-node-22-identities'
  }
});

test(moduleIdentityCompatibilityClaim.statement, async ({ page }) => {
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
    const runtime = await Mimic.boot({ workdir: '/home/module-identities' });
    try {
      await runtime.fs.mount({
        'package.json': {
          file: {
            contents: JSON.stringify({
              name: 'module-identity-app',
              type: 'commonjs',
              exports: {
                './feature': {
                  import: './feature.mjs',
                  require: './feature.cjs',
                  default: './feature-fallback.cjs'
                }
              },
              imports: {
                '#internal': {
                  import: './internal.mjs',
                  require: './internal.cjs',
                  default: './internal-fallback.cjs'
                },
                '#external': 'external-identity'
              }
            })
          }
        },
        'entry.cjs': {
          file: {
            contents: [
              "const fs = require('node:fs');",
              "fs.symlinkSync('./real.cjs', '/home/module-identities/link.cjs');",
              "const real = require('./real.cjs');",
              "const linked = require('./link.cjs');",
              "const fileUrl = require('file:///home/module-identities/real.cjs');",
              "const directFeature = require('./feature.cjs');",
              "const requiredFeature = require('module-identity-app/feature');",
              "const directInternal = require('./internal.cjs');",
              "const requiredInternal = require('#internal');",
              "const directExternal = require('external-identity');",
              "const requiredExternal = require('#external');",
              "const requiredBuiltin = require('fs');",
              "const prefixedBuiltin = require('node:fs');",
              "const stream = require('node:stream');",
              "const tty = require('node:tty');",
              "const requiredSynthetic = require('./synthetic.cjs');",
              'let privateExportCode;',
              "try { require('module-identity-app/private.cjs'); } catch (error) { privateExportCode = error.code; }",
              "const dataSpecifier = 'data:text/javascript,' + encodeURIComponent('export const answer = 42;\\nexport const identity = import.meta.url;\\nexport const filename = import.meta.filename;\\nexport const dirname = import.meta.dirname;\\nexport default answer;');",
              'let dataRequireRejected = false;',
              'try { require(dataSpecifier); } catch (error) { dataRequireRejected = error.message.startsWith("Cannot require a data: module from CommonJS:"); }',
              'Promise.all([',
              "  import('module-identity-app/feature'),",
              "  import('./feature.mjs'),",
              "  import('#internal'),",
              "  import('./internal.mjs'),",
              "  import('fs'),",
              "  import('node:fs'),",
              '  import(dataSpecifier),',
              '  import(dataSpecifier),',
              "  import('./special ;:@&=+$,~#%.mjs'),",
              "  import('./synthetic.cjs'),",
              "  import('./synthetic.cjs')",
              ']).then(([importedFeature, directImportedFeature, importedInternal, directImportedInternal, bareBuiltin, nodeBuiltin, firstData, secondData, specialFile, firstSynthetic, secondSynthetic]) => {',
              '  console.log(JSON.stringify({',
              '    fileUrlIdentity: fileUrl === real,',
              '    symlinkIdentity: linked === real,',
              "    selfReference: requiredFeature === directFeature && importedFeature === directImportedFeature && requiredFeature.mode === 'require' && importedFeature.mode === 'import',",
              "    packageImports: requiredInternal === directInternal && importedInternal === directImportedInternal && requiredExternal === directExternal && requiredInternal.mode === 'require' && importedInternal.mode === 'import',",
              '    exportsEncapsulation: privateExportCode,',
              '    builtinIdentity: requiredBuiltin === prefixedBuiltin && bareBuiltin === nodeBuiltin && bareBuiltin.default === requiredBuiltin,',
              '    ttyStreamIdentity: Object.getPrototypeOf(tty.ReadStream.prototype) === stream.Readable.prototype && Object.getPrototypeOf(tty.WriteStream.prototype) === stream.Writable.prototype,',
              '    dataIdentity: firstData === secondData && firstData.answer === 42 && firstData.default === 42 && firstData.identity === dataSpecifier && firstData.filename === undefined && firstData.dirname === undefined,',
              '    dataBoundaries: dataRequireRejected,',
              "    fileUrlEncoding: specialFile.identity === 'file:///home/module-identities/special%20;:@&=+$,%7E%23%25.mjs',",
              '    syntheticIdentity: firstSynthetic === secondSynthetic && firstSynthetic.default === requiredSynthetic && firstSynthetic.marker === requiredSynthetic.marker',
              '  }));',
              '});'
            ].join('\n')
          }
        },
        'real.cjs': {
          file: { contents: 'module.exports = { identity: {} };' }
        },
        'special ;:@&=+$,~#%.mjs': {
          file: { contents: 'export const identity = import.meta.url;\n' }
        },
        'synthetic.cjs': {
          file: { contents: 'module.exports = { marker: {} };' }
        },
        'feature.cjs': {
          file: { contents: "const identity = {}; module.exports = { mode: 'require', identity };" }
        },
        'feature.mjs': {
          file: { contents: "export const mode = 'import';\nexport const identity = {};" }
        },
        'feature-fallback.cjs': {
          file: { contents: "module.exports = { mode: 'fallback' };" }
        },
        'internal.cjs': {
          file: { contents: "const identity = {}; module.exports = { mode: 'require', identity };" }
        },
        'internal.mjs': {
          file: { contents: "export const mode = 'import';\nexport const identity = {};" }
        },
        'internal-fallback.cjs': {
          file: { contents: "module.exports = { mode: 'fallback' };" }
        },
        'private.cjs': {
          file: { contents: "module.exports = { private: true };" }
        },
        node_modules: {
          directory: {
            'external-identity': {
              directory: {
                'package.json': {
                  file: {
                    contents: JSON.stringify({
                      name: 'external-identity',
                      exports: './index.cjs'
                    })
                  }
                },
                'index.cjs': {
                  file: { contents: "const identity = {}; module.exports = { mode: 'external', identity };" }
                }
              }
            }
          }
        }
      });

      const process = await runtime.spawn('node', ['/home/module-identities/entry.cjs']);
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
    fileUrlIdentity: true,
    symlinkIdentity: true,
    selfReference: true,
    packageImports: true,
    exportsEncapsulation: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
    builtinIdentity: true,
    ttyStreamIdentity: true,
    dataIdentity: true,
    dataBoundaries: true,
    fileUrlEncoding: true,
    syntheticIdentity: true
  });
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
