import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';

const nodeCompatibilityClaim = defineCompatibilityClaim({
  id: 'node-compatibility-context-bootstrap-v1',
  statement: 'Mimic bootstraps isolated Node Compatibility before entry evaluation',
  target: {
    kind: 'runtime-capability',
    capability: 'node-compatibility-context-bootstrap'
  }
});

const nodePreloadCustomizationHooksClaim = defineCompatibilityClaim({
  id: 'node-compatibility-preloads-customization-hooks-v1',
  statement: 'Mimic runs ordered Node preloads and node:module customization hooks without cross-process leakage',
  target: {
    kind: 'runtime-capability',
    capability: 'node-compatibility-preloads-customization-hooks'
  }
});

const preloadForbiddenFallbacks = [
  'falling back to registered command adapter',
  'esm.sh',
  'host Node',
  'vfsPreviewFallback'
] as const;

test(nodeCompatibilityClaim.statement, async ({ page }) => {
  test.setTimeout(120_000);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => message.type() === 'error' && consoleErrors.push(message.text()));
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));

  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated), { timeout: 10_000 }).toBe(true);

  const result = await page.evaluate(async () => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const firstRuntime = await Mimic.boot({ workdir: '/home/node-compatibility' });
    let first: { exitCode: number; output: string };
    let sameRuntime: { exitCode: number; output: string };
    try {
      await firstRuntime.fs.mount(fixture());
      first = await run(firstRuntime, '/home/node-compatibility/entry.cjs');
      sameRuntime = await run(firstRuntime, '/home/node-compatibility/isolation.cjs');
    } finally {
      await firstRuntime.teardown();
    }

    const secondRuntime = await Mimic.boot({ workdir: '/home/node-compatibility' });
    let second: { exitCode: number; output: string };
    try {
      await secondRuntime.fs.mount(fixture());
      second = await run(secondRuntime, '/home/node-compatibility/isolation.cjs');
    } finally {
      await secondRuntime.teardown();
    }

    return { first, sameRuntime, second };

    function fixture() {
      return {
        'entry.cjs': {
          file: {
            contents: [
              "const fs = require('fs');",
              "const qualifiedFs = require('node:fs');",
              "const processBuiltin = require('node:process');",
              "const os = require('node:os');",
              "const buffer = require('node:buffer');",
              "const timers = require('node:timers');",
              "const url = require('node:url');",
              "const moduleBuiltin = require('node:module');",
              "const vm = require('node:vm');",
              "const createdRequire = moduleBuiltin.createRequire(__filename);",
              "const compileCache = moduleBuiltin.enableCompileCache();",
              "const declaredGlobals = ['process', 'console', 'Buffer', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask'];",
              "const timerGlobals = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask'];",
              'let unknownBuiltin;',
              "try { require('node:not-a-builtin'); } catch (error) { unknownBuiltin = { name: error.name, code: error.code }; }",
              "import('./interop.mjs').then((interop) => {",
              '  const initiallyIsolated = !Object.prototype.hasOwnProperty.call(fs, "__nodeCompatibilityMarker");',
              '  fs.__nodeCompatibilityMarker = process.pid;',
              '  console.log(JSON.stringify({',
              '    globalsBeforeEntry: global === globalThis && declaredGlobals.every((name) => Object.prototype.hasOwnProperty.call(globalThis, name)),',
              '    processIdentity: [process.version, process.platform, process.arch, process.versions.node, os.platform(), os.arch()],',
              '    bufferIdentity: Buffer === buffer.Buffer && Buffer.from("globals").toString() === "globals",',
              '    urlIdentity: URL === url.URL && URLSearchParams === url.URLSearchParams && new URL("/identity", "https://runtime.invalid").pathname === "/identity",',
              '    textCodecRoundtrip: new TextDecoder().decode(new TextEncoder().encode("mimic")),',
              '    timerIdentity: timerGlobals.slice(0, -1).every((name) => globalThis[name] === timers[name]) && typeof queueMicrotask === "function",',
              '    builtinIdentity: fs === qualifiedFs && processBuiltin === require("process"),',
              '    moduleInterface: moduleBuiltin === require("module") && createdRequire("./identity.cjs") === require("./identity.cjs") && moduleBuiltin.Module._cache === require.cache && moduleBuiltin.Module._extensions === require.extensions,',
              '    moduleMetadata: ["module", "vm", "buffer", "crypto", "events", "stream", "stream/promises", "string_decoder", "zlib"].every((name) => moduleBuiltin.builtinModules.includes(name) && moduleBuiltin.isBuiltin(`node:${name}`)),',
              '    compileCachePolicy: compileCache.status === moduleBuiltin.constants.compileCacheStatus.ALREADY_ENABLED && moduleBuiltin.getCompileCacheDir() === undefined,',
              '    scriptEvaluator: vm.runInThisContext("40 + 2", { filename: "runtime-vm.js" }) === 42 && new vm.Script("21 * 2").runInThisContext() === 42,',
              '    cjsEsmInterop: interop.fsDefault === fs && interop.readFileSync === fs.readFileSync && interop.processDefault === process,',
              '    initiallyIsolated,',
              '    unknownBuiltin',
              '  }));',
              '});'
            ].join('\n')
          }
        },
        'interop.mjs': {
          file: {
            contents: [
              "import fsDefault, { readFileSync } from 'node:fs';",
              "import processDefault from 'node:process';",
              'export { fsDefault, readFileSync, processDefault };'
            ].join('\n')
          }
        },
        'identity.cjs': {
          file: { contents: 'module.exports = { identity: {} };' }
        },
        'isolation.cjs': {
          file: {
            contents: [
              "const fs = require('node:fs');",
              "const declaredGlobals = ['process', 'console', 'Buffer', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask'];",
              'console.log(JSON.stringify({',
              '  globalsBeforeEntry: global === globalThis && declaredGlobals.every((name) => Object.prototype.hasOwnProperty.call(globalThis, name)),',
              '  isolated: !Object.prototype.hasOwnProperty.call(fs, "__nodeCompatibilityMarker")',
              '}));'
            ].join('\n')
          }
        }
      };
    }

    async function run(runtime: InstanceType<typeof Mimic>, entry: string) {
      const process = await runtime.spawn('node', [entry]);
      const output = await collectOutput(process.output);
      return { exitCode: await process.exit, output };
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

  expect(result.first.exitCode, result.first.output).toBe(0);
  expect(JSON.parse(result.first.output.trim().split('\n').at(-1) ?? '')).toEqual({
    globalsBeforeEntry: true,
    processIdentity: ['v22.22.3', 'linux', 'wasm32', '22.22.3', 'linux', 'wasm32'],
    bufferIdentity: true,
    urlIdentity: true,
    textCodecRoundtrip: 'mimic',
    timerIdentity: true,
    builtinIdentity: true,
    moduleInterface: true,
    moduleMetadata: true,
    compileCachePolicy: true,
    scriptEvaluator: true,
    cjsEsmInterop: true,
    initiallyIsolated: true,
    unknownBuiltin: { name: 'NodeCompatibilityError', code: 'ERR_UNKNOWN_BUILTIN_MODULE' }
  });
  expect(result.second.exitCode, result.second.output).toBe(0);
  expect(result.sameRuntime.exitCode, result.sameRuntime.output).toBe(0);
  expect(JSON.parse(result.sameRuntime.output.trim().split('\n').at(-1) ?? '')).toEqual({
    globalsBeforeEntry: true,
    isolated: true
  });
  expect(JSON.parse(result.second.output.trim().split('\n').at(-1) ?? '')).toEqual({
    globalsBeforeEntry: true,
    isolated: true
  });
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test(nodePreloadCustomizationHooksClaim.statement, async ({ page }) => {
  test.setTimeout(120_000);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => message.type() === 'error' && consoleErrors.push(message.text()));
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));

  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated), { timeout: 10_000 }).toBe(true);

  const result = await page.evaluate(async () => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const firstRuntime = await Mimic.boot({ workdir: '/home/node-preload-hooks' });
    const firstCleanup = { tornDown: false };

    let preloaded: { exitCode: number; output: string };
    let sameRuntime: { exitCode: number; output: string };
    try {
      await firstRuntime.fs.mount(fixture());
      preloaded = await run(firstRuntime, [
        '--import',
        `${firstRuntime.workdir}/import-first.mjs`,
        '--require',
        `${firstRuntime.workdir}/require-first.cjs`,
        '--require',
        `${firstRuntime.workdir}/require-second.cjs`,
        '--import',
        `${firstRuntime.workdir}/register-preload.mjs`,
        `${firstRuntime.workdir}/entry.mjs`
      ]);
      sameRuntime = await run(firstRuntime, [`${firstRuntime.workdir}/isolation.mjs`]);
    } finally {
      await firstRuntime.teardown();
      firstCleanup.tornDown = true;
    }

    const rebootedRuntime = await Mimic.boot({ workdir: '/home/node-preload-hooks-reboot' });
    const rebootCleanup = { tornDown: false };

    let reboot: { exitCode: number; output: string };
    try {
      await rebootedRuntime.fs.mount(fixture());
      reboot = await run(rebootedRuntime, [`${rebootedRuntime.workdir}/isolation.mjs`]);
    } finally {
      await rebootedRuntime.teardown();
      rebootCleanup.tornDown = true;
    }

    return {
      preloaded,
      sameRuntime,
      reboot,
      firstCleanup,
      rebootCleanup
    };

    function fixture() {
      return {
        'require-first.cjs': {
          file: { contents: "(globalThis.__preloadTrace ??= []).push('require:first');" }
        },
        'require-second.cjs': {
          file: { contents: "globalThis.__preloadTrace.push('require:second');" }
        },
        'import-first.mjs': {
          file: { contents: "globalThis.__preloadTrace.push('import:first');" }
        },
        'register-preload.mjs': {
          file: {
            contents: [
              "import moduleBuiltin from 'node:module';",
              "globalThis.__preloadTrace.push('import:register');",
              "moduleBuiltin.register(new URL('./hook.mjs', import.meta.url), { data: { initialized: 'preload-data' } });"
            ].join('\n')
          }
        },
        'hook.mjs': {
          file: {
            contents: [
              "let initialized = 'missing';",
              'export async function initialize(data) { initialized = data.initialized; }',
              'export async function resolve(specifier, _context, nextResolve) {',
              "  if (specifier === 'preload-hook-target') return { url: new URL('./hook-target.mjs', import.meta.url).href, shortCircuit: true };",
              '  return nextResolve(specifier, _context);',
              '}',
              'export async function load(url, _context, nextLoad) {',
              "  if (url.endsWith('/hook-target.mjs')) return { format: 'module', source: `export const value = ${JSON.stringify(initialized + ':load')};`, shortCircuit: true };",
              '  return nextLoad(url, _context);',
              '}'
            ].join('\n')
          }
        },
        'hook-target.mjs': {
          file: { contents: "export const value = 'unmodified-source';" }
        },
        'entry.mjs': {
          file: {
            contents: [
              "import { value } from 'preload-hook-target';",
              "globalThis.__preloadTrace.push('entry');",
              'console.log(JSON.stringify({ trace: globalThis.__preloadTrace, value }));'
            ].join('\n')
          }
        },
        'isolation.mjs': {
          file: {
            contents: [
              "import { value } from './hook-target.mjs';",
              "console.log(JSON.stringify({ inheritedPreloadTrace: globalThis.__preloadTrace ?? null, value }));"
            ].join('\n')
          }
        }
      };
    }

    async function run(runtime: InstanceType<typeof Mimic>, args: string[]) {
      const process = await runtime.spawn('node', args);
      const output = await collectOutput(process.output);
      return { exitCode: await process.exit, output };
    }

    async function collectOutput(output: ReadableStream<Uint8Array>): Promise<string> {
      const reader = output.getReader();
      const decoder = new TextDecoder();
      let text = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return text;
          text += decoder.decode(value, { stream: true });
        }
      } finally {
        reader.releaseLock();
      }
    }
  });

  expect(result.preloaded.exitCode, result.preloaded.output).toBe(0);
  expect(JSON.parse(result.preloaded.output.trim().split('\n').at(-1) ?? '')).toEqual({
    trace: ['require:first', 'require:second', 'import:first', 'import:register', 'entry'],
    value: 'preload-data:load'
  });
  for (const witness of [result.sameRuntime, result.reboot]) {
    expect(witness.exitCode, witness.output).toBe(0);
    expect(JSON.parse(witness.output.trim().split('\n').at(-1) ?? '')).toEqual({
      inheritedPreloadTrace: null,
      value: 'unmodified-source'
    });
  }
  expect(result.firstCleanup).toEqual({ tornDown: true });
  expect(result.rebootCleanup).toEqual({ tornDown: true });

  const evidence = [
    result.preloaded.output,
    result.sameRuntime.output,
    result.reboot.output,
    ...pageErrors,
    ...consoleErrors
  ].join('\n');
  for (const forbidden of preloadForbiddenFallbacks) {
    expect(evidence, `forbidden fallback ${forbidden}`).not.toContain(forbidden);
  }
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
