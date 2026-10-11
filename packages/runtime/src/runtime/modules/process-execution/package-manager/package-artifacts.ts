import type { ArtifactCache } from './artifact-cache';
import { TarballIntegrityError, UnsupportedIntegrityError, verifyTarball } from './npm-tarball';
import { InvalidPackageNameError, isValidPackageName } from './package-name';

export type PackageArtifactFetch = (url: string) => Promise<Response>;

const REGISTRY = 'https://registry.npmjs.org';

/** The npm registry publishes the package, but not at this version. */
export class UnpublishedVersionError extends Error {
  constructor(packageName: string, version: string) {
    super(`The npm registry publishes no ${packageName}@${version}.`);
    this.name = 'UnpublishedVersionError';
  }
}

/**
 * Returns the tarball of an exact package, verified against `integrity`.
 * Cached bytes are verified again before use; a mismatch refetches them.
 */
export async function acquirePinnedTarball(
  cache: ArtifactCache,
  reference: Readonly<{ packageName: string; version: string; tarballUrl: string; integrity: string }>,
  fetchArtifact: PackageArtifactFetch = fetch
): Promise<Uint8Array> {
  const key = `${reference.packageName}@${reference.version}`;
  const cached = await cache.get(key);
  if (cached && (await matchesIntegrity(cached, reference.integrity))) return cached;
  const bytes = await fetchVerifiedTarball(reference.tarballUrl, reference.integrity, fetchArtifact);
  await cache.put(key, bytes);
  return bytes;
}

/**
 * Returns the tarball the npm registry publishes for `name@version`, verified
 * against the integrity the registry states for it. The registry is asked for
 * that integrity on every call: the Package Artifact Cache lives in the host
 * origin's storage, which project code can write, so cached bytes are only a
 * download saved, never a verification saved. Bytes that fail are refetched.
 */
export async function acquireRegistryTarball(
  cache: ArtifactCache,
  packageName: string,
  version: string,
  fetchArtifact: PackageArtifactFetch = fetch
): Promise<Uint8Array> {
  const key = `${packageName}@${version}`;
  const metadata = await versionMetadata(packageName, version, fetchArtifact);
  const tarballUrl = metadata.dist?.tarball;
  const integrity = metadata.dist?.integrity;
  if (typeof tarballUrl !== 'string' || typeof integrity !== 'string') {
    throw new Error(`Registry metadata for ${packageName}@${version} names no tarball integrity.`);
  }
  const cached = await cache.get(key);
  if (cached && (await matchesIntegrity(cached, integrity))) return cached;
  const bytes = await fetchVerifiedTarball(tarballUrl, integrity, fetchArtifact);
  await cache.put(key, bytes);
  return bytes;
}

/**
 * Whether the npm registry publishes `name@version`. A cached tarball is not
 * proof: it was not necessarily written by this runtime.
 */
export async function registryPublishes(
  packageName: string,
  version: string,
  fetchArtifact: PackageArtifactFetch = fetch
): Promise<boolean> {
  try {
    await versionMetadata(packageName, version, fetchArtifact);
    return true;
  } catch (error) {
    if (error instanceof UnpublishedVersionError) return false;
    throw error;
  }
}

/** Every version the npm registry publishes of `packageName`. */
export async function publishedVersions(
  packageName: string,
  fetchArtifact: PackageArtifactFetch = fetch
): Promise<readonly string[]> {
  const response = await fetchArtifact(`${REGISTRY}/${registryPath(packageName)}`);
  if (!response.ok) {
    throw new Error(`Registry request for ${packageName} failed: ${response.status}.`);
  }
  const metadata = (await response.json()) as { versions?: Record<string, unknown> };
  return Object.keys(metadata.versions ?? {});
}

/** The registry's path segment for a package; a scoped name's `/` is encoded. */
function registryPath(packageName: string): string {
  if (!isValidPackageName(packageName)) {
    throw new InvalidPackageNameError(packageName, 'A registry request');
  }
  return packageName.replace(/\//gu, '%2f');
}

async function matchesIntegrity(bytes: Uint8Array, integrity: string): Promise<boolean> {
  try {
    await verifyTarball(bytes, { integrity });
    return true;
  } catch (error) {
    if (error instanceof TarballIntegrityError || error instanceof UnsupportedIntegrityError) return false;
    throw error;
  }
}

async function versionMetadata(
  packageName: string,
  version: string,
  fetchArtifact: PackageArtifactFetch
): Promise<{ dist?: { tarball?: unknown; integrity?: unknown } }> {
  const response = await fetchArtifact(
    `${REGISTRY}/${registryPath(packageName)}/${encodeURIComponent(version)}`
  );
  if (response.status === 404) throw new UnpublishedVersionError(packageName, version);
  if (!response.ok) {
    throw new Error(`Registry request for ${packageName}@${version} failed: ${response.status}.`);
  }
  return (await response.json()) as { dist?: { tarball?: unknown; integrity?: unknown } };
}

async function fetchVerifiedTarball(
  url: string,
  integrity: string,
  fetchArtifact: PackageArtifactFetch
): Promise<Uint8Array> {
  const response = await fetchArtifact(url);
  if (!response.ok) {
    throw new Error(`Tarball request ${url} failed: ${response.status} ${response.statusText}`.trim());
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  await verifyTarball(bytes, { integrity });
  return bytes;
}
