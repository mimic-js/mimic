import { defineCompatibilityClaim } from './compatibility-claim';
import { documentId, expect, test } from './stack-scenario';

const webpack5Claim = defineCompatibilityClaim({
  id: 'webpack-5-108-4-dev-server-exact-graph',
  statement:
    'webpack 5.108.4 with webpack-cli 6.0.1 and webpack-dev-server 5.2.2 installs its exact graph, builds, watches, serves, hot-reloads, stops, restarts, tears down, and reboots through Mimic',
  target: {
    kind: 'exact-graph',
    packages: {
      webpack: '5.108.4',
      'webpack-cli': '6.0.1',
      'webpack-dev-server': '5.2.2'
    },
    packageManager: { name: 'npm', version: '11.18.0' },
    lockfile: {
      format: 'npm',
      version: 3,
      path: 'compatibility/fixtures/webpack-5.108.4/package-lock.json'
    },
    virtualPlatform: { operatingSystem: 'linux', architecture: 'wasm32', runtime: 'browser', nodeVersion: '22.22.3' },
    replacements: {},
    execution: {
      command: 'npm',
      entrypoint: 'run build (--config webpack.config.cjs); run watch; run serve'
    }
  }
});

test.use({ fixture: 'webpack-5.108.4' });

// The entry the dev server serves: it counts its evaluations and accepts its own hot update.
const devEntry = (marker: string) =>
  [
    'globalThis.__webpackClaimBoots = (globalThis.__webpackClaimBoots ?? 0) + 1;',
    "const status = document.getElementById('status') ?? document.body.appendChild(Object.assign(document.createElement('h1'), { id: 'status' }));",
    `status.textContent = '${marker}:' + globalThis.__webpackClaimBoots;`,
    'if (module.hot) module.hot.accept();'
  ].join('\n');

test(webpack5Claim.statement, async ({ stack }) => {
  await stack.install();

  const build = await stack.run('npm run build', { timeoutMs: 60_000 });
  expect(build.exitCode, build.output).toBe(0);
  expect(build.output).toContain('WEBPACK_CLAIM_PLUGIN');
  expect(await stack.readFile('dist/bundle.js'), build.output).toContain('LOADER_APPLIED_INITIAL');
  expect(await stack.readFile('dist/claim-plugin.txt')).toBe('PLUGIN_APPLIED');

  const watch = await stack.spawn('npm run watch');
  await watch.waitForOutput('compiled successfully', { timeoutMs: 60_000 });
  const watchBuilds = ((await watch.settle()).match(/compiled successfully/g) ?? []).length;
  await stack.writeFile('src/index.js', "console.log('SOURCE_MARKER_UPDATED');\n");
  await watch.waitForOutput('compiled successfully', { count: watchBuilds + 1 });
  await expect.poll(() => stack.readFile('dist/bundle.js')).toContain('LOADER_APPLIED_UPDATED');
  expect(await watch.output()).toContain('WEBPACK_CLAIM_PLUGIN');
  // webpack-cli and webpack-dev-server close on SIGTERM and exit 0, as they do under Node.
  expect(await watch.stop()).toBe(0);

  await stack.writeFile('src/index.js', devEntry('SOURCE_MARKER_DEV_INITIAL'));
  const server = await stack.start('npm run serve');
  expect(server.port).toBe(5173);
  await server.waitForOutput('compiled successfully', { timeoutMs: 60_000 });
  expect(await server.fetch('/')).toMatchObject({ status: 200, body: expect.stringContaining('webpack loading') });
  expect(await server.fetch('/nested/history/route')).toMatchObject({
    status: 200,
    body: expect.stringContaining('webpack loading')
  });
  expect(await server.fetch('/static-claim.txt')).toMatchObject({ status: 200, body: 'STATIC_ROUTE_OK' });
  expect(await server.fetch('/claim-plugin.txt')).toMatchObject({ status: 200, body: 'PLUGIN_APPLIED' });
  expect(await server.fetch('/bundle.js')).toMatchObject({
    status: 200,
    body: expect.stringContaining('LOADER_APPLIED_DEV_INITIAL')
  });

  // A hot update changes the page without loading its document again.
  const app = await server.open('/');
  await expect(app.locator('#status')).toHaveText('LOADER_APPLIED_DEV_INITIAL:1');
  const document = await documentId(app);
  const serveBuilds = ((await server.settle()).match(/compiled successfully/g) ?? []).length;
  await stack.writeFile('src/index.js', devEntry('SOURCE_MARKER_DEV_UPDATED'));
  await server.waitForOutput('compiled successfully', { count: serveBuilds + 1 });
  await expect(app.locator('#status')).toHaveText('LOADER_APPLIED_DEV_UPDATED:2');
  expect(await documentId(app)).toBe(document);
  expect(await server.stop()).toBe(0);
  expect((await server.fetch('/static-claim.txt')).status).not.toBe(200);

  const restarted = await stack.start('npm run serve');
  expect(restarted.port).toBe(5173);
  await restarted.waitForOutput('compiled successfully', { timeoutMs: 60_000 });
  expect(await restarted.fetch('/static-claim.txt')).toMatchObject({ status: 200, body: 'STATIC_ROUTE_OK' });
  expect(await restarted.stop()).toBe(0);

  // A server left running is ended, and its endpoint released, by the teardown every scenario asserts.
  await (await stack.start('npm run serve')).waitForOutput('compiled successfully', { timeoutMs: 60_000 });
});
