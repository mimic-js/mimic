import { dirname, joinPath, normalizePath } from '../virtual-file-system';
import {
  ModuleResolutionCache,
  type ModuleResolutionCommitJournal
} from './module-resolution-cache';
import {
  ModuleResolutionError,
  type ModuleResolutionFileSystem
} from './module-resolution-types';
import { PnpPackageResolver } from './pnp-resolution';

export type ResolutionMode = 'import' | 'require';

type PackageManifest = {
  name?: string;
  type?: string;
  main?: string;
  exports?: unknown;
  imports?: Record<string, unknown>;
};

const blockedPackageTarget = Symbol('blocked-package-target');
type PackageTarget = string | typeof blockedPackageTarget | readonly PackageTarget[] | undefined;

export interface ModuleResolverOptions {
  readonly cwd: string;
  readonly pnp?: boolean;
  readonly conditions?: readonly string[];
  readonly extensions?: readonly string[];
  /** Directories `require()` falls back to after `node_modules`, as `NODE_PATH` does. */
  readonly globalPaths?: readonly string[];
  /**
   * The committed-revision view of the file system. With it, manifests,
   * package scopes and resolved specifiers are remembered and invalidated from
   * the VFS Commit Journal; without it nothing is remembered.
   */
  readonly commitJournal?: ModuleResolutionCommitJournal;
}

export interface PackageScope {
  readonly root: string;
  readonly manifestPath: string;
  readonly manifest: { readonly name?: string; readonly type?: string };
}

export interface ModuleResolver {
  resolve(specifier: string, fromDirectory: string, mode?: ResolutionMode): string;
  /** The nearest enclosing package scope, as Node finds it for a module's format. */
  packageScope(directory: string): PackageScope | undefined;
}

export function createModuleResolver(
  fs: ModuleResolutionFileSystem,
  options: ModuleResolverOptions
): ModuleResolver {
  return new OwnedModuleResolver(fs, options);
}

class OwnedModuleResolver implements ModuleResolver {
  private readonly pnpResolver: PnpPackageResolver | undefined;
  private readonly cache: ModuleResolutionCache | undefined;
  private readonly fs: ModuleResolutionFileSystem;

  constructor(
    fs: ModuleResolutionFileSystem,
    private readonly options: ModuleResolverOptions
  ) {
    const cache = options.commitJournal ? new ModuleResolutionCache(options.commitJournal) : undefined;
    this.cache = cache;
    // Every file-system fact a cached answer was derived from is one of its dependencies.
    this.fs = cache
      ? {
          readText: (path) => (cache.depend(path), fs.readText(path)),
          isFile: (path) => (cache.depend(path), fs.isFile(path)),
          isDirectory: (path) => (cache.depend(path), fs.isDirectory(path)),
          realpathSync: (path) => {
            cache.depend(path);
            const real = fs.realpathSync(path);
            cache.depend(real);
            return real;
          }
        }
      : fs;
    this.pnpResolver = options.pnp ? PnpPackageResolver.find(fs, options.cwd) : undefined;
    if (options.pnp && !this.pnpResolver) {
      throw moduleNotFound(`Cannot activate PnP without ${joinPath(options.cwd, '.pnp.data.json')}`);
    }
  }

  resolve(specifier: string, fromDirectory: string, mode: ResolutionMode = 'import'): string {
    if (!this.cache) return this.resolveUncached(specifier, fromDirectory, mode);
    return this.cache.remember(
      `resolve\0${mode}\0${normalizePath(fromDirectory, this.options.cwd)}\0${specifier}`,
      () => this.resolveUncached(specifier, fromDirectory, mode)
    );
  }

  packageScope(directory: string): PackageScope | undefined {
    const start = normalizePath(directory, this.options.cwd);
    if (!this.cache) return this.findPackageScope(start);
    // Null stands for "no enclosing package", which is as cacheable as a scope.
    return this.cache.remember(`scope\0${start}`, () => this.findPackageScope(start) ?? null) ?? undefined;
  }

