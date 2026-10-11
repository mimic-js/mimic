import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';

const parcelWatcherClaim = defineCompatibilityClaim({
  id: 'browser-package-replacement-parcel-watcher-v1',
  statement:
    '@parcel/watcher 2.4.1 installed by npm runs as @parcel/watcher-wasm and reports files created, changed and deleted under a subscribed directory',
  target: { kind: 'runtime-capability', capability: 'browser-package-replacement-parcel-watcher' }
});

const watchSource = [
  "const fs = require('node:fs');",
  "const watcher = require('@parcel/watcher');",
  "const root = `${process.cwd()}/watched`;",
  'void (async () => {',
  '  const seen = [];',
  '  const subscription = await watcher.subscribe(root, (error, events) => {',
  '    if (error) throw error;',
  '    seen.push(...events.map((event) => `${event.type} ${event.path.slice(root.length)}`));',
  '  });',
  "  fs.writeFileSync(`${root}/nested/existing.txt`, 'changed');",
  "  fs.writeFileSync(`${root}/created.txt`, 'created');",
  '  setTimeout(() => fs.rmSync(`${root}/created.txt`), 300);',
  '  setTimeout(async () => {',
  '    await subscription.unsubscribe();',
  "    const manifest = JSON.parse(fs.readFileSync('node_modules/@parcel/watcher/package.json', 'utf8'));",
  '    console.log(JSON.stringify({ name: manifest.name, seen: seen.sort() }));',
  '  }, 1500);',
  '})();'
].join('\n');

test(parcelWatcherClaim.statement, async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated)).toBe(true);

  const result = await page.evaluate(async (watch) => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const { runProcessToExit } = await import('/tests/e2e/process-output.ts');
    const runtime = await Mimic.boot({ workdir: '/home/parcel-watcher' });
    const run = async (command: string, args: string[]) =>
      runProcessToExit(await runtime.spawn(command, args), `${command} ${args.join(' ')}`, 180_000);
    try {
      await runtime.fs.mount({
        'package.json': {
          file: {
            contents: JSON.stringify({
              name: 'parcel-watcher',
              version: '1.0.0',
              dependencies: { '@parcel/watcher': '2.4.1' }
            })
          }
        },
        'watch.cjs': { file: { contents: watch } },
        watched: { directory: { nested: { directory: { 'existing.txt': { file: { contents: 'existing' } } } } } }
      });
      const install = await run('npm', ['install']);
      if (install.exitCode !== 0) throw new Error(`npm install failed:\n${install.output}`);
      return await run('node', ['watch.cjs']);
    } finally {
      await runtime.teardown();
    }
  }, watchSource);

  expect(result.exitCode, result.output).toBe(0);
  expect(JSON.parse(result.output)).toEqual({
    name: '@parcel/watcher-wasm',
    seen: ['create /created.txt', 'delete /created.txt', 'update /nested/existing.txt']
  });
});
