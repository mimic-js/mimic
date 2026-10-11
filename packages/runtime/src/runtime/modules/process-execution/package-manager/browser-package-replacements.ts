import type { ArtifactCache } from './artifact-cache';
import { extractNpmTarball, type TarballEntry } from './npm-tarball';
import {
  acquireRegistryTarball,
  publishedVersions,
  registryPublishes,
  UnpublishedVersionError,
  type PackageArtifactFetch
} from './package-artifacts';
import { repairNapiWasiLoader, webAssemblyExportNames } from './napi-wasi-loader';
import { InvalidPackageNameError, isValidPackageName } from './package-name';
import { nearestVersion, sameMajorLine } from './version-range';
import type {
  ProcessFileSystemClient,
  ProcessFileSystemTree,
  ProcessFileSystemTreeNode
} from '../file-system-ports';

/**
 * A source package whose published native code cannot run in the browser,
 * and the official package that can.
 *
 * - `package-contents`: after an install, every installed copy of the source
 *   package holds the files of its replacement instead: of the same version,
 *   or of the published version nearest to it in the same major line when the
 *   replacement skipped that one. A version of a major line the replacement
 *   was never published for is left as the manager installed it, so the
 *   package reports for itself that it cannot run here.
 * - `companion`: the source package itself stays; the named package is
 *   installed where the source package resolves it, because the source
 *   package's own loader falls back to it.
 * - `executable`: the source package locates its binary through
 *   `environmentVariable`; it names a launcher that runs the replacement's
 *   `asset` of the version being executed. An installed source version the
 *   replacement was never published for is swapped, after an install, for the
 *   nearest source version that it was published for.
 *
 * A package built with NAPI-RS needs no entry: its `napi` metadata names the
 * WASI binding its loader falls back to, and that binding is installed as a
 * companion by rule (`napiCompanions`).
 */
export type BrowserPackageReplacement =
  | Readonly<{
      kind: 'package-contents';
      source: string;
      replacement: string;
    }>
  | Readonly<{
      kind: 'companion';
      source: string;
      companion: string;
    }>
  | BrowserPackageExecutableReplacement;

export type BrowserPackageExecutableReplacement = Readonly<{
  kind: 'executable';
  source: string;
  replacement: string;
  asset: string;
  environmentVariable: string;
  launcher: string;
  /** The argument prefix by which the source package names its own version to its binary. */
  versionArgument: string;
}>;

const BROWSER_PACKAGE_REPLACEMENTS: readonly BrowserPackageReplacement[] = Object.freeze([
  {
    kind: 'package-contents',
    source: 'rollup',
    replacement: '@rollup/wasm-node'
  },
  {
    kind: 'package-contents',
    source: 'lightningcss',
    replacement: 'lightningcss-wasm'
  },
  {
    kind: 'package-contents',
    source: '@parcel/watcher',
    replacement: '@parcel/watcher-wasm'
  },
  {
    kind: 'executable',
    source: 'esbuild',
    replacement: '@esbuild/wasi-preview1',
    asset: 'esbuild.wasm',
    environmentVariable: 'ESBUILD_BINARY_PATH',
    launcher: '/.mimic/bin/esbuild',
    versionArgument: '--service='
  }
]);

export const BROWSER_PACKAGE_EXECUTABLE_REPLACEMENTS = BROWSER_PACKAGE_REPLACEMENTS.filter(
  (entry): entry is BrowserPackageExecutableReplacement => entry.kind === 'executable'
);

const REPLACEMENT_ROOT = '/.mimic/replacements';

/**
 * Where a project's companions are materialized: inside its `node_modules`,
 * so an export of the installed tree carries them, under a dot-prefixed name
 * the managers leave alone.
 */
const COMPANION_DIRECTORY = 'node_modules/.mimic/companions';

/**
 * The suffixes NAPI-RS appends to a package's binding name for its WASI
 * builds, in the order the generated loader tries them.
 */
const NAPI_WASI_SUFFIXES = ['-wasm32-wasi', '-wasm32-wasip1'] as const;

type ReplacementServices = Readonly<{
  fileSystem: ProcessFileSystemClient;
  cache: ArtifactCache;
  fetch?: PackageArtifactFetch;
  /**
   * Installs `spec` (`name@version`) with its dependencies under
   * `directory/node_modules`, through the pinned npm. Throws when npm fails.
   */
  installCompanion?(directory: string, spec: string): Promise<void>;
}>;

