import { createHash } from 'node:crypto';

import { describe, expect, test, vi } from 'vitest';

import { generatedLoader, moduleExporting } from '../../../../tests/napi-wasi-fixture';
import { makePackageTgz } from '../../../../tests/npm-tarball-fixture';
import { memoryProcessFileSystem, VirtualFileSystem } from '../../../../tests/memory-process-file-system';
import { createPackageManagerCommandProxies } from './package-manager-command-proxies';
import { MemoryArtifactCache } from './package-manager/artifact-cache';
import type { RuntimeProgramRequest } from './process-execution';
import { createVirtualProcess, type RuntimeProgramProcess } from './virtual-process';

// The pinned CLI integrities name the fixture tarballs this test publishes.
vi.mock('./package-manager/package-manager-clis', async (importOriginal) => {
  const original = await importOriginal<typeof import('./package-manager/package-manager-clis')>();
  return {
    ...original,
    PACKAGE_MANAGER_CLIS: original.PACKAGE_MANAGER_CLIS.map((cli) => ({
      ...cli,
      integrity: integrityOf(cliTarball(cli.manager))
    }))
  };
});

const projectRoot = '/home/project';
const cliRoot = '/.mimic/toolchains';
const launcher = '/.mimic/bin/esbuild';

describe('Command Proxies', () => {
  test.each([
    ['npm', ['-s', 'run', 'x'], 'npm/11.18.0/bin/npm-cli.js'],
    ['npm', ['--legacy-peer-deps', 'i'], 'npm/11.18.0/bin/npm-cli.js'],
    ['npx', ['tool', '--flag', 'value'], 'npm/11.18.0/bin/npx-cli.js'],
    ['pnpm', ['-r', 'build'], 'pnpm/11.11.0/bin/pnpm.mjs'],
    ['pnpm', ['-w', 'add', 'left-pad'], 'pnpm/11.11.0/bin/pnpm.mjs'],
    ['pnpx', ['create-vite', '--template', 'vanilla'], 'pnpm/11.11.0/bin/pnpx.mjs'],
    ['yarn', ['--immutable'], 'yarn/4.17.1/bin/yarn.js'],
    ['yarn', ['workspaces', 'focus', '--production'], 'yarn/4.17.1/bin/yarn.js'],
    ['yarnpkg', ['dlx', 'create-vite'], 'yarn/4.17.1/bin/yarn.js']
  ] as const)('%s %j runs the CLI\'s own bin script with the arguments untouched', async (command, args, script) => {
    const harness = createHarness();

    const exitCode = await harness.run(command, args);

    expect(exitCode).toBe(0);
    expect(harness.spawned).toEqual([
      expect.objectContaining({
        command: `${cliRoot}/${script}`,
        args,
        cwd: projectRoot,
        parentPid: 41
      })
    ]);
  });

  test('passes the manager\'s exit code, stdout and stderr through unchanged', async () => {
    const harness = createHarness({
      child: { code: 7, stdout: ['partial output\n'], stderr: ['npm error code E404\n'] }
    });

    expect(await harness.run('npm', ['install', 'missing-package'])).toBe(7);
    expect(harness.stdout).toEqual(['partial output\n']);
    expect(harness.stderr).toEqual(['npm error code E404\n']);
  });

  test('delivers a signal sent before the manager started to the manager once it has', async () => {
    const harness = createHarness({ signalBeforeSpawn: 'SIGTERM' });

    await harness.run('npm', ['ci']);

    expect(harness.killed).toEqual(['SIGTERM']);
  });

  test('does not deliver a signal an earlier command in the same process already received', async () => {
    const harness = createHarness();

    await harness.run('npm', ['run', 'dev'], {}, projectRoot, Promise.resolve('SIGINT'));

    expect(harness.killed).toEqual([]);
  });

  test('runs the manager with its defaults, the replacement launchers and the caller environment last', async () => {
    const harness = createHarness();

    await harness.run('npm', ['ci'], { npm_config_audit: 'true', ESBUILD_BINARY_PATH: '/caller/esbuild' });

    expect(harness.spawned[0]?.env).toEqual({
      PATH: '/bin',
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_audit: 'true',
      ESBUILD_BINARY_PATH: '/caller/esbuild'
    });
    expect(await harness.fs.exists(launcher)).toBe(true);
  });

  test('materializes each pinned CLI once from its verified tarball', async () => {
    const harness = createHarness();

    await harness.run('npm', ['--version']);
    await harness.run('npx', ['--version']);

    expect(harness.fetched).toEqual(['https://registry.npmjs.org/npm/-/npm-11.18.0.tgz']);
    expect(await harness.fs.readFile(`${cliRoot}/npm/11.18.0/bin/npm-cli.js`, 'utf8')).toBe('npm cli');
  });

  test('rejects a CLI tarball whose bytes do not match the pinned integrity', async () => {
    const harness = createHarness({ cliBytes: makePackageTgz({ 'bin/npm-cli.js': 'tampered' }) });

    await expect(harness.run('npm', ['--version'])).rejects.toThrow(/integrity mismatch/u);
    expect(harness.spawned).toEqual([]);
  });

  test('runs the release package.json asks for, from the registry, in place of the pinned one', async () => {
    const harness = createHarness();
    harness.vfs.writeFileSync(`${projectRoot}/package.json`, JSON.stringify({ packageManager: 'pnpm@9.0.0' }));

    expect(await harness.run('pnpm', ['install'])).toBe(0);
    await harness.run('pnpm', ['run', 'dev']);

    expect(harness.spawned.map((request) => request.command)).toEqual([
      `${cliRoot}/pnpm/9.0.0/bin/pnpm.cjs`,
      `${cliRoot}/pnpm/9.0.0/bin/pnpm.cjs`
    ]);
    expect(harness.fetched.filter((url) => url.includes('pnpm-9.0.0'))).toEqual(['https://tarballs.test/pnpm-9.0.0.tgz']);
    expect(harness.fetched).not.toContain('https://registry.npmjs.org/pnpm/-/pnpm-11.11.0.tgz');
  });

  test('finds the packageManager field in the nearest manifest above a workspace package', async () => {
    const harness = createHarness();
    harness.vfs.writeFileSync(`${projectRoot}/package.json`, JSON.stringify({ packageManager: 'yarn@1.22.22' }));
    harness.vfs.mkdirSync(`${projectRoot}/packages/tool`, { recursive: true });
    harness.vfs.writeFileSync(`${projectRoot}/packages/tool/package.json`, JSON.stringify({ name: 'tool' }));

    expect(await harness.run('yarn', ['install'], {}, `${projectRoot}/packages/tool`)).toBe(0);
    expect(harness.spawned[0]?.command).toBe(`${cliRoot}/yarn/1.22.22/bin/yarn.js`);
    expect(harness.fetched).toContain('https://registry.npmjs.org/yarn/1.22.22');
  });

  test('takes Yarn 2 and later from @yarnpkg/cli-dist', async () => {
    const harness = createHarness();
    harness.vfs.writeFileSync(`${projectRoot}/package.json`, JSON.stringify({ packageManager: 'yarn@4.15.0' }));

    expect(await harness.run('yarnpkg', ['install'])).toBe(0);
    expect(harness.spawned[0]?.command).toBe(`${cliRoot}/yarn/4.15.0/bin/yarn.js`);
    expect(harness.fetched).toContain('https://registry.npmjs.org/@yarnpkg%2fcli-dist/4.15.0');
  });

  test('checks the Corepack hash against the release archive', async () => {
    const tarball = managerRelease('pnpm', '9.0.0');
    const matching = createHarness();
    matching.vfs.writeFileSync(
      `${projectRoot}/package.json`,
      JSON.stringify({ packageManager: `pnpm@9.0.0+sha512.${createHash('sha512').update(tarball).digest('hex')}` })
    );
    expect(await matching.run('pnpm', ['install'])).toBe(0);

    const tampered = createHarness();
    tampered.vfs.writeFileSync(
      `${projectRoot}/package.json`,
      JSON.stringify({ packageManager: `pnpm@9.0.0+sha256.${'0'.repeat(64)}` })
    );
    expect(await tampered.run('pnpm', ['install'])).toBe(1);
    expect(tampered.stderr.join('')).toBe(
      `pnpm: package.json asks for pnpm@9.0.0, which could not be installed: its sha256 hash does not match ${'0'.repeat(64)}.\n`
    );
    expect(tampered.spawned).toEqual([]);
  });

  test('checks a Corepack hash the field names for a release already installed without one', async () => {
    const harness = createHarness();
    harness.vfs.writeFileSync(`${projectRoot}/package.json`, JSON.stringify({ packageManager: 'pnpm@9.0.0' }));
    expect(await harness.run('pnpm', ['install'])).toBe(0);

    harness.vfs.writeFileSync(
      `${projectRoot}/package.json`,
      JSON.stringify({ packageManager: `pnpm@9.0.0+sha256.${'0'.repeat(64)}` })
    );
    expect(await harness.run('pnpm', ['install'])).toBe(1);
    expect(harness.stderr.join('')).toBe(
      `pnpm: package.json asks for pnpm@9.0.0, which could not be installed: its sha256 hash does not match ${'0'.repeat(64)}.\n`
    );

    const tarball = managerRelease('pnpm', '9.0.0');
    harness.vfs.writeFileSync(
      `${projectRoot}/package.json`,
      JSON.stringify({ packageManager: `pnpm@9.0.0+sha512.${createHash('sha512').update(tarball).digest('hex')}` })
    );
    expect(await harness.run('pnpm', ['install'])).toBe(0);
    expect(harness.spawned.map((request) => request.command)).toEqual([
      `${cliRoot}/pnpm/9.0.0/bin/pnpm.cjs`,
      `${cliRoot}/pnpm/9.0.0/bin/pnpm.cjs`
    ]);
  });

  test('names a release the registry does not publish, and a request without an exact version', async () => {
    const unpublished = createHarness({ unpublished: ['pnpm@9.99.0'] });
    unpublished.vfs.writeFileSync(`${projectRoot}/package.json`, JSON.stringify({ packageManager: 'pnpm@9.99.0' }));
    expect(await unpublished.run('pnpm', ['install'])).toBe(1);
    expect(unpublished.stderr.join('')).toBe(
      'pnpm: package.json asks for pnpm@9.99.0, which could not be installed: The npm registry publishes no pnpm@9.99.0.\n'
    );

    const range = createHarness();
    range.vfs.writeFileSync(`${projectRoot}/package.json`, JSON.stringify({ packageManager: 'pnpm@^9' }));
    expect(await range.run('pnpm', ['install'])).toBe(1);
    expect(range.stderr.join('')).toBe('pnpm: package.json asks for pnpm@^9, which names no exact version.\n');
    expect([...unpublished.spawned, ...range.spawned]).toEqual([]);
  });

  test('leaves the pinned release in charge when package.json asks for another manager or the pinned version', async () => {
    const harness = createHarness();
    harness.vfs.writeFileSync(`${projectRoot}/package.json`, JSON.stringify({ packageManager: 'yarn@1.22.22' }));
    await harness.run('npm', ['install']);
    harness.vfs.writeFileSync(`${projectRoot}/package.json`, JSON.stringify({ packageManager: 'pnpm@11.11.0' }));
    await harness.run('pnpm', ['install']);

    expect(harness.spawned.map((request) => request.command)).toEqual([
      `${cliRoot}/npm/11.18.0/bin/npm-cli.js`,
      `${cliRoot}/pnpm/11.11.0/bin/pnpm.mjs`
    ]);
  });

  test('runs installs without a lockfile, without package-lock and without dependencies', async () => {
    const harness = createHarness({
      child: {
        code: 0,
        install(vfs) {
          vfs.mkdirSync(`${projectRoot}/node_modules`, { recursive: true });
          vfs.writeFileSync(`${projectRoot}/node_modules/.package-lock.json`, `{"run":${Math.random()}}`);
        }
      }
    });
    harness.vfs.writeFileSync(`${projectRoot}/package.json`, JSON.stringify({ name: 'empty' }));

    expect(await harness.run('npm', ['install'])).toBe(0);
    expect(await harness.run('npm', ['install', '--no-package-lock'])).toBe(0);
    expect(harness.stderr).toEqual([]);
  });
});

