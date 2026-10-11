import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './stack-scenario';

const prettierShellLifecycleClaim = defineCompatibilityClaim({
  id: 'prettier-3-9-5-shell-lifecycle',
  statement: 'Prettier 3.9.5 formats files and stdin through immutable Mimic shell execution',
  target: {
    kind: 'exact-graph',
    packages: { prettier: '3.9.5' },
    packageManager: { name: 'npm', version: '11.18.0' },
    lockfile: {
      format: 'npm',
      version: 3,
      path: 'compatibility/fixtures/prettier-3.9.5/package-lock.json'
    },
    virtualPlatform: { operatingSystem: 'linux', architecture: 'wasm32', runtime: 'browser', nodeVersion: '22.22.3' },
    replacements: {},
    execution: { command: 'npm exec prettier', entrypoint: 'prettier' }
  }
});

test.use({ fixture: 'prettier-3.9.5' });

test(prettierShellLifecycleClaim.statement, async ({ stack }) => {
  await stack.install();

  const version = await stack.run('npm exec -- prettier --version');
  expect(version.exitCode, version.output).toBe(0);
  expect(version.output).toContain('3.9.5');

  // `.prettierrc.cjs` refuses to load without the variable, the working directory and the bin path of this spawn.
  const formatFile = await stack.run('npm run format-file', { env: { PRETTIER_RECEIPT: 'public-spawn' } });
  expect(formatFile.exitCode, formatFile.output).toBe(0);
  expect(await stack.readFile('fixture.js'), formatFile.output).toBe('const file = { answer: 42 }\n');

  const fromStdin = await stack.spawn('npm exec -- prettier --stdin-filepath stdin.js', {
    env: { PRETTIER_RECEIPT: 'public-stdin' }
  });
  await fromStdin.write("const stdin={value:'from stdin'}\n", { end: true });
  const formatted = await fromStdin.exit(15_000);
  expect(formatted.exitCode, formatted.output).toBe(0);
  expect(formatted.output).toContain("const stdin = { value: 'from stdin' }\n");

  const missingFile = await stack.run('npm exec -- prettier --check missing.js');
  expect(missingFile.exitCode, missingFile.output).not.toBe(0);
  expect(missingFile.output).toContain('missing.js');
  expect(await stack.exists('node_modules/prettier/bin/prettier.cjs')).toBe(true);
});
