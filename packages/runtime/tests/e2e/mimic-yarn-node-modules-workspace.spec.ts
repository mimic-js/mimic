import { readFileSync } from 'node:fs';

import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';
import { prepareTrackedLockfileInstall } from './tracked-lockfile-install';

const fixtureRoot = '../../compatibility/fixtures/yarn-node-modules-workspace/';
const fixturePackageJsonPath = `${fixtureRoot}package.json`;
const fixtureYarnLockPath = `${fixtureRoot}yarn.lock`;
const yarnWorkspacePackageJson = readFixture('package.json');
const yarnWorkspaceLockfile = readFixture('yarn.lock');
const yarnWorkspaceInstallFixture = prepareTrackedLockfileInstall({
  packageJson: yarnWorkspacePackageJson,
  lockfile: yarnWorkspaceLockfile,
  install: { command: 'yarn', args: ['install', '--immutable', '--immutable-cache'] }
});
const yarnWorkspaceFiles = Object.fromEntries(
  [
    '.yarnrc.yml',
    'packages/archive-dependency/package.json',
    'packages/archive-dependency/index.cjs',
    'packages/tool/package.json',
    'packages/tool/scripts/verify.cjs',
    'packages/dependency/package.json',
    'packages/dependency/marker.cjs',
    'packages/actual-helper/package.json',
    'packages/actual-helper/bin/helper.cjs',
    'packages/peer-provider/package.json',
    'packages/peer-provider/index.cjs',
    'packages/portable-optional/package.json',
    'packages/portable-optional/bin/portable.cjs'
  ].map((path) => [path, readFixture(path)])
);

const yarnNodeModulesWorkspaceClaim = defineCompatibilityClaim({
  id: 'yarn-4-17-1-node-modules-workspace',
  statement:
    'Yarn 4.17.1 installs and executes the exact is-odd node-modules workspace graph through Mimic with a tracked immutable lockfile and transparent tarball cache',
  target: {
    kind: 'exact-graph',
    packages: { 'is-odd': '3.0.1', 'is-number': '6.0.0' },
    packageManager: { name: 'yarn', version: '4.17.1' },
    lockfile: {
      format: 'yarn',
      version: 10,
      path: 'compatibility/fixtures/yarn-node-modules-workspace/yarn.lock'
    },
    virtualPlatform: { operatingSystem: 'linux', architecture: 'wasm32', runtime: 'browser', nodeVersion: '22.22.3' },
    replacements: {},
    execution: { command: 'yarn workspace @workspace/tool exec helper', entrypoint: 'bin/helper.cjs' }
  }
});

