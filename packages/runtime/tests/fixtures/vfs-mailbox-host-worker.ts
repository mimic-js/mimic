import { parentPort, workerData } from 'node:worker_threads';

import {
  type SynchronousVirtualFileSystemMailboxOptions,
  type VfsCommitRequest
} from '../../src/runtime/modules/virtual-file-system/index';
import {
  createSynchronousVirtualFileSystemMailboxHost
} from '../../src/runtime/modules/virtual-file-system/mailbox';
import {
  createVirtualFileSystemAuthority
} from '../../src/runtime/modules/virtual-file-system/authority';

/**
 * Hosts a VFS authority and its synchronous mailboxes on a worker thread so a
 * unit test can block on the synchronous client the way a Runtime Process does.
 */
type Command =
  | {
      readonly type: 'open';
      readonly id: number;
      readonly contextId: string;
      readonly options?: SynchronousVirtualFileSystemMailboxOptions;
    }
  | { readonly type: 'close'; readonly id: number; readonly contextId: string }
  | { readonly type: 'usage'; readonly id: number }
  | { readonly type: 'commit'; readonly id: number; readonly request: VfsCommitRequest }
  | { readonly type: 'stall'; readonly id: number; readonly milliseconds: number };

if (!parentPort) throw new Error('The VFS mailbox host fixture must run as a worker thread.');
const port = parentPort;
const authority = createVirtualFileSystemAuthority((workerData as { workdir: string }).workdir);
const host = createSynchronousVirtualFileSystemMailboxHost(authority);

port.on('message', (command: Command) => {
  switch (command.type) {
    case 'open':
      port.postMessage({
        id: command.id,
        descriptor: host.open(command.contextId, command.options)
      });
      return;
    case 'close':
      host.close(command.contextId);
      port.postMessage({ id: command.id });
      return;
    case 'usage':
      port.postMessage({ id: command.id, usage: authority.usage() });
      return;
    case 'commit': {
      const result = authority.commit(command.request);
      host.observeRevision(authority.revision);
      port.postMessage({ id: command.id, status: result.status, revision: result.revision });
      return;
    }
    case 'stall':
      port.postMessage({ id: command.id });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, command.milliseconds);
      return;
  }
});
