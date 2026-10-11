import type {
  DirentLike,
  FileSystemArchiveFormat,
  FileStatLike,
  FileSystemTree,
  RevisionedFileSystemAPI,
  VfsCommitJournalResult,
  VfsCommittedWatchEvent,
  VfsCommittedWatchOptions,
  VfsCommittedWatchRegistration,
  VfsCommitOperation,
  VfsCommitRequest,
  VfsCommitResult,
  VfsWriteFileOptions,
  VirtualFileSystemApi
} from './types';
import type { Remote } from '../worker-transport';
import type {
  SynchronousVirtualFileSystemMailboxDescriptor,
  SynchronousVirtualFileSystemMailboxOptions
} from './mailbox';
import { failSynchronousChannel } from '../worker-transport';
import { VirtualFileSystemError } from './errors';
import { direntFromData, statFromData } from './projections';

let nextClientId = 0;

export interface AsyncVirtualFileSystemClient extends RevisionedFileSystemAPI {
  readonly revision: number;
  access(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  closeFile(id: number): Promise<void>;
  close(): void;
  commit(request: VfsCommitRequest): Promise<Extract<VfsCommitResult, { readonly status: 'committed' }>>;
  observeRevision(revision: number): void;
  exportArchive(path: string | undefined, format: FileSystemArchiveFormat): Promise<Uint8Array>;
  exportTree(path?: string): Promise<FileSystemTree>;
  exists(path: string): Promise<boolean>;
  lstat(path: string): Promise<FileStatLike>;
  mount(tree: FileSystemTree, mountPoint?: string): Promise<void>;
  mountArchive(archive: Uint8Array, mountPoint?: string): Promise<void>;
  openFile(
    path: string,
    options: { readonly append: boolean; readonly readable: boolean; readonly writable: boolean }
  ): Promise<number>;
  readOpenFile(id: number, length: number, position?: number): Promise<Uint8Array>;
  readCommitJournal(afterRevision: number): Promise<VfsCommitJournalResult>;
  waitForCommitJournal(
    afterRevision: number,
    signal?: AbortSignal
  ): Promise<VfsCommitJournalResult>;
  watchCommitted(
    listener: (event: VfsCommittedWatchEvent) => void,
    options?: VfsCommittedWatchOptions
  ): () => void;
  openSynchronousMailbox(
    contextId: string,
    options?: SynchronousVirtualFileSystemMailboxOptions
  ): Promise<SynchronousVirtualFileSystemMailboxDescriptor>;
  closeSynchronousMailbox(contextId: string): Promise<void>;
  readlink(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<FileStatLike>;
  statOpenFile(id: number): Promise<FileStatLike>;
  symlink(target: string, path: string): Promise<void>;
  writeOpenFile(id: number, data: Uint8Array, position?: number): Promise<number>;
}

export async function createAsyncVirtualFileSystemClient(
  api: Remote<VirtualFileSystemApi>
): Promise<AsyncVirtualFileSystemClient> {
  const client = new AsyncVirtualFileSystemClientImplementation(api);
  try {
    client.observeRevision(await api.currentRevision());
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}

class AsyncVirtualFileSystemClientImplementation implements AsyncVirtualFileSystemClient {
  readonly #committedWatches = new Set<CommittedWatchState>();
  readonly #remote: Remote<VirtualFileSystemApi>;
  readonly #synchronousMailboxes = new Map<string, SynchronousVirtualFileSystemMailboxDescriptor>();
  readonly #origin = `async-vfs-client-${++nextClientId}`;
  #closed = false;
  #revision = 0;
  #nextWaitId = 0;

  constructor(remote: Remote<VirtualFileSystemApi>) {
    this.#remote = remote;
  }

  get revision(): number {
    return this.#revision;
  }

  observeRevision(revision: number): void {
    if (revision <= this.#revision) return;
    this.#revision = revision;
    for (const watch of this.#committedWatches) this.scheduleCommittedWatch(watch);
  }

  async readFile(path: string, encoding: 'utf8'): Promise<string>;
  async readFile(path: string, encoding?: null): Promise<Uint8Array>;
  async readFile(path: string, encoding?: 'utf8' | null): Promise<string | Uint8Array> {
    this.assertOpen();
    const result = await this.#remote.readFile(path);
    this.observeRevision(result.revision);
    return encoding === 'utf8' ? new TextDecoder().decode(result.data) : result.data;
  }

  async openFile(
    path: string,
    options: { readonly append: boolean; readonly readable: boolean; readonly writable: boolean }
  ): Promise<number> {
    this.assertOpen();
    const result = await this.#remote.openFile(path, options);
    this.observeRevision(result.revision);
    return result.id;
  }

  async closeFile(id: number): Promise<void> {
    this.assertOpen();
    const result = await this.#remote.closeFile(id);
    this.observeRevision(result.revision);
  }

  async readOpenFile(id: number, length: number, position?: number): Promise<Uint8Array> {
    this.assertOpen();
    const result = await this.#remote.readOpenFile(id, length, position);
    this.observeRevision(result.revision);
    return result.data;
  }

  async writeOpenFile(id: number, data: Uint8Array, position?: number): Promise<number> {
    this.assertOpen();
    const result = await this.#remote.writeOpenFile(id, data, position);
    this.observeRevision(result.revision);
    return data.byteLength;
  }

  async statOpenFile(id: number): Promise<FileStatLike> {
    this.assertOpen();
    const result = await this.#remote.statOpenFile(id);
    this.observeRevision(result.revision);
    return statFromData(result.stat);
  }

  async writeFile(
    path: string,
    data: string | Uint8Array,
    options?: VfsWriteFileOptions
  ): Promise<void> {
    await this.commitOne({
      type: 'write-file',
      path,
      data,
      append: options?.append,
      exclusive: options?.exclusive,
      mode: options?.mode
    });
  }

  async chmod(path: string, mode: number): Promise<void> {
    await this.commitOne({ type: 'chmod', path, mode });
  }

  async readdir(path: string, options?: { withFileTypes?: boolean }): Promise<Array<string | DirentLike>> {
    this.assertOpen();
    const withFileTypes = options?.withFileTypes === true;
    const result = await this.#remote.readdir(path, withFileTypes);
    this.observeRevision(result.revision);
    return result.entries.map((entry) => {
      if (typeof entry === 'string') return entry;
      return direntFromData(entry);
    });
  }

  async mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void> {
    await this.commitOne({ type: 'mkdir', path, options });
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    await this.commitOne({ type: 'rm', path, options });
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.commitOne({ type: 'rename', oldPath, newPath });
  }

  async symlink(target: string, path: string): Promise<void> {
    await this.commitOne({ type: 'symlink', target, path });
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    await this.commitOne({ type: 'link', existingPath, newPath });
  }

  async utimes(path: string, mtimeMs: number): Promise<void> {
    await this.commitOne({ type: 'utimes', path, mtimeMs });
  }

  async readlink(path: string): Promise<string> {
    this.assertOpen();
    const result = await this.#remote.readlink(path);
    this.observeRevision(result.revision);
    return result.target;
  }

  async stat(path: string): Promise<FileStatLike> {
    return this.readStat(path, true);
  }

  async lstat(path: string): Promise<FileStatLike> {
    return this.readStat(path, false);
  }

  async access(path: string): Promise<void> {
    this.assertOpen();
    const result = await this.#remote.access(path);
    this.observeRevision(result.revision);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.access(path);
      return true;
    } catch (error) {
      if ((error as { readonly code?: unknown }).code === 'NOT_FOUND') return false;
      throw error;
    }
  }

  async realpath(path: string): Promise<string> {
    this.assertOpen();
    const result = await this.#remote.realpath(path);
    this.observeRevision(result.revision);
    return result.path;
  }

  async mount(tree: FileSystemTree, mountPoint?: string): Promise<void> {
    await this.commitOne({ type: 'mount', tree, mountPoint });
  }

  async mountArchive(archive: Uint8Array, mountPoint?: string): Promise<void> {
    this.assertOpen();
    const result = await this.#remote.mountArchive(archive, mountPoint, this.#origin);
    this.observeRevision(result.revision);
  }

  async exportTree(path?: string): Promise<FileSystemTree> {
    this.assertOpen();
    const result = await this.#remote.exportTree(path);
    this.observeRevision(result.revision);
    return result.tree;
  }

  async exportArchive(
    path: string | undefined,
    format: FileSystemArchiveFormat
  ): Promise<Uint8Array> {
    this.assertOpen();
    const result = await this.#remote.exportArchive(path, format);
    this.observeRevision(result.revision);
    return result.archive;
  }

  async commit(request: VfsCommitRequest): Promise<Extract<VfsCommitResult, { readonly status: 'committed' }>> {
    this.assertOpen();
    const result = await this.#remote.commit(request);
    this.observeRevision(result.revision);
    return result;
  }

  async readCommitJournal(afterRevision: number): Promise<VfsCommitJournalResult> {
    this.assertOpen();
    const result = await this.#remote.readCommitJournal(afterRevision);
    this.observeRevision(
      result.status === 'delta' ? result.toRevision : result.currentRevision
    );
    return result;
  }

  async waitForCommitJournal(
    afterRevision: number,
    signal?: AbortSignal
  ): Promise<VfsCommitJournalResult> {
    this.assertOpen();
    const waitId = `${this.#origin}:wait-${++this.#nextWaitId}`;
    const cancel = (): void => {
      void this.#remote.cancelCommitJournalWait(waitId).catch(() => undefined);
    };
    const waiting = this.#remote.waitForCommitJournal(afterRevision, waitId);
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
    let result: VfsCommitJournalResult;
    try {
      result = await waiting;
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
    this.observeRevision(
      result.status === 'delta' ? result.toRevision : result.currentRevision
    );
    return result;
  }

  watchCommitted(
    listener: (event: VfsCommittedWatchEvent) => void,
    options: VfsCommittedWatchOptions = {}
  ): () => void {
    this.assertOpen();
    const afterRevision = options.afterRevision;
    const maxQueuedRevisions = options.maxQueuedRevisions ?? 64;
    if (
      afterRevision !== undefined &&
      (!Number.isInteger(afterRevision) ||
        afterRevision < 0 ||
        afterRevision > this.#revision)
    ) {
      throw new RangeError(
        `A committed VFS watch cursor must be an integer between 0 and ${this.#revision}.`
      );
    }
    if (!Number.isInteger(maxQueuedRevisions) || maxQueuedRevisions < 1) {
      throw new RangeError('A committed VFS watch queue capacity must be a positive integer.');
    }
    const watch: CommittedWatchState = {
      abort: undefined,
      afterRevision,
      closed: false,
      draining: false,
      listener,
      maxQueuedRevisions,
      onRegistered: options.onRegistered,
      registered: false,
      registrationRevision: this.#revision
    };
    this.#committedWatches.add(watch);
    this.scheduleCommittedWatch(watch);
    return () => {
      watch.closed = true;
      watch.abort?.abort();
      this.#committedWatches.delete(watch);
    };
  }

  async openSynchronousMailbox(
    contextId: string,
    options?: SynchronousVirtualFileSystemMailboxOptions
  ): Promise<SynchronousVirtualFileSystemMailboxDescriptor> {
    this.assertOpen();
    const result = await this.#remote.openSynchronousMailbox(contextId, options);
    this.observeRevision(result.revision);
    this.#synchronousMailboxes.set(contextId, result.descriptor);
    return result.descriptor;
  }

  async closeSynchronousMailbox(contextId: string): Promise<void> {
    this.assertOpen();
    const result = await this.#remote.closeSynchronousMailbox(contextId);
    this.observeRevision(result.revision);
    this.#synchronousMailboxes.delete(contextId);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const descriptor of this.#synchronousMailboxes.values()) {
      failSynchronousChannel(descriptor.channel);
    }
    this.#synchronousMailboxes.clear();
    for (const watch of this.#committedWatches) {
      watch.closed = true;
      watch.abort?.abort();
    }
    this.#committedWatches.clear();
  }

  private async commitOne(operation: VfsCommitOperation): Promise<void> {
    await this.commit({ origin: this.#origin, operations: [operation] });
  }

  private async readStat(path: string, followFinal: boolean): Promise<FileStatLike> {
    this.assertOpen();
    const result = await this.#remote.stat(path, followFinal);
    this.observeRevision(result.revision);
    return statFromData(result.stat);
  }

  private scheduleCommittedWatch(watch: CommittedWatchState): void {
    if (
      this.#closed ||
      watch.closed ||
      watch.draining
    ) {
      return;
    }
    watch.draining = true;
    queueMicrotask(() => {
      void this.drainCommittedWatch(watch)
        .catch(() => {
          watch.closed = true;
          this.#committedWatches.delete(watch);
        })
        .finally(() => {
          watch.draining = false;
        });
    });
  }

  private async drainCommittedWatch(watch: CommittedWatchState): Promise<void> {
    while (!this.#closed && !watch.closed) {
      if (!watch.registered) {
        let registrationRevision = watch.registrationRevision;
        if (watch.afterRevision === undefined) {
          const revision = await this.#remote.currentRevision();
          this.observeRevision(revision);
          registrationRevision = revision;
          watch.afterRevision = revision;
        }
        if (watch.closed || this.#closed) return;
        const cursor = watch.afterRevision;
        if (cursor === undefined) {
          throw new Error('A committed VFS watch registration did not establish its cursor.');
        }
        watch.registrationRevision = registrationRevision;
        watch.registered = true;
        watch.onRegistered?.({
          registrationRevision,
          cursor
        });
      }
      const afterRevision = watch.afterRevision;
      if (afterRevision === undefined) {
        throw new Error('A committed VFS watch cannot drain without a registration cursor.');
      }
      const abort = new AbortController();
      watch.abort = abort;
      const result = await this.waitForCommitJournal(afterRevision, abort.signal);
      if (watch.abort === abort) watch.abort = undefined;
      if (watch.closed || this.#closed) return;
      if (result.status === 'resync-required') {
        watch.afterRevision = result.currentRevision;
        watch.listener({
          kind: 'resync-required',
          afterRevision,
          currentRevision: result.currentRevision,
          oldestRetainedRevision: result.oldestRetainedRevision,
          reason: 'journal-expired'
        });
        continue;
      }
      if (result.records.length > watch.maxQueuedRevisions) {
        watch.afterRevision = result.toRevision;
        watch.listener({
          kind: 'resync-required',
          afterRevision,
          currentRevision: result.toRevision,
          oldestRetainedRevision: result.records[0]?.revision ?? result.toRevision,
          reason: 'subscriber-backpressure'
        });
        continue;
      }
      watch.afterRevision = result.toRevision;
      for (const record of result.records) {
        if (watch.closed) return;
        watch.listener({
          kind: 'commit',
          revision: record.revision,
          invalidations: record.invalidations
        });
      }
    }
  }

  private assertOpen(): void {
    if (this.#closed) throw new VirtualFileSystemError({ code: 'VFS_CLIENT_CLOSED', message: 'The VFS client is closed.' });
  }
}

type CommittedWatchState = {
  abort: AbortController | undefined;
  afterRevision: number | undefined;
  closed: boolean;
  draining: boolean;
  readonly listener: (event: VfsCommittedWatchEvent) => void;
  readonly maxQueuedRevisions: number;
  readonly onRegistered: ((registration: VfsCommittedWatchRegistration) => void) | undefined;
  registered: boolean;
  registrationRevision: number;
};
