import { readFileSync } from 'node:fs';

import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';
import { prepareTrackedLockfileInstall } from './tracked-lockfile-install';

const exactWorkspacePackageJson = readFileSync(
  new URL('../../compatibility/fixtures/npm-exact-workspace/package.json', import.meta.url),
  'utf8'
);
const exactWorkspacePackageLock = readFileSync(
  new URL('../../compatibility/fixtures/npm-exact-workspace/package-lock.json', import.meta.url),
  'utf8'
);
const exactWorkspaceInstallFixture = prepareTrackedLockfileInstall({
  packageJson: exactWorkspacePackageJson,
  lockfile: exactWorkspacePackageLock,
  install: { command: 'npm', args: ['ci'] }
});

const exactWorkspaceClaim = defineCompatibilityClaim({
  id: 'npm-11-18-0-exact-workspace-shell-lifecycle',
  statement:
    'Upstream npm 11.18.0 preserves a frozen workspace graph, the esbuild replacement launcher, and shell lifecycle execution through Mimic',
  target: {
    kind: 'exact-graph',
    packages: { esbuild: '0.25.12' },
    packageManager: { name: 'npm', version: '11.18.0' },
    lockfile: {
      format: 'npm',
      version: 3,
      path: 'compatibility/fixtures/npm-exact-workspace/package-lock.json'
    },
    virtualPlatform: { operatingSystem: 'linux', architecture: 'wasm32', runtime: 'browser', nodeVersion: '22.22.3' },
    replacements: {},
    execution: { command: 'npm run verify', entrypoint: '@workspace/tool' }
  }
});

const packageExecutionRoutingClaim = defineCompatibilityClaim({
  id: 'process-execution-package-execution-routing-v1',
  statement:
    'Package Manager Command Proxies run every npm invocation as the selected upstream manager Runtime Process and pass its exit code and output through',
  target: {
    kind: 'runtime-capability',
    capability: 'process-execution-package-execution-routing'
  }
});

