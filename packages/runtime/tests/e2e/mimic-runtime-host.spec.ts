import type { Page } from '@playwright/test';
import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';
import {
  disposeExecutionWorkerFault,
  installExecutionWorkerFault
} from './execution-worker-fault';
import {
  disposeTerminalRuntimeHostWorker,
  injectTerminalRuntimeHostFailure,
  installTerminalRuntimeHostWorker,
  TERMINAL_WORKER_FIXTURE_CHANNEL
} from './terminal-runtime-host-worker';

const runtimeHostCompatibilityClaim = defineCompatibilityClaim({
  id: 'runtime-supervisor-worker-lifecycle-v1',
  statement: 'Mimic owns a fail-stop Runtime Host Worker across teardown, reboot, and terminal failure',
  target: {
    kind: 'runtime-capability',
    capability: 'runtime-host-worker-lifecycle'
  }
});

test(runtimeHostCompatibilityClaim.statement, async ({ page }) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const workerUrls: string[] = [];
  page.on('worker', (worker) => workerUrls.push(worker.url()));
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  page.on('console', (message) => message.type() === 'error' && consoleErrors.push(message.text()));

  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);

  const result = await page.evaluate(async () => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const runtime = await Mimic.boot({ workdir: '/home/runtime-host-first' });
    const firstTeardown = runtime.teardown();
    const sameTeardownPromise = firstTeardown === runtime.teardown();
    let queuedBootResolved = false;
    const bootBeforeTeardown = Mimic.boot({ workdir: '/home/runtime-host-reboot' }).then((rebooted) => {
      queuedBootResolved = true;
      return rebooted;
    });
    await Promise.resolve();
    const bootWaitedForTeardown = !queuedBootResolved;
    const newWorkFailure = await runtime.fs.mount({}).then(
      () => 'accepted',
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    );
    await firstTeardown;

    const rebooted = await bootBeforeTeardown;
    await rebooted.teardown();

    return { bootWaitedForTeardown, newWorkFailure, sameTeardownPromise };
  });

  expect(result.sameTeardownPromise).toBe(true);
  expect(result.bootWaitedForTeardown).toBe(true);
  expect(result.newWorkFailure).toContain('Mimic runtime is tearing down');
  // One Runtime Host Worker per boot; the process workers it keeps ahead of demand are not counted.
  expect(workerUrls.filter((url) => url.includes('runtime-host-worker')).length).toBe(2);
  await expect.poll(() => currentRuntimeWorkerUrls(page), { timeout: 5_000 }).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('Mimic fails the epoch when the Runtime Host worker crashes', async ({ page }) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  page.on('console', (message) => message.type() === 'error' && consoleErrors.push(message.text()));

  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);
  await installTerminalRuntimeHostWorker(page);

  const result = await page.evaluate(async ({ inject, channel }) => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const runtime = await Mimic.boot({ workdir: '/home/runtime-host-terminal-failure' });
    const pendingProcess = await runtime.spawn('pending');
    new Function('channel', `(${inject})(channel)`)(channel);
    const pendingFailure = await pendingProcess.exit.then(
      (code) => ({ type: 'exit' as const, code }),
      (error: unknown) => ({
        type: 'crash' as const,
        code:
          typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : 'missing-code',
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : 'NonError'
      })
    );
    const rejectedWork = await runtime.fs.mount({}).then(
      () => 'accepted',
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    );
    const teardownFailure = await runtime.teardown().then(
      () => undefined,
      (error: unknown) => ({
        code:
          typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : 'missing-code',
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : 'NonError'
      })
    );
    return { pendingFailure, rejectedWork, teardownFailure };
  }, { inject: injectTerminalRuntimeHostFailure.toString(), channel: TERMINAL_WORKER_FIXTURE_CHANNEL });

  await disposeTerminalRuntimeHostWorker(page);
  await page.evaluate(async () => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const rebooted = await Mimic.boot({ workdir: '/home/runtime-host-after-failure' });
    await rebooted.teardown();
  });

  expect(result.pendingFailure).toEqual({
    type: 'crash',
    code: 'PROCESS_CRASH',
    message: expect.stringContaining('Runtime epoch failed'),
    name: 'MimicProcessCrashError'
  });
  expect(result.rejectedWork).toContain('Mimic runtime is tearing down');
  expect(result.teardownFailure).toEqual({
    code: 'RUNTIME_EPOCH_FAILED',
    message: expect.stringContaining('Injected terminal Runtime Host failure'),
    name: 'RuntimeEpochFailedError'
  });
  await expect.poll(() => currentRuntimeWorkerUrls(page), { timeout: 5_000 }).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('Runtime Host owns browser-hosted background invariant failure', async ({
  page
}) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) =>
    pageErrors.push(error.stack ?? error.message)
  );
  page.on(
    'console',
    (message) =>
      message.type() === 'error' && consoleErrors.push(message.text())
  );

  await page.goto('/mimic-test-host.html', {
    waitUntil: 'domcontentloaded'
  });
  await expect
    .poll(() => page.evaluate(() => globalThis.crossOriginIsolated))
    .toBe(true);

  await installExecutionWorkerFault(
    page,
    [
      // Once the host starts the process, report a background runtime error
      // as a Worker Transport notification of the host's `runtimeError` method.
      "self.addEventListener('message', () => {",
      "  self.postMessage({ kind: 'rpc:call', id: 0, path: ['runtimeError'], args: [{",
      "    name: 'Error',",
      "    message: 'browser-background-invariant-marker'",
      '  }] });',
      '}, { once: true });'
    ].join('\n')
  );
  const result = await page.evaluate(async () => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const runtime = await Mimic.boot({ workdir: '/home/background-invariant' });
    try {
      await (
        globalThis as typeof globalThis & {
          __armNextMimicExecutionWorkerFault(): Promise<void>;
        }
      ).__armNextMimicExecutionWorkerFault();
      const pendingProcess = await runtime.spawn('node', [
        '-e',
        'await new Promise(() => {});'
      ]);
      const pendingFailure = await pendingProcess.exit.catch(
        (error: unknown) => ({
          code:
            typeof error === 'object' && error !== null && 'code' in error
              ? String(error.code)
              : 'missing-code',
          message: error instanceof Error ? error.message : String(error),
          name: error instanceof Error ? error.name : 'NonError'
        })
      );
      const rejectedWork = await runtime.fs.mount({}).then(
        () => 'accepted',
        (error: unknown) =>
          error instanceof Error ? error.message : String(error)
      );
      const teardownFailure = await runtime.teardown().catch(
        (error: unknown) => ({
          causeName:
            error instanceof Error && error.cause instanceof Error
              ? error.cause.name
              : 'missing-cause',
          code:
            typeof error === 'object' && error !== null && 'code' in error
              ? String(error.code)
              : 'missing-code',
          message: error instanceof Error ? error.message : String(error),
          name: error instanceof Error ? error.name : 'NonError'
        })
      );
      const rebooted = await Mimic.boot({ workdir: '/home/background-invariant-reboot' });
      const rebootProcess = await rebooted.spawn('echo', [
        'background-rebooted'
      ]);
      const rebootOutput = await readText(rebootProcess.stdout);
      const rebootExit = await rebootProcess.exit;
      await rebooted.teardown();
      return {
        pendingFailure,
        reboot: { exit: rebootExit, output: rebootOutput },
        rejectedWork,
        teardownFailure
      };
    } finally {
      await runtime.teardown().catch(() => undefined);
    }

    async function readText(
      stream: ReadableStream<Uint8Array>
    ): Promise<string> {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let output = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) return output + decoder.decode();
        output += decoder.decode(value, { stream: true });
      }
    }
  }).finally(() => disposeExecutionWorkerFault(page));

  expect(result.pendingFailure).toEqual({
    code: 'PROCESS_CRASH',
    message: expect.stringContaining(
      'browser-background-invariant-marker'
    ),
    name: 'MimicProcessCrashError'
  });
  expect(result.teardownFailure).toEqual({
    causeName: 'RuntimeHostAdapterInvariantError',
    code: 'RUNTIME_EPOCH_FAILED',
    message: expect.stringContaining(
      'browser-background-invariant-marker'
    ),
    name: 'RuntimeEpochFailedError'
  });
  expect(result.rejectedWork).toContain(
    'Mimic runtime is tearing down'
  );
  expect(result.reboot).toEqual({
    exit: 0,
    output: 'background-rebooted\n'
  });
  await expect
    .poll(() => currentRuntimeWorkerUrls(page), { timeout: 5_000 })
    .toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

async function currentRuntimeWorkerUrls(page: Page): Promise<string[]> {
  const session = await page.context().newCDPSession(page);
  try {
    const { targetInfos } = await session.send('Target.getTargets');
    return targetInfos
      // The Runtime Host document's frame, not the page, opens the runtime's workers (ADR-0033).
      .filter(
        (target) =>
          target.type === 'worker' &&
          (target.url.includes('/src/runtime/') || target.url.includes('/generated/runtime-host/'))
      )
      .map((target) => target.url);
  } finally {
    await session.detach();
  }
}
