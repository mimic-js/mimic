/// <reference lib="webworker" />

import { exitCodeForSignal } from '../process-execution';
import { awaitRuntimeHostConnection } from './worker-entry';
import { createRuntimeHostEpoch } from './worker-epoch';

const scope = self as DedicatedWorkerGlobalScope;

const epoch = createRuntimeHostEpoch({
  closeWorker: () => undefined,
  virtualFileSystem: { mailboxHost: { autoSchedule: false } },
  runtimePrograms: [
    {
      id: 'pending',
      commands: ['pending'],
      handlesSignals: true,
      run: async (_args, context) => {
        await context.signal;
        return exitCodeForSignal('SIGTERM');
      }
    }
  ]
});

awaitRuntimeHostConnection(scope, (page) => epoch.connect(page, scope));
// The page cannot post to this worker, which the Runtime Host document
// created; it asks over a channel of their shared origin instead.
new BroadcastChannel('mimic:terminal-worker-fixture').addEventListener(
  'message',
  (event: MessageEvent<unknown>) => {
    if (
      typeof event.data === 'object' &&
      event.data !== null &&
      'type' in event.data &&
      event.data.type === 'inject-terminal-failure'
    ) {
      epoch.fail(new Error('Injected terminal Runtime Host failure'));
    }
  }
);
scope.addEventListener('error', (event) => {
  event.preventDefault();
  epoch.fail(event.error);
});
scope.addEventListener('unhandledrejection', (event) => {
  event.preventDefault();
  epoch.fail(event.reason);
});
