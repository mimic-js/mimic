import { RuntimeAsyncTaskRejection } from '../runtime-artifact';

const nativeThen = Promise.prototype.then;
const ignore = (): void => undefined;

/**
 * Liveness tracking shared by CommonJS and ESM evaluation. Only native
 * promises are tracked, and they are observed through the intrinsic `then`, so
 * a program's own thenables (a query builder exported as `module.exports`, for
 * example) are never invoked.
 */
export class RuntimeAsyncTasks {
  private readonly pending = new Set<Promise<unknown>>();

  /** Tracks `value` when it is a native promise and returns it unchanged. */
  track<Value>(value: Value): Value {
    if (!(value instanceof Promise)) return value;
    let resolve!: (result: unknown) => void;
    let reject!: (reason: unknown) => void;
    const settled = new Promise<unknown>((fulfill, fail) => {
      resolve = fulfill;
      reject = fail;
    });
    try {
      // The intrinsic rejects a non-promise receiver before running any program code.
      nativeThen.call(value, resolve, reject);
    } catch {
      return value;
    }
    this.pending.add(settled);
    // A rejected task stays pending until a drain reports it.
    nativeThen.call(settled, () => this.pending.delete(settled), () => undefined);
    return value;
  }

  /**
   * Keeps evaluation alive until `promise` settles without reporting its
   * rejection, which belongs to whoever awaits it: an import the program
   * catches is not an unhandled task.
   */
  settle<Value>(promise: Promise<Value>): Promise<Value> {
    this.track(nativeThen.call(promise, ignore, ignore));
    return promise;
  }

  get size(): number {
    return this.pending.size;
  }

  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      const tasks = [...this.pending];
      try {
        await Promise.all(tasks);
      } catch (error) {
        throw new RuntimeAsyncTaskRejection(error);
      } finally {
        for (const task of tasks) this.pending.delete(task);
      }
    }
  }
}
