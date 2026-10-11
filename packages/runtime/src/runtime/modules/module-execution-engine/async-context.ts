/**
 * Async Context: the frame of `AsyncLocalStorage` stores that belongs to the
 * asynchronous continuation currently running in this JavaScript realm.
 *
 * A browser has no promise hooks, so the frame is carried explicitly:
 *
 * - compiled modules route every `await` and `for await` through
 *   `awaitValue`/`forAwait` (a compile-time rewrite owned by the Runtime
 *   Artifact Compiler);
 * - `Promise.prototype.then` binds its reactions to the frame that registered
 *   them, installed the first time a frame is entered;
 * - scheduling entry points (timers, immediates, `nextTick`, `queueMicrotask`)
 *   capture `frame()` and deliver through `run`.
 *
 * Every job that none of these instrument starts with no frame, so a store is
 * never observed by a continuation that did not descend from its `run`. Source
 * evaluated dynamically, which the compiler does not see, therefore loses the
 * frame at its first `await` instead of inheriting another continuation's.
 */
export type AsyncContextFrame = ReadonlyMap<object, unknown>;

type Reaction = (value: unknown) => unknown;

const NativePromise = Promise;
const nativeThen = Promise.prototype.then;
const nativeQueueMicrotask = globalThis.queueMicrotask.bind(globalThis);

let current: AsyncContextFrame | undefined;
let thenInstalled = false;
let leaveQueued = false;

const leave = (): void => {
  current = undefined;
};

function run<Result>(frame: AsyncContextFrame | undefined, task: () => Result): Result {
  const previous = current;
  if (frame !== undefined) installThen();
  current = frame;
  try {
    return task();
  } finally {
    current = previous;
  }
}

/**
 * Replaces the frame for the rest of the running job. The frame is left at the
 * next job boundary; continuations the job starts have captured it by then.
 */
function enter(frame: AsyncContextFrame | undefined): void {
  if (frame !== undefined) installThen();
  current = frame;
  if (leaveQueued) return;
  leaveQueued = true;
  nativeQueueMicrotask(() => {
    leaveQueued = false;
    leave();
  });
}

function bind<Callback extends (...args: never[]) => unknown>(
  callback: Callback,
  frame: AsyncContextFrame | undefined = current
): Callback {
  return function (this: unknown, ...args: never[]) {
    return run(frame, () => callback.apply(this, args));
  } as Callback;
}

/**
 * The operand of a compiled `await`. Outside a frame it is returned untouched.
 * Inside one it is forwarded into a native promise that only this `await`
 * holds and that is still pending once the `await` has registered its
 * continuation. Around that continuation the promise carries two reactions:
 * the first re-enters the frame, the last leaves it. The reactions of a pending
 * promise run as consecutive jobs in registration order, so the continuation
 * resumes in its frame and no other job inherits it. The forwarding resumes the
 * continuation one tick later than the uncompiled `await` would.
 */
function awaitValue(value: unknown): unknown {
  const frame = current;
  if (frame === undefined) return value;
  let forwarded: Promise<unknown>;
  // Queued before the forwarding job, so it runs after the `await` has
  // registered its continuation and before the forwarded promise settles.
  nativeQueueMicrotask(() => {
    nativeThen.call(forwarded, leave, leave);
  });
  forwarded = nativeThen.call(NativePromise.resolve(value));
  const enterFrame = (): void => {
    current = frame;
  };
  nativeThen.call(forwarded, enterFrame, enterFrame);
  return forwarded;
}

/** The iterable of a compiled `for await`: each step resumes the loop body in the frame that requested it. */
function forAwait(iterable: unknown): unknown {
  if (current === undefined) return iterable;
  return {
    [Symbol.asyncIterator]() {
      const iterator = openAsyncIterator(iterable);
      const close = iterator.return;
      return {
        next: () => awaitValue(iterator.next()),
        return: typeof close === 'function'
          ? (value?: unknown) => awaitValue(close.call(iterator, value))
          : undefined
      };
    }
  };
}

type LooseIterator = {
  next(): unknown;
  return?: (value?: unknown) => unknown;
};

function openAsyncIterator(iterable: unknown): LooseIterator {
  const source = iterable as {
    [Symbol.asyncIterator]?: () => LooseIterator;
    [Symbol.iterator]?: () => Iterator<unknown>;
  };
  const asyncMethod = source?.[Symbol.asyncIterator];
  if (asyncMethod !== undefined && asyncMethod !== null) return asyncMethod.call(source);
  const syncMethod = source?.[Symbol.iterator];
  if (typeof syncMethod !== 'function') throw new TypeError('object is not async iterable');
  // `for await` over a synchronous iterable awaits each value it yields.
  const iterator = syncMethod.call(source);
  const settle = (result: IteratorResult<unknown>): unknown =>
    nativeThen.call(NativePromise.resolve(result.value), (value) => ({ value, done: result.done }));
  const close = iterator.return;
  return {
    next: () => settle(iterator.next()),
    return: typeof close === 'function'
      ? (value?: unknown) => settle(close.call(iterator, value))
      : undefined
  };
}

function installThen(): void {
  if (thenInstalled) return;
  thenInstalled = true;
  const inFrame = (reaction: unknown, frame: AsyncContextFrame): unknown =>
    typeof reaction === 'function'
      ? (value: unknown) => run(frame, () => (reaction as Reaction)(value))
      : reaction;
  Object.defineProperty(NativePromise.prototype, 'then', {
    configurable: true,
    writable: true,
    value: function then(this: unknown, onFulfilled?: unknown, onRejected?: unknown): unknown {
      const frame = current;
      return frame === undefined
        ? nativeThen.call(this as Promise<unknown>, onFulfilled as Reaction, onRejected as Reaction)
        : nativeThen.call(
            this as Promise<unknown>,
            inFrame(onFulfilled, frame) as Reaction,
            inFrame(onRejected, frame) as Reaction
          );
    }
  });
}

export const asyncContext = {
  /** The frame of the running continuation, or undefined outside every `run`. */
  frame: (): AsyncContextFrame | undefined => current,
  run,
  enter,
  bind,
  awaitValue,
  forAwait
};
