export type CompatibilityClaim = Readonly<{
  id: string;
  statement: string;
  target: CompatibilityClaimTarget;
}>;

export type CompatibilityClaimTarget = ExactGraphCompatibilityTarget | RuntimeCapabilityCompatibilityTarget;

export type NpmTrackedCompatibilityLockfilePath = `compatibility/fixtures/${string}/package-lock.json`;
export type PnpmTrackedCompatibilityLockfilePath = `compatibility/fixtures/${string}/pnpm-lock.yaml`;
export type YarnTrackedCompatibilityLockfilePath = `compatibility/fixtures/${string}/yarn.lock`;
export type TrackedCompatibilityLockfilePath =
  | NpmTrackedCompatibilityLockfilePath
  | PnpmTrackedCompatibilityLockfilePath
  | YarnTrackedCompatibilityLockfilePath;

type ExactGraphCompatibilityTargetBase = Readonly<{
  kind: 'exact-graph';
  packages: Readonly<Record<string, string>>;
  virtualPlatform: Readonly<{
    operatingSystem: 'linux';
    architecture: 'wasm32';
    runtime: 'browser';
    nodeVersion: '22.22.3';
  }>;
  /**
   * The Browser Package Replacements the installed graph carries: each source
   * package name maps to the `name@version` installed in its place.
   */
  replacements: Readonly<Record<string, string>>;
  execution: Readonly<{
    command: string;
    entrypoint: string;
  }>;
}>;

export type NpmExactGraphCompatibilityTarget = ExactGraphCompatibilityTargetBase &
  Readonly<{
  packageManager: Readonly<{
    name: 'npm';
    version: '11.18.0';
  }>;
  lockfile: Readonly<{
    format: 'npm';
    version: 3;
    path: NpmTrackedCompatibilityLockfilePath;
  }>;
}>;

export type YarnExactGraphCompatibilityTarget = ExactGraphCompatibilityTargetBase &
  Readonly<{
    packageManager: Readonly<{
      name: 'yarn';
      version: '4.17.1';
    }>;
    lockfile: Readonly<{
      format: 'yarn';
      version: 10;
      path: YarnTrackedCompatibilityLockfilePath;
    }>;
  }>;

export type PnpmExactGraphCompatibilityTarget = ExactGraphCompatibilityTargetBase &
  Readonly<{
  packageManager: Readonly<{
    name: 'pnpm';
    version: '11.11.0';
  }>;
  lockfile: Readonly<{
    format: 'pnpm';
    version: 9;
    path: PnpmTrackedCompatibilityLockfilePath;
  }>;
}>;

export type ExactGraphCompatibilityTarget =
  | NpmExactGraphCompatibilityTarget
  | PnpmExactGraphCompatibilityTarget
  | YarnExactGraphCompatibilityTarget;

export type RuntimeCapabilityCompatibilityTarget = Readonly<{
  kind: 'runtime-capability';
  capability: string;
}>;

export function defineCompatibilityClaim<const TClaim extends CompatibilityClaim>(claim: TClaim): TClaim;
export function defineCompatibilityClaim(claim: unknown): CompatibilityClaim;
export function defineCompatibilityClaim(claim: unknown): CompatibilityClaim {
  if (!isCompatibilityClaim(claim)) {
    throw new Error('Invalid compatibility claim');
  }

  return claim;
}

function isCompatibilityClaim(value: unknown): value is CompatibilityClaim {
  if (!isRecord(value) || !isNonEmptyString(value.id) || !isNonEmptyString(value.statement)) return false;
  if (!hasOnlyKeys(value, ['id', 'statement', 'target'])) return false;
  return isExactGraphTarget(value.target) || isRuntimeCapabilityTarget(value.target);
}