  private findPackageScope(start: string): InternalPackageScope | undefined {
    let current = start;
    while (true) {
      const manifestPath = joinPath(current, 'package.json');
      if (this.fs.isFile(manifestPath)) {
        return { root: current, manifestPath, manifest: this.readManifest(manifestPath) };
      }
      if (current === '/') return undefined;
      current = dirname(current);
    }
  }

  private readManifest(manifestPath: string): PackageManifest {
    const parse = (): PackageManifest => JSON.parse(this.fs.readText(manifestPath)) as PackageManifest;
    return this.cache ? this.cache.remember(`manifest\0${manifestPath}`, parse) : parse();
  }

  private resolveUncached(specifier: string, fromDirectory: string, mode: ResolutionMode): string {
    // A file URL in any of the forms the URL parser accepts, as Node parses one:
    // `file:/path`, `file:///path` and `file://localhost/path` name the same file.
    if (specifier.startsWith('file:')) {
      return this.resolveFileOrDirectory(normalizePath(new URL(specifier), fromDirectory));
    }
    if (specifier.startsWith('/') || isRelativeSpecifier(specifier)) {
      return this.resolveFileOrDirectory(normalizePath(specifier, fromDirectory));
    }
    if (specifier.startsWith('#')) return this.resolvePackageImport(specifier, fromDirectory, mode);
    return this.resolvePackage(specifier, fromDirectory, mode);
  }

  private resolvePackageImport(specifier: string, fromDirectory: string, mode: ResolutionMode): string {
    const scope = this.packageScope(fromDirectory) as InternalPackageScope | undefined;
    if (!scope) {
      throw new ModuleResolutionError(
        'package-import-not-defined',
        `Cannot resolve package import '${specifier}' from ${fromDirectory}`
      );
    }
    const target = resolvePackageMapTarget(scope.manifest.imports, specifier, mode, this.options.conditions);
    const resolved = this.resolvePackageTargetValue(target, scope.root, mode, true);
    if (typeof resolved === 'string') return resolved;
    throw new ModuleResolutionError(
      'package-import-not-defined',
      `Package import '${specifier}' is not defined in ${scope.manifestPath}`
    );
  }

  private resolvePackage(specifier: string, fromDirectory: string, mode: ResolutionMode): string {
    const { packageName, subpath } = splitPackageSpecifier(specifier);
    const scope = this.packageScope(fromDirectory) as InternalPackageScope | undefined;
    if (scope?.manifest.name === packageName && scope.manifest.exports !== undefined) {
      return subpath ? this.resolvePackageSubpath(scope.root, subpath, mode) : this.resolvePackageEntry(scope.root, mode);
    }
    const pnpPackageRoot = this.pnpResolver?.resolvePackageLocation(packageName, fromDirectory);
    if (pnpPackageRoot) {
      return subpath ? this.resolvePackageSubpath(pnpPackageRoot, subpath, mode) : this.resolvePackageEntry(pnpPackageRoot, mode);
    }
    if (this.pnpResolver) throw moduleNotFound(`Cannot find module '${specifier}' from ${fromDirectory}`);
    let current = normalizePath(fromDirectory, this.options.cwd);

    while (true) {
      const packageRoot = joinPath(current, 'node_modules', packageName);
      if (this.fs.isDirectory(packageRoot)) {
        return subpath ? this.resolvePackageSubpath(packageRoot, subpath, mode) : this.resolvePackageEntry(packageRoot, mode);
      }
      if (current === '/') break;
      current = dirname(current);
    }

    if (mode === 'require') {
      for (const globalPath of this.options.globalPaths ?? []) {
        const resolved = this.resolveExisting(joinPath(globalPath, specifier));
        if (resolved) return resolved;
      }
    }

    throw moduleNotFound(`Cannot find module '${specifier}' from ${fromDirectory}`);
  }

  private resolvePackageSubpath(packageRoot: string, subpath: string, mode: ResolutionMode): string {
    const manifestPath = joinPath(packageRoot, 'package.json');
    if (this.fs.isFile(manifestPath)) {
      const manifest = this.readManifest(manifestPath);
      if (manifest.exports !== undefined) {
        const target = resolvePackageMapTarget(manifest.exports, `./${subpath}`, mode, this.options.conditions);
        const resolved = this.resolvePackageTargetValue(target, packageRoot, mode, false);
        if (typeof resolved === 'string') return resolved;
        throw new ModuleResolutionError(
          'package-path-not-exported',
          `Package subpath './${subpath}' is not defined by "exports" in ${manifestPath}`
        );
      }
    }
    return this.resolveFileOrDirectory(joinPath(packageRoot, subpath));
  }

