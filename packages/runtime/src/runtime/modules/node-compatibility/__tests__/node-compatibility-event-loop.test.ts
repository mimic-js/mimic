import { describe, expect, test, vi } from 'vitest';

import { createNodeEventLoop, type NodeEventLoopOptions } from '../event-loop';

function createLoop(overrides: Partial<NodeEventLoopOptions> = {}) {
  const uncaught: unknown[] = [];
  const macrotasks: Array<() => void> = [];
  const loop = createNodeEventLoop({
    queueMacrotask: (callback) => {
      let cancelled = false;
      macrotasks.push(() => {
        if (!cancelled) callback();
      });
      return () => {
        cancelled = true;
      };
    },
    onUncaughtException: (error) => uncaught.push(error),
    onUnhandledRejection: (reason) => uncaught.push(reason),
    isExitSignal: () => false,
    ...overrides
  });
  return {
    loop,
    uncaught,
    macrotasks,
    runMacrotasks: () => {
      for (const task of macrotasks.splice(0)) task();
    }
  };
}

describe('Node event loop', () => {
  test('counts referenced timers and immediates without scanning them', async () => {
    const { loop, runMacrotasks } = createLoop();
    expect(loop.hasReferencedTasks()).toBe(false);

    const timer = loop.setTimeout(() => undefined, 60_000) as unknown as {
      ref(): unknown;
      unref(): unknown;
      hasRef(): boolean;
    };
    const immediate = loop.setImmediate(() => undefined);
    expect(loop.hasReferencedTasks()).toBe(true);

    let idle = false;
    void loop.waitForIdle().then(() => {
      idle = true;
    });
    timer.unref();
    timer.unref();
    expect(timer.hasRef()).toBe(false);
    expect(loop.hasReferencedTasks()).toBe(true);

    immediate.unref();
    expect(loop.hasReferencedTasks()).toBe(false);
    await Promise.resolve();
    expect(idle).toBe(true);

    timer.ref();
    immediate.ref();
    expect(loop.hasReferencedTasks()).toBe(true);
    loop.clearTimeout(timer as never);
    runMacrotasks();
    expect(loop.hasReferencedTasks()).toBe(false);
    loop.cancel();
  });

  test('clears a timer by the number its handle coerces to and refreshes one from its callback', () => {
    vi.useFakeTimers();
    try {
      const { loop } = createLoop();
      const fired: string[] = [];
      const cleared = loop.setTimeout(() => fired.push('cleared'), 10);
      loop.clearTimeout(Number(cleared));

      let runs = 0;
      const refreshed = loop.setTimeout(() => {
        fired.push('refreshed');
        if (++runs < 2) (refreshed as unknown as { refresh(): void }).refresh();
      }, 10);
      const interval = loop.setInterval(() => fired.push('interval'), 25);

      vi.advanceTimersByTime(30);
      expect(fired).toEqual(['refreshed', 'refreshed', 'interval']);
      expect(loop.hasReferencedTasks()).toBe(true);
      loop.clearInterval(interval);
      expect(loop.hasReferencedTasks()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test('runs immediates in order, skips cleared ones, and drains ticks between them', async () => {
    const { loop, runMacrotasks } = createLoop();
    const order: string[] = [];

    loop.setImmediate((value) => {
      order.push(`first:${String(value)}`);
      loop.nextTick(() => order.push('tick'));
      void Promise.resolve().then(() => order.push('promise'));
    }, 'argument');
    const cleared = loop.setImmediate(() => order.push('cleared'));
    loop.setImmediate(() => order.push('second'));
    loop.clearImmediate(cleared);

    runMacrotasks();
    await Promise.resolve();
    expect(order).toEqual(['first:argument', 'tick', 'second', 'promise']);
    expect(loop.hasReferencedTasks()).toBe(false);
  });

  test('a turn drains ticks before promise jobs, and ticks outside a turn ride the microtask queue', async () => {
    const { loop } = createLoop();
    const order: string[] = [];

    loop.runTurn(() => {
      void Promise.resolve().then(() => order.push('promise'));
      loop.nextTick((value) => order.push(`tick:${String(value)}`), 1);
      order.push('body');
    });
    expect(order).toEqual(['body', 'tick:1']);
    await Promise.resolve();
    expect(order).toEqual(['body', 'tick:1', 'promise']);

    loop.nextTick(() => order.push('later'));
    expect(order).not.toContain('later');
    await Promise.resolve();
    expect(order.at(-1)).toBe('later');
  });

  test('reports callback failures and rejected results, and lets an exit signal pass silently', async () => {
    const exit = new Error('exit');
    const { loop, uncaught, runMacrotasks } = createLoop({ isExitSignal: (error) => error === exit });
    const failure = new Error('failure');
    const rejection = new Error('rejection');

    loop.setImmediate(() => {
      throw failure;
    });
    loop.setImmediate(() => {
      throw exit;
    });
    loop.setImmediate(() => Promise.reject(rejection));
    loop.nextTick(() => {
      throw failure;
    });
    runMacrotasks();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(uncaught).toEqual([failure, failure, rejection]);
    expect(() => loop.nextTick('not a function' as never)).toThrow(/must be of type function/);
  });

  test('cancelling drops pending work and releases every idle waiter', async () => {
    const { loop, runMacrotasks } = createLoop();
    const ran: string[] = [];
    loop.setTimeout(() => ran.push('timeout'), 0);
    loop.setImmediate(() => ran.push('immediate'));
    loop.nextTick(() => ran.push('tick'));
    const release = loop.acquireReferencedActivity();
    const idle = loop.waitForIdle();

    loop.cancel();
    await idle;
    runMacrotasks();
    release();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(ran).toEqual([]);
    expect(loop.hasReferencedTasks()).toBe(false);
    expect(loop.setTimeout(() => undefined, 0)).toBe(-1);
    expect(loop.setImmediate(() => ran.push('late')).hasRef()).toBe(true);
    runMacrotasks();
    expect(ran).toEqual([]);
  });
});
