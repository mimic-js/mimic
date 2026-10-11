import type { Page } from '@playwright/test';

import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';

const lockfileLessInstallClaim = defineCompatibilityClaim({
  id: 'package-manager-lockfile-less-installs-v1',
  statement:
    'npm installs through its Command Proxy without a lockfile, with --no-package-lock, and with no dependencies, and a mutating install leaves npm\'s own lockfile on disk',
  target: { kind: 'runtime-capability', capability: 'package-manager-lockfile-less-installs' }
});

const untouchedInvocationClaim = defineCompatibilityClaim({
  id: 'package-manager-untouched-invocation-v1',
  statement:
    'A Command Proxy forwards global options and tool arguments untouched and passes the manager\'s exit code and stderr through unchanged',
  target: { kind: 'runtime-capability', capability: 'package-manager-untouched-invocation' }
});

const esbuildReplacementClaim = defineCompatibilityClaim({
  id: 'browser-package-replacement-esbuild-versions-v1',
  statement:
    'Two esbuild versions in one graph install concurrently, each runs its own publisher WASI binary through its asynchronous and synchronous APIs, and an esbuild published before the WASI binary is swapped at install for the nearest version that has one and runs',
  target: { kind: 'runtime-capability', capability: 'browser-package-replacement-esbuild-versions' }
});

test(lockfileLessInstallClaim.statement, async ({ page }) => {
  test.setTimeout(300_000);
  const diagnostics = await openTestHost(page);
  const result = await page.evaluate(async () => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const { runProcessToExit } = await import('/tests/e2e/process-output.ts');
    const runtime = await Mimic.boot({ workdir: '/home/lockfile-less-installs' });
    const run = async (command: string, args: string[]) =>
      runProcessToExit(await runtime.spawn(command, args), `${command} ${args.join(' ')}`, 120_000);
    const lockfilePath = `${runtime.workdir}/package-lock.json`;
    try {
      await runtime.fs.mount({
        'package.json': { file: { contents: JSON.stringify({ name: 'lockfile-less', version: '1.0.0' }) } }
      });
      const zeroDependencies = await run('npm', ['install']);
      const zeroDependencyLockfile = JSON.parse(await runtime.fs.readFile(lockfilePath, 'utf8'));
      await runtime.fs.rm(lockfilePath);
      const withoutLockfile = await run('npm', ['install', '--no-package-lock', 'is-number@7.0.0']);
      const lockfileAfterNoPackageLock = await runtime.fs.exists(lockfilePath);
      const firstLockedInstall = await run('npm', ['install', 'is-odd@3.0.1']);
      const lockedBefore = await runtime.fs.readFile(lockfilePath, 'utf8');
      const mutatingInstall = await run('npm', ['install', 'picocolors@1.1.1']);
      const lockedAfter = await runtime.fs.readFile(lockfilePath, 'utf8');
      const verify = await run('node', [
        '-e',
        "console.log(require('is-odd')(3), require('picocolors').bold('ok'), require('is-number')(1))"
      ]);
      return {
        zeroDependencies,
        zeroDependencyLockfile,
        withoutLockfile,
        lockfileAfterNoPackageLock,
        firstLockedInstall,
        lockedBefore,
        mutatingInstall,
        lockedAfter,
        npmInstallState: await runtime.fs.readFile(`${runtime.workdir}/node_modules/.package-lock.json`, 'utf8'),
        verify
      };
    } finally {
      await runtime.teardown();
    }
  });

  expect(result.zeroDependencies.exitCode, result.zeroDependencies.output).toBe(0);
  expect(result.zeroDependencyLockfile).toMatchObject({
    name: 'lockfile-less',
    lockfileVersion: 3,
    packages: { '': { name: 'lockfile-less', version: '1.0.0' } }
  });
  expect(result.withoutLockfile.exitCode, result.withoutLockfile.output).toBe(0);
  expect(result.lockfileAfterNoPackageLock).toBe(false);
  expect(result.firstLockedInstall.exitCode, result.firstLockedInstall.output).toBe(0);
  expect(result.mutatingInstall.exitCode, result.mutatingInstall.output).toBe(0);
  const before = JSON.parse(result.lockedBefore) as { packages: Record<string, Record<string, unknown>> };
  const after = JSON.parse(result.lockedAfter) as { packages: Record<string, Record<string, unknown>> };
  expect(before.packages['node_modules/picocolors']).toBeUndefined();
  expect(after.packages['']).toMatchObject({ dependencies: { 'is-odd': '^3.0.1', picocolors: '^1.1.1' } });
  expect(after.packages['node_modules/picocolors']).toMatchObject({
    version: '1.1.1',
    resolved: 'https://registry.npmjs.org/picocolors/-/picocolors-1.1.1.tgz',
    integrity: expect.stringMatching(/^sha512-/u)
  });
  // The lockfile is npm's output: it records exactly what npm says it installed.
  const installed = JSON.parse(result.npmInstallState) as { packages: Record<string, Record<string, unknown>> };
  for (const [path, entry] of Object.entries(installed.packages)) {
    expect(after.packages[path], path).toMatchObject({ version: entry.version, resolved: entry.resolved });
  }
  expect(result.lockedAfter).not.toContain('file:');
  expect(result.lockedAfter).not.toContain('.mimic');
  expect(result.verify).toEqual({ exitCode: 0, output: 'true ok true\n' });
  expect(diagnostics()).toEqual({ consoleErrors: [], pageErrors: [] });
});

