import type { Page } from '@playwright/test';

import { serveRuntimeHostWorkerScript } from './runtime-host-worker-hook';

export const TERMINAL_WORKER_FIXTURE_CHANNEL = 'mimic:terminal-worker-fixture';
const RUNTIME_HOST_WORKER_SCRIPT = /\/runtime-host-worker\.js$/u;

/**
 * Replaces the Runtime Host Worker of every boot from now on with the
 * terminal-failure fixture, a Runtime Host epoch whose `pending` program
 * waits for a signal and which fails terminally when the page asks over
 * {@link injectTerminalRuntimeHostFailure}.
 */
export async function installTerminalRuntimeHostWorker(page: Page): Promise<void> {
  await serveRuntimeHostWorkerScript(
    page,
    () => "import '/src/runtime/modules/runtime-host/terminal-worker.fixture.ts';\n"
  );
}

export async function disposeTerminalRuntimeHostWorker(page: Page): Promise<void> {
  await page.unroute(RUNTIME_HOST_WORKER_SCRIPT);
}

/** Runs in the page: asks the fixture worker to fail its epoch terminally. */
export function injectTerminalRuntimeHostFailure(channel: string): void {
  new BroadcastChannel(channel).postMessage({ type: 'inject-terminal-failure' });
}
