import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './stack-scenario';

const typescript6CompilerWatchClaim = defineCompatibilityClaim({
  id: 'typescript-6-0-2-compiler-watch',
  statement:
    'TypeScript 6.0.2 compiles, watches VFS mutations, reports diagnostics, and classifies node:async_hooks support through immutable Mimic execution',
  target: {
    kind: 'exact-graph',
    packages: { '@typescript/typescript6': '6.0.2' },
    packageManager: { name: 'npm', version: '11.18.0' },
    lockfile: {
      format: 'npm',
      version: 3,
      path: 'compatibility/fixtures/typescript-6.0.2/package-lock.json'
    },
    virtualPlatform: { operatingSystem: 'linux', architecture: 'wasm32', runtime: 'browser', nodeVersion: '22.22.3' },
    replacements: {},
    execution: { command: 'npm exec tsc6', entrypoint: 'tsc6' }
  }
});

test.use({ fixture: 'typescript-6.0.2' });

test(typescript6CompilerWatchClaim.statement, async ({ stack }) => {
  await stack.install();

  const version = await stack.run('npm exec -- tsc6 --version');
  expect(version.exitCode, version.output).toBe(0);
  expect(version.output).toContain('6.0.2');

  const compile = await stack.run('npm run typecheck');
  expect(compile.exitCode, compile.output).toBe(0);
  expect(await stack.readFile('dist/success.js'), compile.output).toContain('exports.answer = 42;');

  const diagnostics = await stack.run('npm exec -- tsc6 --project tsconfig.diagnostic.json --pretty false');
  expect(diagnostics.exitCode, diagnostics.output).not.toBe(0);
  expect(diagnostics.output).toContain("Type 'number' is not assignable to type 'string'.");

  const supportedAsyncHooks = await stack.run('node async-hooks-supported.cjs');
  expect(supportedAsyncHooks.exitCode, supportedAsyncHooks.output).toBe(0);
  expect(supportedAsyncHooks.output).toContain(
    'ASYNC_HOOKS_SYNCHRONOUS_SCOPE_SUPPORTED:typescript-6:typescript-6-supported-boundary'
  );
  const inertAsyncHook = await stack.run('node async-hooks-rejected.cjs');
  expect(inertAsyncHook.exitCode, inertAsyncHook.output).toBe(0);
  expect(inertAsyncHook.output).toContain('ASYNC_HOOKS_CREATE_HOOK_INERT:0');

  // Each mutation of the watched tree is followed by one rebuild without errors.
  const watch = await stack.spawn('npm run watch');
  await watch.waitForOutput('Watching for file changes.');
  const rebuilt = (count: number) => watch.waitForOutput('Found 0 errors', { count });
  const builds = ((await watch.output()).match(/Found 0 errors/g) ?? []).length;
  await stack.writeFile('src/watch/nested/seed.ts', "export const seed: string = 'changed';\n");
  await rebuilt(builds + 1);
  await stack.writeFile('src/watch/nested/created.ts', 'export const created = true;\n');
  await rebuilt(builds + 2);
  await stack.rm('src/watch/nested/created.ts');
  await rebuilt(builds + 3);
  await stack.rename('src/watch/nested/rename-from.ts', 'src/watch/nested/rename-to.ts');
  await rebuilt(builds + 4);
  expect(((await watch.output()).match(/File change detected/g) ?? []).length).toBeGreaterThanOrEqual(4);
  expect(await watch.stop()).toBe(143);

  // A watch left running is ended by the teardown, which every scenario asserts.
  await (await stack.spawn('npm run watch')).waitForOutput('Watching for file changes.');
});
