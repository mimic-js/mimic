import { dirname, joinPath, normalizePath } from '../virtual-file-system';
import type { ModuleResolutionFileSystem } from './module-resolution-types';

type PnpDependencyReference = string | [string, string] | null;
type PnpPackageRecord = {
  packageLocation: string;
  packageDependencies: Array<[string, PnpDependencyReference]>;
};
type PnpRuntimeState = {
  packageRegistryData: Array<[string | null, Array<[string | null, PnpPackageRecord]>]>;
};

type IndexedPackageRecord = {
  name: string | null;
  reference: string | null;
  location: string;
  dependencies: Map<string, PnpDependencyReference>;
};

export class PnpPackageResolver {
  private constructor(
    private readonly records: IndexedPackageRecord[],
    private readonly recordsByLocator: Map<string, IndexedPackageRecord>
  ) {}

  static find(fs: ModuleResolutionFileSystem, cwd: string): PnpPackageResolver | undefined {
    let current = normalizePath(cwd, cwd);
    while (true) {
      const dataPath = joinPath(current, '.pnp.data.json');
      if (fs.isFile(dataPath)) return PnpPackageResolver.fromData(fs.readText(dataPath), current);
      if (current === '/') return undefined;
      current = dirname(current);
    }
  }

  resolvePackageLocation(packageName: string, issuerDirectory: string): string | undefined {
    const issuer = this.findIssuer(issuerDirectory);
    const dependencyReference = issuer?.dependencies.get(packageName);
    if (dependencyReference === undefined || dependencyReference === null) return undefined;
    const [resolvedName, resolvedReference] = Array.isArray(dependencyReference)
      ? dependencyReference
      : [packageName, dependencyReference];
    return this.recordsByLocator.get(locatorKey(resolvedName, resolvedReference))?.location;
  }

  private static fromData(source: string, basePath: string): PnpPackageResolver {
    const state = JSON.parse(source) as PnpRuntimeState;
    if (!Array.isArray(state.packageRegistryData)) throw new Error(`Invalid PnP runtime data in ${basePath}/.pnp.data.json`);
    const records: IndexedPackageRecord[] = [];
    const recordsByLocator = new Map<string, IndexedPackageRecord>();
    for (const [name, references] of state.packageRegistryData) {
      for (const [reference, record] of references) {
        const indexed = {
          name,
          reference,
          location: normalizePath(record.packageLocation, basePath),
          dependencies: new Map(record.packageDependencies)
        } satisfies IndexedPackageRecord;
        records.push(indexed);
        if (name !== null && reference !== null) recordsByLocator.set(locatorKey(name, reference), indexed);
      }
    }
    records.sort((left, right) => right.location.length - left.location.length);
    return new PnpPackageResolver(records, recordsByLocator);
  }

  private findIssuer(directory: string): IndexedPackageRecord | undefined {
    const issuer = normalizePath(directory, directory);
    return this.records.find((record) => issuer === record.location || issuer.startsWith(`${record.location}/`));
  }
}

function locatorKey(name: string, reference: string): string {
  return `${name}\0${reference}`;
}
