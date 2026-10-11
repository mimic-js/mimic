import { readFileSync } from 'node:fs';

import type { Page } from '@playwright/test';

import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';
import { prepareTrackedLockfileInstall } from './tracked-lockfile-install';

// Every process worker asks the Runtime Host's compile service for its
// modules, which compiles each distinct source once, in its compiler pool, and
// persists the compiled text in the origin private file system. A persisted
// entry is written only when a source is compiled, so an unchanged set of
// entries, each with the time it was written, proves that nothing compiled.

const installFixture = prepareTrackedLockfileInstall({
  packageJson: readFileSync(
    new URL('../../compatibility/fixtures/vanilla-vite-6.4.3/package.json', import.meta.url),
    'utf8'
  ),
  lockfile: readFileSync(
    new URL('../../compatibility/fixtures/vanilla-vite-6.4.3/package-lock.json', import.meta.url),
    'utf8'
  ),
  install: { command: 'npm', args: ['ci'] }
});

const compileOnceClaim = defineCompatibilityClaim({
  id: 'module-execution-compile-once-v1',
  statement:
    'Mimic compiles each module source once, ahead of first use after an install, and reuses it across processes and reloads',
  target: {
    kind: 'runtime-capability',
    capability: 'module-execution-compile-once'
  }
});

const projectFiles = {
  ...installFixture.files,
  'index.html': { file: { contents: '<!doctype html><script type="module" src="/main.js"></script>' } },
  'main.js': { file: { contents: 'document.body.textContent = "ready";' } },
  'entry.mjs': {
    file: { contents: "import value from './value.cjs';\nconsole.log(`value:${value}`);" }
  },
  'value.cjs': { file: { contents: 'module.exports = 42;' } }
};

type Phase = Readonly<{
  installMs: number;
  /** Persisted entries after the install, once ahead-of-time compilation settled. */
  installed: Record<string, number>;
  /** Persisted entries after `node entry.mjs` ran twice. */
  afterNode: Record<string, number>;
  /** Persisted entries after the first of the two runs. */
  afterFirstNode: Record<string, number>;
  /** Persisted entries after Vite's development server became ready. */
  afterVite: Record<string, number>;
  nodeOutput: string;
  viteReadyMs: number;
}>;

test(compileOnceClaim.statement, async ({ page }) => {
  test.setTimeout(300_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));

  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated)).toBe(true);
  const cold = await runPhase(page);

  // A new epoch of the same origin: the Virtual File System starts empty, the
  // compiled text does not.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated)).toBe(true);
  const warm = await runPhase(page);

  console.log(
    JSON.stringify({
      entries: Object.keys(cold.afterVite).length,
      coldViteReadyMs: cold.viteReadyMs,
      warmViteReadyMs: warm.viteReadyMs,
      coldInstallMs: cold.installMs,
      warmInstallMs: warm.installMs
    })
  );

  expect(cold.nodeOutput).toBe('value:42\nvalue:42\n');
  // The install compiled the installed JavaScript before anything loaded it.
  expect(Object.keys(cold.installed).length).toBeGreaterThan(50);
  // The second process compiled nothing: the first one's output was shared.
  expect(cold.afterNode).toEqual(cold.afterFirstNode);
  expect(Object.keys(cold.afterFirstNode)).toEqual(
    expect.arrayContaining([expect.stringMatching(/^module-/), expect.stringMatching(/^commonjs-/)])
  );
  // After the reload, installing, running node and starting Vite compiled nothing.
  expect(warm.installed).toEqual(cold.afterVite);
  expect(warm.afterVite).toEqual(cold.afterVite);
  expect(pageErrors).toEqual([]);
});

async function runPhase(page: Page): Promise<Phase> {
  return page.evaluate(async (files) => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const { collectProcessOutput } = await import('/tests/e2e/process-output.ts');

    const persistedEntries = async (): Promise<Record<string, number>> => {
      const entries: Record<string, number> = {};
      const root = await navigator.storage.getDirectory();
      const cache = await root.getDirectoryHandle('mimic-compile-cache', { create: true });
      for await (const [, version] of (cache as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
        if (version.kind !== 'directory') continue;
        for await (const [name, file] of (version as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
          // A `.crswap` file is Chromium's copy of an entry being written; it goes when the write ends.
          if (file.kind === 'file' && !name.endsWith('.crswap')) {
            entries[name] = (await (file as FileSystemFileHandle).getFile()).lastModified;
          }
        }
      }
      return entries;
    };
    /** Entries are written in the background; waits until they stop changing. */
    const settledEntries = async (): Promise<Record<string, number>> => {
      let previous = JSON.stringify(await persistedEntries());
      for (let stable = 0; stable < 6;) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const current = JSON.stringify(await persistedEntries());
        stable = current === previous ? stable + 1 : 0;
        previous = current;
      }
      return JSON.parse(previous) as Record<string, number>;
    };

    const runtime = await Mimic.boot({ workdir: '/home/compile-cache' });
    try {
      await runtime.fs.mount(files);
      const installStart = performance.now();
      const install = await runtime.spawn('npm', ['ci'], { cwd: runtime.workdir });
      const installOutput = collectProcessOutput(install);
      if ((await install.exit) !== 0) throw new Error(`npm ci failed: ${await installOutput.done}`);
      const installMs = Math.round(performance.now() - installStart);
      const installed = await settledEntries();

      let nodeOutput = '';
      const runNode = async () => {
        const node = await runtime.spawn('node', ['entry.mjs'], { cwd: runtime.workdir });
        const output = collectProcessOutput(node);
        if ((await node.exit) !== 0) throw new Error(`node failed: ${await output.done}`);
        nodeOutput += await output.done;
      };
      await runNode();
      const afterFirstNode = await settledEntries();
      await runNode();
      const afterNode = await settledEntries();

      let unsubscribe: (() => void) | undefined;
      const published = new Promise<void>((resolve) => {
        unsubscribe = runtime.endpoints.on('published', () => resolve());
      });
      const viteStart = performance.now();
      const vite = await runtime.spawn('npm', ['run', 'dev'], { cwd: runtime.workdir });
      const viteOutput = collectProcessOutput(vite);
      const outcome = await Promise.race([
        published.then(() => 'ready' as const),
        vite.exit.then(() => 'exit' as const)
      ]);
      const viteReadyMs = Math.round(performance.now() - viteStart);
      unsubscribe?.();
      if (outcome !== 'ready') throw new Error(`vite exited before it was ready: ${viteOutput.text()}`);
      vite.kill('SIGTERM');
      await vite.exit;
      const afterVite = await settledEntries();
      return { installMs, installed, afterFirstNode, afterNode, afterVite, nodeOutput, viteReadyMs };
    } finally {
      await runtime.teardown();
    }
  }, projectFiles);
}
