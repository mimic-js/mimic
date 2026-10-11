import { dirname } from './path';
import type { VfsCommitInvalidation, VfsCommittedWatchChange } from './types';

export function isVfsCommitInvalidation(
  value: unknown
): value is VfsCommitInvalidation {
  if (!isRecord(value)) return false;
  const invalidation = value;
  return (
    typeof invalidation.path === 'string' &&
    (invalidation.scope === 'path' ||
      invalidation.scope === 'directory' ||
      invalidation.scope === 'subtree')
  );
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Projects compact authority invalidations onto one watch root without turning
 * cache invalidations into observable filesystem events.
 */
export function selectVfsCommittedWatchChanges(
  invalidations: readonly VfsCommitInvalidation[],
  watchedPath: string,
  recursive: boolean
): readonly VfsCommittedWatchChange[] {
  const changes = new Map<string, VfsCommittedWatchChange['event']>();

  for (const invalidation of invalidations) {
    if (invalidation.scope === 'directory') continue;
    const path = selectedPath(invalidation, watchedPath, recursive);
    if (!path) continue;
    const event = invalidation.scope === 'path' ? 'change' : 'rename';
    if (changes.get(path) !== 'rename' || event === 'rename') changes.set(path, event);
  }

  return [...changes].map(([path, event]) => ({ path, event }));
}

function selectedPath(
  invalidation: VfsCommitInvalidation,
  watchedPath: string,
  recursive: boolean
): string | undefined {
  const path = invalidation.path;
  if (path === watchedPath) return path;

  if (isDescendant(path, watchedPath)) {
    if (recursive || dirname(path) === watchedPath) return path;
    return undefined;
  }

  if (invalidation.scope === 'subtree' && isDescendant(watchedPath, path)) return watchedPath;
  return undefined;
}

function isDescendant(path: string, parent: string): boolean {
  return parent === '/' ? path !== '/' : path.startsWith(`${parent}/`);
}
