import {
  createSynchronousChannel,
  failSynchronousChannel,
  serveSynchronousRpc,
  synchronousChannelWords,
  type SynchronousChannel,
  type SynchronousRpcServer
} from '../worker-transport';
import type { VirtualFileSystemAuthority } from './authority';
import { normalizePath } from './path';
import type {
  VfsCommitEvent,
  VfsCommitJournalResult,
  VfsCommitOperation,
  VfsCommitResult,
  VfsDirentData,
  VfsResult,
  VfsStatData
} from './types';

/** The status word through which the host publishes the authority's revision. */
export const AUTHORITY_REVISION_WORD = 0;

const DEFAULT_PAYLOAD_CAPACITY = 1024 * 1024;
const DEFAULT_MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;

export type SynchronousVfsCommitOperation = Exclude<VfsCommitOperation, { readonly type: 'mount' }>;

export interface SynchronousVfsCommitRequest {
  readonly origin: string;
  readonly operations: readonly SynchronousVfsCommitOperation[];
}

/**
 * A path-reading answer names the other paths it depends on (the symlinks it
 * traversed and the path they led to) so the client cache can drop the entry
 * when any of them changes.
 */
export type PathDependent<Response> = Response & { readonly dependencies?: readonly string[] };

/** A commit answer does not echo its operations; the caller already holds them. */
export type MailboxCommitResult =
  | { readonly status: 'committed'; readonly revision: number; readonly origin: string }
  | Extract<VfsCommitResult, { readonly status: 'rejected' }>;

/** What a synchronous VFS mailbox serves; the client drives it through the synchronous RPC. */
export interface SynchronousVirtualFileSystemMailboxApi {
  readFile(path: string): PathDependent<VfsResult<{ readonly data: Uint8Array }>>;
  readFileSlice(path: string, offset: number, length: number): VfsResult<{ readonly data: Uint8Array }>;
  readdir(
    path: string,
    withFileTypes: boolean
  ): PathDependent<VfsResult<{ readonly entries: readonly (string | VfsDirentData)[] }>>;
  readlink(path: string): PathDependent<VfsResult<{ readonly target: string }>>;
  stat(path: string, followFinal: boolean): PathDependent<VfsResult<{ readonly stat: VfsStatData }>>;
  access(path: string): PathDependent<VfsResult<Record<never, never>>>;
  realpath(path: string): PathDependent<VfsResult<{ readonly path: string }>>;
  openFile(
    path: string,
    options: { readonly append: boolean; readonly readable: boolean; readonly writable: boolean }
  ): VfsResult<{ readonly id: number }>;
  closeFile(id: number): VfsResult<Record<never, never>>;
  readOpenFile(id: number, length: number, position?: number): VfsResult<{ readonly data: Uint8Array }>;
  writeOpenFile(id: number, data: Uint8Array, position?: number): MailboxCommitResult;
  statOpenFile(id: number): VfsResult<{ readonly stat: VfsStatData }>;
  commit(request: SynchronousVfsCommitRequest): MailboxCommitResult;
  readCommitJournal(afterRevision: number): VfsCommitJournalResult;
  /**
   * A synchronous call to another service of the Runtime Host, which the
   * mailbox carries without interpreting: the Module Execution Engine's
   * compile cache is one.
   */
  call(service: string, payload: unknown): unknown;
}

export interface SynchronousVirtualFileSystemMailboxOptions {
  readonly payloadCapacity?: number;
  readonly maxPayloadBytes?: number;
  readonly watchdogMs?: number;
}

export interface SynchronousVirtualFileSystemMailboxDescriptor {
  readonly channel: SynchronousChannel;
  readonly contextId: string;
  readonly workdir: string;
}

export interface SynchronousVirtualFileSystemMailboxHost {
  close(contextId: string): void;
  dispose(): void;
  fail(): void;
  observeRevision(revision: number): void;
  open(
    contextId: string,
    options?: SynchronousVirtualFileSystemMailboxOptions
  ): SynchronousVirtualFileSystemMailboxDescriptor;
}

export interface SynchronousVirtualFileSystemMailboxHostOptions {
  /** False leaves every mailbox unserved, as a stalled Runtime Host would. */
  readonly autoSchedule?: boolean;
  readonly onCommit?: (event: VfsCommitEvent) => void;
  /**
   * Other Runtime Host services a context calls synchronously through its
   * mailbox. The caller stays blocked while the service's promise is pending;
   * the watchdog only bounds how long the host takes to pick the call up.
   */
  readonly services?: Readonly<Record<string, (payload: unknown) => unknown>>;
}

type HostMailbox = {
  readonly words: Int32Array;
  readonly server: SynchronousRpcServer | undefined;
  readonly channel: SynchronousChannel;
  /** The Open File Descriptions this context opened and has not closed. */
  readonly openFiles: Set<number>;
};

