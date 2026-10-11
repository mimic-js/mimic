import { readFileSync } from 'node:fs';

import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';
import { prepareTrackedLockfileInstall } from './tracked-lockfile-install';

const yarnPnpZipFsClaim = defineCompatibilityClaim({
  id: 'yarn-4-17-1-pnp-zipfs',
  statement:
    'Yarn 4.17.1 preserves its frozen is-odd PnP graph and CJS/ESM dependency-edge resolution from immutable ZipFS caches through Mimic',
  target: {
    kind: 'exact-graph',
    packages: { 'is-odd': '3.0.1', 'is-number': '6.0.0' },
    packageManager: { name: 'yarn', version: '4.17.1' },
    lockfile: {
      format: 'yarn',
      version: 10,
      path: 'compatibility/fixtures/yarn-pnp-zipfs/yarn.lock'
    },
    virtualPlatform: { operatingSystem: 'linux', architecture: 'wasm32', runtime: 'browser', nodeVersion: '22.22.3' },
    replacements: {},
    execution: { command: 'yarn node', entrypoint: 'check.cjs' }
  }
});

const fixtureUrl = new URL('../../compatibility/fixtures/yarn-pnp-zipfs/', import.meta.url);
const yarnPnpFixture = {
  packageJson: readFileSync(new URL('package.json', fixtureUrl), 'utf8'),
  lockfile: readFileSync(new URL('yarn.lock', fixtureUrl), 'utf8'),
  yarnrc: readFileSync(new URL('.yarnrc.yml', fixtureUrl), 'utf8'),
  scripts: {
    'check.cjs': "const isOdd = require('is-odd');\n\nconsole.log('pnp-cjs', isOdd(41), isOdd(42));\n",
    'check.mjs': "import isOdd from 'is-odd';\n\nconsole.log('pnp-esm', isOdd(41), isOdd(42));\n",
    'loader-check.cjs': [
      "const pnp = require('./.pnp.cjs');",
      '',
      "const isOddPath = pnp.resolveRequest('is-odd', __filename);",
      "const isNumberPath = pnp.resolveRequest('is-number', isOddPath);",
      "let undeclaredError;",
      "try { pnp.resolveRequest('is-number', __filename); } catch (error) { undeclaredError = error; }",
      "if (!undeclaredError) throw new Error('root issuer unexpectedly resolved transitive is-number');",
      '',
      "console.log('pnp-cjs-loader', isOddPath, isNumberPath, 'pnp-cjs-undeclared', undeclaredError.message);",
      ''
    ].join('\n'),
    'loader-check.mjs': [
      "await import('./.pnp.cjs');",
      "const { resolve } = await import('./.pnp.loader.mjs');",
      '',
      "const isOdd = await resolve('is-odd', { conditions: ['node', 'import', 'default'], parentURL: import.meta.url }, () => {",
      "  throw new Error('forbidden fallback called while resolving is-odd');",
      '});',
      "const isNumber = await resolve('is-number', { conditions: ['node', 'import', 'default'], parentURL: isOdd.url }, () => {",
      "  throw new Error('forbidden fallback called while resolving is-number');",
      '});',
      "let undeclaredError;",
      "try {",
      "  await resolve('is-number', { conditions: ['node', 'import', 'default'], parentURL: import.meta.url }, () => {",
      "    throw new Error('forbidden undeclared fallback called');",
      "  });",
      "} catch (error) { undeclaredError = error; }",
      "if (!undeclaredError || undeclaredError.message.includes('forbidden undeclared fallback')) throw undeclaredError ?? new Error('root issuer unexpectedly resolved transitive is-number');",
      '',
      "console.log('pnp-esm-loader', isOdd.url, isNumber.url, 'pnp-esm-undeclared', undeclaredError.message);",
      ''
    ].join('\n')
  }
} as const;

const yarnPnpInstallFixture = prepareTrackedLockfileInstall({
  packageJson: yarnPnpFixture.packageJson,
  lockfile: yarnPnpFixture.lockfile,
  install: { command: 'yarn', args: ['install', '--immutable', '--immutable-cache'] }
});

