import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './stack-scenario';

const rollupWasmNodeClaim = defineCompatibilityClaim({
  id: 'rollup-4-62-4-wasm-node-execution',
  statement:
    'Rollup 4.62.4 executes its official same-version wasm-node replacement through Mimic',
  target: {
    kind: 'exact-graph',
    packages: { rollup: '4.62.4' },
    packageManager: { name: 'npm', version: '11.18.0' },
    lockfile: {
      format: 'npm',
      version: 3,
      path: 'compatibility/fixtures/rollup-4-native-request-4.62.4/package-lock.json'
    },
    virtualPlatform: { operatingSystem: 'linux', architecture: 'wasm32', runtime: 'browser', nodeVersion: '22.22.3' },
    replacements: {
      rollup: '@rollup/wasm-node@4.62.4'
    },
    execution: {
      command: 'node',
      entrypoint: 'Rollup Node API and node_modules/rollup/dist/bin/rollup'
    }
  }
});

test.use({ fixture: 'rollup-4-native-request-4.62.4' });

test(rollupWasmNodeClaim.statement, async ({ stack, tarballCacheEvidence }) => {
  const before = tarballCacheEvidence();
  await stack.install('npm ci', { layer: false });
  const after = tarballCacheEvidence();
  expect(after.requests - before.requests).toBeGreaterThan(0);

  // The replacement is installed under the source package's name; no native binding is.
  expect(await stack.installedPackage('node_modules/rollup')).toBe(rollupWasmNodeClaim.target.replacements.rollup);
  for (const [path, entry] of Object.entries(stack.lockfile.packages)) {
    const nativeOptional = entry.optional === true && (Array.isArray(entry.cpu) || Array.isArray(entry.os));
    if (path.startsWith('node_modules/') && nativeOptional) {
      expect(await stack.exists(`${path}/package.json`), path).toBe(false);
    }
  }

  const api = await stack.run('node api.mjs', { timeoutMs: 60_000 });
  expect(api.exitCode, api.output).toBe(0);
  expect(api.output).toContain('ROLLUP_API_OK 4.62.4');
  expect(await stack.readFile('dist/api.js'), api.output).toContain('catalog-api');

  const cli = await stack.run('node node_modules/rollup/dist/bin/rollup --config rollup.config.mjs', {
    timeoutMs: 60_000
  });
  expect(cli.exitCode, cli.output).toBe(0);
  expect(cli.output).toMatch(/created\s+(?:\u001b\[[0-9;]*m)?dist\/cli\.js/);
  expect(await stack.readFile('dist/cli.js'), cli.output).toContain('catalog-cli');
});
