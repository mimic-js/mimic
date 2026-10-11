export { serveVirtualFileSystem } from './service';
export {
  createAsyncVirtualFileSystemClient
} from './client';
export { VfsCommitJournalIndex } from './commit-journal-index';
export { createSynchronousVirtualFileSystemClient } from './mailbox-client';
export {
  isVfsCommitInvalidation,
  selectVfsCommittedWatchChanges
} from './committed-watch';
export { basename, dirname, joinPath, normalizePath } from './path';

export type {
  VirtualFileSystemAuthority,
  VirtualFileSystemAuthorityOptions
} from './authority';
export type {
  ServeVirtualFileSystemOptions,
  VirtualFileSystemService
} from './service';
export type { AsyncVirtualFileSystemClient } from './client';
export type {
  VfsCommitDependency,
  VfsCommitJournalReconciliation,
  VfsCommitJournalSource
} from './commit-journal-index';
export type {
  SynchronousVirtualFileSystemClient,
  SynchronousVirtualFileSystemClientOptions,
  SynchronousVirtualFileSystemDiagnostics
} from './mailbox-client';
export type {
  SynchronousVirtualFileSystemMailboxDescriptor,
  SynchronousVirtualFileSystemMailboxHostOptions,
  SynchronousVirtualFileSystemMailboxOptions
} from './mailbox';
export type {
  DirentLike,
  ExportedFileSystemTree,
  FileSystemArchiveFormat,
  FileStatLike,
  FileSystemAPI,
  FileSystemTree,
  FileSystemTreeNode,
  RevisionedFileSystemAPI,
  RuntimeVirtualFileSystemClient,
  VfsCommitEvent,
  VfsCommittedWatchEvent,
  VfsCommittedWatchChange,
  VfsCommittedWatchOptions,
  VfsCommittedWatchRegistration,
  VfsCommitInvalidation,
  VfsCommitJournalRecord,
  VfsCommitJournalResult,
  VfsCommitOperation,
  VfsCommitRequest,
  VfsCommitResult,
  VfsDirentData,
  VfsDomainError,
  VfsResult,
  VfsStatData,
  VfsWriteFileOptions,
  VirtualFileSystemApi
} from './types';
