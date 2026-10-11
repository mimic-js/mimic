import { statDataFrom } from './projections';
import type {
  ExportedFileSystemTree,
  FileSystemArchiveFormat,
  VfsCommitJournalRecord,
  VfsCommitJournalResult,
  VfsCommitRequest,
  VfsCommitResult,
  VfsDirentData,
  VfsDomainError,
  VfsResult,
  VfsStatData
} from './types';
import { VirtualFileSystem, type VfsOpenFileOptions } from './virtual-file-system';

export interface VirtualFileSystemAuthority {
  readonly revision: number;
  readonly workdir: string;
  /**
   * `adoptData` lets the authority keep the request's byte arrays instead of
   * copying them; the caller must never touch them again.
   */
  commit(request: VfsCommitRequest, options?: VfsCommitOptions): VfsCommitResult;
  openFile(path: string, options: VfsOpenFileOptions): VfsResult<{ readonly id: number }>;
  closeFile(id: number): VfsResult<Record<never, never>>;
  readOpenFile(
    id: number,
    length: number,
    position?: number
  ): VfsResult<{ readonly data: Uint8Array }>;
  writeOpenFile(id: number, data: Uint8Array, position?: number): VfsCommitResult;
  statOpenFile(id: number): VfsResult<{ readonly stat: VfsStatData }>;
  readCommitJournal(afterRevision: number): VfsCommitJournalResult;
  readFile(path: string): VfsResult<{ readonly data: Uint8Array }>;
  /** Returns the stored bytes without copying; the caller must not retain or mutate them. */
  readFileView(path: string): VfsResult<{ readonly data: Uint8Array }>;
  /** Paths whose change can alter how `path` resolves: traversed symlinks and the final target. */
  tracePath(path: string, followFinal: boolean): VfsPathTrace | undefined;
  /** How many Open File Descriptions and file inodes the authority holds. */
  usage(): { readonly openFileDescriptions: number; readonly inodes: number };
  readFileSlice(
    path: string,
    offset: number,
    length: number
  ): VfsResult<{ readonly data: Uint8Array }>;
  readdir(
    path: string,
    withFileTypes: boolean
  ): VfsResult<{ readonly entries: readonly (string | VfsDirentData)[] }>;
  readlink(path: string): VfsResult<{ readonly target: string }>;
  stat(path: string, followFinal: boolean): VfsResult<{ readonly stat: VfsStatData }>;
  access(path: string): VfsResult<Record<never, never>>;
  realpath(path: string): VfsResult<{ readonly path: string }>;
  exportTree(path?: string): VfsResult<{ readonly tree: ExportedFileSystemTree }>;
  exportArchive(
    path: string | undefined,
    format: FileSystemArchiveFormat
  ): VfsResult<{ readonly archive: Uint8Array }>;
}

export interface VfsCommitOptions {
  readonly adoptData?: boolean;
}

export interface VfsPathTrace {
  readonly path: string;
  readonly symlinks: readonly string[];
}

export interface VirtualFileSystemAuthorityOptions {
  readonly journalCapacity?: number;
}

// Readers that fall further behind than this resynchronize; a build that
// commits file by file must not push an idle reader past the window.
const DEFAULT_JOURNAL_CAPACITY = 1_024;
const JOURNAL_INVALIDATION_BUDGET = 100_000;