export type AppliedBrowserPackageReplacements = Readonly<{
  /** What could not be applied, and why, for the caller to report. */
  statements: readonly string[];
  /**
   * Directories that now hold another version of their package. The manager
   * ran the install script of the version it installed; the one of the
   * version there now has yet to run.
   */
  swapped: readonly string[];
}>;

/**
 * Applies the replacements to the packages installed under `projectRoot`. A
 * replacement that fails to download or install throws.
 */
export async function applyBrowserPackageReplacements(
  services: ReplacementServices,
  projectRoot: string
): Promise<AppliedBrowserPackageReplacements> {
  const entries = new Map(BROWSER_PACKAGE_REPLACEMENTS.map((entry) => [entry.source, entry] as const));
  const installed = await findInstalledPackages(services.fileSystem, projectRoot);
  const tarballs = new Map<string, Promise<TarballEntry[]>>();
  const versions = new Map<string, Promise<readonly string[]>>();
  const published = (packageName: string): Promise<readonly string[]> => {
    let known = versions.get(packageName);
    if (!known) versions.set(packageName, (known = publishedVersions(packageName, services.fetch)));
    return known;
  };
  const publishes = memoizedRegistryPublishes(services.fetch);
  const files = (packageName: string, version: string): Promise<TarballEntry[]> => {
    const key = `${packageName}@${version}`;
    let extracted = tarballs.get(key);
    if (!extracted) {
      extracted = acquireRegistryTarball(services.cache, packageName, version, services.fetch).then(extractNpmTarball);
      tarballs.set(key, extracted);
    }
    return extracted;
  };
  const companions = createCompanionLinker(services, projectRoot, publishes);
  const statements: string[] = [];
  const swapped: string[] = [];
  await Promise.all(installed.map(async (found) => {
    if (found.napi) await repairShippedWasiLoaders(services.fileSystem, found.directory, found.napi);
    const entry = entries.get(found.directoryName);
    if (entry?.kind === 'executable') {
      if (found.name !== entry.source) return;
      if (await publishes(entry.replacement, found.version)) return;
      const nearest = nearestVersion(found.version, await published(entry.replacement));
      if (!nearest) return;
      await replacePackageContents(services.fileSystem, found.directory, await files(entry.source, nearest));
      swapped.push(found.directory);
      return;
    }
    if (entry?.kind === 'companion') {
      if (found.name !== entry.source) return;
      statements.push(...(await companions.link(found, [entry.companion])));
      return;
    }
    if (entry?.kind === 'package-contents') {
      // A copy replaced by an earlier install carries the replacement's name.
      const alreadyReplaced = found.name === entry.replacement;
      if (found.name !== entry.source && !alreadyReplaced) return;
      let contents: TarballEntry[];
      try {
        contents = await files(entry.replacement, found.version);
      } catch (error) {
        if (!(error instanceof UnpublishedVersionError)) throw error;
        const nearest = nearestVersion(found.version, sameMajorLine(found.version, await published(entry.replacement)));
        // No replacement exists for this major line: the package stays as installed.
        if (!nearest) return;
        contents = await files(entry.replacement, nearest);
      }
      // A manager prunes the dependencies a replacement bundles, because its
      // lockfile does not name them; they are put back with the contents.
      if (alreadyReplaced && !(await lacksBundledDependency(services.fileSystem, found.directory, contents))) return;
      await replacePackageContents(services.fileSystem, found.directory, contents);
      return;
    }
    let candidates: readonly string[];
    try {
      candidates = napiCompanions(found);
    } catch (error) {
      // Metadata that names no package name derives no companion; the package is left as installed.
      if (!(error instanceof InvalidPackageNameError)) throw error;
      statements.push(`${found.name}@${found.version}: ${error.message}`);
      return;
    }
    if (candidates.length === 0) return;
    // A binding the package ships itself is what its loader tries first.
    if (await services.fileSystem.exists(`${found.directory}/${found.napi?.binaryName ?? 'index'}.wasi.cjs`)) return;
    statements.push(...(await companions.link(found, candidates)));
  }));
  return {
    statements: [
      ...statements.sort(),
      ...(await pnpStatements(
        services.fileSystem,
        projectRoot,
        [...entries.values()].filter((entry) => entry.kind === 'package-contents'),
        published
      ))
    ],
    swapped: swapped.sort()
  };
}

/**
 * How deep under a package its own WASI loader may sit: nx keeps it in
 * `dist/src/native`.
 */