test(untouchedInvocationClaim.statement, async ({ page }) => {
  test.setTimeout(300_000);
  const diagnostics = await openTestHost(page);
  const result = await page.evaluate(async () => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const { collectProcessOutput } = await import('/tests/e2e/process-output.ts');
    const runtime = await Mimic.boot({ workdir: '/home/untouched-invocation' });
    const run = async (command: string, args: string[]) => {
      const process = await runtime.spawn(command, args);
      const stderr: string[] = [];
      const output = collectProcessOutput(process, (chunk, stream) => {
        if (stream === 'stderr') stderr.push(chunk);
      });
      return { exitCode: await process.exit, output: await output.done, stderr: stderr.join('') };
    };
    try {
      await runtime.fs.mount({
        'package.json': {
          file: {
            contents: JSON.stringify({
              name: 'untouched-invocation',
              version: '1.0.0',
              scripts: {
                x: 'node -e "console.log(\'script output\')"',
                fail: 'node -e "process.stderr.write(\'custom failure\\\\n\'); process.exit(7)"'
              },
              dependencies: { 'argv-echo': 'file:./argv-echo' }
            })
          }
        },
        'argv-echo': {
          directory: {
            'package.json': {
              file: { contents: JSON.stringify({ name: 'argv-echo', version: '1.0.0', bin: { 'argv-echo': 'echo.js' } }) }
            },
            'echo.js': {
              file: { contents: '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n' }
            }
          }
        }
      });
      const install = await run('npm', ['--loglevel', 'error', 'install']);
      return {
        install,
        silentRun: await run('npm', ['-s', 'run', 'x']),
        npxFlags: await run('npx', ['argv-echo', '--flag', 'value', '-y']),
        execFlags: await run('npm', ['exec', '--', 'argv-echo', '--version']),
        failingScript: await run('npm', ['run', 'fail']),
        missingPackage: await run('npm', ['--loglevel', 'error', 'install', 'mimic-missing-package-a1b2c3'])
      };
    } finally {
      await runtime.teardown();
    }
  });

  expect(result.install.exitCode, result.install.output).toBe(0);
  expect(result.silentRun).toEqual({ exitCode: 0, output: 'script output\n', stderr: '' });
  expect(result.npxFlags).toMatchObject({ exitCode: 0, output: '["--flag","value","-y"]\n' });
  expect(result.execFlags).toMatchObject({ exitCode: 0, output: '["--version"]\n' });
  expect(result.failingScript.exitCode, result.failingScript.output).toBe(7);
  expect(result.failingScript.stderr).toContain('custom failure\n');
  expect(result.missingPackage.exitCode, result.missingPackage.output).toBe(1);
  expect(result.missingPackage.stderr).toContain('npm error code E404');
  expect(result.missingPackage.stderr).not.toContain('PackageManagerCommandProxy');
  expect(diagnostics()).toEqual({ consoleErrors: [], pageErrors: [] });
});