test(yarnPnpZipFsClaim.statement, async ({ page }, testInfo) => {
  test.setTimeout(420_000);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  page.on('console', (message) => {
    if (
      message.text().startsWith('[yarn-pnp-phase]') ||
      message.text().startsWith('[yarn-pnp-output]')
    ) {
      console.info(message.text());
    }
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) {
      consoleErrors.push(message.text());
    }
  });

  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated), { timeout: 10_000 }).toBe(true);

  const result = await page.evaluate(async (fixture) => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const { collectProcessOutput } = await import('/tests/e2e/process-output.ts');
    type Runtime = Awaited<ReturnType<typeof Mimic.boot>>;
    type CacheFiles = Record<string, { file: { contents: Uint8Array } }>;
    type ProcessResult = { exitCode: number; output: string };

    const boot = async (workdirName: string) => {
      const runtime = await Mimic.boot({ workdir: `/home/${workdirName}` });
      return runtime;
    };

    const run = async (
      runtime: Runtime,
      command: string,
      args: string[],
      cwd = runtime.workdir
    ): Promise<ProcessResult> => {
      const invocation = [command, ...args].join(' ');
      console.info(`[yarn-pnp-phase] start ${invocation}`);
      const process = await runtime.spawn(command, args, {
        cwd,
        env: { CI: 'true', YARN_ENABLE_COLORS: '0' }
      });
      const output = collectProcessOutput(process, (chunk) => {
          console.info(`[yarn-pnp-output] ${invocation}\n${chunk}`);
      });
      const timeoutMs =
        command === 'yarn' && args[0] === 'install'
          ? 180_000
          : 60_000;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const exitCode = await Promise.race([
          process.exit,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              process.kill('SIGKILL');
              reject(
                new Error(
                  `Timed out after ${timeoutMs}ms running ${invocation}:\n${output.text()}`
                )
              );
            }, timeoutMs);
          })
        ]);
        await output.done;
        console.info(`[yarn-pnp-phase] end ${invocation} exit=${exitCode}`);
        return { exitCode, output: output.text() };
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    };

    const yarn = (runtime: Runtime, args: readonly string[]) => run(runtime, 'yarn', [...args]);

    const projectTree = (cacheFiles?: CacheFiles) => ({
      ...fixture.install.files,
      '.yarnrc.yml': { file: { contents: fixture.yarnrc } },
      ...Object.fromEntries(
        Object.entries(fixture.scripts).map(([name, contents]) => [name, { file: { contents } }])
      ),
      '.yarn': {
        directory: {
          // Yarn rejects --immutable-cache before package acquisition when its
          // configured cache root is absent. An empty root permits the cold
          // immutable install to acquire publisher tarballs through Playwright's
          // transparent cache; fresh and reboot runs use --immutable-cache.
          cache: { directory: cacheFiles ?? {} }
        }
      }
    });

    const runGraph = async (runtime: Runtime, installArgs: readonly string[]) => {
      const version = await yarn(runtime, ['--version']);
      const install = await yarn(runtime, installArgs);
      if (install.exitCode !== 0) {
        throw new Error(
          `Yarn ${installArgs.join(' ')} failed with exit ${install.exitCode}:\n${install.output}`
        );
      }
      const directNode = install.exitCode === 0 ? await run(runtime, 'node', ['check.cjs']) : install;
      const cjs = install.exitCode === 0 ? await yarn(runtime, ['node', 'check.cjs']) : install;
      const esm = install.exitCode === 0 ? await yarn(runtime, ['node', 'check.mjs']) : install;
      const cjsLoader = install.exitCode === 0 ? await yarn(runtime, ['node', 'loader-check.cjs']) : install;
      const esmLoader = install.exitCode === 0 ? await yarn(runtime, ['node', 'loader-check.mjs']) : install;
      const pnpCjsPath = `${runtime.workdir}/.pnp.cjs`;
      const pnpDataPath = `${runtime.workdir}/.pnp.data.json`;
      const pnpEsmLoaderPath = `${runtime.workdir}/.pnp.loader.mjs`;
      return {
        version,
        install,
        directNode,
        cjs,
        esm,
        cjsLoader,
        esmLoader,
        lockfile: await runtime.fs.readFile(`${runtime.workdir}/yarn.lock`, 'utf8'),
        pnpCjs: await runtime.fs.exists(pnpCjsPath),
        pnpData: await runtime.fs.exists(pnpDataPath),
        pnpEsmLoader: await runtime.fs.exists(pnpEsmLoaderPath),
        pnpDataBytes: (await runtime.fs.readFile(pnpDataPath)).byteLength,
        pnpCjsSource: await runtime.fs.readFile(pnpCjsPath, 'utf8'),
        nodeModules: await runtime.fs.exists(`${runtime.workdir}/node_modules`),
        rootEntries: (await runtime.fs.readdir(runtime.workdir)).map(String)
      };
    };

    const cold = await boot('yarn-pnp-cold');
    let coldRun: Awaited<ReturnType<typeof runGraph>>;
    let cacheNames: string[];
    let cacheFiles: CacheFiles;
    let coldCacheReceipt: Awaited<ReturnType<typeof fingerprintPaths>>;
    let failure: ProcessResult;
    let failureBefore: Awaited<ReturnType<typeof fingerprintPaths>>;
    let failureAfter: Awaited<ReturnType<typeof fingerprintPaths>>;
    try {
      await cold.fs.mount(projectTree());
      // The first immutable install seeds the project ZipFS cache through the
      // transparent browser tarball cache. Later fresh/reboot installs use the
      // canonical immutable-cache arguments carried by the tracked fixture.
      coldRun = await runGraph(cold, ['install', '--immutable']);
      const cacheDirectory = `${cold.workdir}/.yarn/cache`;
      cacheNames = (await cold.fs.readdir(cacheDirectory)).map(String).sort();
      cacheFiles = Object.fromEntries(
        await Promise.all(
          cacheNames.map(async (name) => [
            name,
            { file: { contents: await cold.fs.readFile(`${cacheDirectory}/${name}`) } }
          ])
        )
      ) as CacheFiles;
      coldCacheReceipt = await fingerprintPaths(
        cold,
        cacheNames.map((name) => `${cacheDirectory}/${name}`)
      );

      const protectedPaths = ['yarn.lock', '.pnp.cjs', '.pnp.data.json', '.pnp.loader.mjs'].map(
        (name) => `${cold.workdir}/${name}`
      );
      failureBefore = await fingerprintPaths(cold, protectedPaths);
      const changedManifest = JSON.stringify({
        ...JSON.parse(fixture.packageJson),
        dependencies: {
          ...JSON.parse(fixture.packageJson).dependencies,
          'is-odd': '^3.0.1'
        }
      });
      await cold.fs.writeFile(`${cold.workdir}/package.json`, changedManifest);
      failure = await yarn(cold, ['install', '--immutable', '--immutable-cache']);
      failureAfter = await fingerprintPaths(cold, protectedPaths);
    } finally {
      await cold.teardown();
    }

    const fresh = await boot('yarn-pnp-fresh-vfs');
    let freshRun: Awaited<ReturnType<typeof runGraph>>;
    let freshCacheNames: string[];
    let freshCacheReceipt: Awaited<ReturnType<typeof fingerprintPaths>>;
    try {
      await fresh.fs.mount(projectTree(cacheFiles));
      freshRun = await runGraph(fresh, fixture.install.args);
      const freshCacheDirectory = `${fresh.workdir}/.yarn/cache`;
      freshCacheNames = (await fresh.fs.readdir(freshCacheDirectory)).map(String).sort();
      freshCacheReceipt = await fingerprintPaths(
        fresh,
        freshCacheNames.map((name) => `${freshCacheDirectory}/${name}`)
      );
    } finally {
      await fresh.teardown();
    }

    const rebooted = await boot('yarn-pnp-reboot');
    let rebootedRun: Awaited<ReturnType<typeof runGraph>>;
    try {
      await rebooted.fs.mount(projectTree(cacheFiles));
      rebootedRun = await runGraph(rebooted, fixture.install.args);
    } finally {
      await rebooted.teardown();
    }

    return {
      cold: coldRun,
      coldCacheNames: cacheNames,
      coldCacheReceipt,
      failure,
      failureBefore,
      failureAfter,
      fresh: freshRun,
      freshCacheNames,
      freshCacheReceipt,
      rebooted: rebootedRun
    };

    async function fingerprintPaths(
      runtime: Runtime,
      paths: string[]
    ): Promise<Array<{ path: string; bytes: number; sha256: string }>> {
      return Promise.all(
        paths.map(async (path) => {
          const bytes = await runtime.fs.readFile(path);
          const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
          return {
            path: path.slice(runtime.workdir.length),
            bytes: bytes.byteLength,
            sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
          };
        })
      );
    }
  }, {
    ...yarnPnpFixture,
    install: {
      files: yarnPnpInstallFixture.files,
      args: yarnPnpInstallFixture.install.args
    }
  });

  assertSuccessfulGraph(result.cold, yarnPnpInstallFixture.assertLockfileUnchanged);
  expect(result.cold.install.output).toContain('YN0013');
  const coldZipCacheNames = result.coldCacheNames.filter((entry) => entry.endsWith('.zip'));
  expect(coldZipCacheNames).toHaveLength(2);
  expect(coldZipCacheNames.some((entry) => entry.includes('is-odd-npm-3.0.1'))).toBe(true);
  expect(coldZipCacheNames.some((entry) => entry.includes('is-number-npm-6.0.0'))).toBe(true);

  expect(result.failure.exitCode).not.toBe(0);
  expect(result.failure.output).toContain('YN0028');
  expect(result.failureAfter).toEqual(result.failureBefore);

  assertSuccessfulGraph(result.fresh, yarnPnpInstallFixture.assertLockfileUnchanged);
  expect(result.fresh.install.output).not.toContain('YN0013');
  expect(result.freshCacheNames).toEqual(result.coldCacheNames);
  expect(result.freshCacheReceipt).toEqual(result.coldCacheReceipt);

  assertSuccessfulGraph(result.rebooted, yarnPnpInstallFixture.assertLockfileUnchanged);
  expect(result.rebooted.install.output).not.toContain('YN0013');

  const observedOutput = [
    result.cold.version.output,
    result.cold.install.output,
    result.cold.cjs.output,
    result.cold.esm.output,
    result.cold.cjsLoader.output,
    result.cold.esmLoader.output,
    result.failure.output,
    result.fresh.install.output,
    result.rebooted.install.output
  ].join('\n');
  for (const forbidden of [
    '/tooling/',
    'ViteCommand',
    'falling back to registered command adapter',
    'forbidden fallback called',
    'esm.sh',
    'vfsPreviewFallback',
    'host Node'
  ]) {
    expect(observedOutput).not.toContain(forbidden);
  }
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);

  await testInfo.attach('yarn-pnp-zipfs-exact-graph', {
    body: JSON.stringify({
      schemaVersion: 1,
      claim: yarnPnpZipFsClaim,
      packageManager: { name: 'yarn', version: '4.17.1', command: 'yarn' },
      fixture: {
        path: 'compatibility/fixtures/yarn-pnp-zipfs',
        graph: { root: 'is-odd@3.0.1', dependency: 'is-number@6.0.0' },
        lockfileUnchanged: true
      },
      linker: {
        name: 'pnp',
        physicalNodeModules: false,
        loaders: ['.pnp.cjs', '.pnp.data.json', '.pnp.loader.mjs']
      },
      zipfs: {
        cold: result.coldCacheReceipt,
        freshVfs: result.freshCacheReceipt
      },
      failure: {
        exitCode: result.failure.exitCode,
        protectedFilesBefore: result.failureBefore,
        protectedFilesAfter: result.failureAfter
      },
      reboot: true
    }),
    contentType: 'application/json'
  });
});