const SHIPPED_LOADER_DEPTH = 4;

/**
 * Rewrites the WASI loaders a NAPI-RS package ships whose register calls do
 * not match the module beside them (`napi-wasi-loader.ts`). The loader loads
 * the debug build of the module when the package ships one, so that is the
 * one it is checked against.
 */
async function repairShippedWasiLoaders(
  fileSystem: ProcessFileSystemClient,
  directory: string,
  napi: NapiMetadata
): Promise<void> {
  const binaryName = napi.binaryName ?? 'index';
  const loaders: string[] = [];
  const visit = async (current: string, depth: number): Promise<void> => {
    const names = await entryNames(fileSystem, current);
    if (names.includes(`${binaryName}.wasi.cjs`)) loaders.push(current);
    if (depth === SHIPPED_LOADER_DEPTH) return;
    await Promise.all(names.map(async (name) => {
      // Files are recognised by their extension without asking for their status.
      if (name === 'node_modules' || name.startsWith('.') || name.includes('.')) return;
      const path = `${current}/${name}`;
      try {
        if (!(await fileSystem.stat(path)).isDirectory()) return;
      } catch {
        return;
      }
      await visit(path, depth + 1);
    }));
  };
  await visit(directory, 0);
  await Promise.all(loaders.map(async (loaderDirectory) => {
    const debugModule = `${loaderDirectory}/${binaryName}.wasm32-wasi.debug.wasm`;
    const module = (await fileSystem.exists(debugModule))
      ? debugModule
      : `${loaderDirectory}/${binaryName}.wasm32-wasi.wasm`;
    if (!(await fileSystem.exists(module))) return;
    const loader = `${loaderDirectory}/${binaryName}.wasi.cjs`;
    let exported: readonly string[];
    try {
      exported = webAssemblyExportNames(await fileSystem.readFile(module));
    } catch {
      // A module that cannot be read leaves its loader to report the failure.
      return;
    }
    const repaired = repairNapiWasiLoader(await fileSystem.readFile(loader, 'utf8'), exported);
    if (repaired !== undefined) await fileSystem.writeFile(loader, repaired);
  }));
}

/**
 * The WASI bindings a NAPI-RS package's generated loader falls back to, in
 * the order it tries them: `<napi.packageName or name>-wasm32-wasi`, then the
 * single-threaded `-wasm32-wasip1`. Empty when the package publishes no WASI
 * target, as its loader then has nothing to fall back to. The names come from
 * the installed package's own metadata and reach registry URLs, `npm install`
 * specs and Virtual File System paths, so a derived name that is not an npm
 * package name throws `InvalidPackageNameError`.
 */
export function napiCompanions(found: Readonly<{ name: string; napi?: NapiMetadata }>): readonly string[] {
  const napi = found.napi;
  if (!napi?.targets.some((target) => target.startsWith('wasm32-wasi'))) return [];
  const base = napi.packageName ?? found.name;
  const source = napi.packageName === undefined ? 'The package.json "name" field' : 'The napi.packageName metadata';
  const companions = NAPI_WASI_SUFFIXES.map((suffix) => `${base}${suffix}`);
  for (const companion of companions) {
    if (!isValidPackageName(companion)) throw new InvalidPackageNameError(base, source);
  }
  return companions;
}

/** Asks the registry once per `name@version` for whether it publishes it. */
function memoizedRegistryPublishes(
  fetchArtifact: PackageArtifactFetch | undefined
): (packageName: string, version: string) => Promise<boolean> {
  const answers = new Map<string, Promise<boolean>>();
  return (packageName, version) => {
    const key = `${packageName}@${version}`;
    let answer = answers.get(key);
    if (!answer) {
      answer = registryPublishes(packageName, version, fetchArtifact);
      answers.set(key, answer);
      void answer.catch(() => answers.delete(key));
    }
    return answer;
  };
}

/**
 * Makes companions resolvable from the packages that fall back to them. Each
 * `name@version` is installed once per project, with its dependencies, under
 * `node_modules/.mimic/companions`, and linked into the package's
 * own `node_modules`, where Node's resolution finds it first.
 */
