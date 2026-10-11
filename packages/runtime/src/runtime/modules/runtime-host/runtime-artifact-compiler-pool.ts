import {
  runtimeArtifactCompileFailure,
  type RuntimeArtifactKind,
  type RuntimeArtifactTranslation,
  type RuntimeArtifactTranslationPriority
} from '../module-execution-engine';
import { connectRpc, type RpcConnection } from '../worker-transport';

/** What one compiler worker serves. */
export interface RuntimeArtifactCompilerWorkerApi {
  translate(kind: RuntimeArtifactKind, source: string): RuntimeArtifactTranslation;
}

export interface RuntimeArtifactCompilerPool {
  translate(
    kind: RuntimeArtifactKind,
    source: string,
    priority: RuntimeArtifactTranslationPriority
  ): Promise<RuntimeArtifactTranslation>;
  dispose(): void;
}

type Job = Readonly<{
  kind: RuntimeArtifactKind;
  source: string;
  priority: RuntimeArtifactTranslationPriority;
  resolve(result: RuntimeArtifactTranslation): void;
}>;

type Slot = {
  readonly worker: Worker;
  readonly connection: RpcConnection<RuntimeArtifactCompilerWorkerApi>;
  idleTimer?: ReturnType<typeof setTimeout>;
};

/** A compiler worker that sits idle this long is terminated, releasing its compiler. */
const IDLE_WORKER_MS = 15_000;

/**
 * A bounded pool of compiler workers. Translations a context waits for run
 * before translations ahead of first use, and ahead-of-time work occupies at
 * most one worker so that it never delays a waiting context by more than one
 * file. Workers start when there is work and stop when there has been none.
 */
export function createRuntimeArtifactCompilerPool(options: {
  readonly createWorker: () => Worker;
  readonly size: number;
}): RuntimeArtifactCompilerPool {
  const size = Math.max(1, Math.floor(options.size));
  const demand: Job[] = [];
  const ahead: Job[] = [];
  const idle: Slot[] = [];
  const slots = new Set<Slot>();
  let aheadRunning = 0;
  let disposed = false;

  const discard = (slot: Slot): void => {
    if (slot.idleTimer !== undefined) clearTimeout(slot.idleTimer);
    slots.delete(slot);
    const index = idle.indexOf(slot);
    if (index !== -1) idle.splice(index, 1);
    slot.connection.close();
    slot.worker.terminate();
  };

  const spawn = (): Slot => {
    const worker = options.createWorker();
    const slot: Slot = { worker, connection: connectRpc<RuntimeArtifactCompilerWorkerApi>(worker, {}) };
    // A worker that fails to load or crashes closes its connection, which
    // fails the translation it was running; the pool replaces it on demand.
    worker.addEventListener('error', (event) => {
      event.preventDefault();
      discard(slot);
    });
    slots.add(slot);
    return slot;
  };

  const release = (slot: Slot): void => {
    if (disposed || !slots.has(slot)) return;
    idle.push(slot);
    slot.idleTimer = setTimeout(() => discard(slot), IDLE_WORKER_MS);
  };

  const run = (slot: Slot, job: Job): void => {
    if (slot.idleTimer !== undefined) clearTimeout(slot.idleTimer);
    slot.idleTimer = undefined;
    if (job.priority === 'ahead') aheadRunning += 1;
    slot.connection.remote.translate(job.kind, job.source).then(
      (result) => {
        job.resolve(result);
        release(slot);
      },
      (error: unknown) => {
        job.resolve({ status: 'failed', error: runtimeArtifactCompileFailure(error) });
        discard(slot);
      }
    ).finally(() => {
      if (job.priority === 'ahead') aheadRunning -= 1;
      pump();
    });
  };

  const pump = (): void => {
    while (!disposed) {
      const queue = demand.length > 0 ? demand : aheadRunning === 0 && ahead.length > 0 ? ahead : undefined;
      if (!queue) return;
      const slot = idle.pop() ?? (slots.size < size ? spawn() : undefined);
      if (!slot) return;
      run(slot, queue.shift()!);
    }
  };

  return {
    translate(kind, source, priority) {
      if (disposed) {
        return Promise.resolve({
          status: 'failed',
          error: { name: 'Error', message: 'The Runtime Host compiler pool is closed.' }
        });
      }
      return new Promise((resolve) => {
        (priority === 'demand' ? demand : ahead).push({ kind, source, priority, resolve });
        pump();
      });
    },
    dispose() {
      disposed = true;
      for (const slot of [...slots]) discard(slot);
      for (const job of [...demand.splice(0), ...ahead.splice(0)]) {
        job.resolve({ status: 'failed', error: { name: 'Error', message: 'The Runtime Host compiler pool is closed.' } });
      }
    }
  };
}
