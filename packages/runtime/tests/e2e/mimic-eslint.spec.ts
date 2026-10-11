import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './stack-scenario';

const eslint1070Claim = defineCompatibilityClaim({
  id: 'eslint-10-7-0',
  statement: 'ESLint 10.7.0 loads flat config and reports diagnostics through immutable Mimic execution',
  target: {
    kind: 'exact-graph',
    packages: { eslint: '10.7.0' },
    packageManager: { name: 'npm', version: '11.18.0' },
    lockfile: {
      format: 'npm',
      version: 3,
      path: 'compatibility/fixtures/eslint-10.7.0/package-lock.json'
    },
    virtualPlatform: { operatingSystem: 'linux', architecture: 'wasm32', runtime: 'browser', nodeVersion: '22.22.3' },
    replacements: {},
    execution: { command: 'npm exec eslint', entrypoint: 'eslint' }
  }
});

test.use({ fixture: 'eslint-10.7.0' });

test(eslint1070Claim.statement, async ({ stack }) => {
  await stack.install();

  const version = await stack.run('npm exec -- eslint --version');
  expect(version.exitCode, version.output).toBe(0);
  expect(version.output).toContain('v10.7.0');

  const config = await stack.run('npm exec -- eslint --print-config fixture.js');
  expect(config.exitCode, config.output).toBe(0);
  expect(config.output).toContain('no-unused-vars');

  const lint = await stack.run('npm run lint');
  expect(lint.exitCode, lint.output).not.toBe(0);
  expect(lint.output).toContain('no-unused-vars');
  expect(lint.output).toContain('semi');
  expect(lint.output).toContain('File ignored because of a matching ignore pattern');
  expect(lint.output).not.toContain("'ignored' is assigned a value but never used");
  expect(await stack.exists('node_modules/eslint/bin/eslint.js')).toBe(true);
});