  private resolvePackageEntry(packageRoot: string, mode: ResolutionMode): string {
    const manifestPath = joinPath(packageRoot, 'package.json');
    if (this.fs.isFile(manifestPath)) {
      const manifest = this.readManifest(manifestPath);
      if (manifest.exports !== undefined) {
        const target = resolvePackageMapTarget(manifest.exports, '.', mode, this.options.conditions);
        const resolved = this.resolvePackageTargetValue(target, packageRoot, mode, false);
        if (typeof resolved === 'string') return resolved;
        throw new ModuleResolutionError(
          'package-path-not-exported',
          `Package subpath '.' is not defined by "exports" in ${manifestPath}`
        );
      }
      // Node resolution reads `main` only; the `browser` field belongs to bundlers.
      if (manifest.main) return this.resolveFileOrDirectory(joinPath(packageRoot, manifest.main));
    }
    return this.resolveFileOrDirectory(joinPath(packageRoot, 'index'));
  }

  private resolveFileOrDirectory(path: string): string {
    const resolved = this.resolveExisting(path);
    if (resolved) return resolved;
    throw moduleNotFound(`Cannot resolve module path: ${normalizePath(path, this.options.cwd)}`);
  }

  private resolveExisting(path: string): string | undefined {
    const extensions = this.options.extensions ?? ['.js', '.cjs', '.mjs', '.json'];
    const normalized = normalizePath(path, this.options.cwd);
    if (this.fs.isFile(normalized)) return this.fs.realpathSync(normalized);
    for (const extension of extensions) {
      const candidate = `${normalized}${extension}`;
      if (this.fs.isFile(candidate)) return this.fs.realpathSync(candidate);
    }
    if (this.fs.isDirectory(normalized)) {
      const manifestPath = joinPath(normalized, 'package.json');
      if (this.fs.isFile(manifestPath)) {
        const entry = this.readManifest(manifestPath).main;
        if (entry) return this.resolveExisting(joinPath(normalized, entry));
      }
      return this.resolveExisting(joinPath(normalized, 'index'));
    }
    return undefined;
  }

  private resolvePackageTargetValue(
    target: PackageTarget,
    packageRoot: string,
    mode: ResolutionMode,
    allowExternal: boolean
  ): string | typeof blockedPackageTarget | undefined {
    if (target === blockedPackageTarget) return blockedPackageTarget;
    if (Array.isArray(target)) {
      let lastFailure: ModuleResolutionError | undefined;
      for (const candidate of target) {
        try {
          const resolved = this.resolvePackageTargetValue(candidate, packageRoot, mode, allowExternal);
          if (resolved === blockedPackageTarget) return blockedPackageTarget;
          if (resolved) return resolved;
        } catch (error) {
          if (!(error instanceof ModuleResolutionError)) throw error;
          if (error.kind !== 'invalid-package-target') throw error;
          lastFailure = error;
        }
      }
      if (lastFailure) throw lastFailure;
      return undefined;
    }
    if (typeof target !== 'string') return undefined;
    if (target.startsWith('./')) {
      validatePackageTarget(target, packageRoot);
      return this.resolveFileOrDirectory(joinPath(packageRoot, target));
    }
    if (!allowExternal || target.startsWith('../') || target.startsWith('/') || target.includes('\\')) {
      throw invalidPackageTarget(target, packageRoot);
    }
    return this.resolve(target, packageRoot, mode);
  }
}

export function resolveVfsModuleSpecifier(
  specifier: string,
  importer: string,
  fs: ModuleResolutionFileSystem,
  cwd: string,
  conditions: readonly string[] = []
): string | undefined {
  try {
    return createModuleResolver(fs, {
      cwd,
      conditions,
      extensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json']
    }).resolve(specifier, importer ? dirname(importer) : cwd);
  } catch (error) {
    if (error instanceof ModuleResolutionError) return undefined;
    throw error;
  }
}

