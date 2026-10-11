import {
  createSynchronousVirtualFileSystemMailboxHost,
  type SynchronousVirtualFileSystemMailboxHost,
  type SynchronousVirtualFileSystemMailboxHostOptions
} from './mailbox';
import {
  createVirtualFileSystemAuthority,
  type VirtualFileSystemAuthority,
  type VirtualFileSystemAuthorityOptions
} from './authority';
import type {
  VfsCommitEvent,
  VfsCommitJournalResult,
  VfsCommitResult,
  VfsResult,
  VfsRevisioned,
  VirtualFileSystemApi
} from './types';
import { decodeFileSystemArchive } from './archive';
import { VirtualFileSystemError } from './errors';

export interface ServeVirtualFileSystemOptions {
  readonly authority?: VirtualFileSystemAuthorityOptions;
  readonly mailboxHost?: SynchronousVirtualFileSystemMailboxHostOptions;
}

export interface VirtualFileSystemService {
  readonly api: VirtualFileSystemApi;
  readonly authority: VirtualFileSystemAuthority | undefined;
  /**
   * The API as one owner, such as a Runtime Process, calls it. The owner
   * closes only the synchronous mailboxes it opened through this view, and
   * releasing it closes the Open File Descriptions and mailboxes it left
   * open. An owner bound to a mailbox context id opens that mailbox whatever
   * id it names, with the host's mailbox options.
   */
  forOwner(binding?: VirtualFileSystemOwnerBinding): VirtualFileSystemOwner;
  dispose(): void;
}

export interface VirtualFileSystemOwnerBinding {
  /** The one synchronous mailbox this owner may open and close. */
  readonly mailboxContextId?: string;
}

export interface VirtualFileSystemOwner {
  readonly api: VirtualFileSystemApi;
  release(): void;
}

type CommitJournalWaiter = {
  readonly afterRevision: number;
  readonly resolve: (result: VfsCommitJournalResult) => void;
};