export function createVirtualFileSystemAuthority(
  workdir: string,
  options: VirtualFileSystemAuthorityOptions = {}
): VirtualFileSystemAuthority {
  const journalCapacity = options.journalCapacity ?? DEFAULT_JOURNAL_CAPACITY;
  if (!Number.isInteger(journalCapacity) || journalCapacity < 1) {
    throw new RangeError('The VFS commit journal capacity must be a positive integer.');
  }
  const fileSystem = new VirtualFileSystem(workdir);
  let revision = 0;
  const journal: VfsCommitJournalRecord[] = [];
  let journaledInvalidations = 0;

  const query = <Value extends object>(operation: () => Value): VfsResult<Value> => {
    try {
      return { status: 'ok', revision, ...operation() };
    } catch (error) {
      return { status: 'rejected', revision, error: domainError(error) };
    }
  };

  const commit = (request: VfsCommitRequest, commitOptions?: VfsCommitOptions): VfsCommitResult => {
    if (request.operations.length === 0) {
      return {
        status: 'rejected',
        revision,
        error: {
          code: 'INVALID_ARGUMENT',
          message: 'A VFS commit requires at least one operation.'
        }
      };
    }
    const applied = fileSystem.applyCommit(request.operations, commitOptions);
    if (!applied.ok) {
      return {
        status: 'rejected',
        revision,
        error: {
          ...domainError(applied.error),
          operationIndex: applied.operationIndex,
          operationType: applied.operationType
        }
      };
    }
    revision += 1;
    journal.push({ revision, invalidations: applied.invalidations });
    journaledInvalidations += applied.invalidations.length;
    let expired = 0;
    // A few very large commits must not pin their invalidation lists for a whole window.
    while (
      journal.length - expired > journalCapacity ||
      (journal.length - expired > 1 && journaledInvalidations > JOURNAL_INVALIDATION_BUDGET)
    ) {
      journaledInvalidations -= journal[expired].invalidations.length;
      expired += 1;
    }
    if (expired > 0) journal.splice(0, expired);
    return {
      status: 'committed',
      revision,
      origin: request.origin,
      operations: request.operations
    };
  };

  return {
    get revision() {
      return revision;
    },
    workdir,
    commit,
    openFile: (path, fileOptions) =>
      query(() => ({ id: fileSystem.openFileDescriptionSync(path, fileOptions) })),
    closeFile: (id) =>
      query(() => {
        fileSystem.closeFileDescriptionSync(id);
        return {};
      }),
    readOpenFile: (id, length, position) =>
      query(() => ({ data: fileSystem.readFileDescriptionSync(id, length, position) })),
    writeOpenFile: (id, data, position) =>
      commit({
        origin: `open-file:${id}`,
        operations: [{ type: 'write-open-file', id, data, position }]
      }),
    statOpenFile: (id) =>
      query(() => ({ stat: statDataFrom(fileSystem.statFileDescriptionSync(id)) })),
    readCommitJournal(afterRevision) {
      if (!Number.isInteger(afterRevision) || afterRevision < 0 || afterRevision > revision) {
        return {
          status: 'resync-required',
          currentRevision: revision,
          oldestRetainedRevision: journal[0]?.revision ?? revision
        };
      }
      const oldestRetainedRevision = journal[0]?.revision ?? revision + 1;
      if (afterRevision < oldestRetainedRevision - 1) {
        return { status: 'resync-required', currentRevision: revision, oldestRetainedRevision };
      }
      return {
        status: 'delta',
        fromRevision: afterRevision,
        toRevision: revision,
        // Revisions are contiguous, so the records after a cursor are a suffix.
        records: journal.slice(Math.max(0, afterRevision - oldestRetainedRevision + 1))
      };
    },
    readFile: (path) => query(() => ({ data: fileSystem.readFileSync(path) })),
    readFileView: (path) => query(() => ({ data: fileSystem.readFileViewSync(path) })),
    usage: () => fileSystem.usage(),
    tracePath(path, followFinal) {
      try {
        return fileSystem.tracePathResolutionSync(path, followFinal);
      } catch {
        return undefined;
      }
    },
    readFileSlice: (path, offset, length) =>
      query(() => ({ data: fileSystem.readFileSliceSync(path, offset, length) })),
    readdir: (path, withFileTypes) =>
      query(() => {
        const entries = fileSystem.readdirSync(path, { withFileTypes });
        return {
          entries: entries.map((entry): string | VfsDirentData => {
            if (typeof entry === 'string') return entry;
            return {
              name: entry.name,
              kind: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'symlink'
            };
          })
        };
      }),
    readlink: (path) => query(() => ({ target: fileSystem.readlinkSync(path) })),
    stat: (path, followFinal) =>
      query(() => ({
        stat: statDataFrom(followFinal ? fileSystem.statSync(path) : fileSystem.lstatSync(path))
      })),
    access: (path) =>
      query(() => {
        if (!fileSystem.exists(path)) {
          const error = new Error(`No such path: ${path}`) as Error & { code: string };
          error.code = 'NOT_FOUND';
          throw error;
        }
        return {};
      }),
    realpath: (path) => query(() => ({ path: fileSystem.realpathSync(path) })),
    exportTree: (path) => query(() => ({ tree: fileSystem.exportTree(path) })),
    exportArchive: (path, format) =>
      query(() => ({ archive: fileSystem.exportArchive(path, format) }))
  };
}

function domainError(error: unknown): VfsDomainError {
  if (error instanceof Error) {
    return {
      code:
        typeof (error as Error & { code?: unknown }).code === 'string'
          ? (error as Error & { code: string }).code
          : 'IO_FAILURE',
      message: error.message
    };
  }
  return { code: 'IO_FAILURE', message: String(error) };
}
