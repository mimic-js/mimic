export type FileSystemTree = {
  [name: string]: FileSystemTreeNode;
};

export type FileSystemTreeNode = (
  | { file: { contents: string | Uint8Array | ArrayBuffer } }
  | { symlink: { target: string } }
  | { directory: FileSystemTree }
) & {
  /**
   * Modification time retained by deterministic filesystem snapshots and archives.
   * Creation time is intentionally not portable across the supported formats.
   */
  readonly mtimeMs?: number;
  /**
   * Permission bits of a file or directory, present only when they differ from
   * the default for its kind. Symbolic links keep a fixed mode and ignore it.
   */
  readonly mode?: number;
};

export type ExportedFileSystemTree = FileSystemTree;
export type ExportedFileSystemTreeNode = FileSystemTreeNode;
export type FileSystemArchiveFormat = 'zip' | 'tar';

export interface FileSystemAPI {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  readFile(path: string, encoding?: null): Promise<Uint8Array>;
  writeFile(path: string, data: string | Uint8Array, options?: VfsWriteFileOptions): Promise<void>;
  readdir(path: string, options?: { withFileTypes?: boolean }): Promise<Array<string | DirentLike>>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  link(existingPath: string, newPath: string): Promise<void>;
  utimes(path: string, mtimeMs: number): Promise<void>;
}

export interface VfsWriteFileOptions {
  /** Appends to an existing file instead of replacing its contents. */
  readonly append?: boolean;
  /** Fails with ALREADY_EXISTS when the path exists, atomically with the creation. */
  readonly exclusive?: boolean;
  /** Permission bits applied when the write creates the file. */
  readonly mode?: number;
}

