import { describe, expect, test } from 'vitest';

import { prepareTrackedLockfileInstall } from '../e2e/tracked-lockfile-install';

const packageJson = JSON.stringify({
  name: 'exact-graph-fixture',
  version: '0.0.0',
  private: true,
  dependencies: { express: '5.2.1' }
});
const packageLock = JSON.stringify({
  name: 'exact-graph-fixture',
  version: '0.0.0',
  lockfileVersion: 3,
  packages: {
    '': { name: 'exact-graph-fixture', version: '0.0.0', dependencies: { express: '5.2.1' } },
    'node_modules/express': {
      version: '5.2.1',
      resolved: 'https://registry.npmjs.org/express/-/express-5.2.1.tgz',
      integrity: 'sha512-example'
    }
  }
});

const yarnLock = [
  '__metadata:',
  '  version: 10',
  '  cacheKey: 10c0',
  '',
  '"exact-graph-fixture@workspace:.":',
  '  version: 0.0.0-use.local',
  '  resolution: "exact-graph-fixture@workspace:."',
  '  languageName: unknown',
  '  linkType: soft',
  ''
].join('\n');

const pnpmLock = [
  "lockfileVersion: '9.0'",
  '',
  'settings:',
  '  autoInstallPeers: true',
  '',
  'importers:',
  '  .:',
  '    dependencies:',
  '      express:',
  '        specifier: 5.2.1',
  '        version: 5.2.1',
  '',
  'packages:',
  '  express@5.2.1:',
  '    resolution: {integrity: sha512-example}',
  ''
].join('\n');

describe('tracked compatibility lockfile install', () => {
  test('mounts the curated manifest and lockfile for immutable npm ci execution', () => {
    const fixture = prepareTrackedLockfileInstall({
      packageJson,
      lockfile: packageLock,
      install: { command: 'npm', args: ['ci'] }
    });

    expect(fixture.install).toEqual({ command: 'npm', args: ['ci'] });
    expect(fixture.files).toEqual({
      'package.json': { file: { contents: packageJson } },
      'package-lock.json': { file: { contents: packageLock } }
    });
    expect(() => fixture.assertLockfileUnchanged(packageLock)).not.toThrow();
  });

  test('fails closed when the curated lockfile is missing', () => {
    expect(() =>
      prepareTrackedLockfileInstall({
        packageJson,
        lockfile: '',
        install: { command: 'npm', args: ['ci'] }
      })
    ).toThrow('Tracked Compatibility Lockfile is missing');
  });

  test('fails closed when the install command can update the lockfile', () => {
    expect(() =>
      prepareTrackedLockfileInstall({
        packageJson,
        lockfile: packageLock,
        install: { command: 'npm', args: ['install'] }
      })
    ).toThrow('registry-backed Exact Graph fixtures require npm ci');
  });

  test('fails closed when the package manager mutates the tracked lockfile', () => {
    const fixture = prepareTrackedLockfileInstall({
      packageJson,
      lockfile: packageLock,
      install: { command: 'npm', args: ['ci'] }
    });

    expect(() => fixture.assertLockfileUnchanged(`${packageLock}\n`)).toThrow(
      'package manager changed the Tracked Compatibility Lockfile'
    );
  });

  test('mounts a pnpm 11.11.0 lockfile for canonical frozen execution', () => {
    const fixture = prepareTrackedLockfileInstall({
      packageJson,
      lockfile: pnpmLock,
      install: { command: 'pnpm', args: ['install', '--frozen-lockfile'] }
    });

    expect(fixture.install).toEqual({
      command: 'pnpm',
      args: ['install', '--frozen-lockfile']
    });
    expect(fixture.files).toEqual({
      'package.json': { file: { contents: packageJson } },
      'pnpm-lock.yaml': { file: { contents: pnpmLock } }
    });
    expect(() => fixture.assertLockfileUnchanged(pnpmLock)).not.toThrow();
  });

  test.each([
    ['missing frozen-lockfile', ['install']],
    ['mutable override', ['install', '--no-frozen-lockfile']],
    ['flags in a noncanonical order', ['--frozen-lockfile', 'install']]
  ])('rejects the pnpm %s invocation', (_description, args) => {
    expect(() =>
      prepareTrackedLockfileInstall({
        packageJson,
        lockfile: pnpmLock,
        install: { command: 'pnpm', args }
      })
    ).toThrow('registry-backed Exact Graph fixtures require pnpm install --frozen-lockfile');
  });

  test('rejects a pnpm lockfile without lockfileVersion 9', () => {
    expect(() =>
      prepareTrackedLockfileInstall({
        packageJson,
        lockfile: pnpmLock.replace("lockfileVersion: '9.0'", "lockfileVersion: '8.0'"),
        install: { command: 'pnpm', args: ['install', '--frozen-lockfile'] }
      })
    ).toThrow('Tracked Compatibility Lockfile must be a pnpm lockfileVersion 9 graph');
  });

  test('mounts a Yarn 4.17.1 lockfile for the canonical immutable-cache install', () => {
    const fixture = prepareTrackedLockfileInstall({
      packageJson,
      lockfile: yarnLock,
      install: { command: 'yarn', args: ['install', '--immutable', '--immutable-cache'] }
    });

    expect(fixture.install).toEqual({ command: 'yarn', args: ['install', '--immutable', '--immutable-cache'] });
    expect(fixture.files).toEqual({
      'package.json': { file: { contents: packageJson } },
      'yarn.lock': { file: { contents: yarnLock } }
    });
    expect(() => fixture.assertLockfileUnchanged(yarnLock)).not.toThrow();
  });

  test.each([
    ['missing immutable-cache', ['install', '--immutable']],
    ['mutable install', ['install']],
    ['flags in a noncanonical order', ['install', '--immutable-cache', '--immutable']]
  ])('rejects the Yarn %s invocation', (_description, args) => {
    expect(() =>
      prepareTrackedLockfileInstall({
        packageJson,
        lockfile: yarnLock,
        install: { command: 'yarn', args }
      })
    ).toThrow('registry-backed Exact Graph fixtures require Yarn install --immutable --immutable-cache');
  });

  test('rejects a Yarn lockfile without __metadata version 10', () => {
    expect(() =>
      prepareTrackedLockfileInstall({
        packageJson,
        lockfile: yarnLock.replace('version: 10', 'version: 9'),
        install: { command: 'yarn', args: ['install', '--immutable', '--immutable-cache'] }
      })
    ).toThrow('Tracked Compatibility Lockfile must be a Yarn __metadata version 10 lockfile');
  });

  test('requires a nonempty dependency graph for Yarn fixtures too', () => {
    expect(() =>
      prepareTrackedLockfileInstall({
        packageJson: JSON.stringify({ name: 'dependency-free', private: true, dependencies: {} }),
        lockfile: yarnLock,
        install: { command: 'yarn', args: ['install', '--immutable', '--immutable-cache'] }
      })
    ).toThrow('Registry-backed Exact Graph fixture package.json must declare dependencies');
  });
});