test(yarnNodeModulesWorkspaceClaim.statement, async ({ page }, testInfo) => {
  test.setTimeout(480_000);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const offlineRegistryRequests: string[] = [];
  let registryOffline = false;
  let yarnPhase = 'browser setup';
  await page.exposeBinding('reportYarnPhase', (_source, phase: string) => {
    yarnPhase = phase;
  });
  await page.exposeBinding('setYarnRegistryOffline', () => {
    registryOffline = true;
  });
  await page.exposeBinding('setYarnRegistryOnline', () => {
    registryOffline = false;
  });
  await page.route(/^https:\/\/(?:registry\.npmjs\.org|registry\.yarnpkg\.com)\//u, async (route) => {
    if (!registryOffline) {
      await route.continue();
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
      'ViteCommand'
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
      (globalThis as typeof globalThis & { reportYarnPhase(phase: string): Promise<void> })
        .reportYarnPhase(phase);
    const run = async (runtime: Runtime, args: string[]) => {
      const phase = `${runtime.workdir}: yarn ${args.join(' ')}`;
      await reportPhase(phase);
      const process = await runtime.spawn('yarn', args, {
        env: { CI: 'true', YARN_ENABLE_COLORS: '0' }
      });
      const output = collectProcessOutput(process);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const exitCode = await Promise.race([
          process.exit,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error(
                `${phase} did not settle within 150 seconds\nPartial output:\n${output.text()}`
              )),
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
    const bytes = (value: Uint8Array) =>
      Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const cacheEntries = async (runtime: Runtime) => {
      const path = `${runtime.workdir}/.yarn/cache`;
      if (!(await runtime.fs.exists(path))) return [];
      return (await runtime.fs.readdir(path)).map((entry) => (typeof entry === 'string' ? entry : entry.name)).sort();
    };
    const readInstallState = async (runtime: Runtime) =>
      bytes(await runtime.fs.readFile(`${runtime.workdir}/.yarn/install-state.gz`));
    const workspaceLinks = async (runtime: Runtime) => {
      const tool = `${runtime.workdir}/node_modules/@workspace/tool`;
      const helper = `${runtime.workdir}/node_modules/actual-helper`;
      const peer = `${runtime.workdir}/node_modules/peer-provider`;
      return {
        toolSymbolic: (await runtime.fs.lstat(tool)).isSymbolicLink(),
        toolRealpath: await runtime.fs.realpath(tool),
        helperRealpath: await runtime.fs.realpath(helper),
        peerRealpath: await runtime.fs.realpath(peer)
      };
    };
    const runCompleteGraph = async (workdirName: string) => {
      await reportPhase(`${workdirName}: boot`);
      const runtime = await boot(workdirName);
      try {
        await reportPhase(`${workdirName}: mount`);
        await mount(runtime);
        const mountedLockfile = await runtime.fs.readFile(`${runtime.workdir}/yarn.lock`, 'utf8');
        const version = await run(runtime, ['--version']);
        const coldInstall = await run(runtime, ['install', '--immutable']);
        if (coldInstall.exitCode !== 0) {
          throw new Error(`Yarn frozen cold install exited ${coldInstall.exitCode}: ${coldInstall.output}`);
        }
        const bin = await run(runtime, ['workspace', '@workspace/tool', 'exec', 'helper', 'installed-bin']);
        if (bin.exitCode !== 0) {
          throw new Error(`Yarn workspace bin exited ${bin.exitCode}: ${bin.output}`);
        }
        const lifecycle = await run(runtime, [
          'workspaces',
          'foreach',
          '-A',
          '-t',
          '-v',
          'run',
          'verify'
        ]);
        if (lifecycle.exitCode !== 0) {
          throw new Error(`Yarn workspace lifecycle exited ${lifecycle.exitCode}: ${lifecycle.output}`);
        }
        const cold = {
          lockfile: await runtime.fs.readFile(`${runtime.workdir}/yarn.lock`, 'utf8'),
          installState: await readInstallState(runtime),
          cache: await cacheEntries(runtime),
          links: await workspaceLinks(runtime),
          bin,
          lifecycle,
          order: await runtime.fs.readFile(`${runtime.workdir}/order.log`, 'utf8'),
          peer: await runtime.fs.readFile(`${runtime.workdir}/peer.log`, 'utf8'),
          optional: await runtime.fs.readFile(`${runtime.workdir}/optional.log`, 'utf8')
        };
        await runtime.fs.rm(`${runtime.workdir}/node_modules`, { recursive: true });
        await runtime.fs.writeFile(`${runtime.workdir}/order.log`, '');
        await (globalThis as typeof globalThis & { setYarnRegistryOffline(): Promise<void> })
          .setYarnRegistryOffline();
        const repeatInstall = await run(runtime, fixtureInput.install.args);
        const repeatLifecycle = await run(runtime, [
          'workspaces',
          'foreach',
          '-A',
          '-t',
          '-v',
          'run',
          'verify'
        ]);
        if (repeatLifecycle.exitCode !== 0) {
          throw new Error(`Yarn repeated workspace lifecycle exited ${repeatLifecycle.exitCode}: ${repeatLifecycle.output}`);
        }
        const repeat = {
          lockfile: await runtime.fs.readFile(`${runtime.workdir}/yarn.lock`, 'utf8'),
          installState: await readInstallState(runtime),
          cache: await cacheEntries(runtime),
          links: await workspaceLinks(runtime),
          lifecycle: repeatLifecycle,
          order: await runtime.fs.readFile(`${runtime.workdir}/order.log`, 'utf8')
        };
        await runtime.fs.writeFile(
          `${runtime.workdir}/package.json`,
          fixtureInput.packageJson.replace(
            '"@workspace/tool": "workspace:*"',
            '"@workspace/missing": "workspace:*"'
          )
        );
        const refusedBefore = {
          lockfile: await runtime.fs.readFile(`${runtime.workdir}/yarn.lock`, 'utf8'),
          installState: await readInstallState(runtime),
          installedTool: await runtime.fs.exists(`${runtime.workdir}/node_modules/@workspace/tool`)
        };
        const failedInstall = await run(runtime, fixtureInput.install.args);
        const refusedAfter = {
          lockfile: await runtime.fs.readFile(`${runtime.workdir}/yarn.lock`, 'utf8'),
          installState: await readInstallState(runtime),
          installedTool: await runtime.fs.exists(`${runtime.workdir}/node_modules/@workspace/tool`)
        };
        return { mountedLockfile, version, coldInstall, cold, repeatInstall, repeat, failedInstall, refusedBefore, refusedAfter };
      } finally {
        try {
          await runtime.teardown();
        } catch (error) {
          await reportPhase(`${workdirName}: teardown`);
          throw error;
        }
      }
    };

    const cold = await runCompleteGraph('yarn-node-modules-cold');
    await (globalThis as typeof globalThis & { setYarnRegistryOnline(): Promise<void> })
      .setYarnRegistryOnline();
    const reboot = await runCompleteGraph('yarn-node-modules-reboot');
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
    files: yarnWorkspaceInstallFixture.files,
    install: yarnWorkspaceInstallFixture.install,
    packageJson: yarnWorkspacePackageJson,
    workspaceFiles: yarnWorkspaceFiles
  }).catch((error) => {
    throw new Error(`Yarn browser witness failed during "${yarnPhase}": ${error instanceof Error ? error.message : String(error)}`);
  });

  for (const run of [result.cold, result.reboot]) {
    expect(run.mountedLockfile).toBe(yarnWorkspaceLockfile);
    expect(run.version.exitCode, run.version.output).toBe(0);
    expect(run.version.output.trim()).toBe('4.17.1');
    expect(run.coldInstall.exitCode, run.coldInstall.output).toBe(0);
    expect(run.cold.bin.exitCode, run.cold.bin.output).toBe(0);
    expect(run.cold.lifecycle.exitCode, run.cold.lifecycle.output).toBe(0);
    yarnWorkspaceInstallFixture.assertLockfileUnchanged(run.cold.lockfile);
    expect(run.cold.installState).not.toBe('');
    expect(run.cold.cache.length).toBeGreaterThan(0);
    expect(run.cold.links).toEqual({
      toolSymbolic: true,
      toolRealpath: `/home/${run === result.cold ? 'yarn-node-modules-cold' : 'yarn-node-modules-reboot'}/packages/tool`,
      helperRealpath: `/home/${run === result.cold ? 'yarn-node-modules-cold' : 'yarn-node-modules-reboot'}/packages/actual-helper`,
      peerRealpath: `/home/${run === result.cold ? 'yarn-node-modules-cold' : 'yarn-node-modules-reboot'}/packages/peer-provider`
    });
    expect(run.cold.bin.output).toContain('peer-helper installed-bin');
    expect(run.cold.peer).toBe('peer-helper lifecycle\n');
    expect(run.cold.optional).toBe('portable-optional linux wasm32\n');
    expect(run.cold.order).toBe('dependency\ntool\n');
    expect(run.repeatInstall.exitCode, run.repeatInstall.output).toBe(0);
    expect(run.repeat.lifecycle.exitCode, run.repeat.lifecycle.output).toBe(0);
    yarnWorkspaceInstallFixture.assertLockfileUnchanged(run.repeat.lockfile);
    expect(run.repeat.installState).toBe(run.cold.installState);
    expect(run.repeat.cache).toEqual(run.cold.cache);
    expect(run.repeat.links).toEqual(run.cold.links);
    expect(run.repeat.order).toBe('dependency\ntool\n');
    expect(run.failedInstall.exitCode, run.failedInstall.output).not.toBe(0);
    expect(run.refusedAfter).toEqual(run.refusedBefore);
  }

  expect(offlineRegistryRequests).toEqual([]);
  expect(result.observedFallbacks).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await testInfo.attach('yarn-node-modules-workspace-exact-graph', {
    body: JSON.stringify({
      schemaVersion: 1,
      claim: yarnNodeModulesWorkspaceClaim,
      fixture: {
        packageJson: { path: fixturePackageJsonPath, contents: yarnWorkspacePackageJson },
        lockfile: {
          path: fixtureYarnLockPath,
          contents: yarnWorkspaceLockfile,
          generatedBy: 'Yarn 4.17.1 outside browser execution',
          consumedBy: 'Yarn 4.17.1 node-modules runtime program'
        },
        path: 'compatibility/fixtures/yarn-node-modules-workspace',
        graph: { root: 'is-odd@3.0.1', dependency: 'is-number@6.0.0' },
        linkerConfigPath: `${fixtureRoot}.yarnrc.yml`,
        lockfileUnchanged: true
      },
      result
    }),
    contentType: 'application/json'
  });
});

function readFixture(path: string): string {
  return readFileSync(new URL(`${fixtureRoot}${path}`, import.meta.url), 'utf8');
}
