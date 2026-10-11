import type { NodeMacrotaskQueue } from '../node-compatibility';
import type { RuntimeProgramContext } from '../runtime-program-context';
import { createWorkerThreadSharedMemoryPool } from '../worker-thread-shared-memory';

/**
 * The unclamped macrotask queue a test gives a JavaScript Runtime Program; a
 * process worker passes Worker Transport's.
 */
export const testMacrotaskQueue: NodeMacrotaskQueue = (callback) => {
  const timers = globalThis as unknown as {
    setImmediate(callback: () => void): unknown;
    clearImmediate(immediate: unknown): void;
  };
  const immediate = timers.setImmediate(callback);
  return () => timers.clearImmediate(immediate);
};

/**
 * The process ports a test gives a JavaScript Runtime Program it runs in the
 * test's own context. A child process or a Worker Thread is a process worker
 * of the Runtime Host, which such a test does not have, so starting one fails;
 * MessagePorts work while both ends stay in the test's thread.
 */
export function testProcessPorts(
  pid = 1
): Pick<RuntimeProgramContext, 'childProcess' | 'synchronousProcessAuthority' | 'workerThreads'> {
  const unavailable = (what: string): never => {
    throw Object.assign(new Error(`${what} needs a Runtime Host process worker.`), { code: 'ENOTSUP' });
  };
  let nextPort = 0;
  return {
    childProcess: {
      spawn: async () => unavailable('A child process'),
      signal: async () => false
    },
    synchronousProcessAuthority: {
      spawnSync: () => unavailable('A synchronous child process')
    },
    workerThreads: {
      current: { identity: { pid, threadId: 0 } },
      execution: { start: () => unavailable('A Worker Thread') },
      ports: {
        createId: () => `test.${++nextPort}`,
        host: () => unavailable('A MessagePort that leaves its thread'),
        link: () => unavailable('A MessagePort that leaves its thread')
      },
      sharedMemoryPool: createWorkerThreadSharedMemoryPool()
    }
  };
}
