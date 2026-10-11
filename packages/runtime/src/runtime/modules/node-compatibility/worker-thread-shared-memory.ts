/**
 * Shared memory every thread of a process holds from its start (ADR-0025). Its
 * first word allocates the 4-byte signals, which `new SharedArrayBuffer(4)`
 * returns in a thread; its second hands out thread ids. A message that a thread
 * must receive synchronously can only refer to shared memory the thread already
 * holds, so such a signal crosses as its index.
 */
export type WorkerThreadSharedMemoryPool = Readonly<{
  /**
   * Names the process among every worker of the origin; `worker_threads.BroadcastChannel`
   * scopes its channels with it.
   */
  id: string;
  state: SharedArrayBuffer;
  signals: readonly SharedArrayBuffer[];
}>;

/** Index of the next free signal in a pool's state. */
export const WORKER_THREAD_POOL_NEXT_SIGNAL = 0;
/** Index of the last thread id drawn from a pool's state. */
export const WORKER_THREAD_POOL_NEXT_THREAD_ID = 1;
export const WORKER_THREAD_SHARED_SIGNAL_BYTES = Int32Array.BYTES_PER_ELEMENT;
/**
 * Signals are not returned to the pool, and a program may take one per call:
 * `make-synchronized`, behind `@prettier/sync`, does. 4,096 cost about 2 ms to
 * create and 5 ms to hand to each new thread (Chrome, M1 Pro); 16,384 cost 61 ms
 * per thread. A process that spends them all gets ordinary buffers from then on.
 */
const SHARED_SIGNAL_CAPACITY = 4096;

export function createWorkerThreadSharedMemoryPool(): WorkerThreadSharedMemoryPool {
  return {
    // Unique, not secret: every context of the origin can open any channel name anyway.
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`,
    state: new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT),
    // ponytail: Angular's synchronous worker handshakes use 4-byte signals; add size classes if another measured workload needs them.
    signals: Array.from(
      { length: SHARED_SIGNAL_CAPACITY },
      () => new SharedArrayBuffer(WORKER_THREAD_SHARED_SIGNAL_BYTES)
    )
  };
}