function assertSuccessfulGraph(
  result: {
    version: { exitCode: number; output: string };
    install: { exitCode: number; output: string };
    directNode: { exitCode: number; output: string };
    cjs: { exitCode: number; output: string };
    esm: { exitCode: number; output: string };
    cjsLoader: { exitCode: number; output: string };
    esmLoader: { exitCode: number; output: string };
    lockfile: string;
    pnpCjs: boolean;
    pnpData: boolean;
    pnpEsmLoader: boolean;
    pnpDataBytes: number;
    pnpCjsSource: string;
    nodeModules: boolean;
    rootEntries: string[];
  },
  assertLockfileUnchanged: (actual: string) => void
): void {
  expect(result.version).toMatchObject({ exitCode: 0, output: expect.stringContaining('4.17.1') });
  expect(result.install.exitCode, result.install.output).toBe(0);
  assertLockfileUnchanged(result.lockfile);
  expect(result).toMatchObject({
    pnpCjs: true,
    pnpData: true,
    pnpEsmLoader: true,
    nodeModules: false
  });
  expect(result.pnpDataBytes).toBeGreaterThan(0);
  expect(result.pnpCjsSource).toContain('.pnp.data.json');
  expect(result.rootEntries).not.toContain('node_modules');

  expect(result.directNode.exitCode).not.toBe(0);
  expect(result.directNode.output).toContain("Cannot find module 'is-odd'");
  expect(result.cjs).toMatchObject({ exitCode: 0, output: expect.stringContaining('pnp-cjs true false') });
  expect(result.esm).toMatchObject({ exitCode: 0, output: expect.stringContaining('pnp-esm true false') });
  expect(result.cjsLoader).toMatchObject({ exitCode: 0, output: expect.stringContaining('pnp-cjs-loader') });
  expect(result.esmLoader).toMatchObject({ exitCode: 0, output: expect.stringContaining('pnp-esm-loader') });
  expect(result.cjsLoader.output).toContain('pnp-cjs-undeclared');
  expect(result.esmLoader.output).toContain('pnp-esm-undeclared');
  expect(result.esmLoader.output).not.toContain('forbidden undeclared fallback');
  for (const loaderOutput of [result.cjsLoader.output, result.esmLoader.output]) {
    expect(loaderOutput).toContain('/.yarn/cache/');
    expect(loaderOutput).toContain('.zip/node_modules/is-odd/index.js');
    expect(loaderOutput).toContain('.zip/node_modules/is-number/index.js');
  }
}