test(esbuildReplacementClaim.statement, async ({ page }) => {
  test.setTimeout(400_000);
  const diagnostics = await openTestHost(page);
  const result = await page.evaluate(async () => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const { runProcessToExit } = await import('/tests/e2e/process-output.ts');
    const { preparedEsbuildBinaryPath } = await import('/tests/e2e/browser-package-replacement-evidence.ts');
    const runtime = await Mimic.boot({ workdir: '/home/esbuild-versions' });
    const run = async (command: string, args: string[], cwd = runtime.workdir) =>
      runProcessToExit(await runtime.spawn(command, args, { cwd }), `${command} ${args.join(' ')}`, 180_000);
    try {
      await runtime.fs.mount({
        'package.json': {
          file: {
            contents: JSON.stringify({
              name: 'esbuild-versions',
              version: '1.0.0',
              dependencies: { esbuild: '0.25.12', 'esbuild-28': 'npm:esbuild@0.28.1' }
            })
          }
        },
        'transform.cjs': {
          file: {
            contents: [
              "const current = require('esbuild');",
              "const next = require('esbuild-28');",
              "const source = 'const answer: number = 42';",
              'Promise.all([current, next].map(async (esbuild) => ({',
              '  version: esbuild.version,',
              "  code: (await esbuild.transform(source, { loader: 'ts' })).code,",
              "  syncCode: esbuild.transformSync(source, { loader: 'ts' }).code",
              '}))).then((results) => {',
              '  console.log(JSON.stringify(results));',
              '  process.exit(0);',
              '});'
            ].join('\n')
          }
        },
        legacy: {
          directory: {
            'package.json': {
              file: { contents: JSON.stringify({ name: 'legacy', version: '1.0.0', dependencies: { esbuild: '0.21.5' } }) }
            }
          }
        }
      });
      // Both esbuild install scripts validate their binary with execFileSync, concurrently.
      const install = await run('npm', ['install']);
      if (install.exitCode !== 0) throw new Error(`npm install failed:\n${install.output}`);
      const transform = await run('node', ['transform.cjs']);
      const legacyRoot = `${runtime.workdir}/legacy`;
      const legacyInstall = await run('npm', ['install'], legacyRoot);
      if (legacyInstall.exitCode !== 0) throw new Error(`npm install failed:\n${legacyInstall.output}`);
      return {
        install,
        binaryPaths: [
          await preparedEsbuildBinaryPath(runtime.fs, `${runtime.workdir}/node_modules/esbuild`),
          await preparedEsbuildBinaryPath(runtime.fs, `${runtime.workdir}/node_modules/esbuild-28`)
        ],
        transform,
        legacyInstall,
        legacyBinaryPath: await preparedEsbuildBinaryPath(runtime.fs, `${legacyRoot}/node_modules/esbuild`),
        legacyVersion: await run('npx', ['esbuild', '--version'], legacyRoot),
        legacyBuild: await run(
          'node',
          [
            '-e',
            "const esbuild = require('esbuild'); esbuild.transform('const answer: number = 42', { loader: 'ts' })" +
              '.then(({ code }) => { console.log(JSON.stringify({ version: esbuild.version, code })); process.exit(0); },' +
              ' (error) => { console.error(error); process.exit(1); })'
          ],
          legacyRoot
        )
      };
    } finally {
      await runtime.teardown();
    }
  });

  expect(result.install.exitCode, result.install.output).toBe(0);
  expect(result.binaryPaths).toEqual(['/.mimic/bin/esbuild', '/.mimic/bin/esbuild']);
  expect(result.transform.exitCode, result.transform.output).toBe(0);
  expect(JSON.parse(result.transform.output)).toEqual([
    { version: '0.25.12', code: 'const answer = 42;\n', syncCode: 'const answer = 42;\n' },
    { version: '0.28.1', code: 'const answer = 42;\n', syncCode: 'const answer = 42;\n' }
  ]);
  expect(result.legacyInstall.exitCode, result.legacyInstall.output).toBe(0);
  expect(result.legacyBinaryPath).toBe('/.mimic/bin/esbuild');
  // @esbuild/wasi-preview1 starts at 0.22.0: the installed 0.21.5 is that version now.
  expect(result.legacyVersion).toEqual({ exitCode: 0, output: '0.22.0\n' });
  expect(result.legacyBuild.exitCode, result.legacyBuild.output).toBe(0);
  expect(JSON.parse(result.legacyBuild.output)).toEqual({ version: '0.22.0', code: 'const answer = 42;\n' });
  expect(diagnostics()).toEqual({ consoleErrors: [], pageErrors: [] });
});

async function openTestHost(page: Page): Promise<() => { consoleErrors: string[]; pageErrors: string[] }> {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated), { timeout: 10_000 }).toBe(true);
  return () => ({ consoleErrors, pageErrors });
}
