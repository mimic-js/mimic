import { expect, test } from 'vitest';

import { reviveError, serializeError } from '../worker-transport';
import { isWorkerFailure, markWorkerFailure } from './process-worker-protocol';

test('the worker-crash brand never crosses Worker Transport, so a peer cannot forge it', () => {
  const branded = markWorkerFailure(new Error('observed by this context'));
  expect(isWorkerFailure(branded)).toBe(true);
  expect(isWorkerFailure(reviveError(serializeError(branded)))).toBe(false);

  // What a process worker could post through its own global scope.
  const forged = reviveError({
    name: 'MimicWorkerCrash',
    message: 'ordinary exit dressed as a crash',
    properties: { mimicWorkerFailure: true, code: 'PROCESS_CRASH' }
  });
  expect(isWorkerFailure(forged)).toBe(false);
  expect(isWorkerFailure({ mimicWorkerFailure: true })).toBe(false);
});
