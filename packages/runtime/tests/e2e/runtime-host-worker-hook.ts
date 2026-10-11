import type { Page } from '@playwright/test';

// Runtime Processes run in workers that the Runtime Host Worker creates, out of
// the page's reach, and the Runtime Host Worker itself is created by the
// Runtime Host document in a hidden frame (ADR-0033). A test that must observe
// or disturb one installs a hook: a module the Runtime Host Worker evaluates
// before its own entry, served in place of the worker's prebuilt script. The
// page talks to the hook through a BroadcastChannel of the page's origin,
// which the hook re-dispatches as `message` events on the worker's scope.

const RUNTIME_HOST_WORKER_SCRIPT = /\/runtime-host-worker\.js$/u;
const HOOK_CHANNEL = 'mimic:runtime-host-worker-hook';
const ORIGINAL_QUERY = 'original';

type RuntimeHostWorkerHookGlobal = typeof globalThis & {
  /** Resolves once the hook has handled the message, so a call the page makes next is ordered after it. */
  __postToMimicRuntimeHostWorker?: (message: unknown) => Promise<void>;
};

const ACK_TYPE = 'mimic:runtime-host-worker-hook-ack';

/**
 * Makes every Runtime Host Worker booted from now on evaluate `hookSource`
 * first. `hookSource` runs as a module in the Runtime Host Worker's scope.
 */
export async function installRuntimeHostWorkerHook(
  page: Page,
  hookSource: string
): Promise<void> {
  await disposeRuntimeHostWorkerHook(page);
  // A BroadcastChannel message is not ordered with the page's RPC calls over
  // the worker's port, so the hook acknowledges each one and the page waits.
  const prelude = [
    `const __hookChannel = new BroadcastChannel(${JSON.stringify(HOOK_CHANNEL)});`,
    "__hookChannel.addEventListener('message', (event) => {",
    `  if (event.data?.type === ${JSON.stringify(ACK_TYPE)}) return;`,
    "  self.dispatchEvent(new MessageEvent('message', { data: event.data.message }));",
    `  __hookChannel.postMessage({ type: ${JSON.stringify(ACK_TYPE)}, id: event.data.id });`,
    '});'
  ].join('\n');
  await serveRuntimeHostWorkerScript(page, (originalUrl) =>
    [
      `import ${JSON.stringify(moduleDataUrl(`${prelude}\n${hookSource}`))};`,
      `import ${JSON.stringify(originalUrl)};`
    ].join('\n')
  );
  await page.evaluate(({ channel, ackType }) => {
    let nextId = 0;
    (globalThis as RuntimeHostWorkerHookGlobal).__postToMimicRuntimeHostWorker = (message) => {
      const id = ++nextId;
      const port = new BroadcastChannel(channel);
      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          port.close();
          reject(new Error('The Runtime Host Worker hook did not acknowledge the message.'));
        }, 10_000);
        port.addEventListener('message', (event) => {
          if (event.data?.type !== ackType || event.data.id !== id) return;
          clearTimeout(timeout);
          port.close();
          resolve();
        });
        port.postMessage({ id, message });
      });
    };
  }, { channel: HOOK_CHANNEL, ackType: ACK_TYPE });
}

export async function disposeRuntimeHostWorkerHook(page: Page): Promise<void> {
  await page.unroute(RUNTIME_HOST_WORKER_SCRIPT);
  await page.evaluate(() => {
    delete (globalThis as RuntimeHostWorkerHookGlobal).__postToMimicRuntimeHostWorker;
  });
}

/**
 * Serves `source(originalUrl)` in place of the Runtime Host Worker's script,
 * with the headers a worker of a cross-origin isolated frame needs.
 * `originalUrl` is the prebuilt script, reachable under a query the route
 * does not match.
 */
export async function serveRuntimeHostWorkerScript(
  page: Page,
  source: (originalUrl: string) => string
): Promise<void> {
  await page.route(RUNTIME_HOST_WORKER_SCRIPT, async (route) => {
    const original = new URL(route.request().url());
    original.searchParams.set(ORIGINAL_QUERY, '1');
    await route.fulfill({
      status: 200,
      headers: {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
        'cross-origin-embedder-policy': 'require-corp',
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-resource-policy': 'cross-origin'
      },
      body: source(original.href)
    });
  });
}

export function moduleDataUrl(source: string): string {
  return `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
}