export function serveVirtualFileSystem(
  options: ServeVirtualFileSystemOptions = {}
): VirtualFileSystemService {
  let authority: VirtualFileSystemAuthority | undefined;
  let mailboxHost: SynchronousVirtualFileSystemMailboxHost | undefined;
  const journalWaiters = new Map<string, CommitJournalWaiter>();

  const requireAuthority = (): VirtualFileSystemAuthority => {
    if (authority) return authority;
    throw new VirtualFileSystemError({
      code: 'VFS_NOT_INITIALIZED',
      message: 'The Runtime Host VFS is not initialized.'
    });
  };
  const accept = <Value extends object>(result: VfsResult<Value>): VfsRevisioned<Value> => {
    if (result.status === 'rejected') throw new VirtualFileSystemError(result.error);
    return result;
  };
  const acceptCommit = (result: VfsCommitResult): VfsCommitEvent => {
    if (result.status === 'rejected') throw new VirtualFileSystemError(result.error);
    return result;
  };
  const readCommitJournal = (afterRevision: number): VfsCommitJournalResult =>
    authority?.readCommitJournal(afterRevision) ?? {
      status: 'resync-required' as const,
      currentRevision: 0,
      oldestRetainedRevision: 0
    };
  const settleJournalWaiter = (waitId: string, result: VfsCommitJournalResult): void => {
    const waiter = journalWaiters.get(waitId);
    if (!waiter) return;
    journalWaiters.delete(waitId);
    waiter.resolve(result);
  };
  const releaseJournalWaiters = (): void => {
    for (const [waitId, waiter] of journalWaiters) {
      const result = readCommitJournal(waiter.afterRevision);
      if (result.status === 'delta' && result.records.length === 0) continue;
      settleJournalWaiter(waitId, result);
    }
  };
  const publishCommit = (result: VfsCommitEvent): VfsCommitEvent => {
    mailboxHost?.observeRevision(result.revision);
    releaseJournalWaiters();
    return result;
  };

  const api: VirtualFileSystemApi = {
    initialize(workdir) {
      if (authority) {
        throw new VirtualFileSystemError({
          code: 'ALREADY_INITIALIZED',
          message: 'The Runtime Host VFS is already initialized.'
        });
      }
      authority = createVirtualFileSystemAuthority(workdir, options.authority);
      mailboxHost = createSynchronousVirtualFileSystemMailboxHost(authority, {
        ...options.mailboxHost,
        onCommit: () => releaseJournalWaiters()
      });
      return authority.revision;
    },
    currentRevision: () => authority?.revision ?? 0,
    readFile: (path) => accept(requireAuthority().readFile(path)),
    readdir: (path, withFileTypes) => accept(requireAuthority().readdir(path, withFileTypes)),
    readlink: (path) => accept(requireAuthority().readlink(path)),
    stat: (path, followFinal) => accept(requireAuthority().stat(path, followFinal)),
    access: (path) => accept(requireAuthority().access(path)),
    realpath: (path) => accept(requireAuthority().realpath(path)),
    openFile: (path, openOptions) => accept(requireAuthority().openFile(path, openOptions)),
    closeFile: (id) => accept(requireAuthority().closeFile(id)),
    readOpenFile: (id, length, position) =>
      accept(requireAuthority().readOpenFile(id, length, position)),
    writeOpenFile: (id, data, position) =>
      publishCommit(acceptCommit(requireAuthority().writeOpenFile(id, data, position))),
    statOpenFile: (id) => accept(requireAuthority().statOpenFile(id)),
    exportTree: (path) => accept(requireAuthority().exportTree(path)),
    exportArchive: (path, format) => accept(requireAuthority().exportArchive(path, format)),
    mountArchive(archive, mountPoint, origin) {
      const committed = requireAuthority();
      const tree = decodeFileSystemArchive(archive);
      return publishCommit(
        acceptCommit(
          committed.commit({ origin, operations: [{ type: 'mount', tree, mountPoint }] })
        )
      );
    },
    commit: (request) => publishCommit(acceptCommit(requireAuthority().commit(request))),
    readCommitJournal,
    waitForCommitJournal(afterRevision, waitId) {
      const current = readCommitJournal(afterRevision);
      if (current.status === 'resync-required' || current.records.length > 0) {
        return current;
      }
      return new Promise<VfsCommitJournalResult>((resolve) => {
        journalWaiters.set(waitId, { afterRevision, resolve });
      });
    },
    cancelCommitJournalWait(waitId) {
      const waiter = journalWaiters.get(waitId);
      if (waiter) settleJournalWaiter(waitId, readCommitJournal(waiter.afterRevision));
    },
    openSynchronousMailbox(contextId, mailboxOptions) {
      const committed = requireAuthority();
      return {
        revision: committed.revision,
        // The host exists whenever the authority does.
        descriptor: mailboxHost!.open(contextId, mailboxOptions)
      };
    },
    closeSynchronousMailbox(contextId) {
      const committed = requireAuthority();
      mailboxHost?.close(contextId);
      return { revision: committed.revision };
    }
  };

  return {
    api,
    get authority() {
      return authority;
    },
    forOwner(binding = {}) {
      const openFiles = new Set<number>();
      const mailboxes = new Set<string>();
      const bound = binding.mailboxContextId;
      return {
        api: {
          ...api,
          openFile(path, openOptions) {
            const opened = api.openFile(path, openOptions);
            openFiles.add(opened.id);
            return opened;
          },
          closeFile(id) {
            openFiles.delete(id);
            return api.closeFile(id);
          },
          openSynchronousMailbox(contextId, mailboxOptions) {
            // A bound owner's mailbox and its options are the host's to choose.
            const opened =
              bound === undefined
                ? api.openSynchronousMailbox(contextId, mailboxOptions)
                : api.openSynchronousMailbox(bound);
            mailboxes.add(bound ?? contextId);
            return opened;
          },
          closeSynchronousMailbox(contextId) {
            const closing = bound ?? contextId;
            if (!mailboxes.has(closing)) {
              throw new VirtualFileSystemError({
                code: 'VFS_MAILBOX_NOT_OWNED',
                message: `The synchronous VFS mailbox ${String(contextId)} was not opened by this owner.`
              });
            }
            mailboxes.delete(closing);
            return api.closeSynchronousMailbox(closing);
          }
        },
        release() {
          for (const contextId of mailboxes) mailboxHost?.close(contextId);
          mailboxes.clear();
          for (const id of openFiles) authority?.closeFile(id);
          openFiles.clear();
        }
      };
    },
    dispose() {
      for (const [waitId, waiter] of [...journalWaiters]) {
        settleJournalWaiter(waitId, readCommitJournal(waiter.afterRevision));
      }
      mailboxHost?.fail();
      mailboxHost?.dispose();
      mailboxHost = undefined;
      authority = undefined;
    }
  };
}
