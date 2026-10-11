/**
 * The longest package name the npm registry accepts.
 */
const MAX_PACKAGE_NAME_LENGTH = 214;

/**
 * One segment of a package name: the scope without its `@`, or the name
 * itself. Lowercase, URL-safe, and not led by `.` or `_`.
 */
const SEGMENT = /^[a-z0-9][a-z0-9._-]*$/u;

/**
 * Whether `name` is a package name the npm registry would publish: at most
 * 214 characters, lowercase, made of URL-safe characters, with at most one
 * `@scope/` prefix, no segment led by `.` or `_`, and no `..`. Names that
 * flow into registry URLs, `npm install` specs and Virtual File System paths
 * are checked against this grammar where they are taken from untrusted
 * metadata.
 */
export function isValidPackageName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_PACKAGE_NAME_LENGTH || name.includes('..')) return false;
  const segments = name.startsWith('@') ? name.slice(1).split('/') : [name];
  if (name.startsWith('@') ? segments.length !== 2 : segments.length !== 1) return false;
  return segments.every((segment) => SEGMENT.test(segment));
}

/** A name taken from package metadata that is not a package name. */
export class InvalidPackageNameError extends Error {
  override readonly name = 'InvalidPackageNameError';

  constructor(packageName: string, source: string) {
    super(`${source} names ${JSON.stringify(packageName)}, which is not a valid npm package name.`);
  }
}
