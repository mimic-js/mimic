import { asyncContext, type AsyncContextFrame } from '../module-execution-engine';

type Callback = (...args: unknown[]) => unknown;
type HostTimer = ReturnType<typeof globalThis.setTimeout>;

export interface NodeEventLoopOptions {
  /** Queues an unclamped macrotask and returns its cancellation. */
  queueMacrotask(callback: () => void): () => void;
  onUncaughtException(error: unknown): void;
  onUnhandledRejection(reason: unknown, promise: Promise<unknown>): void;
  /** True for the error `process.exit()` throws to unwind the running callback. */
  isExitSignal(error: unknown): boolean;
}

export interface NodeTimerHandle {
  ref(): this;
  unref(): this;
  hasRef(): boolean;
  refresh(): this;
  close(): this;
  [Symbol.toPrimitive](): number;
}

export interface NodeImmediateHandle {
  ref(): this;
  unref(): this;
  hasRef(): boolean;
}

export interface NodeEventLoop {
  readonly setTimeout: typeof globalThis.setTimeout;
  readonly clearTimeout: typeof globalThis.clearTimeout;
  readonly setInterval: typeof globalThis.setInterval;
  readonly clearInterval: typeof globalThis.clearInterval;
  readonly setImmediate: (callback: Callback, ...args: unknown[]) => NodeImmediateHandle;
  readonly clearImmediate: (handle: unknown) => void;
  readonly queueMicrotask: typeof globalThis.queueMicrotask;
  readonly nextTick: (callback: Callback, ...args: unknown[]) => void;
  /**
   * Runs `task` as one turn of the loop: the nextTick queue drains when it
   * returns, before any promise job the task left behind.
   */
  runTurn<T>(task: () => T): T;
  trackPromise<T>(promise: Promise<T>): Promise<T>;
  acquireReferencedActivity(): () => void;
  hasReferencedTasks(): boolean;
  waitForIdle(): Promise<void>;
  cancel(): void;
}

/**
 * The timers, immediates, and nextTick queue of one Node process, with the
 * count of referenced work that keeps that process alive. Every callback runs
 * in the Async Context frame that scheduled it.
 */
