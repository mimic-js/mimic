import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './stack-scenario';

const rollup3DefaultClaim = defineCompatibilityClaim({
  id: 'rollup-3-default-3-29-4',
  statement: 'Rollup 3.29.4 default profile installs its exact graph through Mimic',
  target: {
    kind: 'exact-graph',
    packages: { rollup: '3.29.4' },
    packageManager: { name: 'npm', version: '11.18.0' },
    lockfile: {
      format: 'npm',
      version: 3,
      path: 'compatibility/fixtures/rollup-3-default-3.29.4/package-lock.json'
    },
    virtualPlatform: { operatingSystem: 'linux', architecture: 'wasm32', runtime: 'browser', nodeVersion: '22.22.3' },
    replacements: {},
    execution: { command: 'node', entrypoint: 'rollup API and CLI' }
  }
});

const rollup3DefaultCliClaim = defineCompatibilityClaim({
  ...rollup3DefaultClaim,
  id: 'rollup-3-default-3-29-4-cli-output',
  statement:
    'Rollup 3.29.4 CLI applies its config, writes split ESM and CommonJS outputs, and serves the ESM output through Mimic',
  target: {
    ...rollup3DefaultClaim.target,
    execution: { command: 'node', entrypoint: 'node_modules/rollup/dist/bin/rollup --config' }
  }
});

const rollup3BrowserClaim = defineCompatibilityClaim({
  id: 'rollup-3-browser-3-29-4',
  statement:
    'Rollup Browser 3.29.4 generates configured split ESM and CommonJS outputs through Mimic',
  target: {
    kind: 'exact-graph',
    packages: { '@rollup/browser': '3.29.4' },
    packageManager: { name: 'npm', version: '11.18.0' },
    lockfile: {
      format: 'npm',
      version: 3,
      path: 'compatibility/fixtures/rollup-3-browser-3.29.4/package-lock.json'
    },
    virtualPlatform: { operatingSystem: 'linux', architecture: 'wasm32', runtime: 'browser', nodeVersion: '22.22.3' },
    replacements: {},
    execution: { command: 'browser', entrypoint: '@rollup/browser rollup API' }
  }
});

test.describe(() => {
  test.use({ fixture: 'rollup-3-default-3.29.4' });

  test(rollup3DefaultClaim.statement, async ({ stack }) => {
    await stack.install();
    const api = await stack.run('node rollup-default-profile.cjs');
    expect(api.exitCode, api.output).toBe(0);
    expect(api.output).toContain('ROLLUP_3_DEFAULT_API 3.29.4');
  });

  test(rollup3DefaultCliClaim.statement, async ({ stack }) => {
    await stack.install();
    const cli = await stack.run('node node_modules/rollup/dist/bin/rollup --config');
    expect(cli.exitCode, cli.output).toBe(0);
    expect(await stack.listFiles('cli-dist')).toEqual(
      expect.arrayContaining([
        'cjs/admin.cjs',
        'cjs/entry.cjs',
        'esm/admin.js',
        'esm/entry.js',
        expect.stringMatching(/^cjs\/chunks\//),
        expect.stringMatching(/^esm\/chunks\//)
      ])
    );

    const server = await stack.start('node server.cjs');
    expect((await server.fetch('/')).status).toBe(200);
    const app = await server.open('/');
    await expect(app.locator('body')).toHaveText('Rollup 3 default CLI output: 42');
    expect(await server.stop()).toBe(143);
  });
});

test.describe(() => {
  test.use({ fixture: 'rollup-3-browser-3.29.4' });

  test(rollup3BrowserClaim.statement, async ({ stack }) => {
    await stack.install();
    const server = await stack.start('node server.cjs');
    const app = await server.open('/');
    await expect(app.locator('body')).toHaveText('Rollup 3 browser output: 42', { timeout: 60_000 });
    const generated = await app.locator('body').evaluate(() => Reflect.get(window, '__rollup3Browser'));
    expect(generated).toEqual({
      version: '3.29.4',
      outputs: { esm: 4, cjs: 4, hasSharedChunk: true, hasDynamicChunk: true }
    });
    expect(await server.stop()).toBe(143);
  });
});
