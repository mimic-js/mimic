export function createTimersBuiltin(runtimeGlobal: typeof globalThis): unknown {
  const setImmediate: unknown = Reflect.get(runtimeGlobal, 'setImmediate');
  const clearImmediate: unknown = Reflect.get(runtimeGlobal, 'clearImmediate');
  if (typeof setImmediate !== 'function' || typeof clearImmediate !== 'function') {
    throw new TypeError('Node timers require setImmediate and clearImmediate globals');
  }
  const timers = {
    setTimeout: runtimeGlobal.setTimeout,
    clearTimeout: runtimeGlobal.clearTimeout,
    setInterval: runtimeGlobal.setInterval,
    clearInterval: runtimeGlobal.clearInterval,
    setImmediate,
    clearImmediate
  };
  return { ...timers, default: timers };
}

export function createTimersPromisesBuiltin(runtimeGlobal: typeof globalThis): unknown {
  const scheduleImmediate = Reflect.get(runtimeGlobal, 'setImmediate') as (callback: () => void) => unknown;
  const cancelImmediate = Reflect.get(runtimeGlobal, 'clearImmediate') as (handle: unknown) => void;
  if (typeof scheduleImmediate !== 'function' || typeof cancelImmediate !== 'function') {
    throw new TypeError('Node timers require setImmediate and clearImmediate globals');
  }
  type TimerOptions = Readonly<{ signal?: AbortSignal; ref?: boolean }>;
  const abortError = (signal: AbortSignal) =>
    Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
      code: 'ABORT_ERR',
      cause: signal.reason
    });
  const schedule = <T>(kind: 'timeout' | 'immediate', delay: number, value: T, options: TimerOptions = {}) =>
    new Promise<T>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(abortError(options.signal));
        return;
      }
      const complete = () => {
        options.signal?.removeEventListener('abort', abort);
        resolve(value);
      };
      const cancel =
        kind === 'immediate'
          ? cancelImmediate.bind(undefined, scheduleImmediate(complete))
          : runtimeGlobal.clearTimeout.bind(
              undefined,
              runtimeGlobal.setTimeout(complete, Math.max(0, Number(delay) || 0))
            );
      const abort = () => {
        cancel();
        reject(abortError(options.signal!));
      };
      options.signal?.addEventListener('abort', abort, { once: true });
    });
  const setTimeout = <T = void>(delay = 1, value?: T, options?: TimerOptions) => schedule('timeout', delay, value as T, options);
  const setImmediate = <T = void>(value?: T, options?: TimerOptions) => schedule('immediate', 0, value as T, options);
  const setInterval = async function* <T = void>(delay = 1, value?: T, options?: TimerOptions) {
    while (true) {
      await setTimeout(delay, undefined, options);
      yield value as T;
    }
  };
  const scheduler = {
    wait: (delay: number, options?: TimerOptions) => setTimeout(delay, undefined, options),
    yield: () => setImmediate()
  };
  const timers = { setTimeout, setImmediate, setInterval, scheduler };
  return { ...timers, default: timers };
}
