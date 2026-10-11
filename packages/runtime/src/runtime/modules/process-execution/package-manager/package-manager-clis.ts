export type PackageManagerName = 'npm' | 'pnpm' | 'yarn';

/**
 * One exact, integrity-pinned upstream package-manager CLI. `bin` is copied
 * from the published package's own `bin` map: every command it owns runs the
 * script the package itself names for it.
 */
export type PackageManagerCli = Readonly<{
  id: string;
  manager: PackageManagerName;
  version: string;
  packageName: string;
  tarballUrl: string;
  integrity: string;
  bin: Readonly<Record<string, string>>;
  /** Defaults the CLI runs with; the caller's environment overrides each. */
  environment: Readonly<Record<string, string>>;
  /** The file the manager rewrites whenever it changes installed dependencies. */
  installState: string;
}>;

export const PACKAGE_MANAGER_CLIS: readonly PackageManagerCli[] = Object.freeze([
  Object.freeze({
    id: 'toolchain:npm@11.18.0',
    manager: 'npm',
    version: '11.18.0',
    packageName: 'npm',
    tarballUrl: 'https://registry.npmjs.org/npm/-/npm-11.18.0.tgz',
    integrity: 'sha512-T67M4L5wNm0cZ7EBLErcEkY1SmzEW/WJ+SADBzsFUY1UdAPfFHXFQtZ6SEXiK0+vzXysCvAsepbMaBTwnrAD+w==',
    bin: Object.freeze({ npm: 'bin/npm-cli.js', npx: 'bin/npx-cli.js' }),
    environment: Object.freeze({
      npm_config_update_notifier: 'false',
      npm_config_audit: 'false',
      npm_config_fund: 'false'
    }),
    installState: 'node_modules/.package-lock.json'
  }),
  Object.freeze({
    id: 'toolchain:pnpm@11.11.0',
    manager: 'pnpm',
    version: '11.11.0',
    packageName: 'pnpm',
    tarballUrl: 'https://registry.npmjs.org/pnpm/-/pnpm-11.11.0.tgz',
    integrity: 'sha512-RGP2X9gO2A1pvB1L8WPulPYFxzgPwxi7Wy6+FfjNEtScUaTVnpUbQB52TTtsp1HL9RvFDtcAGmvLSTXmhMNIgg==',
    bin: Object.freeze({
      pnpm: 'bin/pnpm.mjs',
      pnpx: 'bin/pnpx.mjs',
      pn: 'bin/pnpm.mjs',
      pnx: 'bin/pnpx.mjs'
    }),
    environment: Object.freeze({}),
    installState: 'node_modules/.modules.yaml'
  }),
  Object.freeze({
    id: 'toolchain:yarn@4.17.1',
    manager: 'yarn',
    version: '4.17.1',
    packageName: '@yarnpkg/cli-dist',
    tarballUrl: 'https://registry.npmjs.org/@yarnpkg/cli-dist/-/cli-dist-4.17.1.tgz',
    integrity: 'sha512-2tiSQuJNl/L3QwTdrq6lKWDpkcnp9MGvCT/rIldHcbu3SWfnLdmehvt3eulX1hT7FFt1Gjfq3CesF+kvhFip6g==',
    bin: Object.freeze({ yarn: 'bin/yarn.js', yarnpkg: 'bin/yarn.js' }),
    environment: Object.freeze({}),
    installState: '.yarn/install-state.gz'
  })
]);

/** A Corepack hash: the hex digest of the release the project pinned. */
export type PackageManagerReleaseHash = Readonly<{
  algorithm: 'sha1' | 'sha256' | 'sha384' | 'sha512';
  hex: string;
}>;

/** The release of a manager a project's `packageManager` field asks for. */
export type RequestedPackageManagerRelease = Readonly<{
  manager: PackageManagerName;
  version: string;
  hash?: PackageManagerReleaseHash;
}>;

/** A `packageManager` field this runtime cannot honour, with the reason. */
export class InvalidPackageManagerRequestError extends Error {
  constructor(requested: string, reason: string) {
    super(`package.json asks for ${requested}, ${reason}`);
    this.name = 'InvalidPackageManagerRequestError';
  }
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const HASH_ALGORITHMS: ReadonlySet<string> = new Set(['sha1', 'sha256', 'sha384', 'sha512']);

/**
 * The release of this manager a project's `packageManager` field asks for,
 * as Corepack reads it, when it is another than the pinned one. A field that
 * names another manager, or none, leaves the pinned release in charge:
 * that is the other manager's to judge.
 */
export function requestedPackageManagerRelease(
  cli: PackageManagerCli,
  manifestSource: string | undefined
): RequestedPackageManagerRelease | undefined {
  if (manifestSource === undefined) return undefined;
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestSource);
  } catch {
    return undefined;
  }
  const requested =
    typeof manifest === 'object' && manifest !== null && !Array.isArray(manifest)
      ? (manifest as Record<string, unknown>).packageManager
      : undefined;
  if (typeof requested !== 'string') return undefined;
  const match = /^(npm|pnpm|yarn)@([^+]+)(?:\+(.+))?$/u.exec(requested.trim());
  if (!match || match[1] !== cli.manager) return undefined;
  const version = match[2]!;
  if (!EXACT_VERSION.test(version)) {
    throw new InvalidPackageManagerRequestError(requested.trim(), 'which names no exact version.');
  }
  if (version === cli.version) return undefined;
  if (match[3] === undefined) return { manager: cli.manager, version };
  const hash = /^(sha\d+)\.([0-9a-f]+)$/u.exec(match[3]);
  if (!hash || !HASH_ALGORITHMS.has(hash[1]!)) {
    throw new InvalidPackageManagerRequestError(requested.trim(), `whose hash ${match[3]} this runtime cannot check.`);
  }
  return {
    manager: cli.manager,
    version,
    hash: { algorithm: hash[1] as PackageManagerReleaseHash['algorithm'], hex: hash[2]! }
  };
}

/**
 * The npm package a release of a manager is published as: Yarn 1 is `yarn`,
 * every later Yarn the standalone `@yarnpkg/cli-dist`.
 */
export function packageManagerPackageName(manager: PackageManagerName, version: string): string {
  if (manager !== 'yarn') return manager;
  return Number(version.split('.')[0]) < 2 ? 'yarn' : '@yarnpkg/cli-dist';
}

/** The file a release rewrites whenever it changes installed dependencies. */
export function packageManagerInstallState(manager: PackageManagerName, version: string): string {
  const pinned = PACKAGE_MANAGER_CLIS.find((cli) => cli.manager === manager)!;
  if (manager === 'yarn' && packageManagerPackageName(manager, version) === 'yarn') {
    return 'node_modules/.yarn-integrity';
  }
  return pinned.installState;
}