describe('Browser Package Replacements after an install', () => {
  test('replace every installed copy of a package, leaving its own dependencies', async () => {
    const harness = createHarness({
      child: {
        code: 0,
        install(vfs) {
          installPackage(vfs, `${projectRoot}/node_modules/rollup`, 'rollup', '4.62.4', { 'native.js': 'native' });
          installPackage(vfs, `${projectRoot}/node_modules/rollup/node_modules/@types/estree`, '@types/estree', '1.0.9');
          installPackage(vfs, `${projectRoot}/node_modules/vite/node_modules/rollup`, 'rollup', '4.40.0');
          installPackage(vfs, `${projectRoot}/node_modules/lightningcss`, 'lightningcss', '1.33.0');
          vfs.writeFileSync(`${projectRoot}/node_modules/.package-lock.json`, '{}');
        }
      }
    });

    expect(await harness.run('npm', ['ci'])).toBe(0);

    expect(harness.manifest('node_modules/rollup')).toEqual({ name: '@rollup/wasm-node', version: '4.62.4' });
    expect(harness.vfs.existsSync(`${projectRoot}/node_modules/rollup/native.js`)).toBe(false);
    expect(harness.manifest('node_modules/rollup/node_modules/@types/estree')).toEqual({
      name: '@types/estree',
      version: '1.0.9'
    });
    expect(harness.manifest('node_modules/vite/node_modules/rollup')).toEqual({
      name: '@rollup/wasm-node',
      version: '4.40.0'
    });
    expect(harness.manifest('node_modules/lightningcss')).toEqual({ name: 'lightningcss-wasm', version: '1.33.0' });
  });

  test('put back the dependencies a replacement bundles after a later install pruned them', async () => {
    const bundled = `${projectRoot}/node_modules/lightningcss/node_modules/napi-wasm`;
    let installs = 0;
    const harness = createHarness({
      child: {
        code: 0,
        install(vfs) {
          installs += 1;
          if (installs === 1) installPackage(vfs, `${projectRoot}/node_modules/lightningcss`, 'lightningcss', '1.33.0');
          else vfs.rmSync(bundled, { recursive: true });
          vfs.writeFileSync(`${projectRoot}/node_modules/.package-lock.json`, `{"installs":${installs}}`);
        }
      }
    });

    expect(await harness.run('npm', ['ci'])).toBe(0);
    expect(harness.manifest('node_modules/lightningcss/node_modules/napi-wasm')).toEqual({
      name: 'napi-wasm',
      version: '1.1.3'
    });

    expect(await harness.run('npm', ['install', '--no-save', 'picocolors'])).toBe(0);
    expect(harness.manifest('node_modules/lightningcss')).toEqual({ name: 'lightningcss-wasm', version: '1.33.0' });
    expect(harness.manifest('node_modules/lightningcss/node_modules/napi-wasm')).toEqual({
      name: 'napi-wasm',
      version: '1.1.3'
    });
  });

  test('use the nearest published version of a replacement that skipped the installed one', async () => {
    const harness = createHarness({
      versions: { '@parcel/watcher-wasm': ['2.3.0', '2.5.1', '2.5.4', '2.6.0'] },
      child: {
        code: 0,
        install(vfs) {
          installPackage(vfs, `${projectRoot}/node_modules/@parcel/watcher`, '@parcel/watcher', '2.5.3');
          installPackage(vfs, `${projectRoot}/node_modules/sass/node_modules/@parcel/watcher`, '@parcel/watcher', '2.5.1');
          vfs.writeFileSync(`${projectRoot}/node_modules/.package-lock.json`, '{}');
        }
      }
    });

    expect(await harness.run('npm', ['install'])).toBe(0);

    expect(harness.manifest('node_modules/@parcel/watcher')).toEqual({ name: '@parcel/watcher-wasm', version: '2.5.4' });
    expect(harness.manifest('node_modules/sass/node_modules/@parcel/watcher')).toEqual({
      name: '@parcel/watcher-wasm',
      version: '2.5.1'
    });
  });

  test('swap an esbuild that has no WASI binary for the nearest version that has, and run its install script', async () => {
    const harness = createHarness({
      versions: { '@esbuild/wasi-preview1': ['0.0.1', '0.22.0', '0.25.12'] },
      child: {
        code: 0,
        install(vfs) {
          installPackage(vfs, `${projectRoot}/node_modules/esbuild`, 'esbuild', '0.25.12', { 'lib/main.js': 'installed' });
          installPackage(vfs, `${projectRoot}/node_modules/builder/node_modules/esbuild`, 'esbuild', '0.19.12', {
            'lib/main.js': 'installed'
          });
          vfs.writeFileSync(`${projectRoot}/node_modules/.package-lock.json`, '{}');
        }
      }
    });

    expect(await harness.run('npm', ['install'])).toBe(0);

    expect(harness.manifest('node_modules/esbuild')).toEqual({ name: 'esbuild', version: '0.25.12' });
    expect(harness.vfs.readText(`${projectRoot}/node_modules/esbuild/lib/main.js`)).toBe('installed');
    expect(harness.manifest('node_modules/builder/node_modules/esbuild')).toEqual({ name: 'esbuild', version: '0.22.0' });
    expect(harness.vfs.readText(`${projectRoot}/node_modules/builder/node_modules/esbuild/lib/main.js`)).toBe(
      'esbuild 0.22.0'
    );
    expect(harness.spawned.slice(1)).toEqual([
      expect.objectContaining({
        command: 'sh',
        args: ['-c', 'node install.js'],
        cwd: `${projectRoot}/node_modules/builder/node_modules/esbuild`,
        env: expect.objectContaining({ ESBUILD_BINARY_PATH: launcher })
      })
    ]);
  });

  test('fail the command when the install script of a swapped version fails', async () => {
    const harness = createHarness({
      versions: { '@esbuild/wasi-preview1': ['0.22.0'] },
      child: {
        code: 0,
        scriptCode: 3,
        install(vfs) {
          installPackage(vfs, `${projectRoot}/node_modules/esbuild`, 'esbuild', '0.19.12');
          vfs.writeFileSync(`${projectRoot}/node_modules/.package-lock.json`, '{}');
        }
      }
    });

    expect(await harness.run('npm', ['install'])).toBe(1);
    expect(harness.stderr.join('')).toBe(
      'npm: the postinstall script of esbuild@0.22.0, which replaced the installed version, exited with 3.\n'
    );
  });

  test('leave a package of a major line its replacement was never published for as the manager installed it', async () => {
    const harness = createHarness({
      versions: { '@rollup/wasm-node': ['4.0.0', '4.62.4'], 'lightningcss-wasm': ['1.14.0', '1.33.0'] },
      child: {
        code: 0,
        install(vfs) {
          installPackage(vfs, `${projectRoot}/node_modules/rollup`, 'rollup', '3.29.4');
          installPackage(vfs, `${projectRoot}/node_modules/lightningcss`, 'lightningcss', '2.0.0');
          vfs.writeFileSync(`${projectRoot}/node_modules/.package-lock.json`, '{}');
        }
      }
    });

    expect(await harness.run('npm', ['install'])).toBe(0);
    expect(harness.manifest('node_modules/rollup')).toEqual({ name: 'rollup', version: '3.29.4' });
    expect(harness.manifest('node_modules/lightningcss')).toEqual({ name: 'lightningcss', version: '2.0.0' });
    expect(harness.fetched.filter((url) => url.endsWith('.tgz') && !url.includes('/npm/-/'))).toEqual([]);
  });

  test('replace the package directory in the pnpm store without touching files hard-linked from it', async () => {
    const store = '/home/.pnpm-store/rollup-native.js';
    const harness = createHarness({
      child: {
        code: 0,
        install(vfs) {
          const real = `${projectRoot}/node_modules/.pnpm/rollup@4.62.4/node_modules/rollup`;
          installPackage(vfs, real, 'rollup', '4.62.4');
          vfs.mkdirSync('/home/.pnpm-store', { recursive: true });
          vfs.writeFileSync(store, 'native from store');
          vfs.linkSync(store, `${real}/native.js`);
          vfs.symlinkSync('.pnpm/rollup@4.62.4/node_modules/rollup', `${projectRoot}/node_modules/rollup`);
          vfs.writeFileSync(`${projectRoot}/node_modules/.modules.yaml`, 'layoutVersion: 5\n');
        }
      }
    });

    expect(await harness.run('pnpm', ['install', '--frozen-lockfile'])).toBe(0);
    expect(harness.manifest('node_modules/rollup')).toEqual({ name: '@rollup/wasm-node', version: '4.62.4' });
    expect(harness.vfs.readText(store)).toBe('native from store');
  });

  test('state that Yarn Plug\'n\'Play archives keep their native package', async () => {
    const harness = createHarness({
      versions: { '@rollup/wasm-node': ['4.0.0', '4.62.4'] },
      child: {
        code: 0,
        install(vfs) {
          vfs.writeFileSync(`${projectRoot}/.pnp.cjs`, [
            'const RAW_RUNTIME_STATE =',
            '\'{\\',
            '  "packageRegistryData": [\\',
            '    ["rollup", [\\',
            '      ["npm:4.62.4", {\\',
            '        "packageLocation": "./.yarn/cache/rollup-npm-4.62.4.zip/node_modules/rollup/"\\'
          ].join('\n'));
          vfs.mkdirSync(`${projectRoot}/.yarn`, { recursive: true });
          vfs.writeFileSync(`${projectRoot}/.yarn/install-state.gz`, 'state');
        }
      }
    });

    expect(await harness.run('yarn', ['install'])).toBe(0);
    expect(harness.stderr.join('')).toBe(
      'yarn: rollup@4.62.4 needs its Browser Package Replacement @rollup/wasm-node, which is not applied ' +
        "to packages Yarn Plug'n'Play keeps in archives; set \"nodeLinker: node-modules\" in .yarnrc.yml to install it.\n"
    );
  });

  test('apply nothing when the manager left its install state alone', async () => {
    const harness = createHarness({
      child: {
        code: 0,
        install: (vfs) => installPackage(vfs, `${projectRoot}/node_modules/rollup`, 'rollup', '4.62.4')
      }
    });

    expect(await harness.run('npm', ['run', 'build'])).toBe(0);
    expect(harness.manifest('node_modules/rollup')).toEqual({ name: 'rollup', version: '4.62.4' });
  });

  test('fail the command when a replacement cannot be downloaded', async () => {
    const harness = createHarness({
      failing: ['@rollup/wasm-node@4.62.4'],
      child: {
        code: 0,
        install(vfs) {
          installPackage(vfs, `${projectRoot}/node_modules/rollup`, 'rollup', '4.62.4');
          vfs.writeFileSync(`${projectRoot}/node_modules/.package-lock.json`, '{}');
        }
      }
    });

    expect(await harness.run('npm', ['ci'])).toBe(1);
    expect(harness.stderr.join('')).toBe(
      'npm: the Browser Package Replacements could not be applied: ' +
        'Registry request for @rollup/wasm-node@4.62.4 failed: 503.\n'
    );
  });
});

