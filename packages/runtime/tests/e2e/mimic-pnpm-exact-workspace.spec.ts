import { readFileSync } from 'node:fs';

import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';
import { prepareTrackedLockfileInstall } from './tracked-lockfile-install';

const fixtureRoot = '../../compatibility/fixtures/pnpm-exact-workspace/';
const fixturePackageJsonPath = `${fixtureRoot}package.json`;
const fixturePnpmLockPath = `${fixtureRoot}pnpm-lock.yaml`;
const pnpmWorkspacePackageJson = readFixture('package.json');
const pnpmWorkspaceLockfile = readFixture('pnpm-lock.yaml');
const pnpmWorkspaceInstallFixture = prepareTrackedLockfileInstall({
  packageJson: pnpmWorkspacePackageJson,
  lockfile: pnpmWorkspaceLockfile,
  install: { command: 'pnpm', args: ['install', '--frozen-lockfile'] }
});
const pnpmWorkspaceFiles = Object.fromEntries(
  [
    '.npmrc',
    'pnpm-workspace.yaml',
    'packages/tool/package.json',
    'packages/tool/bin/workspace-tool.cjs',
    'packages/tool/scripts/verify.cjs'
  ].map((path) => [path, readFixture(path)])
);

const pnpmExactWorkspaceClaim = defineCompatibilityClaim({
  id: 'pnpm-11-11-0-exact-workspace',
  statement:
    'Mimic runs an exact upstream pnpm 11.11.0 workspace through a tracked frozen graph, native store replay, frozen-lockfile refusal, teardown, and reboot',
  target: {
    kind: 'exact-graph',
    packages: { 'is-number': '6.0.0', 'is-odd': '3.0.1' },
    packageManager: { name: 'pnpm', version: '11.11.0' },
    lockfile: {
      format: 'pnpm',
      version: 9,
      path: 'compatibility/fixtures/pnpm-exact-workspace/pnpm-lock.yaml'
    },
    virtualPlatform: { operatingSystem: 'linux', architecture: 'wasm32', runtime: 'browser', nodeVersion: '22.22.3' },
    replacements: {},
    execution: { command: 'pnpm', entrypoint: 'workspace-tool' }
  }
});