export interface RuntimeVirtualFileSystemClient extends FileSystemAPI {
  access(path: string): Promise<void>;
  exists(path: string): boolean | Promise<boolean>;
  lstat(path: string): Promise<FileStatLike>;
  readlink(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<FileStatLike>;
  symlink(target: string, path: string): Promise<void>;
}

export interface RevisionedFileSystemAPI
  extends RuntimeVirtualFileSystemClient {
  readonly revision: number;
}

export type FileStatLike = {
  size: number;
  ino: number;
  /** File type and permission bits, as in `st_mode`. */
  mode?: number;
  nlink?: number;
  ctime: Date;
  mtime: Date;
  mtimeMs: number;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isFile(): boolean;
  isDirectory(): boolean;
  isSocket(): boolean;
  isSymbolicLink(): boolean;
};

export type DirentLike = {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

export type VfsCommitOperation =
  | ({
      readonly type: 'write-file';
      readonly path: string;
      readonly data: string | Uint8Array;
    } & VfsWriteFileOptions)
  | {
      readonly type: 'mkdir';
      readonly path: string;
      readonly options?: { readonly recursive?: boolean; readonly mode?: number };
    }
  | {
      readonly type: 'rm';
      readonly path: string;
      readonly options?: { readonly recursive?: boolean; readonly force?: boolean };
    }
  | { readonly type: 'rename'; readonly oldPath: string; readonly newPath: string }
  | { readonly type: 'symlink'; readonly target: string; readonly path: string }
  | { readonly type: 'link'; readonly existingPath: string; readonly newPath: string }
  | { readonly type: 'utimes'; readonly path: string; readonly mtimeMs: number }
  | { readonly type: 'chmod'; readonly path: string; readonly mode: number }
  | {
      readonly type: 'write-open-file';
      readonly id: number;
      readonly data: Uint8Array;
      readonly position?: number;
    }
  | { readonly type: 'mount'; readonly tree: FileSystemTree; readonly mountPoint?: string };

export interface VfsCommitRequest {
  readonly origin: string;
  readonly operations: readonly VfsCommitOperation[];
}

export interface VfsDomainError {
  readonly code: string;
  readonly message: string;
  readonly operationIndex?: number;
  readonly operationType?: VfsCommitOperation['type'];
}

export type VfsResult<Value extends object> =
  | ({ readonly status: 'ok'; readonly revision: number } & Value)
  | { readonly status: 'rejected'; readonly revision: number; readonly error: VfsDomainError };

export type VfsCommitResult =
  | {
      readonly status: 'committed';
      readonly revision: number;
      readonly origin: string;
      readonly operations: readonly VfsCommitOperation[];
    }
  | { readonly status: 'rejected'; readonly revision: number; readonly error: VfsDomainError };

export type VfsCommitEvent = Extract<VfsCommitResult, { readonly status: 'committed' }>;

export interface VfsCommitInvalidation {
  readonly path: string;
  readonly scope: 'path' | 'directory' | 'subtree';
}

export interface VfsCommitJournalRecord {
  readonly revision: number;
  readonly invalidations: readonly VfsCommitInvalidation[];
}

export type VfsCommitJournalResult =
  | {
      readonly status: 'delta';
      readonly fromRevision: number;
      readonly toRevision: number;
      readonly records: readonly VfsCommitJournalRecord[];
    }
  | {
      readonly status: 'resync-required';
      readonly currentRevision: number;
      readonly oldestRetainedRevision: number;
    };

export type VfsCommittedWatchEvent =
  | {
      readonly kind: 'commit';
      readonly revision: number;
      readonly invalidations: readonly VfsCommitInvalidation[];
    }
  | {
      readonly kind: 'resync-required';
      readonly afterRevision: number;
      readonly currentRevision: number;
      readonly oldestRetainedRevision: number;
      readonly reason: 'subscriber-backpressure' | 'journal-expired';
    };

export interface VfsCommittedWatchOptions {
  readonly afterRevision?: number;
  readonly maxQueuedRevisions?: number;
  readonly onRegistered?: (registration: VfsCommittedWatchRegistration) => void;
}

export interface VfsCommittedWatchRegistration {
  readonly registrationRevision: number;
  readonly cursor: number;
}

export interface VfsCommittedWatchChange {
  readonly path: string;
  readonly event: 'change' | 'rename';
}

export interface VfsDirentData {
  readonly name: string;
  readonly kind: 'file' | 'directory' | 'symlink';
}

export interface VfsStatData {
  readonly size: number;
  readonly ino: number;
  readonly mode: number;
  readonly nlink: number;
  readonly ctimeMs: number;
  readonly mtimeMs: number;
  readonly kind: 'file' | 'directory' | 'symlink';
}

/** A value read at a committed VFS revision. */
export type VfsRevisioned<Value extends object = Record<never, never>> = Value & {
  readonly revision: number;
};

/**
 * The operations the Virtual File System authority serves to other contexts.
 * A rejected operation throws a VirtualFileSystemError.
 */
export interface VirtualFileSystemApi {
  initialize(workdir: string): number;
  currentRevision(): number;
  readFile(path: string): VfsRevisioned<{ readonly data: Uint8Array }>;
  readdir(
    path: string,
    withFileTypes: boolean
  ): VfsRevisioned<{ readonly entries: readonly (string | VfsDirentData)[] }>;
  readlink(path: string): VfsRevisioned<{ readonly target: string }>;
  stat(path: string, followFinal: boolean): VfsRevisioned<{ readonly stat: VfsStatData }>;
  access(path: string): VfsRevisioned;
  realpath(path: string): VfsRevisioned<{ readonly path: string }>;
  openFile(
    path: string,
    options: import('./virtual-file-system').VfsOpenFileOptions
  ): VfsRevisioned<{ readonly id: number }>;
  closeFile(id: number): VfsRevisioned;
  readOpenFile(
    id: number,
    length: number,
    position?: number
  ): VfsRevisioned<{ readonly data: Uint8Array }>;
  writeOpenFile(id: number, data: Uint8Array, position?: number): VfsCommitEvent;
  statOpenFile(id: number): VfsRevisioned<{ readonly stat: VfsStatData }>;
  exportTree(path?: string): VfsRevisioned<{ readonly tree: ExportedFileSystemTree }>;
  exportArchive(
    path: string | undefined,
    format: FileSystemArchiveFormat
  ): VfsRevisioned<{ readonly archive: Uint8Array }>;
  mountArchive(
    archive: Uint8Array,
    mountPoint: string | undefined,
    origin: string
  ): VfsCommitEvent;
  commit(request: VfsCommitRequest): VfsCommitEvent;
  readCommitJournal(afterRevision: number): VfsCommitJournalResult;
  /** Waits for commits after `afterRevision`; `cancelCommitJournalWait` releases an abandoned wait. */
  waitForCommitJournal(
    afterRevision: number,
    waitId: string
  ): VfsCommitJournalResult | Promise<VfsCommitJournalResult>;
  cancelCommitJournalWait(waitId: string): void;
  openSynchronousMailbox(
    contextId: string,
    options?: import('./mailbox').SynchronousVirtualFileSystemMailboxOptions
  ): VfsRevisioned<{
    readonly descriptor: import('./mailbox').SynchronousVirtualFileSystemMailboxDescriptor;
  }>;
  closeSynchronousMailbox(contextId: string): VfsRevisioned;
}
