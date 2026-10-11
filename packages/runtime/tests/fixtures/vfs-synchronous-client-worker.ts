/// <reference lib="webworker" />

import {
  createSynchronousVirtualFileSystemClient,
  type SynchronousVirtualFileSystemMailboxDescriptor
} from '../../src/runtime/modules/virtual-file-system/index';

type WorkerCommand =
  | { readonly type: 'initialize'; readonly descriptor: SynchronousVirtualFileSystemMailboxDescriptor }
  | { readonly type: 'write-read'; readonly id: string; readonly path: string; readonly size: number }
  | { readonly type: 'read'; readonly id: string; readonly path: string }
  | { readonly type: 'readdir'; readonly id: string; readonly path: string }
  | { readonly type: 'close' };

const scope = self as DedicatedWorkerGlobalScope;
let client: ReturnType<typeof createSynchronousVirtualFileSystemClient> | undefined;

scope.addEventListener('message', (event: MessageEvent<WorkerCommand>) => {
  const command = event.data;
  if (command.type === 'initialize') {
    client = createSynchronousVirtualFileSystemClient(command.descriptor);
    scope.postMessage({ type: 'initialized' });
    return;
  }
  if (command.type === 'close') {
    client?.close();
    scope.close();
    return;
  }
  scope.postMessage({ type: 'started', id: command.id });
  try {
    if (!client) throw new Error('The synchronous VFS client is not initialized.');
    if (command.type === 'write-read') {
      const bytes = Uint8Array.from({ length: command.size }, (_, index) => index % 251);
      client.writeFileSync(command.path, bytes);
      const observed = client.readFileSync(command.path);
      scope.postMessage({
        type: 'result',
        id: command.id,
        revision: client.revision,
        byteLength: observed.byteLength,
        first: observed[0],
        last: observed.at(-1),
        diagnostics: client.diagnostics
      });
      return;
    }
    if (command.type === 'readdir') {
      const entries = client.readdirSync(command.path);
      scope.postMessage({ type: 'result', id: command.id, revision: client.revision, entries: entries.length });
      return;
    }
    const observed = client.readFileSync(command.path, 'utf8');
    scope.postMessage({
      type: 'result',
      id: command.id,
      revision: client.revision,
      text: observed,
      diagnostics: client.diagnostics
    });
  } catch (error) {
    scope.postMessage({
      type: 'error',
      id: command.id,
      name: error instanceof Error ? error.name : 'Error',
      code: error instanceof Error && 'code' in error ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error)
    });
  }
});
