import { expect, test } from 'vitest';

import { queueMacrotask } from '../../src/runtime/modules/worker-transport/index';

test('macrotasks run in order as separate tasks, after pending microtasks, and can be cancelled', async () => {
  const order: string[] = [];
  await new Promise<void>((resolve) => {
    queueMacrotask(() => {
      order.push('first');
      void Promise.resolve().then(() => order.push('microtask of first'));
    });
    const cancel = queueMacrotask(() => order.push('cancelled'));
    queueMacrotask(() => {
      order.push('second');
      resolve();
    });
    cancel();
    void Promise.resolve().then(() => order.push('microtask'));
    order.push('synchronous');
  });

  expect(order).toEqual(['synchronous', 'microtask', 'first', 'microtask of first', 'second']);
});

test('a thousand chained macrotasks are not held to a timer floor', async () => {
  const started = performance.now();
  await new Promise<void>((resolve) => {
    let remaining = 1000;
    const next = () => {
      if (--remaining === 0) resolve();
      else queueMacrotask(next);
    };
    queueMacrotask(next);
  });

  // A 1 ms timer floor, which is what Node applies, would take over a second.
  expect(performance.now() - started).toBeLessThan(250);
});
