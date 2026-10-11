import type { FileSystemArchiveEntry } from './archive-entry';
import { decodeTarArchive, encodeTarArchive } from './tar-archive';
import type { FileSystemArchiveFormat, FileSystemTree, FileSystemTreeNode } from './types';
import { decodeZipArchive, encodeZipArchive } from './zip-archive';

export function encodeFileSystemArchive(
  tree: FileSystemTree,
  format: FileSystemArchiveFormat
): Uint8Array {
  const entries = archiveEntriesFromTree(tree);
  return format === 'zip' ? encodeZipArchive(entries) : encodeTarArchive(entries);
}

export function decodeFileSystemArchive(archive: Uint8Array): FileSystemTree {
  try {
    return treeFromArchiveEntries(decodeZipArchive(archive));
  } catch (zipError) {
    try {
      return treeFromArchiveEntries(decodeTarArchive(archive));
    } catch (tarError) {
      throw archiveError('Unsupported binary filesystem snapshot.', {
        zipError,
        tarError
      });
    }
  }
}

function archiveEntriesFromTree(tree: FileSystemTree): FileSystemArchiveEntry[] {
  const entries: FileSystemArchiveEntry[] = [];
  const visit = (directory: FileSystemTree, prefix: string): void => {
    for (const [name, node] of Object.entries(directory).sort(compareNamedEntries)) {
      assertTreeEntryName(name);
      const path = prefix ? `${prefix}/${name}` : name;
      const mtimeMs = node.mtimeMs ?? 0;
      if ('file' in node) {
        const contents = node.file.contents;
        entries.push({
          path,
          kind: 'file',
          data:
            typeof contents === 'string'
              ? new TextEncoder().encode(contents)
              : new Uint8Array(contents),
          mtimeMs,
          mode: node.mode
        });
      } else if ('symlink' in node) {
        entries.push({ path, kind: 'symlink', target: node.symlink.target, mtimeMs });
      } else {
        entries.push({ path, kind: 'directory', mtimeMs, mode: node.mode });
        visit(node.directory, path);
      }
    }
  };
  visit(tree, '');
  return entries;
}

/**
 * A tree whose names are looked up as own entries only, so a file or directory
 * may be called `constructor`, `toString` or `__proto__`.
 */
function emptyTree(): FileSystemTree {
  return Object.create(null) as FileSystemTree;
}

function treeFromArchiveEntries(entries: readonly FileSystemArchiveEntry[]): FileSystemTree {
  const tree = emptyTree();
  const ordered = [...entries].sort((left, right) => {
    const depthDifference = pathDepth(left.path) - pathDepth(right.path);
    return depthDifference || compareText(left.path, right.path);
  });

  for (const entry of ordered) {
    const segments = entry.path.split('/');
    const name = segments.pop();
    if (!name) throw archiveError('Archive entry path must name a filesystem node.');
    const parent = ensureDirectory(tree, segments);
    const existing = parent[name];
    if (entry.kind === 'directory') {
      if (existing && !('directory' in existing)) {
        throw archiveError(`Archive path conflicts with a non-directory entry: ${entry.path}`);
      }
      parent[name] = {
        directory: existing && 'directory' in existing ? existing.directory : emptyTree(),
        mtimeMs: entry.mtimeMs,
        ...(entry.mode === undefined ? {} : { mode: entry.mode })
      };
    } else if (entry.kind === 'file') {
      if (existing) throw archiveError(`Archive contains duplicate or conflicting path: ${entry.path}`);
      parent[name] = {
        file: { contents: entry.data.slice() },
        mtimeMs: entry.mtimeMs,
        ...(entry.mode === undefined ? {} : { mode: entry.mode })
      };
    } else {
      if (existing) throw archiveError(`Archive contains duplicate or conflicting path: ${entry.path}`);
      parent[name] = {
        symlink: { target: entry.target },
        mtimeMs: entry.mtimeMs
      };
    }
  }
  return sortTree(tree);
}

function ensureDirectory(tree: FileSystemTree, segments: readonly string[]): FileSystemTree {
  let directory = tree;
  for (const segment of segments) {
    const existing = directory[segment];
    if (!existing) {
      const created: FileSystemTreeNode = { directory: emptyTree(), mtimeMs: 0 };
      directory[segment] = created;
      directory = created.directory;
      continue;
    }
    if (!('directory' in existing)) {
      throw archiveError(`Archive path traverses a non-directory entry: ${segments.join('/')}`);
    }
    directory = existing.directory;
  }
  return directory;
}

function sortTree(tree: FileSystemTree): FileSystemTree {
  const sorted = emptyTree();
  for (const [name, node] of Object.entries(tree).sort(compareNamedEntries)) {
    sorted[name] = 'directory' in node
      ? {
          directory: sortTree(node.directory),
          mtimeMs: node.mtimeMs,
          ...(node.mode === undefined ? {} : { mode: node.mode })
        }
      : node;
  }
  return sorted;
}

function assertTreeEntryName(name: string): void {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw archiveError(`Unsafe filesystem tree entry name: ${name}`);
  }
}

function pathDepth(path: string): number {
  return path.split('/').length;
}

function compareNamedEntries(
  [left]: readonly [string, unknown],
  [right]: readonly [string, unknown]
): number {
  return compareText(left, right);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function archiveError(message: string, cause?: unknown): Error {
  const error = new Error(message, cause === undefined ? undefined : { cause }) as Error & {
    code: string;
  };
  error.code = 'INVALID_ARCHIVE';
  return error;
}
