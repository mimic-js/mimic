/// <reference lib="webworker" />

import { awaitRuntimeHostConnection } from './worker-entry';
import {
  startRuntimeHostWorker
} from './worker-epoch';
const scope = self as DedicatedWorkerGlobalScope;

awaitRuntimeHostConnection(scope, (page) => {
  startRuntimeHostWorker({
    page,
    hostDocument: scope,
    // The Runtime Host document terminates the Worker after the terminal
    // transport state is observable. Calling scope.close() first leaves a ghost
    // dedicated worker in Chromium even after Worker.terminate().
    closeWorker: () => undefined,
    onUnhandledError: (listener) => scope.addEventListener('error', listener),
    onUnhandledRejection: (listener) => scope.addEventListener('unhandledrejection', listener)
  });
});