describe('NAPI-RS companions after an install', () => {
  const rolldown = { binaryName: 'rolldown-binding', packageName: '@rolldown/binding', targets: ['x86_64-unknown-linux-gnu', 'wasm32-wasip1-threads'] };
  const companionRoot = `${projectRoot}/node_modules/.mimic/companions`;

  test('install the WASI binding a package names in its napi metadata once, and link it into every copy', async () => {
    const harness = createHarness({
      versions: { '@rolldown/binding-wasm32-wasi': ['1.2.12'] },
      child: {
        code: 0,
        install(vfs) {
          installPackage(vfs, `${projectRoot}/node_modules/rolldown`, 'rolldown', '1.2.12', {}, { napi: rolldown });
          installPackage(vfs, `${projectRoot}/node_modules/vite/node_modules/rolldown`, 'rolldown', '1.2.12', {}, { napi: rolldown });
          vfs.writeFileSync(`${projectRoot}/node_modules/.package-lock.json`, '{}');
        }
      }
    });

    expect(await harness.run('npm', ['ci'])).toBe(0);

    const materialized = `${companionRoot}/@rolldown/binding-wasm32-wasi/1.2.12`;
    expect(harness.spawned.slice(1)).toEqual([
      expect.objectContaining({
        command: `${cliRoot}/npm/11.18.0/bin/npm-cli.js`,
        args: ['install', '--no-save', '--no-package-lock', '--ignore-scripts', '--loglevel=error', '@rolldown/binding-wasm32-wasi@1.2.12'],
        cwd: materialized,
        env: expect.objectContaining({ npm_config_audit: 'false', PATH: '/bin' })
      })
    ]);
    for (const copy of ['node_modules/rolldown', 'node_modules/vite/node_modules/rolldown']) {
      const link = `${projectRoot}/${copy}/node_modules/@rolldown/binding-wasm32-wasi`;
      expect(harness.vfs.realpathSync(link)).toBe(`${materialized}/node_modules/@rolldown/binding-wasm32-wasi`);
      expect(harness.manifest(`${copy}/node_modules/@rolldown/binding-wasm32-wasi`)).toEqual({
        name: '@rolldown/binding-wasm32-wasi',
        version: '1.2.12'
      });
    }
    expect(harness.manifest('node_modules/rolldown')).toEqual({ name: 'rolldown', version: '1.2.12' });
    expect(harness.stderr).toEqual([]);
  });

  test('derive the binding from the package name when napi.packageName is absent', async () => {
    const harness = createHarness({
      versions: { '@node-rs/argon2-wasm32-wasi': ['2.2.1'] },
      child: {
        code: 0,
        install(vfs) {
          installPackage(vfs, `${projectRoot}/node_modules/@node-rs/argon2`, '@node-rs/argon2', '2.2.1', {}, {
            napi: { binaryName: 'argon2', targets: ['aarch64-apple-darwin', 'wasm32-wasip1-threads'] }
          });
          vfs.writeFileSync(`${projectRoot}/node_modules/.package-lock.json`, '{}');
        }
      }
    });

    expect(await harness.run('npm', ['install'])).toBe(0);
    expect(harness.spawned[1]?.args.at(-1)).toBe('@node-rs/argon2-wasm32-wasi@2.2.1');
    expect(harness.manifest('node_modules/@node-rs/argon2/node_modules/@node-rs/argon2-wasm32-wasi')).toEqual({
      name: '@node-rs/argon2-wasm32-wasi',
      version: '2.2.1'
    });
  });

  test('leave a package whose binding is installed, bundled or not published for WASI alone', async () => {
    const harness = createHarness({
      versions: { '@tailwindcss/oxide-wasm32-wasi': ['4.3.3'] },
      child: {
        code: 0,
        install(vfs) {
          // npm installed the binding as an optional dependency.
          installPackage(vfs, `${projectRoot}/node_modules/@tailwindcss/oxide`, '@tailwindcss/oxide', '4.3.3', {}, {
            napi: { binaryName: 'tailwindcss-oxide', packageName: '@tailwindcss/oxide', targets: ['wasm32-wasip1-threads'] }
          });
          installPackage(vfs, `${projectRoot}/node_modules/@tailwindcss/oxide-wasm32-wasi`, '@tailwindcss/oxide-wasm32-wasi', '4.3.3');
          // nx ships its WASI binding inside the package.
          installPackage(vfs, `${projectRoot}/node_modules/nx`, 'nx', '23.2.1', { 'nx.wasi.cjs': 'bundled' }, {
            napi: { binaryName: 'nx', packageName: '@nx/nx', targets: ['x86_64-unknown-linux-gnu', 'wasm32-wasip1-threads'] }
          });
          // @swc/core publishes no WASI target.
          installPackage(vfs, `${projectRoot}/node_modules/@swc/core`, '@swc/core', '1.16.13', {}, {
            napi: { binaryName: 'swc', targets: ['x86_64-unknown-linux-gnu'] }
          });
          vfs.writeFileSync(`${projectRoot}/node_modules/.package-lock.json`, '{}');
        }
      }
    });

    expect(await harness.run('npm', ['ci'])).toBe(0);
    expect(harness.spawned).toHaveLength(1);
    expect(harness.vfs.existsSync(companionRoot)).toBe(false);
    expect(harness.stderr).toEqual([]);
  });

  test('rewrite a shipped WASI loader that calls register functions its module does not export', async () => {
    const nx = { binaryName: 'nx', packageName: '@nx/nx', targets: ['x86_64-unknown-linux-gnu'] };
    const native = `${projectRoot}/node_modules/nx/dist/src/native`;
    const current = ['__napi_register__copy_4', '__napi_register__is_ai_agent_64'];
    const harness = createHarness({
      child: {
        code: 0,
        install(vfs) {
          // nx 23.2 publishes a loader generated by another build than its module.
          installPackage(vfs, `${projectRoot}/node_modules/nx`, 'nx', '23.2.0', {
            'dist/src/native/nx.wasi.cjs': generatedLoader(['__napi_register__copy_3', '__napi_register__is_ai_agent_52'], ['copy']),
            'dist/src/native/index.js': ''
          }, { napi: nx });
          vfs.writeFileSync(`${native}/nx.wasm32-wasi.wasm`, moduleExporting(current));
          // A package whose loader matches its module keeps it byte for byte.
          installPackage(vfs, `${projectRoot}/node_modules/@oxc-parser/binding-wasm32-wasi`, '@oxc-parser/binding-wasm32-wasi', '0.139.0', {
            'parser.wasi.cjs': generatedLoader(['__napi_register__parse_0'], ['parse'])
          }, { napi: { binaryName: 'parser', targets: [] } });
          vfs.writeFileSync(
            `${projectRoot}/node_modules/@oxc-parser/binding-wasm32-wasi/parser.wasm32-wasi.wasm`,
            moduleExporting(['__napi_register__parse_0'])
          );
          vfs.writeFileSync(`${projectRoot}/node_modules/.package-lock.json`, '{}');
        }
      }
    });

    expect(await harness.run('npm', ['ci'])).toBe(0);

    const loader = new TextDecoder().decode(harness.vfs.readFileSync(`${native}/nx.wasi.cjs`));
    expect([...loader.matchAll(/exports\['(__napi_register__[^']+)'\]/gu)].map((match) => match[1])).toEqual(current);
    expect(loader).toContain('Object.assign(module.exports, __napiModule.exports)');
    expect(new TextDecoder().decode(harness.vfs.readFileSync(`${projectRoot}/node_modules/@oxc-parser/binding-wasm32-wasi/parser.wasi.cjs`))).toBe(
      generatedLoader(['__napi_register__parse_0'], ['parse'])
    );
    expect(harness.stderr).toEqual([]);
  });

  test('state a binding the registry does not publish at the installed version', async () => {
    const harness = createHarness({
      versions: { '@rolldown/binding-wasm32-wasi': ['1.2.11'], '@rolldown/binding-wasm32-wasip1': [] },
      child: {
        code: 0,
        install(vfs) {
          installPackage(vfs, `${projectRoot}/node_modules/rolldown`, 'rolldown', '1.2.12', {}, { napi: rolldown });
          vfs.writeFileSync(`${projectRoot}/node_modules/.package-lock.json`, '{}');
        }
      }
    });

    expect(await harness.run('npm', ['ci'])).toBe(0);
    expect(harness.spawned).toHaveLength(1);
    expect(harness.stderr.join('')).toBe(
      'npm: rolldown@1.2.12 falls back to the WebAssembly binding @rolldown/binding-wasm32-wasi, which the npm registry ' +
        'does not publish at that version; the package reports the missing binding itself when executed.\n'
    );
  });

  test('relink a companion a later install pruned without installing it again', async () => {
    const link = `${projectRoot}/node_modules/rolldown/node_modules/@rolldown/binding-wasm32-wasi`;
    let installs = 0;
    const harness = createHarness({
      versions: { '@rolldown/binding-wasm32-wasi': ['1.2.12'] },
      child: {
        code: 0,
        install(vfs) {
          installs += 1;
          if (installs === 1) installPackage(vfs, `${projectRoot}/node_modules/rolldown`, 'rolldown', '1.2.12', {}, { napi: rolldown });
          else vfs.rmSync(`${projectRoot}/node_modules/rolldown/node_modules`, { recursive: true });
          vfs.writeFileSync(`${projectRoot}/node_modules/.package-lock.json`, `{"installs":${installs}}`);
        }
      }
    });

    expect(await harness.run('npm', ['ci'])).toBe(0);
    const fetchedBefore = harness.fetched.length;
    expect(await harness.run('npm', ['install', '--no-save', 'picocolors'])).toBe(0);

    expect(harness.vfs.existsSync(`${link}/package.json`)).toBe(true);
    expect(harness.spawned.filter((request) => request.cwd !== projectRoot)).toHaveLength(1);
    // The second apply asked the registry nothing: the materialized companion decides.
    expect(harness.fetched.slice(fetchedBefore)).toEqual([]);
  });

  test('relink a companion a later install pruned while writing the same install state again', async () => {
    const link = `${projectRoot}/node_modules/rolldown/node_modules/@rolldown/binding-wasm32-wasi`;
    const installState = `${projectRoot}/node_modules/.package-lock.json`;
    let installs = 0;
    const harness = createHarness({
      versions: { '@rolldown/binding-wasm32-wasi': ['1.2.12'] },
      child: {
        code: 0,
        install(vfs) {
          installs += 1;
          if (installs === 1) installPackage(vfs, `${projectRoot}/node_modules/rolldown`, 'rolldown', '1.2.12', {}, { napi: rolldown });
          else vfs.rmSync(`${projectRoot}/node_modules/rolldown/node_modules`, { recursive: true });
          // npm writes its hidden lockfile on every install, with the same content when the packages it installed did not change.
          vfs.writeFileSync(installState, '{"packages":{}}');
          vfs.utimesSync(installState, 1_000 * installs);
        }
      }
    });

    expect(await harness.run('npm', ['ci'])).toBe(0);
    expect(harness.vfs.existsSync(`${link}/package.json`)).toBe(true);
    expect(await harness.run('npm', ['install'])).toBe(0);

    expect(harness.vfs.existsSync(`${link}/package.json`)).toBe(true);
    expect(harness.spawned.filter((request) => request.cwd !== projectRoot)).toHaveLength(1);
  });

  test('report, instead of installing, a binding whose name the napi metadata derives invalidly', async () => {
    const harness = createHarness({
      versions: { '@rolldown/binding-wasm32-wasi': ['1.2.12'] },
      child: {
        code: 0,
        install(vfs) {
          installPackage(vfs, `${projectRoot}/node_modules/evil`, 'evil', '1.0.0', {}, {
            napi: { binaryName: 'evil', packageName: '../../.mimic/bin/esbuild', targets: ['wasm32-wasip1-threads'] }
          });
          installPackage(vfs, `${projectRoot}/node_modules/rolldown`, 'rolldown', '1.2.12', {}, { napi: rolldown });
          vfs.writeFileSync(`${projectRoot}/node_modules/.package-lock.json`, '{}');
        }
      }
    });

    expect(await harness.run('npm', ['install'])).toBe(0);

    expect(harness.stderr.join('')).toMatch(
      /evil@1\.0\.0: The napi\.packageName metadata names "\.\.\/\.\.\/\.mimic\/bin\/esbuild", which is not a valid npm package name\./u
    );
    expect(harness.spawned.filter((request) => request.cwd !== projectRoot).map((request) => request.args.at(-1))).toEqual([
      '@rolldown/binding-wasm32-wasi@1.2.12'
    ]);
    expect(harness.fetched.filter((url) => url.includes('.mimic'))).toEqual([]);
  });

  test("run the project's install scripts again once the companion its failed postinstall needed is in place", async () => {
    // npm runs `nuxt prepare` before the replacements: rolldown has no binding yet.
    const harness = createHarness({
      versions: { '@rolldown/binding-wasm32-wasi': ['1.2.12'] },
      child: {
        code: 1,
        stderr: ['npm error command sh -c nuxt prepare\n'],
        install(vfs) {
          vfs.writeFileSync(`${projectRoot}/package.json`, JSON.stringify({ name: 'starter', scripts: { postinstall: 'nuxt prepare' } }));
          installPackage(vfs, `${projectRoot}/node_modules/rolldown`, 'rolldown', '1.2.12', {}, { napi: rolldown });
          vfs.writeFileSync(`${projectRoot}/node_modules/.package-lock.json`, '{}');
        }
      }
    });

    expect(await harness.run('npm', ['install'])).toBe(0);
    expect(harness.spawned.filter((request) => request.command === 'sh')).toEqual([
      expect.objectContaining({
        args: ['-c', 'nuxt prepare'],
        cwd: projectRoot,
        env: expect.objectContaining({
          npm_lifecycle_event: 'postinstall',
          PATH: `${projectRoot}/node_modules/.bin:/home/node_modules/.bin:/node_modules/.bin:/bin`
        })
      })
    ]);
    expect(harness.stderr.join('')).toBe(
      'npm error command sh -c nuxt prepare\n' +
        "npm: the Browser Package Replacements are now in place; the project's install scripts run again.\n"
    );
  });

  test.each([
    ['pnpm', {}, 'node_modules/.modules.yaml', '. postinstall$ nuxt prepare\n ELIFECYCLE  Command failed with exit code 1.\n'],
    ['yarn', { packageManager: 'yarn@1.22.22' }, 'node_modules/.yarn-integrity', '$ nuxt prepare\nerror Command failed with exit code 1.\n']
  ] as const)("run the project's install scripts again when %s reports its postinstall failed", async (command, manifest, installState, report) => {
    const harness = createHarness({
      versions: { '@rolldown/binding-wasm32-wasi': ['1.2.12'] },
      child: {
        code: 1,
        // pnpm colours the script line.
        stdout: [command === 'pnpm' ? `\u001b[1m${report}\u001b[22m` : report],
        install(vfs) {
          installPackage(vfs, `${projectRoot}/node_modules/rolldown`, 'rolldown', '1.2.12', {}, { napi: rolldown });
          vfs.writeFileSync(`${projectRoot}/${installState}`, '{}');
        }
      }
    });
    harness.vfs.writeFileSync(
      `${projectRoot}/package.json`,
      JSON.stringify({ name: 'starter', ...manifest, scripts: { postinstall: 'nuxt prepare' } })
    );

    expect(await harness.run(command, ['install'])).toBe(0);
    expect(harness.spawned.filter((request) => request.command === 'sh').map((request) => request.args)).toEqual([
      ['-c', 'nuxt prepare']
    ]);
  });

  test.each([
    ['--ignore-scripts', ['install', '--ignore-scripts'], {}, undefined, 'npm error command sh -c husky\n'],
    ['npm_config_ignore_scripts', ['install'], { npm_config_ignore_scripts: 'true' }, undefined, 'npm error command sh -c husky\n'],
    ['ignore-scripts in .npmrc', ['install'], {}, 'registry=https://registry.npmjs.org/\nignore-scripts=true\n', 'npm error command sh -c husky\n'],
    ["a dependency's failed install script", ['install'], {}, undefined, 'npm error command sh -c node install.js\n'],
    ['a failure no script caused', ['install'], {}, undefined, 'npm error code ECONNRESET\n']
  ] as const)("keep the manager's exit code, running no project script again, after %s", async (_case, args, env, npmrc, report) => {
    const harness = createHarness({
      versions: { '@rolldown/binding-wasm32-wasi': ['1.2.12'] },
      child: {
        code: 1,
        stderr: [report],
        install(vfs) {
          vfs.writeFileSync(`${projectRoot}/package.json`, JSON.stringify({ name: 'app', scripts: { prepare: 'husky' } }));
          installPackage(vfs, `${projectRoot}/node_modules/rolldown`, 'rolldown', '1.2.12', {}, { napi: rolldown });
          vfs.writeFileSync(`${projectRoot}/node_modules/.package-lock.json`, '{}');
        }
      }
    });
    if (npmrc) harness.vfs.writeFileSync(`${projectRoot}/.npmrc`, npmrc);

    expect(await harness.run('npm', args, env)).toBe(1);
    expect(harness.spawned.filter((request) => request.command === 'sh')).toEqual([]);
    expect(harness.stderr).toEqual([report]);
  });

  test('keep the exit code of a failed install the replacements change nothing for', async () => {
    const harness = createHarness({
      child: {
        code: 1,
        install(vfs) {
          vfs.writeFileSync(`${projectRoot}/package.json`, JSON.stringify({ name: 'app', scripts: { postinstall: 'exit 1' } }));
          installPackage(vfs, `${projectRoot}/node_modules/left-pad`, 'left-pad', '1.3.0');
          vfs.writeFileSync(`${projectRoot}/node_modules/.package-lock.json`, '{}');
        }
      }
    });

    expect(await harness.run('npm', ['install'])).toBe(1);
    expect(harness.spawned.filter((request) => request.command === 'sh')).toEqual([]);
  });

  test('fail the command when the companion install fails', async () => {
    const harness = createHarness({
      versions: { '@rolldown/binding-wasm32-wasi': ['1.2.12'] },
      child: {
        code: 0,
        companionCode: 1,
        install(vfs) {
          installPackage(vfs, `${projectRoot}/node_modules/rolldown`, 'rolldown', '1.2.12', {}, { napi: rolldown });
          vfs.writeFileSync(`${projectRoot}/node_modules/.package-lock.json`, '{}');
        }
      }
    });

    expect(await harness.run('npm', ['ci'])).toBe(1);
    expect(harness.stderr.join('')).toBe(
      'npm: the Browser Package Replacements could not be applied: npm install @rolldown/binding-wasm32-wasi@1.2.12 exited with 1.\n'
    );
  });
});

describe('esbuild replacement launcher', () => {
  test('runs the WASI binary of the version esbuild names in its service argument', async () => {
    const harness = createHarness();

    expect(await harness.run(launcher, ['--service=0.25.12', '--ping'])).toBe(0);
    expect(await harness.run(launcher, ['--service=0.28.1', '--ping'])).toBe(0);

    expect(harness.replaced).toEqual([
      expect.objectContaining({
        command: '/.mimic/replacements/@esbuild/wasi-preview1/0.25.12/esbuild.wasm',
        args: ['--service=0.25.12', '--ping']
      }),
      expect.objectContaining({
        command: '/.mimic/replacements/@esbuild/wasi-preview1/0.28.1/esbuild.wasm',
        args: ['--service=0.28.1', '--ping']
      })
    ]);
    expect(await harness.fs.readFile(harness.replaced[1]!.command, 'utf8')).toBe('wasm 0.28.1');
  });

  test('runs the version of the esbuild package it is called from', async () => {
    const harness = createHarness();
    installPackage(harness.vfs, `${projectRoot}/node_modules/esbuild`, 'esbuild', '0.27.0');
    installPackage(harness.vfs, `${projectRoot}/node_modules/vite/node_modules/esbuild`, 'esbuild', '0.25.12');

    await harness.run(launcher, ['--version'], {}, `${projectRoot}/node_modules/vite/node_modules/esbuild`);
    await harness.run(launcher, ['app.js', '--bundle'], {}, `${projectRoot}/src`);

    expect(harness.replaced.map(({ command }) => command)).toEqual([
      '/.mimic/replacements/@esbuild/wasi-preview1/0.25.12/esbuild.wasm',
      '/.mimic/replacements/@esbuild/wasi-preview1/0.27.0/esbuild.wasm'
    ]);
  });

  test('answers the version check of an esbuild that has no WASI binary and refuses to run it', async () => {
    const harness = createHarness({ versions: { '@esbuild/wasi-preview1': ['0.22.0', '0.25.12'] } });
    installPackage(harness.vfs, `${projectRoot}/node_modules/esbuild`, 'esbuild', '0.19.12');

    // The install script of the version an install is about to swap asks for it.
    expect(await harness.run(launcher, ['--version'], {}, `${projectRoot}/node_modules/esbuild`)).toBe(0);
    expect(harness.stdout).toEqual(['0.19.12\n']);
    expect(await harness.run(launcher, ['--service=0.19.12', '--ping'])).toBe(1);
    expect(harness.stderr.join('')).toBe(
      'esbuild@0.19.12 cannot run in Mimic: @esbuild/wasi-preview1 is not published for it. ' +
        "An install through npm, pnpm or Yarn's node-modules linker swaps it for the nearest esbuild " +
        'version that has one.\n'
    );
    expect(harness.replaced).toEqual([]);
  });
});

type ChildBehaviour = Readonly<{
  code: number;
  /** The exit code of an install script run after a swap. */
  scriptCode?: number;
  /** The exit code of a companion install; 0 installs the companion and one dependency. */
  companionCode?: number;
  stdout?: readonly string[];
  stderr?: readonly string[];
  install?: (vfs: VirtualFileSystem) => void;
}>;

function createHarness(options: Readonly<{
  child?: ChildBehaviour;
  cliBytes?: Uint8Array;
  unpublished?: readonly string[];
  /** The `name@version` whose registry metadata request fails with a server error. */
  failing?: readonly string[];
  /** The versions the registry lists for a package; any version not `unpublished` is otherwise served. */
  versions?: Readonly<Record<string, readonly string[]>>;
  /** A signal the proxy receives while it starts the manager. */
  signalBeforeSpawn?: 'SIGTERM' | 'SIGINT';
}> = {}) {
  const vfs = new VirtualFileSystem(projectRoot);
  vfs.mkdirSync(projectRoot, { recursive: true });
  const fs = memoryProcessFileSystem(vfs);
  const registry = createRegistry(options);
  const spawned: RuntimeProgramRequest[] = [];
  const replaced: Omit<RuntimeProgramRequest, 'parentPid'>[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const killed: string[] = [];
  const signalListeners = new Set<(signal: 'SIGTERM' | 'SIGKILL' | 'SIGINT') => void>();
  const recordKills = (child: RuntimeProgramProcess): RuntimeProgramProcess => {
    const kill = child.kill.bind(child);
    child.kill = (signal) => {
      killed.push(signal ?? 'SIGTERM');
      kill(signal);
    };
    return child;
  };
  const programs = createPackageManagerCommandProxies({
    fileSystem: fs,
    cache: new MemoryArtifactCache(),
    fetch: registry.fetch,
    async spawnProgram(request) {
      spawned.push(request);
      const child = options.child ?? { code: 0 };
      if (request.command === 'sh') return childProcess({ code: child.scriptCode ?? 0 });
      if (request.cwd !== projectRoot && request.args.includes('--no-save')) {
        // The pinned npm installing a companion: `npm install <name>@<version>` under its cwd.
        const code = child.companionCode ?? 0;
        if (code === 0) {
          const spec = /^(.+)@([^@]+)$/u.exec(request.args.at(-1)!)!;
          installPackage(vfs, `${request.cwd}/node_modules/${spec[1]}`, spec[1]!, spec[2]!, { 'index.js': 'wasi' });
          installPackage(vfs, `${request.cwd}/node_modules/@napi-rs/wasm-runtime`, '@napi-rs/wasm-runtime', '1.2.4');
        }
        return childProcess({ code });
      }
      // Only the manager installs; an install script it did not run is a plain child.
      child.install?.(vfs);
      if (options.signalBeforeSpawn) for (const listener of [...signalListeners]) listener(options.signalBeforeSpawn);
      return recordKills(childProcess(child));
    },
    async replaceProgram(request) {
      replaced.push(request);
      return 0;
    }
  });
  const writer = (sink: string[]) => ({
    write: (chunk: string | Uint8Array) => {
      sink.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    },
    close() {},
    fail() {},
    waitForKill: () => new Promise<never>(() => undefined)
  });
  return {
    vfs,
    fs,
    spawned,
    replaced,
    stdout,
    stderr,
    killed,
    fetched: registry.fetched,
    manifest(path: string) {
      const { name, version } = JSON.parse(vfs.readText(`${projectRoot}/${path}/package.json`)) as {
        name: string;
        version: string;
      };
      return { name, version };
    },
    async run(
      command: string,
      args: readonly string[],
      env: Record<string, string> = {},
      cwd = projectRoot,
      signal?: Promise<'SIGTERM' | 'SIGKILL' | 'SIGINT'>
    ) {
      const program = programs.find((candidate) => candidate.commands.includes(command));
      if (!program) throw new Error(`No program owns ${command}`);
      return program.run(args, {
        cwd,
        env: { PATH: '/bin', ...env },
        executable: {
          programId: program.id,
          argv: args,
          provenance: { kind: 'runtime-program', command, paths: [] }
        },
        pid: 41,
        ...(signal ? { signal } : {}),
        onSignal(listener: (signal: 'SIGTERM' | 'SIGKILL' | 'SIGINT') => void) {
          signalListeners.add(listener);
          return () => signalListeners.delete(listener);
        },
        fs,
        writer: writer(stdout),
        errorWriter: writer(stderr),
        input: { read: async () => undefined }
      });
    }
  };
}

function childProcess(behaviour: ChildBehaviour): RuntimeProgramProcess {
  return createVirtualProcess(42, async (stdout, _stdin, stderr) => {
    for (const chunk of behaviour.stdout ?? []) await stdout.write(chunk);
    for (const chunk of behaviour.stderr ?? []) await stderr.write(chunk);
    return behaviour.code;
  });
}

function createRegistry(options: Readonly<{
  cliBytes?: Uint8Array;
  unpublished?: readonly string[];
  failing?: readonly string[];
  versions?: Readonly<Record<string, readonly string[]>>;
}>) {
  const fetched: string[] = [];
  const tarballs = new Map<string, Uint8Array>([
    ['https://registry.npmjs.org/npm/-/npm-11.18.0.tgz', cliTarball('npm')],
    ['https://registry.npmjs.org/pnpm/-/pnpm-11.11.0.tgz', cliTarball('pnpm')],
    ['https://registry.npmjs.org/@yarnpkg/cli-dist/-/cli-dist-4.17.1.tgz', cliTarball('yarn')]
  ]);
  if (options.cliBytes) tarballs.set('https://registry.npmjs.org/npm/-/npm-11.18.0.tgz', options.cliBytes);
  const published = (name: string, version: string): Uint8Array | undefined => {
    if (options.unpublished?.includes(`${name}@${version}`)) return undefined;
    const listed = options.versions?.[name];
    if (listed && !listed.includes(version)) return undefined;
    if (name === '@esbuild/wasi-preview1') return makePackageTgz({ 'esbuild.wasm': `wasm ${version}` });
    if (name === 'esbuild') {
      return makePackageTgz({
        'package.json': JSON.stringify({ name, version, scripts: { postinstall: 'node install.js' } }),
        'lib/main.js': `esbuild ${version}`
      });
    }
    if (name === 'lightningcss-wasm') {
      return makePackageTgz({
        'package.json': JSON.stringify({ name, version }),
        'node_modules/napi-wasm/package.json': JSON.stringify({ name: 'napi-wasm', version: '1.1.3' })
      });
    }
    if (name === 'pnpm') return managerRelease('pnpm', version);
    if (name === 'yarn' || name === '@yarnpkg/cli-dist') return managerRelease('yarn', version);
    return makePackageTgz({
      'package.json': JSON.stringify({ name, version }),
      'dist/index.js': `${name} ${version}`
    });
  };
  const fetchArtifact = async (url: string): Promise<Response> => {
    fetched.push(url);
    const tarball = tarballs.get(url);
    if (tarball) return new Response(tarball.slice());
    const packument = /^https:\/\/registry\.npmjs\.org\/((?:@[^/]+%2f)?[^/]+)$/u.exec(url);
    if (packument) {
      const name = packument[1]!.replace('%2f', '/');
      return Response.json({
        name,
        versions: Object.fromEntries((options.versions?.[name] ?? []).map((version) => [version, {}]))
      });
    }
    const metadata = /^https:\/\/registry\.npmjs\.org\/(.+)\/([^/]+)$/u.exec(url);
    if (metadata) {
      const name = metadata[1]!.replace('%2f', '/');
      if (options.failing?.includes(`${name}@${metadata[2]}`)) return new Response('unavailable', { status: 503 });
      const bytes = published(name, metadata[2]!);
      if (!bytes) return new Response('{}', { status: 404 });
      const tarballUrl = `https://tarballs.test/${name}-${metadata[2]}.tgz`;
      tarballs.set(tarballUrl, bytes);
      return Response.json({ name, version: metadata[2], dist: { tarball: tarballUrl, integrity: integrityOf(bytes) } });
    }
    return new Response('missing', { status: 404 });
  };
  return { fetched, fetch: fetchArtifact };
}

function cliTarball(manager: 'npm' | 'pnpm' | 'yarn'): Uint8Array {
  return makePackageTgz(
    manager === 'npm'
      ? { 'bin/npm-cli.js': 'npm cli', 'bin/npx-cli.js': 'npx cli' }
      : manager === 'pnpm'
        ? { 'bin/pnpm.mjs': 'pnpm cli', 'bin/pnpx.mjs': 'pnpx cli' }
        : { 'bin/yarn.js': 'yarn cli' }
  );
}

/** A published manager release, its `bin` as that manager's package states it. */
function managerRelease(manager: 'pnpm' | 'yarn', version: string): Uint8Array {
  return makePackageTgz(
    manager === 'pnpm'
      ? {
          'package.json': JSON.stringify({ name: 'pnpm', version, bin: { pnpm: 'bin/pnpm.cjs', pnpx: 'bin/pnpx.cjs' } }),
          'bin/pnpm.cjs': `pnpm ${version}`,
          'bin/pnpx.cjs': `pnpx ${version}`
        }
      : {
          'package.json': JSON.stringify({ name: 'yarn', version, bin: { yarn: './bin/yarn.js', yarnpkg: './bin/yarn.js' } }),
          'bin/yarn.js': `yarn ${version}`
        }
  );
}

function integrityOf(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function installPackage(
  vfs: VirtualFileSystem,
  directory: string,
  name: string,
  version: string,
  files: Record<string, string> = {},
  manifest: Record<string, unknown> = {}
): void {
  vfs.mkdirSync(directory, { recursive: true });
  vfs.writeFileSync(`${directory}/package.json`, JSON.stringify({ name, version, ...manifest }));
  for (const [path, contents] of Object.entries(files)) {
    const file = `${directory}/${path}`;
    vfs.mkdirSync(file.slice(0, file.lastIndexOf('/')), { recursive: true });
    vfs.writeFileSync(file, contents);
  }
}