export function createSynchronousVirtualFileSystemMailboxHost(
  authority: VirtualFileSystemAuthority,
  options: SynchronousVirtualFileSystemMailboxHostOptions = {}
): SynchronousVirtualFileSystemMailboxHost {
  const mailboxes = new Map<string, HostMailbox>();
  let disposed = false;

  const observeRevision = (revision: number): void => {
    for (const mailbox of mailboxes.values()) {
      Atomics.store(mailbox.words, AUTHORITY_REVISION_WORD, revision);
    }
  };

  const committed = (result: VfsCommitResult): MailboxCommitResult => {
    if (result.status !== 'committed') return result;
    observeRevision(authority.revision);
    options.onCommit?.(result);
    return { status: result.status, revision: result.revision, origin: result.origin };
  };

  const api: SynchronousVirtualFileSystemMailboxApi = {
    readFile: (path) => withDependencies(authority, path, true, authority.readFileView(path)),
    readFileSlice: (path, offset, length) => authority.readFileSlice(path, offset, length),
    readdir: (path, withFileTypes) =>
      withDependencies(authority, path, true, authority.readdir(path, withFileTypes)),
    readlink: (path) => withDependencies(authority, path, false, authority.readlink(path)),
    stat: (path, followFinal) =>
      withDependencies(authority, path, followFinal, authority.stat(path, followFinal)),
    access: (path) => withDependencies(authority, path, true, authority.access(path)),
    realpath: (path) => withDependencies(authority, path, true, authority.realpath(path)),
    openFile: (path, openOptions) => authority.openFile(path, openOptions),
    closeFile: (id) => authority.closeFile(id),
    readOpenFile: (id, length, position) => authority.readOpenFile(id, length, position),
    writeOpenFile: (id, data, position) => committed(authority.writeOpenFile(id, data, position)),
    statOpenFile: (id) => authority.statOpenFile(id),
    // The decoded request owns its bytes, so the authority can keep them.
    commit: (request) => committed(authority.commit(request, { adoptData: true })),
    readCommitJournal: (afterRevision) => authority.readCommitJournal(afterRevision),
    call(service, payload) {
      const handler = options.services?.[service];
      if (!handler) throw new Error(`No Runtime Host service is named ${service}.`);
      return handler(payload);
    }
  };

  const release = (contextId: string, fail: boolean): void => {
    const mailbox = mailboxes.get(contextId);
    if (!mailbox) return;
    mailboxes.delete(contextId);
    if (!mailbox.server) failSynchronousChannel(mailbox.channel);
    else if (fail) mailbox.server.fail();
    else mailbox.server.close();
    // A context that ends without closing its files, as a killed one does,
    // must not keep their descriptions or the unlinked inodes they pin.
    for (const id of mailbox.openFiles) authority.closeFile(id);
    mailbox.openFiles.clear();
  };

  return {
    open(contextId, mailboxOptions = {}) {
      if (disposed) throw new Error('The synchronous VFS mailbox host is closed.');
      if (mailboxes.has(contextId)) {
        throw new Error(`A synchronous VFS mailbox already exists for ${contextId}.`);
      }
      const maxMessageBytes = mailboxOptions.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
      const channel = createSynchronousChannel({
        capacity: mailboxOptions.payloadCapacity ?? Math.min(DEFAULT_PAYLOAD_CAPACITY, maxMessageBytes),
        maxMessageBytes,
        watchdogMs: mailboxOptions.watchdogMs,
        words: 1
      });
      const words = synchronousChannelWords(channel);
      Atomics.store(words, AUTHORITY_REVISION_WORD, authority.revision);
      const openFiles = new Set<number>();
      const contextApi: SynchronousVirtualFileSystemMailboxApi = {
        ...api,
        openFile(path, openOptions) {
          const opened = api.openFile(path, openOptions);
          if (opened.status === 'ok') openFiles.add(opened.id);
          return opened;
        },
        closeFile(id) {
          openFiles.delete(id);
          return api.closeFile(id);
        }
      };
      mailboxes.set(contextId, {
        words,
        channel,
        openFiles,
        server:
          options.autoSchedule === false ? undefined : serveSynchronousRpc(channel, contextApi)
      });
      return { channel, contextId, workdir: authority.workdir };
    },
    close: (contextId) => release(contextId, false),
    observeRevision,
    fail() {
      for (const contextId of [...mailboxes.keys()]) release(contextId, true);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const contextId of [...mailboxes.keys()]) release(contextId, false);
    }
  };
}

/**
 * Names every path other than the requested one whose change can alter this
 * answer: the symlinks the lookup traversed, the path they led to, and any
 * archive the path reads through.
 */
function withDependencies<Result extends object>(
  authority: VirtualFileSystemAuthority,
  path: string,
  followFinal: boolean,
  result: Result
): Result & { readonly dependencies?: readonly string[] } {
  const trace = authority.tracePath(path, followFinal);
  if (!trace) return result;
  const requested = normalizePath(path, authority.workdir);
  const dependencies = new Set<string>(trace.symlinks);
  dependencies.add(trace.path);
  for (
    let index = trace.path.indexOf('.zip/');
    index !== -1;
    index = trace.path.indexOf('.zip/', index + 1)
  ) {
    dependencies.add(trace.path.slice(0, index + 4));
  }
  dependencies.delete(requested);
  return dependencies.size === 0 ? result : { ...result, dependencies: [...dependencies] };
}
