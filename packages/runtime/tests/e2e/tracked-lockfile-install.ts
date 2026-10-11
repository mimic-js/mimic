export type FrozenCompatibilityInstall = Readonly<{
  command: string;
  args: readonly string[];
}>;

type TrackedLockfileInstallInput = Readonly<{
  packageJson: string;
  lockfile: string;
  install: FrozenCompatibilityInstall;
}>;

type CompatibilityFixtureFile = Readonly<{ file: Readonly<{ contents: string }> }>;

type NpmCompatibilityFixtureFiles = Readonly<{
  'package.json': CompatibilityFixtureFile;
  'package-lock.json': CompatibilityFixtureFile;
}>;

type PnpmCompatibilityFixtureFiles = Readonly<{
  'package.json': CompatibilityFixtureFile;
  'pnpm-lock.yaml': CompatibilityFixtureFile;
}>;

type YarnCompatibilityFixtureFiles = Readonly<{
  'package.json': CompatibilityFixtureFile;
  'yarn.lock': CompatibilityFixtureFile;
}>;

export type NpmTrackedLockfileInstall = Readonly<{
  files: NpmCompatibilityFixtureFiles;
  install: Readonly<{
    command: 'npm';
    args: readonly ['ci'] | readonly ['ci', '--ignore-scripts'];
  }>;
  assertLockfileUnchanged(actual: string): void;
}>;

export type YarnTrackedLockfileInstall = Readonly<{
  files: YarnCompatibilityFixtureFiles;
  install: Readonly<{
    command: 'yarn';
    args: readonly ['install', '--immutable', '--immutable-cache'];
  }>;
  assertLockfileUnchanged(actual: string): void;
}>;

export type PnpmTrackedLockfileInstall = Readonly<{
  files: PnpmCompatibilityFixtureFiles;
  install: Readonly<{
    command: 'pnpm';
    args: readonly ['install', '--frozen-lockfile'];
  }>;
  assertLockfileUnchanged(actual: string): void;
}>;

export type TrackedLockfileInstall =
  | NpmTrackedLockfileInstall
  | PnpmTrackedLockfileInstall
  | YarnTrackedLockfileInstall;

export function prepareTrackedLockfileInstall(input: TrackedLockfileInstallInput): TrackedLockfileInstall {
  const packageJson = parseRecord(input.packageJson, 'Compatibility fixture package.json is missing or invalid');

  if (input.install.command === 'npm') {
    const lockfile = parseRecord(input.lockfile, 'Tracked Compatibility Lockfile is missing or invalid');
    if (lockfile.lockfileVersion !== 3 || !isRecord(lockfile.packages)) {
      throw new Error('Tracked Compatibility Lockfile must be an npm lockfileVersion 3 packages graph');
    }
    assertPackageDependencies(packageJson);
    if (!isFrozenNpmInstall(input.install)) {
      throw new Error('registry-backed Exact Graph fixtures require npm ci so the tracked lockfile is immutable input');
    }

    return {
      files: {
        'package.json': { file: { contents: input.packageJson } },
        'package-lock.json': { file: { contents: input.lockfile } }
      },
      install: {
        command: 'npm',
        args: input.install.args.length === 2 ? ['ci', '--ignore-scripts'] : ['ci']
      },
      assertLockfileUnchanged: createLockfileUnchangedAssertion(input.lockfile)
    };
  }

  if (input.install.command === 'pnpm') {
    if (!isPnpmLockfileVersion9(input.lockfile)) {
      throw new Error('Tracked Compatibility Lockfile must be a pnpm lockfileVersion 9 graph');
    }
    assertPackageDependencies(packageJson);
    if (!isFrozenPnpmInstall(input.install)) {
      throw new Error(
        'registry-backed Exact Graph fixtures require pnpm install --frozen-lockfile'
      );
    }

    return {
      files: {
        'package.json': { file: { contents: input.packageJson } },
        'pnpm-lock.yaml': { file: { contents: input.lockfile } }
      },
      install: {
        command: 'pnpm',
        args: ['install', '--frozen-lockfile']
      },
      assertLockfileUnchanged: createLockfileUnchangedAssertion(input.lockfile)
    };
  }

  if (!isYarnMetadataVersion10(input.lockfile)) {
    throw new Error('Tracked Compatibility Lockfile must be a Yarn __metadata version 10 lockfile');
  }
  assertPackageDependencies(packageJson);
  if (!isFrozenYarnInstall(input.install)) {
    throw new Error('registry-backed Exact Graph fixtures require Yarn install --immutable --immutable-cache');
  }

  return {
    files: {
      'package.json': { file: { contents: input.packageJson } },
      'yarn.lock': { file: { contents: input.lockfile } }
    },
    install: {
      command: 'yarn',
      args: ['install', '--immutable', '--immutable-cache']
    },
    assertLockfileUnchanged: createLockfileUnchangedAssertion(input.lockfile)
  };
}

function assertPackageDependencies(packageJson: Readonly<Record<string, unknown>>): void {
  if (!isRecord(packageJson.dependencies) || Object.keys(packageJson.dependencies).length === 0) {
    throw new Error('Registry-backed Exact Graph fixture package.json must declare dependencies');
  }
}

function isFrozenNpmInstall(install: FrozenCompatibilityInstall): boolean {
  return (
    install.command === 'npm' &&
    install.args[0] === 'ci' &&
    install.args.length <= 2 &&
    (install.args.length === 1 || install.args[1] === '--ignore-scripts')
  );
}

function isFrozenPnpmInstall(install: FrozenCompatibilityInstall): boolean {
  return (
    install.command === 'pnpm' &&
    install.args.length === 2 &&
    install.args[0] === 'install' &&
    install.args[1] === '--frozen-lockfile'
  );
}

function isFrozenYarnInstall(install: FrozenCompatibilityInstall): boolean {
  return (
    install.command === 'yarn' &&
    install.args.length === 3 &&
    install.args[0] === 'install' &&
    install.args[1] === '--immutable' &&
    install.args[2] === '--immutable-cache'
  );
}

function isPnpmLockfileVersion9(lockfile: string): boolean {
  return (
    /^lockfileVersion:\s*['"]?9\.0['"]?\s*(?:#.*)?$/m.test(lockfile) &&
    /^importers:\s*(?:#.*)?$/m.test(lockfile) &&
    /^packages:\s*(?:#.*)?$/m.test(lockfile)
  );
}

function isYarnMetadataVersion10(lockfile: string): boolean {
  const metadata = /^__metadata:\s*\r?\n((?:[\t ]+[^\r\n]*(?:\r?\n|$))*)/m.exec(lockfile);
  return metadata !== null && /^[\t ]+version:\s*10\s*(?:#.*)?$/m.test(metadata[1]);
}

function createLockfileUnchangedAssertion(expected: string): (actual: string) => void {
  return (actual: string): void => {
    if (actual !== expected) {
      throw new Error('package manager changed the Tracked Compatibility Lockfile; curate and review it outside test execution');
    }
  };
}

function parseRecord(source: string, message: string): Readonly<Record<string, unknown>> {
  if (source.trim() === '') throw new Error(message);

  try {
    const value: unknown = JSON.parse(source);
    if (isRecord(value)) return value;
  } catch {
    // Fall through to the fixture-facing error below.
  }
  throw new Error(message);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
