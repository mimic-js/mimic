import { asyncContext, type AsyncContextFrame } from '../module-execution-engine';

type AsyncResourceOptions = number | {
  triggerAsyncId?: number;
  requireManualDestroy?: boolean;
};

interface BrowserAsyncResource {
  readonly type: string;
  runInAsyncScope<TResult, TArgs extends unknown[]>(
    callback: (...args: TArgs) => TResult,
    thisArg: unknown,
    ...args: TArgs
  ): TResult;
  bind<TThis, TArgs extends unknown[], TResult>(
    callback: (this: TThis, ...args: TArgs) => TResult,
    thisArg?: TThis
  ): (this: TThis, ...args: TArgs) => TResult;
  emitDestroy(): this;
  asyncId(): number;
  triggerAsyncId(): number;
}

interface BrowserAsyncResourceConstructor {
  new(type: string, options?: AsyncResourceOptions): BrowserAsyncResource;
  bind<TThis, TArgs extends unknown[], TResult>(
    callback: (this: TThis, ...args: TArgs) => TResult,
    type?: string,
    thisArg?: TThis
  ): (this: TThis, ...args: TArgs) => TResult;
}

interface BrowserAsyncLocalStorage<TStore> {
  readonly name: string;
  disable(): void;
  enterWith(store: TStore): void;
  getStore(): TStore | undefined;
  run<TResult, TArgs extends unknown[]>(
    store: TStore,
    callback: (...args: TArgs) => TResult,
    ...args: TArgs
  ): TResult;
  exit<TResult, TArgs extends unknown[]>(
    callback: (...args: TArgs) => TResult,
    ...args: TArgs
  ): TResult;
}

interface BrowserAsyncLocalStorageConstructor {
  new<TStore = unknown>(options?: { defaultValue?: TStore; name?: string }): BrowserAsyncLocalStorage<TStore>;
  bind<TCallback extends (...args: never[]) => unknown>(callback: TCallback): TCallback;
  snapshot(): <TResult, TArgs extends unknown[]>(
    callback: (...args: TArgs) => TResult,
    ...args: TArgs
  ) => TResult;
}

interface AsyncHooksBuiltinNamespace {
  AsyncLocalStorage: BrowserAsyncLocalStorageConstructor;
  AsyncResource: BrowserAsyncResourceConstructor;
  /**
   * Lifecycle hooks need promise hooks the browser does not expose: the hook
   * enables and disables, and its callbacks are never called.
   */
  createHook(callbacks?: object): AsyncHook;
  executionAsyncId(): number;
  executionAsyncResource(): object;
  triggerAsyncId(): number;
}

type AsyncHook = {
  enable(): AsyncHook;
  disable(): AsyncHook;
};

type AsyncHooksBuiltin = AsyncHooksBuiltinNamespace & {
  default: AsyncHooksBuiltinNamespace;
};

export function createAsyncHooksBuiltin(): AsyncHooksBuiltin {
  // Node's main script runs as asyncId 1, triggered by 0.
  let nextAsyncId = 2;
  let executing: AsyncResource | undefined;

  class AsyncResource {
    private readonly id = nextAsyncId++;
    private readonly trigger: number;
    private readonly frame = asyncContext.frame();

    constructor(
      readonly type: string,
      options: AsyncResourceOptions = {}
    ) {
      if (typeof type !== 'string') throw new TypeError('The "type" argument must be of type string');
      this.trigger =
        (typeof options === 'number' ? options : options.triggerAsyncId) ?? executionAsyncId();
    }

    runInAsyncScope<TResult, TArgs extends unknown[]>(
      callback: (...args: TArgs) => TResult,
      thisArg: unknown,
      ...args: TArgs
    ): TResult {
      const previous = executing;
      executing = this;
      try {
        return asyncContext.run(this.frame, () => callback.apply(thisArg, args));
      } finally {
        executing = previous;
      }
    }

    bind<TThis, TArgs extends unknown[], TResult>(
      callback: (this: TThis, ...args: TArgs) => TResult,
      thisArg?: TThis
    ): (this: TThis, ...args: TArgs) => TResult {
      const resource = this;
      return function (this: TThis, ...args: TArgs) {
        return resource.runInAsyncScope(callback, thisArg ?? this, ...args);
      };
    }

    emitDestroy(): this {
      return this;
    }

    asyncId(): number {
      return this.id;
    }

    triggerAsyncId(): number {
      return this.trigger;
    }

    static bind<TThis, TArgs extends unknown[], TResult>(
      callback: (this: TThis, ...args: TArgs) => TResult,
      type = callback.name || 'bound-anonymous-fn',
      thisArg?: TThis
    ) {
      return new AsyncResource(type).bind(callback, thisArg);
    }
  }

  // Resource identity follows `runInAsyncScope` only: without promise hooks no
  // other continuation has an id of its own, so those report the main script's.
  const executionAsyncId = (): number => executing?.asyncId() ?? 1;

  class AsyncLocalStorage<TStore = unknown> {
    readonly name: string;
    private readonly defaultValue: TStore | undefined;
    private enabled = true;

    constructor(options: { defaultValue?: TStore; name?: string } = {}) {
      this.defaultValue = options.defaultValue;
      this.name = options.name ?? '';
    }

    static bind<TCallback extends (...args: never[]) => unknown>(callback: TCallback): TCallback {
      return asyncContext.bind(callback);
    }

    static snapshot(): <TResult, TArgs extends unknown[]>(
      callback: (...args: TArgs) => TResult,
      ...args: TArgs
    ) => TResult {
      const frame = asyncContext.frame();
      return (callback, ...args) => asyncContext.run(frame, () => callback(...args));
    }

    disable(): void {
      this.enabled = false;
    }

    enterWith(store: TStore): void {
      this.enabled = true;
      asyncContext.enter(this.frameWith(store));
    }

    getStore(): TStore | undefined {
      if (!this.enabled) return undefined;
      const frame = asyncContext.frame();
      return frame?.has(this) ? (frame.get(this) as TStore) : this.defaultValue;
    }

    run<TResult, TArgs extends unknown[]>(store: TStore, callback: (...args: TArgs) => TResult, ...args: TArgs): TResult {
      this.enabled = true;
      return asyncContext.run(this.frameWith(store), () => callback(...args));
    }

    exit<TResult, TArgs extends unknown[]>(callback: (...args: TArgs) => TResult, ...args: TArgs): TResult {
      const frame = asyncContext.frame();
      if (!frame?.has(this)) return callback(...args);
      const outside = new Map(frame);
      outside.delete(this);
      return asyncContext.run(outside.size > 0 ? outside : undefined, () => callback(...args));
    }

    private frameWith(store: TStore): AsyncContextFrame {
      return new Map(asyncContext.frame()).set(this, store);
    }
  }

  const asyncHooks: AsyncHooksBuiltinNamespace = {
    AsyncLocalStorage,
    AsyncResource,
    // React's server renderer enables one to collect debug information; it
    // renders the same without the events.
    createHook: () => {
      const hook: AsyncHook = {
        enable: () => hook,
        disable: () => hook
      };
      return hook;
    },
    executionAsyncId,
    executionAsyncResource: () => executing ?? {},
    triggerAsyncId: () => executing?.triggerAsyncId() ?? 0
  };

  return {
    ...asyncHooks,
    default: asyncHooks
  };
}