function isExactGraphTarget(value: unknown): value is ExactGraphCompatibilityTarget {
  if (!isRecord(value) || value.kind !== 'exact-graph' || !isStringRecord(value.packages)) return false;
  if (
    !hasOnlyKeys(value, [
      'kind',
      'packages',
      'packageManager',
      'lockfile',
      'virtualPlatform',
      'replacements',
      'execution'
    ])
  ) {
    return false;
  }
  if (Object.keys(value.packages).length === 0) return false;

  return (
    isExactGraphManagerAndLockfile(value) &&
    isRecord(value.virtualPlatform) &&
    value.virtualPlatform.operatingSystem === 'linux' &&
    value.virtualPlatform.architecture === 'wasm32' &&
    value.virtualPlatform.runtime === 'browser' &&
    value.virtualPlatform.nodeVersion === '22.22.3' &&
    isRecord(value.replacements) &&
    Object.values(value.replacements).every(isPackageIdentity) &&
    isRecord(value.execution) &&
    isNonEmptyString(value.execution.command) &&
    isNonEmptyString(value.execution.entrypoint)
  );
}

function isExactGraphManagerAndLockfile(value: Readonly<Record<string, unknown>>): boolean {
  if (!isRecord(value.packageManager) || !isRecord(value.lockfile) || !hasOnlyTrackedLockfileKeys(value.lockfile)) return false;

  return (
    (value.packageManager.name === 'npm' &&
      value.packageManager.version === '11.18.0' &&
      value.lockfile.format === 'npm' &&
      value.lockfile.version === 3 &&
      isNpmTrackedCompatibilityLockfilePath(value.lockfile.path)) ||
    (value.packageManager.name === 'pnpm' &&
      value.packageManager.version === '11.11.0' &&
      value.lockfile.format === 'pnpm' &&
      value.lockfile.version === 9 &&
      isPnpmTrackedCompatibilityLockfilePath(value.lockfile.path)) ||
    (value.packageManager.name === 'yarn' &&
      value.packageManager.version === '4.17.1' &&
      value.lockfile.format === 'yarn' &&
      value.lockfile.version === 10 &&
      isYarnTrackedCompatibilityLockfilePath(value.lockfile.path))
  );
}

function isRuntimeCapabilityTarget(value: unknown): value is RuntimeCapabilityCompatibilityTarget {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['kind', 'capability']) &&
    value.kind === 'runtime-capability' &&
    isNonEmptyString(value.capability)
  );
}

function isPackageIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^(?:@[^/@\s]+\/)?[^/@\s]+@\d+\.\d+\.\d+\S*$/u.test(value);
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return isRecord(value) && Object.values(value).every(isNonEmptyString);
}

function isNpmTrackedCompatibilityLockfilePath(value: unknown): value is NpmTrackedCompatibilityLockfilePath {
  return isTrackedCompatibilityLockfilePath(value, 'package-lock.json');
}

function isPnpmTrackedCompatibilityLockfilePath(value: unknown): value is PnpmTrackedCompatibilityLockfilePath {
  return isTrackedCompatibilityLockfilePath(value, 'pnpm-lock.yaml');
}

function isYarnTrackedCompatibilityLockfilePath(value: unknown): value is YarnTrackedCompatibilityLockfilePath {
  return isTrackedCompatibilityLockfilePath(value, 'yarn.lock');
}

function isTrackedCompatibilityLockfilePath(
  value: unknown,
  filename: 'package-lock.json' | 'pnpm-lock.yaml' | 'yarn.lock'
): boolean {
  if (typeof value !== 'string') return false;

  const segments = value.split('/');
  if (segments.length < 4 || segments[0] !== 'compatibility' || segments[1] !== 'fixtures') return false;
  if (segments.at(-1) !== filename) return false;

  return segments.slice(2, -1).every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function hasOnlyTrackedLockfileKeys(value: Readonly<Record<string, unknown>>): boolean {
  return Object.keys(value).every((key) => key === 'format' || key === 'version' || key === 'path');
}

function hasOnlyKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