export function createNodeEventLoop(handlers: NodeEventLoopOptions): NodeEventLoop {
  let active = true;
  let referenced = 0;
  let turnDepth = 0;
  let tickDrainQueued = false;
  let nextTimerId = 1;
  const ticks: Array<{ callback: Callback; args: unknown[]; frame: AsyncContextFrame | undefined }> = [];
  const timers = new Map<number, Timer>();
  const immediates = new Set<Immediate>();
  const idleWaiters = new Set<() => void>();

  const notifyIdle = () => {
    if (referenced > 0 || idleWaiters.size === 0) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };
  const hold = () => {
    if (active) referenced += 1;
  };
  const release = () => {
    referenced = Math.max(0, referenced - 1);
    notifyIdle();
  };

  const invoke = (callback: Callback, args: unknown[], frame: AsyncContextFrame | undefined) => {
    try {
      const result = asyncContext.run(frame, () => callback(...args));
      if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result) {
        const promise = Promise.resolve(result);
        void promise.catch((reason: unknown) => handlers.onUnhandledRejection(reason, promise));
      }
    } catch (error) {
      if (!handlers.isExitSignal(error)) handlers.onUncaughtException(error);
    }
  };
  const drainTicks = () => {
    if (turnDepth > 0) return;
    turnDepth += 1;
    try {
      // Ticks queued by a tick run in the same drain, so none waits behind a promise job.
      for (let tick = ticks.shift(); tick; tick = ticks.shift()) {
        if (active) invoke(tick.callback, tick.args, tick.frame);
      }
    } finally {
      turnDepth -= 1;
    }
  };
  const runTurn = <T>(task: () => T): T => {
    turnDepth += 1;
    let result: T;
    try {
      result = task();
    } finally {
      turnDepth -= 1;
    }
    drainTicks();
    return result;
  };
  const runCallback = (callback: Callback, args: unknown[], frame: AsyncContextFrame | undefined) => {
    runTurn(() => invoke(callback, args, frame));
  };

  class Timer implements NodeTimerHandle {
    readonly id = nextTimerId++;
    private native: HostTimer | undefined;
    private referenced = true;
    private readonly frame = asyncContext.frame();
    active = true;

    constructor(
      private readonly callback: Callback,
      private readonly args: unknown[],
      private readonly delay: number | undefined,
      private readonly repeat: boolean
    ) {
      hold();
      timers.set(this.id, this);
      this.schedule();
    }

    ref(): this {
      if (!this.referenced && this.active) hold();
      this.referenced = true;
      return this;
    }

    unref(): this {
      if (this.referenced && this.active) release();
      this.referenced = false;
      return this;
    }

    hasRef(): boolean {
      return this.referenced;
    }

    refresh(): this {
      if (this.active) {
        this.clearNative();
        this.schedule();
      }
      return this;
    }

    close(): this {
      if (!this.active) return this;
      this.active = false;
      timers.delete(this.id);
      this.clearNative();
      if (this.referenced) release();
      return this;
    }

    /** Stops the host timer without touching the reference count, for loop cancellation. */
    discard(): void {
      this.active = false;
      this.clearNative();
    }

    [Symbol.toPrimitive](): number {
      return this.id;
    }

    private schedule(): void {
      this.native = this.repeat
        ? globalThis.setInterval(() => runCallback(this.callback, this.args, this.frame), this.delay)
        : globalThis.setTimeout(() => {
            this.native = undefined;
            // The callback may refresh the timer, so it stays registered while it runs.
            runCallback(this.callback, this.args, this.frame);
            if (this.native === undefined) this.close();
          }, this.delay);
    }

    private clearNative(): void {
      if (this.native === undefined) return;
      if (this.repeat) globalThis.clearInterval(this.native);
      else globalThis.clearTimeout(this.native);
      this.native = undefined;
    }
  }

  class Immediate implements NodeImmediateHandle {
    private referenced = true;
    private cancel: (() => void) | undefined;
    active = true;

    constructor(callback: Callback, args: unknown[]) {
      if (!active) {
        this.active = false;
        return;
      }
      hold();
      immediates.add(this);
      const frame = asyncContext.frame();
      this.cancel = handlers.queueMacrotask(() => {
        this.cancel = undefined;
        if (!this.active) return;
        this.settle();
        runCallback(callback, args, frame);
      });
    }

    ref(): this {
      if (!this.referenced && this.active) hold();
      this.referenced = true;
      return this;
    }

    unref(): this {
      if (this.referenced && this.active) release();
      this.referenced = false;
      return this;
    }

    hasRef(): boolean {
      return this.referenced;
    }

    close(): void {
      if (!this.active) return;
      this.cancel?.();
      this.cancel = undefined;
      this.settle();
    }

    discard(): void {
      this.active = false;
      this.cancel?.();
      this.cancel = undefined;
    }

    private settle(): void {
      this.active = false;
      immediates.delete(this);
      if (this.referenced) release();
    }
  }

  const requireCallback = (callback: unknown): Callback => {
    if (typeof callback !== 'function') {
      throw Object.assign(
        new TypeError('The "callback" argument must be of type function.'),
        { code: 'ERR_INVALID_ARG_TYPE' }
      );
    }
    return callback as Callback;
  };
  const closeTimer = (handle: unknown, clearHost: (native: HostTimer) => void) => {
    if (handle instanceof Timer) {
      handle.close();
      return;
    }
    // A numeric id is how code that coerced the handle refers back to it.
    if (typeof handle === 'number' || typeof handle === 'string') {
      timers.get(Number(handle))?.close();
      return;
    }
    // A host timer object did not come from this loop; its own id space is the host's.
    if (handle !== null && typeof handle === 'object') clearHost(handle as unknown as HostTimer);
  };

  return {
    setTimeout: ((callback: Callback, delay?: number, ...args: unknown[]) => {
      if (!active) return -1;
      return new Timer(requireCallback(callback), args, delay, false);
    }) as unknown as typeof globalThis.setTimeout,
    clearTimeout: ((handle: unknown) => closeTimer(handle, globalThis.clearTimeout)) as typeof globalThis.clearTimeout,
    setInterval: ((callback: Callback, delay?: number, ...args: unknown[]) => {
      if (!active) return -1;
      return new Timer(requireCallback(callback), args, delay, true);
    }) as unknown as typeof globalThis.setInterval,
    clearInterval: ((handle: unknown) => closeTimer(handle, globalThis.clearInterval)) as typeof globalThis.clearInterval,
    setImmediate: (callback, ...args) => new Immediate(requireCallback(callback), args),
    clearImmediate: (handle) => {
      if (handle instanceof Immediate) handle.close();
    },
    queueMicrotask: (callback) => {
      requireCallback(callback);
      const frame = asyncContext.frame();
      // A tick queued by a microtask waits for the microtask queue, so this is not a turn.
      globalThis.queueMicrotask(() => {
        if (active) invoke(callback, [], frame);
      });
    },
    nextTick: (callback, ...args) => {
      ticks.push({ callback: requireCallback(callback), args, frame: asyncContext.frame() });
      if (tickDrainQueued) return;
      tickDrainQueued = true;
      // Outside a turn there is no boundary to drain at, so the queue rides the next microtask.
      globalThis.queueMicrotask(() => {
        tickDrainQueued = false;
        drainTicks();
      });
    },
    runTurn,
    trackPromise: (promise) => {
      hold();
      return promise.finally(release);
    },
    acquireReferencedActivity: () => {
      if (!active) return () => undefined;
      hold();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        release();
      };
    },
    hasReferencedTasks: () => referenced > 0,
    waitForIdle: () =>
      referenced === 0 ? Promise.resolve() : new Promise<void>((resolve) => idleWaiters.add(resolve)),
    cancel: () => {
      if (!active) return;
      active = false;
      for (const timer of timers.values()) timer.discard();
      timers.clear();
      for (const immediate of immediates) immediate.discard();
      immediates.clear();
      ticks.length = 0;
      referenced = 0;
      notifyIdle();
    }
  };
}