function createCompanionLinker(
  services: ReplacementServices,
  projectRoot: string,
  publishes: (packageName: string, version: string) => Promise<boolean>
) {
  const materialized = new Map<string, Promise<string>>();
  // Companion installs run one at a time: each is one npm process.
  let installs: Promise<unknown> = Promise.resolve();
  const packageDirectoryOf = (companion: string, version: string): string =>
    `${projectRoot}/${COMPANION_DIRECTORY}/${companion}/${version}/node_modules/${companion}`;
  const isMaterialized = (companion: string, version: string): Promise<boolean> =>
    services.fileSystem.exists(`${packageDirectoryOf(companion, version)}/package.json`);
  const materialize = (companion: string, version: string): Promise<string> => {
    const key = `${companion}@${version}`;
    let path = materialized.get(key);
    if (!path) {
      const root = `${projectRoot}/${COMPANION_DIRECTORY}/${companion}/${version}`;
      const packageDirectory = packageDirectoryOf(companion, version);
      path = (async () => {
        if (await isMaterialized(companion, version)) return packageDirectory;
        if (!services.installCompanion) {
          throw new Error(`${key} cannot be installed: no package installer is available to the Command Proxy.`);
        }
        const install = installs.then(() => services.installCompanion!(root, key));
        installs = install.catch(() => undefined);
        await install;
        return packageDirectory;
      })();
      materialized.set(key, path);
      void path.catch(() => materialized.delete(key));
    }
    return path;
  };
  return {
    /**
     * Links the first published candidate into `found`'s `node_modules`, when
     * none is resolvable from it yet. Returns the statement to report when no
     * candidate is published at the package's version.
     */
    async link(found: InstalledPackage, candidates: readonly string[]): Promise<readonly string[]> {
      for (const candidate of candidates) {
        if (await resolvableFrom(services.fileSystem, found.directory, candidate)) return [];
      }
      // A companion materialized by an earlier install is linked again without asking the registry.
      let chosen: string | undefined;
      for (const candidate of candidates) {
        if (await isMaterialized(candidate, found.version)) {
          chosen = candidate;
          break;
        }
      }
      for (const candidate of chosen ? [] : candidates) {
        if (await publishes(candidate, found.version)) {
          chosen = candidate;
          break;
        }
      }
      if (!chosen) {
        return [
          `${found.name}@${found.version} falls back to the WebAssembly binding ${candidates[0]}, ` +
            'which the npm registry does not publish at that version; the package reports the missing binding itself when executed.'
        ];
      }
      const target = await materialize(chosen, found.version);
      const link = `${found.directory}/node_modules/${chosen}`;
      const parent = link.slice(0, link.lastIndexOf('/'));
      await services.fileSystem.mkdir(parent, { recursive: true });
      await services.fileSystem.rm(link, { recursive: true, force: true });
      await services.fileSystem.mount(
        { [link.slice(parent.length + 1)]: { symlink: { target: relativePath(parent, target) } } },
        parent
      );
      return [];
    }
  };
}

/** Whether Node's resolution from `directory` reaches an installed `packageName`. */
async function resolvableFrom(
  fileSystem: ProcessFileSystemClient,
  directory: string,
  packageName: string
): Promise<boolean> {
  for (let current = directory; ; current = current.slice(0, current.lastIndexOf('/')) || '/') {
    if (!current.endsWith('/node_modules')) {
      const manifest = `${current === '/' ? '' : current}/node_modules/${packageName}/package.json`;
      if (await fileSystem.exists(manifest)) return true;
    }
    if (current === '/') return false;
  }
}

/** Runs the replacement executable of the source-package version that invoked the launcher. */
export async function resolveReplacementExecutable(
  services: ReplacementServices,
  entry: BrowserPackageExecutableReplacement,
  args: readonly string[],
  cwd: string,
  materialized: Map<string, Promise<string>>
): Promise<
  | Readonly<{ kind: 'run'; path: string }>
  | Readonly<{ kind: 'version'; version: string }>
  | Readonly<{ kind: 'unsupported'; message: string }>
> {
  const requested = args
    .find((argument) => argument.startsWith(entry.versionArgument))
    ?.slice(entry.versionArgument.length);
  const version = requested || await installedVersionFrom(services.fileSystem, cwd, entry.source);
  if (!version) {
    return {
      kind: 'unsupported',
      message:
        `${entry.launcher} runs ${entry.replacement} for the ${entry.source} package that calls it, ` +
        `but no ${entry.versionArgument}<version> argument was given and no ${entry.source} package ` +
        `is installed at or above ${cwd}.`
    };
  }
  let path = materialized.get(version);
  if (!path) {
    path = materializeExecutable(services, entry, version);
    materialized.set(version, path);
    void path.catch(() => materialized.delete(version));
  }
  try {
    return { kind: 'run', path: await path };
  } catch (error) {
    if (!(error instanceof UnpublishedVersionError)) throw error;
    // The install script of a version about to be swapped compares this answer with its own.
    if (args.length === 1 && args[0] === '--version') return { kind: 'version', version };
    return {
      kind: 'unsupported',
      message:
        `${entry.source}@${version} cannot run in Mimic: ${entry.replacement} is not published ` +
        `for it. An install through npm, pnpm or Yarn's node-modules linker swaps it for the nearest ` +
        `${entry.source} version that has one.`
    };
  }
}