test(
  [
    exactWorkspaceClaim,
    packageExecutionRoutingClaim
  ].map(({ statement }) => statement).join(' / '),
  async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) {
      consoleErrors.push(message.text());
    }
  });
  page.on('requestfailed', (request) => failedRequests.push(`${request.failure()?.errorText ?? 'failed'} ${request.url()}`));

  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated), { timeout: 10_000 }).toBe(true);

  const result = await page.evaluate(async (fixtureInput) => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const { collectProcessOutput } = await import('/tests/e2e/process-output.ts');
    const { ESBUILD_REPLACEMENT_LAUNCHER, preparedEsbuildBinaryPath } = await import(
      '/tests/e2e/browser-package-replacement-evidence.ts'
    );
    const sourceLockfile = fixtureInput.files['package-lock.json'].file.contents;
    const forbiddenFallbacks = [
      '10.0.0-mimic',
      'ourpm install:',
      'falling back to registered command adapter',
      'package-lock registry synthesis failed',
      'synthesized a minimal lockfile',
      'SHLITE_STDIN',
      'esm.sh',
      'vfsPreviewFallback',
      'ViteCommand'
    ];

    const workspaceFiles = {
      packages: {
        directory: {
          tool: {
            directory: {
              'package.json': {
                file: {
                  contents: JSON.stringify({
                    name: '@workspace/tool',
                    version: '1.0.0',
                    type: 'module',
                    bin: { 'workspace-tool': 'bin/workspace-tool.mjs' },
                    scripts: {
                      preverify: 'node scripts/marker.mjs preverify',
                      verify:
                        "workspace-tool 'quoted value' | node scripts/consume.mjs > output.txt && node scripts/marker.mjs verify",
                      postverify: 'node scripts/marker.mjs postverify'
                    }
                  })
                }
              },
              bin: {
                directory: {
                  'workspace-tool.mjs': {
                    file: {
                      contents: [
                        "import fs from 'node:fs';",
                        "const linkPath = process.cwd().replace(/\\/packages\\/tool$/, '') + '/node_modules/@workspace/tool';",
                        "console.log('workspace-bin', fs.lstatSync(linkPath).isSymbolicLink(), fs.realpathSync(linkPath), process.argv[2]);"
                      ].join('\n')
                    }
                  }
                }
              },
              scripts: {
                directory: {
                  'marker.mjs': {
                    file: {
                      contents:
                        "console.log('lifecycle', process.argv[2], process.env.npm_lifecycle_event, process.cwd());"
                    }
                  },
                  'consume.mjs': {
                    file: {
                      contents: [
                        'const chunks = [];',
                        'for await (const chunk of process.stdin) chunks.push(chunk);',
                        "console.log('consumer', Buffer.concat(chunks).toString('utf8').trim());"
                      ].join('\n')
                    }
                  }
                }
              }
            }
          }
        }
      }
    } as const;

    const boot = async (workdirName: string) => {
      const runtime = await Mimic.boot({ workdir: `/home/${workdirName}` });
      return runtime;
    };
    const run = async (
      runtime: Awaited<ReturnType<typeof Mimic.boot>>,
      command: string,
      args: string[]
    ) => {
      const process = await runtime.spawn(command, args);
      const output = collectProcessOutput(process);
      return { exitCode: await process.exit, output: await output.done };
    };
    const mount = async (
      runtime: Awaited<ReturnType<typeof Mimic.boot>>,
      lockfile: string
    ) => {
      await runtime.fs.mount({
        ...fixtureInput.files,
        ...workspaceFiles,
        'package-lock.json': { file: { contents: lockfile } }
      });
    };
    const runCompleteGraph = async (workdirName: string) => {
      const runtime = await boot(workdirName);
      try {
        await mount(runtime, sourceLockfile);
        const mountedLockfile = await runtime.fs.readFile(`${runtime.workdir}/package-lock.json`, 'utf8');
        const version = await run(runtime, 'npm', ['--version']);
        const install = await run(runtime, 'npm', ['ci']);
        if (install.exitCode !== 0) {
          throw new Error(`npm ci exited ${install.exitCode}: ${install.output}`);
        }
        const workspaceBin = await run(runtime, 'npm', [
          'exec',
          '--workspace',
          '@workspace/tool',
          '--',
          'workspace-tool',
          `${workdirName}-bin`
        ]);
        const lifecycle = await run(runtime, 'npm', [
          'run',
          '--workspace',
          '@workspace/tool',
          'verify'
        ]);
        const outputPath = `${runtime.workdir}/packages/tool/output.txt`;
        const output = await runtime.fs.exists(outputPath)
          ? await runtime.fs.readFile(outputPath, 'utf8')
          : '';
        const installedLockfile = await runtime.fs.readFile(`${runtime.workdir}/package-lock.json`, 'utf8');
        const esbuildVersion = await run(runtime, 'npx', ['esbuild', '--version']);
        const workspaceLink = await runtime.fs.lstat(`${runtime.workdir}/node_modules/@workspace/tool`);
        const workspaceRealpath = await runtime.fs.realpath(`${runtime.workdir}/node_modules/@workspace/tool`);
        const esbuildManifest = JSON.parse(
          await runtime.fs.readFile(`${runtime.workdir}/node_modules/esbuild/package.json`, 'utf8')
        ) as { name?: string; version?: string };
        const esbuildBinaryPath = await preparedEsbuildBinaryPath(
          runtime.fs,
          `${runtime.workdir}/node_modules/esbuild`
        );
        return {
          mountedLockfile,
          version,
          install,
          workspaceBin,
          lifecycle,
          output,
          installedLockfile,
          esbuildVersion,
          esbuildBinaryPath,
          workspaceLink: { symbolicLink: workspaceLink.isSymbolicLink() },
          workspaceRealpath,
          esbuildManifest
        };
      } finally {
        await runtime.teardown();
      }
    };
    const runFailure = async (kind: 'manager' | 'cancel') => {
      const runtime = await boot(`npm-exact-${kind}-failure`);
      try {
        await mount(runtime, sourceLockfile);
        const process = await runtime.spawn(
          'npm',
          kind === 'manager'
            ? ['ci', '--workspace', '@workspace/missing']
            : ['ci']
        );
        if (kind === 'cancel') process.kill('SIGTERM');
        const output = await collectProcessOutput(process).done;
        const exitCode = await process.exit;
        return {
          exitCode,
          output,
          lockfile: await runtime.fs.readFile(`${runtime.workdir}/package-lock.json`, 'utf8')
        };
      } finally {
        await runtime.teardown();
      }
    };

    const cold = await runCompleteGraph('npm-exact-cold');
    const managerFailure = await runFailure('manager');
    const reboot = await runCompleteGraph('npm-exact-reboot');
    const cancellation = await runFailure('cancel');
    const evidence = [
      cold.version.output,
      cold.install.output,
      cold.workspaceBin.output,
      cold.lifecycle.output,
      reboot.install.output,
      managerFailure.output,
      cancellation.output
    ].join('\n');
    return {
      launcher: ESBUILD_REPLACEMENT_LAUNCHER,
      cold,
      reboot,
      managerFailure,
      cancellation,
      observedFallbacks: forbiddenFallbacks.filter((fallback) => evidence.includes(fallback))
    };
  }, { files: exactWorkspaceInstallFixture.files });

  for (const run of [result.cold, result.reboot]) {
    expect(run.mountedLockfile).toBe(exactWorkspacePackageLock);
    expect(run.version.exitCode, run.version.output).toBe(0);
    expect(run.version.output.trim()).toBe('11.18.0');
    expect(run.install.exitCode, run.install.output).toBe(0);
    expect(run.workspaceBin.exitCode, run.workspaceBin.output).toBe(0);
    expect(run.lifecycle.exitCode, run.lifecycle.output).toBe(0);
    exactWorkspaceInstallFixture.assertLockfileUnchanged(run.installedLockfile);
    expect(run.workspaceLink).toEqual({ symbolicLink: true });
    expect(run.workspaceRealpath).toContain('/packages/tool');
    expect(run.workspaceBin.output).toContain(`workspace-bin true ${run.workspaceRealpath}`);
    expect(run.lifecycle.output).toMatch(/lifecycle preverify[\s\S]*lifecycle verify[\s\S]*lifecycle postverify/);
    expect(run.output).toContain(`consumer workspace-bin true ${run.workspaceRealpath} quoted value`);
    expect(run.esbuildManifest).toMatchObject({
      name: 'esbuild',
      version: '0.25.12'
    });
    expect(run.esbuildBinaryPath).toBe(result.launcher);
    expect(run.esbuildVersion).toEqual({ exitCode: 0, output: '0.25.12\n' });
  }

  expect(result.managerFailure.exitCode, result.managerFailure.output).toBe(1);
  expect(result.managerFailure.output).toContain('No workspaces found');
  expect(result.managerFailure.output).toContain('@workspace/missing');
  expect(result.managerFailure.lockfile).toBe(exactWorkspacePackageLock);
  expect(result.cancellation.exitCode, result.cancellation.output).toBe(143);
  expect(result.cancellation.lockfile).toBe(exactWorkspacePackageLock);
  expect(result.observedFallbacks).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(
    failedRequests.every((failure) => failure.startsWith('net::ERR_ABORTED ')),
    failedRequests.join('\n')
  ).toBe(true);
  await testInfo.attach('npm-11-18-exact-workspace-evidence', {
    body: JSON.stringify({ schemaVersion: 2, ...result }),
    contentType: 'application/json'
  });
  }
);
