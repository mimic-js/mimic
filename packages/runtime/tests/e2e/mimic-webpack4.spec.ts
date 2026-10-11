import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './stack-scenario';

const webpack4WatchClaim = defineCompatibilityClaim({
  id: 'webpack-4-47-0-watch-rebuild-exact-graph',
  statement:
    'webpack 4.47.0 performs its frozen exact-graph install, loader/plugin build, initial watch, and VFS-triggered watch rebuild through Mimic',
  target: {
    kind: 'exact-graph',
    packages: {
      webpack: '4.47.0',
      'webpack-cli': '3.3.12',
      'webpack-dev-server': '3.11.3'
    },
    packageManager: { name: 'npm', version: '11.18.0' },
    lockfile: {
      format: 'npm',
      version: 3,
      path: 'compatibility/fixtures/webpack-4.47.0/package-lock.json'
    },
    virtualPlatform: { operatingSystem: 'linux', architecture: 'wasm32', runtime: 'browser', nodeVersion: '22.22.3' },
    replacements: {},
    execution: { command: 'npm exec webpack', entrypoint: 'webpack --watch --config webpack.config.js' }
  }
});

test.use({ fixture: 'webpack-4.47.0' });

test(webpack4WatchClaim.statement, async ({ stack }) => {
  await stack.install();

  const build = await stack.run('npm exec -- webpack --config webpack.config.js');
  expect(build.exitCode, build.output).toBe(0);
  expect(build.output).toContain('RECEIPT_PLUGIN_CHILD_OUTPUT');
  expect(await stack.readFile('dist/bundle.js')).toContain('LOADER_APPLIED_INITIAL');
  expect(await stack.readFile('dist/plugin-receipt.txt')).toBe('PLUGIN_APPLIED');

  const watch = await stack.spawn('npm exec -- webpack --watch --config webpack.config.js');
  await watch.waitForOutput('Built at:', { timeoutMs: 60_000 });
  const builds = ((await watch.settle()).match(/Built at:/g) ?? []).length;
  // webpack 4 compares modification times at a resolution of one second.
  await stack.page.waitForTimeout(1_100);
  await stack.writeFile('src/index.js', "console.log('SOURCE_MARKER_UPDATED');\n");
  await watch.waitForOutput('Built at:', { count: builds + 1, timeoutMs: 3_000 });
  expect(await stack.readFile('dist/bundle.js')).toContain('LOADER_APPLIED_UPDATED');
  expect([0, 143]).toContain(await watch.stop());
});