async function materializeExecutable(
  services: ReplacementServices,
  entry: BrowserPackageExecutableReplacement,
  version: string
): Promise<string> {
  const path = `${REPLACEMENT_ROOT}/${entry.replacement}/${version}/${entry.asset}`;
  if (await services.fileSystem.exists(path)) return path;
  const files = await extractNpmTarball(
    await acquireRegistryTarball(services.cache, entry.replacement, version, services.fetch)
  );
  const asset = files.find((file) => file.path === entry.asset);
  if (!asset) {
    throw new Error(`${entry.replacement}@${version} does not contain ${entry.asset}.`);
  }
  await services.fileSystem.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  await services.fileSystem.writeFile(path, asset.data);
  return path;
}

/** What a NAPI-RS package's `package.json` says about its bindings. */
export type NapiMetadata = Readonly<{
  /** The scope and name its binding packages are published under; the package's own name when absent. */
  packageName?: string;
  /** The file name of its bindings; `index` when absent. */
  binaryName?: string;
  /** The Rust targets it publishes bindings for. */
  targets: readonly string[];
}>;

type InstalledPackage = Readonly<{
  directory: string;
  directoryName: string;
  name: string;
  version: string;
  napi?: NapiMetadata;
}>;

/**
 * Finds every installed package, following the node_modules layouts of npm,
 * pnpm (`node_modules/.pnpm`) and Yarn's node-modules linker, including
 * symlinked workspace packages.
 */
async function findInstalledPackages(
  fileSystem: ProcessFileSystemClient,
  projectRoot: string
): Promise<readonly InstalledPackage[]> {
  const found: InstalledPackage[] = [];
  const visited = new Set<string>();
  const visitPackage = async (directory: string, directoryName: string): Promise<void> => {
    let real: string;
    try {
      real = await fileSystem.realpath(directory);
    } catch {
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);
    const manifest = await readManifest(fileSystem, `${real}/package.json`);
    if (manifest) found.push({ directory: real, directoryName, ...manifest });
    await visitNodeModules(`${real}/node_modules`);
  };
  const visitNodeModules = async (directory: string): Promise<void> => {
    await Promise.all((await entryNames(fileSystem, directory)).map(async (entry) => {
      if (entry === '.pnpm') {
        await Promise.all((await entryNames(fileSystem, `${directory}/.pnpm`)).map((store) =>
          store.startsWith('.') || store === 'node_modules'
            ? undefined
            : visitNodeModules(`${directory}/.pnpm/${store}/node_modules`)
        ));
      } else if (entry.startsWith('@')) {
        await Promise.all((await entryNames(fileSystem, `${directory}/${entry}`)).map((scoped) =>
          visitPackage(`${directory}/${entry}/${scoped}`, `${entry}/${scoped}`)
        ));
      } else if (!entry.startsWith('.')) {
        await visitPackage(`${directory}/${entry}`, entry);
      }
    }));
  };
  visited.add(projectRoot);
  await visitNodeModules(`${projectRoot}/node_modules`);
  return found;
}

async function lacksBundledDependency(
  fileSystem: ProcessFileSystemClient,
  directory: string,
  files: readonly TarballEntry[]
): Promise<boolean> {
  const manifests = files.filter((file) => /^node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/u.test(file.path));
  const present = await Promise.all(manifests.map((file) => fileSystem.exists(`${directory}/${file.path}`)));
  return present.includes(false);
}

async function replacePackageContents(
  fileSystem: ProcessFileSystemClient,
  directory: string,
  files: readonly TarballEntry[]
): Promise<void> {
  // Removing each name first leaves any file the manager hard-linked from its
  // store untouched. Dependencies installed inside the package stay.
  for (const entry of await entryNames(fileSystem, directory)) {
    if (entry !== 'node_modules') {
      await fileSystem.rm(`${directory}/${entry}`, { recursive: true, force: true });
    }
  }
  await fileSystem.mount(packageTree(files), directory);
}

