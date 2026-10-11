import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './stack-scenario';

const mainThreadResponsivenessClaim = defineCompatibilityClaim({
  id: 'main-thread-responsive-package-installation-v1',
  statement:
    'Mimic keeps the embedding page main thread free of long tasks while npm installs a tracked graph',
  target: {
    kind: 'runtime-capability',
    capability: 'main-thread-responsive-package-installation'
  }
});

test.use({ fixture: 'vanilla-vite-6.4.3' });

// The page's main thread holds only the public facade, Service Worker
// registration and the iframe bridge: the Shell Program, the core utilities
// and the Package Manager Command Proxies, with their tarball fetching,
// extraction and hashing, run in the Runtime Host Worker and its process
// workers. A main-thread task delays every timer queued behind it, so the
// latest a 16 ms heartbeat fires is the longest task the page ran. Headless
// Chromium reports no Long Tasks API entries, so the heartbeat is the
// measurement. While npm installs, no task may exceed this bound; before the
// programs left the main thread, this install stalled the page for more than a
// second.
const LONG_TASK_BOUND_MS = 100;
const HEARTBEAT_INTERVAL_MS = 16;

test(mainThreadResponsivenessClaim.statement, async ({ stack }) => {
  await stack.page.evaluate((interval) => {
    const beat = { ticks: 0, longestTaskMs: 0, timer: 0 };
    let expected = performance.now() + interval;
    beat.timer = window.setInterval(() => {
      const now = performance.now();
      beat.longestTaskMs = Math.max(beat.longestTaskMs, now - expected);
      expected = now + interval;
      beat.ticks += 1;
    }, interval);
    Reflect.set(window, '__mainThreadBeat', beat);
  }, HEARTBEAT_INTERVAL_MS);

  await stack.install('npm ci', { layer: false });

  const beat = await stack.page.evaluate(() => {
    const recorded = Reflect.get(window, '__mainThreadBeat') as { ticks: number; longestTaskMs: number; timer: number };
    clearInterval(recorded.timer);
    return { ticks: recorded.ticks, longestTaskMs: Math.round(recorded.longestTaskMs) };
  });
  expect(await stack.exists('node_modules/vite/package.json')).toBe(true);
  expect(beat.ticks).toBeGreaterThan(0);
  expect(beat.longestTaskMs).toBeLessThanOrEqual(LONG_TASK_BOUND_MS);
});