test(pnpmExactWorkspaceClaim.statement, async ({ page }, testInfo) => {
  // Canonical CI runs this cold/replay/refusal/reboot graph at Execution
  // Capacity 1. Individual pnpm commands retain their tighter 150s sentinel.
  test.setTimeout(900_000);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const onlineFailedRequests: string[] = [];
  const offlineRegistryRequests: string[] = [];
  let registryOffline = false;
  let pnpmPhase = 'browser setup';
  await page.exposeBinding('reportPnpmPhase', (_source, phase: string) => {
    pnpmPhase = phase;
  });
  await page.exposeBinding('setPnpmRegistryOffline', () => {
    registryOffline = true;
  });
  await page.exposeBinding('setPnpmRegistryOnline', () => {
    registryOffline = false;
  });
  await page.route(/^https:\/\/registry\.npmjs\.org\//u, async (route) => {
    if (!registryOffline) {
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: {
          ...response.headers(),
          'access-control-allow-origin': '*'
        }
      });
      return;
    }
    offlineRegistryRequests.push(route.request().url());
    await route.abort('internetdisconnected');
  });
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) {
      consoleErrors.push(message.text());
    }
  });
  page.on('requestfailed', (request) => {
    if (!registryOffline) {
      onlineFailedRequests.push(
        `${request.failure()?.errorText ?? 'failed'} ${request.url()}`
      );
    }
  });

  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated), { timeout: 10_000 }).toBe(true);

  const result = await page.evaluate(async (fixtureInput) => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const { collectProcessOutput } = await import('/tests/e2e/process-output.ts');
    const forbiddenFallbacks = [
      '10.0.0-mimic',
      'ourpm install:',
      'falling back to registered command adapter',
      'package-lock registry synthesis failed',
      'synthesized a minimal lockfile',
      'SHLITE_STDIN',
      'esm.sh',
      'vfsPreviewFallback',
      'ViteCommand',
      '/tooling/',
      'node_modules/pnpm/bin/pnpm'
    ];

    type Runtime = Awaited<ReturnType<typeof Mimic.boot>>;
    type FileNode = { readonly file: { readonly contents: string } };
    type DirectoryNode = { readonly directory: FileTree };
    type FileTree = Record<string, FileNode | DirectoryNode>;
    const boot = async (workdirName: string) => {
      const runtime = await Mimic.boot({ workdir: `/home/${workdirName}` });
      return runtime;
    };
    const reportPhase = (phase: string) =>
      (globalThis as typeof globalThis & { reportPnpmPhase(phase: string): Promise<void> })
        .reportPnpmPhase(phase);
    const run = async (runtime: Runtime, args: string[]) => {
      const phase = `${runtime.workdir}: pnpm ${args.join(' ')}`;
      await reportPhase(phase);
      const process = await runtime.spawn('pnpm', args, {
        env: { CI: 'true', npm_config_yes: 'true' }
      });
      const output = collectProcessOutput(process);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const exitCode = await Promise.race([
          process.exit,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error(`${phase} did not settle within 150 seconds\nPartial output:\n${output.text()}`)),
              150_000
            );
          })
        ]);
        return { exitCode, output: await output.done };
      } catch (error) {
        process.kill();
        await output.done.catch(() => undefined);
        throw error;
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    };
    const workspaceTree = (): FileTree => {
      const tree: FileTree = {};
      for (const [path, contents] of Object.entries(fixtureInput.workspaceFiles)) {
        const segments = path.split('/');
        let directory = tree;
        for (const segment of segments.slice(0, -1)) {
          const current = directory[segment];
          if (current === undefined) {
            const next: DirectoryNode = { directory: {} };
            directory[segment] = next;
            directory = next.directory;
          } else if ('directory' in current) {
            directory = current.directory;
          } else {
            throw new Error(`Fixture file conflicts with directory: ${path}`);
          }
        }
        directory[segments.at(-1)!] = { file: { contents } };
      }
      return tree;
    };
    const mount = async (runtime: Runtime) => {
      await runtime.fs.mount({ ...fixtureInput.files, ...workspaceTree() });
    };
    const storeEntries = async (runtime: Runtime) => {
      const store = `${runtime.workdir}/.pnpm-store`;
      if (!(await runtime.fs.exists(store))) return [];
      return (await runtime.fs.readdir(store)).map((entry) => (typeof entry === 'string' ? entry : entry.name)).sort();
    };
    const workspaceLinks = async (runtime: Runtime) => {
      const tool = `${runtime.workdir}/node_modules/@workspace/tool`;
      return {
        toolSymbolic: (await runtime.fs.lstat(tool)).isSymbolicLink(),
        toolRealpath: await runtime.fs.realpath(tool),
        peerVisibleToWorkspace: await runtime.fs.exists(`${runtime.workdir}/packages/tool/node_modules/is-number`),
        pnpmVirtualStoreExists: await runtime.fs.exists(`${runtime.workdir}/node_modules/.pnpm`)
      };
    };
    const entryNames = async (runtime: Runtime, path: string) =>
      (await runtime.fs.readdir(path))
        .map((entry) => (typeof entry === 'string' ? entry : entry.name))
        .sort();
    const nativeInstallState = async (runtime: Runtime) => ({
      nodeModulesEntries: await entryNames(runtime, `${runtime.workdir}/node_modules`),
      virtualStoreEntries: await entryNames(runtime, `${runtime.workdir}/node_modules/.pnpm`)
    });
    const runCompleteGraph = async (workdirName: string) => {
      await reportPhase(`${workdirName}: boot`);
      const runtime = await boot(workdirName);
      try {
        await reportPhase(`${workdirName}: mount`);
        await mount(runtime);
        const mountedLockfile = await runtime.fs.readFile(`${runtime.workdir}/pnpm-lock.yaml`, 'utf8');
        const version = await run(runtime, ['--version']);
        const installArgs = [
          ...fixtureInput.install.args,
          '--trust-lockfile',
          '--fetch-retries=0',
          `--store-dir=${runtime.workdir}/.pnpm-store`
        ];
        const coldInstall = await run(runtime, installArgs);
        if (coldInstall.exitCode !== 0) {
          throw new Error(`pnpm frozen cold install exited ${coldInstall.exitCode}: ${coldInstall.output}`);
        }
        const coldInstallLifecycleLog = await runtime.fs.readFile(
          `${runtime.workdir}/lifecycle.log`,
          'utf8'
        );
        const bin = await run(runtime, ['--filter', '@workspace/tool', 'exec', 'workspace-tool', 'installed-bin']);
        const lifecycle = await run(runtime, ['--filter', '@workspace/tool', 'run', 'verify']);
        if (bin.exitCode !== 0 || lifecycle.exitCode !== 0) {
          throw new Error(
            `pnpm workspace execution failed (bin ${bin.exitCode}, lifecycle ${lifecycle.exitCode}):\n${bin.output}\n${lifecycle.output}`
          );
        }
        const cold = {
          lockfile: await runtime.fs.readFile(`${runtime.workdir}/pnpm-lock.yaml`, 'utf8'),
          installState: await nativeInstallState(runtime),
          store: await storeEntries(runtime),
          links: await workspaceLinks(runtime),
          installLifecycleLog: coldInstallLifecycleLog,
          bin,
          lifecycle,
          lifecycleLog: await runtime.fs.readFile(`${runtime.workdir}/lifecycle.log`, 'utf8')
        };
        await runtime.fs.rm(`${runtime.workdir}/node_modules`, { recursive: true });
        await runtime.fs.writeFile(`${runtime.workdir}/lifecycle.log`, '');
        await (globalThis as typeof globalThis & { setPnpmRegistryOffline(): Promise<void> })
          .setPnpmRegistryOffline();
        const repeatInstall = await run(runtime, [...installArgs, '--offline']);
        if (repeatInstall.exitCode !== 0) {
          throw new Error(`pnpm frozen offline replay exited ${repeatInstall.exitCode}: ${repeatInstall.output}`);
        }
        const repeatInstallLifecycleLog = await runtime.fs.readFile(
          `${runtime.workdir}/lifecycle.log`,
          'utf8'
        );
        const repeatLifecycle = await run(runtime, ['--filter', '@workspace/tool', 'run', 'verify']);
        if (repeatLifecycle.exitCode !== 0) {
          throw new Error(`pnpm workspace replay failed: ${repeatLifecycle.output}`);
        }
        const repeat = {
          lockfile: await runtime.fs.readFile(`${runtime.workdir}/pnpm-lock.yaml`, 'utf8'),
          installState: await nativeInstallState(runtime),
          store: await storeEntries(runtime),
          links: await workspaceLinks(runtime),
          installLifecycleLog: repeatInstallLifecycleLog,
          lifecycle: repeatLifecycle,
          lifecycleLog: await runtime.fs.readFile(`${runtime.workdir}/lifecycle.log`, 'utf8')
        };
        await runtime.fs.writeFile(
          `${runtime.workdir}/package.json`,
          fixtureInput.packageJson.replace('"is-odd": "3.0.1"', '"is-odd": "3.0.0"')
        );
        const refusedBefore = {
          lockfile: await runtime.fs.readFile(`${runtime.workdir}/pnpm-lock.yaml`, 'utf8'),
          installState: await nativeInstallState(runtime),
          installedTool: await runtime.fs.exists(`${runtime.workdir}/node_modules/@workspace/tool`)
        };
        const failedInstall = await run(runtime, installArgs);
        const refusedAfter = {
          lockfile: await runtime.fs.readFile(`${runtime.workdir}/pnpm-lock.yaml`, 'utf8'),
          installState: await nativeInstallState(runtime),
          installedTool: await runtime.fs.exists(`${runtime.workdir}/node_modules/@workspace/tool`)
        };
        return { mountedLockfile, version, coldInstall, cold, repeatInstall, repeat, failedInstall, refusedBefore, refusedAfter };
      } finally {
        await runtime.teardown();
      }
    };

    const cold = await runCompleteGraph('pnpm-exact-cold');
    await (globalThis as typeof globalThis & { setPnpmRegistryOnline(): Promise<void> })
      .setPnpmRegistryOnline();
    const reboot = await runCompleteGraph('pnpm-exact-reboot');
    const evidence = [
      cold.version.output,
      cold.coldInstall.output,
      cold.cold.bin.output,
      cold.cold.lifecycle.output,
      cold.repeatInstall.output,
      cold.repeat.lifecycle.output,
      cold.failedInstall.output,
      reboot.coldInstall.output
    ].join('\n');
    return {
      cold,
      reboot,
      observedFallbacks: forbiddenFallbacks.filter((marker) => evidence.includes(marker))
    };
  }, {
    files: pnpmWorkspaceInstallFixture.files,
    install: pnpmWorkspaceInstallFixture.install,
    packageJson: pnpmWorkspacePackageJson,
    workspaceFiles: pnpmWorkspaceFiles
  }).catch((error) => {
    throw new Error(
      [
        `pnpm browser witness failed during "${pnpmPhase}": ${error instanceof Error ? error.message : String(error)}`,
        `Online failed requests:\n${onlineFailedRequests.join('\n') || '(none)'}`,
        `Console errors:\n${consoleErrors.join('\n') || '(none)'}`
      ].join('\n')
    );
  });

  for (const run of [result.cold, result.reboot]) {
    expect(run.mountedLockfile).toBe(pnpmWorkspaceLockfile);
    expect(run.version.exitCode, run.version.output).toBe(0);
    expect(run.version.output.trim().split('\n').at(-1)).toBe('11.11.0');
    expect(run.coldInstall.exitCode, run.coldInstall.output).toBe(0);
    expect(run.cold.bin.exitCode, run.cold.bin.output).toBe(0);
    expect(run.cold.lifecycle.exitCode, run.cold.lifecycle.output).toBe(0);
    pnpmWorkspaceInstallFixture.assertLockfileUnchanged(run.cold.lockfile);
    expect(run.cold.installState.nodeModulesEntries).toEqual(
      expect.arrayContaining(['.bin', '.pnpm', '@workspace', 'is-number', 'is-odd'])
    );
    expect(run.cold.installState.virtualStoreEntries).toEqual(
      expect.arrayContaining(['is-number@6.0.0', 'is-odd@3.0.1'])
    );
    expect(run.cold.store.length).toBeGreaterThan(0);
    expect(run.cold.links).toEqual({
      toolSymbolic: true,
      toolRealpath: `/home/${run === result.cold ? 'pnpm-exact-cold' : 'pnpm-exact-reboot'}/packages/tool`,
      peerVisibleToWorkspace: true,
      pnpmVirtualStoreExists: true
    });
    expect(run.cold.bin.output).toContain('workspace-bin:true:true:installed-bin');
    expect(run.cold.installLifecycleLog).toBe('workspace-lifecycle:true:true:postinstall\n');
    expect(run.cold.lifecycleLog).toBe(
      'workspace-lifecycle:true:true:postinstall\nworkspace-lifecycle:true:true:verify\n'
    );
    expect(run.repeatInstall.exitCode, run.repeatInstall.output).toBe(0);
    expect(run.repeat.lifecycle.exitCode, run.repeat.lifecycle.output).toBe(0);
    pnpmWorkspaceInstallFixture.assertLockfileUnchanged(run.repeat.lockfile);
    expect(run.repeat.installState).toEqual(run.cold.installState);
    expect(run.repeat.store).toEqual(run.cold.store);
    expect(run.repeat.links).toEqual(run.cold.links);
    expect(run.repeat.installLifecycleLog).toBe('workspace-lifecycle:true:true:postinstall\n');
    expect(run.repeat.lifecycleLog).toBe(
      'workspace-lifecycle:true:true:postinstall\nworkspace-lifecycle:true:true:verify\n'
    );
    expect(run.failedInstall.exitCode, run.failedInstall.output).not.toBe(0);
    expect(run.refusedAfter).toEqual(run.refusedBefore);
  }

  expect(offlineRegistryRequests).toEqual([]);
  expect(onlineFailedRequests).toEqual([]);
  expect(result.observedFallbacks).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await testInfo.attach('pnpm-exact-workspace-receipt', {
    body: JSON.stringify({
      schemaVersion: 2,
      claim: pnpmExactWorkspaceClaim,
      fixture: {
        packageJson: { path: fixturePackageJsonPath, contents: pnpmWorkspacePackageJson },
        lockfile: {
          path: fixturePnpmLockPath,
          contents: pnpmWorkspaceLockfile,
          generatedBy: 'pnpm 11.11.0 outside browser execution',
          consumedBy: 'pnpm 11.11.0 default runtime program'
        }
      },
      result
    }),
    contentType: 'application/json'
  });
});

function readFixture(path: string): string {
  return readFileSync(new URL(`${fixtureRoot}${path}`, import.meta.url), 'utf8');
}