/**
 * Yarn Plug'n'Play keeps packages inside archives, where their contents are
 * not replaced: each source package it installed whose major line has a
 * replacement is named.
 */
async function pnpStatements(
  fileSystem: ProcessFileSystemClient,
  projectRoot: string,
  entries: readonly Extract<BrowserPackageReplacement, { kind: 'package-contents' }>[],
  published: (packageName: string) => Promise<readonly string[]>
): Promise<readonly string[]> {
  let manifest: string;
  try {
    manifest = await fileSystem.readFile(`${projectRoot}/.pnp.cjs`, 'utf8');
  } catch {
    return [];
  }
  const statements = await Promise.all(entries.map(async (entry) => {
    const pattern = new RegExp(
      `\\["${entry.source.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&')}", \\[[\\s\\\\]*\\["npm:([^"]+)"`,
      'u'
    );
    const version = pattern.exec(manifest)?.[1];
    return version && sameMajorLine(version, await published(entry.replacement)).length > 0
      ? [
          `${entry.source}@${version} needs its Browser Package Replacement ${entry.replacement}, ` +
            "which is not applied to packages Yarn Plug'n'Play keeps in archives; " +
            'set "nodeLinker: node-modules" in .yarnrc.yml to install it.'
        ]
      : [];
  }));
  return statements.flat();
}

async function installedVersionFrom(
  fileSystem: ProcessFileSystemClient,
  cwd: string,
  name: string
): Promise<string | undefined> {
  const own = await readManifest(fileSystem, `${cwd}/package.json`);
  if (own?.name === name) return own.version;
  for (let directory = cwd; ; directory = directory.slice(0, directory.lastIndexOf('/')) || '/') {
    if (!directory.endsWith('/node_modules')) {
      const manifest = await readManifest(
        fileSystem,
        `${directory === '/' ? '' : directory}/node_modules/${name}/package.json`
      );
      if (manifest?.name === name) return manifest.version;
    }
    if (directory === '/') return undefined;
  }
}

async function readManifest(
  fileSystem: ProcessFileSystemClient,
  path: string
): Promise<{ name: string; version: string; napi?: NapiMetadata } | undefined> {
  try {
    const manifest = JSON.parse(await fileSystem.readFile(path, 'utf8')) as Record<string, unknown>;
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') return undefined;
    const napi = napiMetadata(manifest.napi);
    return napi ? { name: manifest.name, version: manifest.version, napi } : { name: manifest.name, version: manifest.version };
  } catch {
    return undefined;
  }
}

function napiMetadata(value: unknown): NapiMetadata | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const napi = value as Record<string, unknown>;
  const targets = Array.isArray(napi.targets) ? napi.targets.filter((target): target is string => typeof target === 'string') : [];
  return {
    ...(typeof napi.packageName === 'string' ? { packageName: napi.packageName } : {}),
    ...(typeof napi.binaryName === 'string' ? { binaryName: napi.binaryName } : {}),
    targets
  };
}

async function entryNames(
  fileSystem: ProcessFileSystemClient,
  directory: string
): Promise<readonly string[]> {
  try {
    return (await fileSystem.readdir(directory)).map((entry) =>
      typeof entry === 'string' ? entry : entry.name
    );
  } catch {
    return [];
  }
}

/** The path of `to` relative to the directory `from`, both absolute. */
function relativePath(from: string, to: string): string {
  const fromParts = from.split('/').filter(Boolean);
  const toParts = to.split('/').filter(Boolean);
  let shared = 0;
  while (shared < fromParts.length && shared < toParts.length && fromParts[shared] === toParts[shared]) shared += 1;
  return [...fromParts.slice(shared).map(() => '..'), ...toParts.slice(shared)].join('/') || '.';
}

export function packageTree(files: readonly TarballEntry[]): ProcessFileSystemTree {
  const root: ProcessFileSystemTree = {};
  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean);
    if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) {
      throw new Error(`Package tarball contains an invalid path: ${file.path}`);
    }
    let directory = root;
    for (const part of parts.slice(0, -1)) {
      const existing: ProcessFileSystemTreeNode = directory[part] ?? { directory: {} };
      if (!('directory' in existing)) {
        throw new Error(`Package tarball path conflicts with a file: ${file.path}`);
      }
      directory[part] = existing;
      directory = existing.directory;
    }
    directory[parts.at(-1)!] = { file: { contents: file.data } };
  }
  return root;
}
