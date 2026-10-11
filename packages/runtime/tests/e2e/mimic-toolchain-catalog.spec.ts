import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';

const toolchainCatalogArtifactCacheClaim = defineCompatibilityClaim({
  id: 'package-manager-toolchain-catalog-artifact-cache-v1',
  statement:
    'Package Manager Command Proxies select exact npm, pnpm, and Yarn profiles and lazily provision integrity-checked artifacts',
  target: {
    kind: 'runtime-capability',
    capability: 'package-manager-toolchain-catalog-artifact-cache'
  }
});

test(toolchainCatalogArtifactCacheClaim.statement, async ({ page }) => {
  test.setTimeout(180_000);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => message.type() === 'error' && consoleErrors.push(message.text()));
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));

  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => globalThis.crossOriginIsolated), { timeout: 10_000 }).toBe(true);

  const result = await page.evaluate(async () => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const { collectProcessOutput } = await import('/tests/e2e/process-output.ts');
    const run = async (
      runtime: Awaited<ReturnType<typeof Mimic.boot>>,
      command: string
    ) => {
      const process = await runtime.spawn(command, ['--version']);
      const output = collectProcessOutput(process);
      return { exitCode: await process.exit, output: (await output.done).trim() };
    };
    const readProfile = async (
      runtime: Awaited<ReturnType<typeof Mimic.boot>>,
      manager: 'npm' | 'pnpm' | 'yarn',
      version: string
    ) => JSON.parse(
      await runtime.fs.readFile(
        `/.mimic/toolchains/${manager}/${version}/package.json`,
        'utf8'
      )
    ) as { name: string; version: string };
    const runYarnProfile = async (linker: 'node-modules' | 'pnp') => {
      const runtime = await Mimic.boot({ workdir: `/home/yarn-${linker}` });
      try {
        await runtime.fs.mount({
          'package.json': {
            file: { contents: JSON.stringify({ packageManager: 'yarn@4.17.1' }) }
          },
          '.yarnrc.yml': { file: { contents: `nodeLinker: ${linker}\n` } }
        });
        const execution = await run(runtime, 'yarn');
        return {
          execution,
          profile: await readProfile(runtime, 'yarn', '4.17.1')
        };
      } finally {
        await runtime.teardown();
      }
    };

    const primary = await (async () => {
      const runtime = await Mimic.boot({ workdir: '/home/toolchain-proxies' });
      try {
        return {
          npm: await run(runtime, 'npm'),
          npmCached: await run(runtime, 'npm'),
          npmProfile: await readProfile(runtime, 'npm', '11.18.0'),
          pnpm: await run(runtime, 'pnpm'),
          pnpmProfile: await readProfile(runtime, 'pnpm', '11.11.0')
        };
      } finally {
        await runtime.teardown();
      }
    })();
    return {
      ...primary,
      yarnNodeModules: await runYarnProfile('node-modules'),
      yarnPnp: await runYarnProfile('pnp')
    };
  });

  expect(result.npm).toEqual({ exitCode: 0, output: '11.18.0' });
  expect(result.npmCached).toEqual({ exitCode: 0, output: '11.18.0' });
  expect(result.npmProfile).toMatchObject({ name: 'npm', version: '11.18.0' });
  expect(result.pnpm.exitCode).toBe(0);
  expect(result.pnpm.output).toContain('11.11.0');
  expect(result.pnpmProfile).toMatchObject({ name: 'pnpm', version: '11.11.0' });
  expect(result.yarnNodeModules.profile).toMatchObject({
    name: '@yarnpkg/cli-dist',
    version: '4.17.1'
  });
  expect(result.yarnPnp.profile).toMatchObject({
    name: '@yarnpkg/cli-dist',
    version: '4.17.1'
  });
  expect(result.yarnNodeModules.execution.output).not.toContain('Cannot resolve the Yarn');
  expect(result.yarnPnp.execution.output).not.toContain('Cannot resolve the Yarn');
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