type InternalPackageScope = { root: string; manifestPath: string; manifest: PackageManifest };

function splitPackageSpecifier(specifier: string): { packageName: string; subpath: string } {
  if (specifier.startsWith('@')) {
    const [scope, name, ...rest] = specifier.split('/');
    return { packageName: `${scope}/${name}`, subpath: rest.join('/') };
  }
  const [packageName, ...rest] = specifier.split('/');
  return { packageName, subpath: rest.join('/') };
}

function resolvePackageMapTarget(
  targets: unknown,
  request: string,
  mode: ResolutionMode,
  configuredConditions: readonly string[] = []
): PackageTarget {
  if (typeof targets === 'string' || Array.isArray(targets) || targets === null) {
    return request === '.' ? resolveConditionalTarget(targets, mode, configuredConditions) : undefined;
  }
  if (!targets || typeof targets !== 'object') return undefined;
  const record = targets as Record<string, unknown>;
  if (Object.keys(record).some((key) => key.startsWith('.') || key.startsWith('#'))) {
    const exact = record[request];
    if (exact !== undefined) return resolveConditionalTarget(exact, mode, configuredConditions);
    const pattern = findBestPatternMatch(record, request);
    return pattern
      ? applyPackageTargetPattern(resolveConditionalTarget(pattern.target, mode, configuredConditions), pattern.match)
      : undefined;
  }
  return request === '.' ? resolveConditionalTarget(record, mode, configuredConditions) : undefined;
}

function resolveConditionalTarget(
  target: unknown,
  mode: ResolutionMode,
  configuredConditions: readonly string[]
): PackageTarget {
  if (typeof target === 'string') return target;
  if (target === null) return blockedPackageTarget;
  if (Array.isArray(target)) {
    return target.map((candidate) => resolveConditionalTarget(candidate, mode, configuredConditions));
  }
  if (!target || typeof target !== 'object') return undefined;
  const activeConditions = new Set(['node', 'module-sync', mode, ...configuredConditions]);
  for (const [condition, conditionalTarget] of Object.entries(target as Record<string, unknown>)) {
    if (condition !== 'default' && !activeConditions.has(condition)) continue;
    const resolved = resolveConditionalTarget(conditionalTarget, mode, configuredConditions);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

function findBestPatternMatch(
  record: Record<string, unknown>,
  request: string
): { target: unknown; match: string } | undefined {
  let best: { target: unknown; match: string; prefixLength: number; suffixLength: number } | undefined;
  for (const [key, target] of Object.entries(record)) {
    const star = key.indexOf('*');
    if (star === -1) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (!request.startsWith(prefix) || !request.endsWith(suffix) || request.length < prefix.length + suffix.length) continue;
    const candidate = {
      target,
      match: request.slice(prefix.length, request.length - suffix.length),
      prefixLength: prefix.length,
      suffixLength: suffix.length
    };
    if (
      !best ||
      candidate.prefixLength > best.prefixLength ||
      (candidate.prefixLength === best.prefixLength && candidate.suffixLength > best.suffixLength)
    ) {
      best = candidate;
    }
  }
  return best;
}

function applyPackageTargetPattern(target: PackageTarget, match: string): PackageTarget {
  if (typeof target === 'string') return target.replaceAll('*', match);
  return Array.isArray(target) ? target.map((candidate) => applyPackageTargetPattern(candidate, match)) : target;
}

function validatePackageTarget(target: string, packageRoot: string): void {
  if (!target.startsWith('./')) throw invalidPackageTarget(target, packageRoot);
  const segments = target.slice(2).split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment === 'node_modules')) {
    throw invalidPackageTarget(target, packageRoot);
  }
}

function moduleNotFound(message: string): ModuleResolutionError {
  return new ModuleResolutionError('module-not-found', message);
}

function invalidPackageTarget(target: string, packageRoot: string): ModuleResolutionError {
  return new ModuleResolutionError(
    'invalid-package-target',
    `Invalid package target '${target}' defined by ${joinPath(packageRoot, 'package.json')}`
  );
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
}
