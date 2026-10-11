import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';
import {
  disposeExecutionWorkerFault,
  installExecutionWorkerFault
} from './execution-worker-fault';

const processCrashCompatibilityClaim = defineCompatibilityClaim({
  id: 'process-execution-structured-crash-v1',
  statement: 'Mimic processes reject structured crashes and reboot without leaked workers',
  target: {
    kind: 'runtime-capability',
    capability: 'process-execution-structured-crash'
  }
});

test(processCrashCompatibilityClaim.statement, async ({ page }) => {
  test.setTimeout(240_000);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];

  await page.route('**/__worker-diagnostics.html', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      headers: {
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Opener-Policy': 'same-origin'
      },
      body: '<!doctype html><title>worker diagnostics</title><main>worker diagnostics</main>'
    });
  });
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.goto('/__worker-diagnostics.html', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => window.crossOriginIsolated === true, null, { timeout: 10_000 });

  await installExecutionWorkerFault(
    page,
    "setTimeout(() => { throw new Error('execution-context-loss-marker'); }, 0);"
  );
  const result = await page.evaluate(async () => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const runtime = await Mimic.boot({ workdir: '/home/diagnostics' });
    try {
      await runtime.fs.mount({
        'unhandled.mjs': {
          file: {
            contents: [
              "setTimeout(() => Promise.reject(new Error('worker-unhandled-diagnostic-marker')), 0);",
              'await new Promise(() => {});'
            ].join('\n')
          }
        },
        'crash.mjs': {
          file: {
            contents: [
              "setTimeout(() => { throw new Error('worker-crash-diagnostic-marker'); }, 0);",
              'await new Promise(() => {});'
            ].join('\n')
          }
        },
        'handled-rejection.mjs': {
          file: {
            contents: [
              "process.on('unhandledRejection', (error) => { console.error(`handled-rejection:${error.message}`); process.exit(0); });",
              "setTimeout(() => Promise.reject(new Error('handled-rejection-marker')), 0);",
              'await new Promise(() => {});'
            ].join('\n')
          }
        },
        'handled-exception.mjs': {
          file: {
            contents: [
              "process.on('uncaughtException', (error) => { console.error(`handled-exception:${error.message}`); process.exit(0); });",
              "setTimeout(() => { throw new Error('handled-exception-marker'); }, 0);",
              'await new Promise(() => {});'
            ].join('\n')
          }
        },
        'context-loss.mjs': {
          file: {
            contents: 'await new Promise(() => {});'
          }
        }
      });

      const unhandledProcess = await runtime.spawn('node', ['/home/diagnostics/unhandled.mjs']);
      const unhandledStderr = readText(unhandledProcess.stderr);
      const unhandledExit = await withTimeout(
        unhandledProcess.exit,
        'unhandled process exit'
      );

      const crashProcess = await runtime.spawn('node', ['/home/diagnostics/crash.mjs']);
      const crashStderr = readText(crashProcess.stderr);
      const crashExit = await withTimeout(
        crashProcess.exit,
        'uncaught exception process exit'
      );

      const handledRejectionProcess = await runtime.spawn(
        'node',
        ['/home/diagnostics/handled-rejection.mjs']
      );
      const handledRejectionStderr = readText(
        handledRejectionProcess.stderr
      );
      const handledRejectionExit = await withTimeout(
        handledRejectionProcess.exit,
        'handled rejection process exit'
      );
      const handledExceptionProcess = await runtime.spawn(
        'node',
        ['/home/diagnostics/handled-exception.mjs']
      );
      const handledExceptionStderr = readText(
        handledExceptionProcess.stderr
      );
      const handledExceptionExit = await withTimeout(
        handledExceptionProcess.exit,
        'handled exception process exit'
      );

      await (
        globalThis as typeof globalThis & {
          __armNextMimicExecutionWorkerFault(): Promise<void>;
        }
      ).__armNextMimicExecutionWorkerFault();
      const contextLossProcess = await runtime.spawn(
        'node',
        ['/home/diagnostics/context-loss.mjs']
      );
      const contextLossExit = await withTimeout(
        contextLossProcess.exit,
        'Execution Context loss'
      ).then(
        (code) => ({ type: 'exit' as const, code }),
        (error: unknown) => ({
          type: 'crash' as const,
          code: typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'missing-code',
          message: error instanceof Error ? error.message : String(error),
          name: error instanceof Error ? error.name : 'NonError',
          pid:
            typeof error === 'object' && error !== null && 'pid' in error && typeof error.pid === 'number'
              ? error.pid
              : -1
        })
      );
      const replacement = await runtime.spawn('echo', ['epoch-remains-live']);
      const replacementOutput = readText(replacement.stdout);
      const replacementExit = await withTimeout(
        replacement.exit,
        'replacement process exit'
      );
      await withTimeout(runtime.teardown(), 'runtime teardown');

      return {
        unhandledExit,
        unhandledStderr: await unhandledStderr,
        crashExit,
        crashStderr: await crashStderr,
        handledRejection: {
          exit: handledRejectionExit,
          stderr: await handledRejectionStderr
        },
        handledException: {
          exit: handledExceptionExit,
          stderr: await handledExceptionStderr
        },
        contextLossExit,
        replacement: {
          exit: replacementExit,
          output: await replacementOutput
        }
      };
    } finally {
      await runtime.teardown();
    }

    function sleep(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function withTimeout<Value>(
      operation: Promise<Value>,
      phase: string
    ): Promise<Value> {
      return Promise.race([
        operation,
        new Promise<never>((_resolve, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(`${phase} timed out`)
              ),
            10_000
          )
        )
      ]);
    }

    async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
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

  expect(result.unhandledExit).toBe(1);
  expect(result.unhandledStderr).toContain('worker-unhandled-diagnostic-marker');
  expect(result.crashExit).toBe(1);
  expect(result.crashStderr).toContain('worker-crash-diagnostic-marker');
  expect(result.handledRejection).toEqual({
    exit: 0,
    stderr: expect.stringContaining(
      'handled-rejection:handled-rejection-marker'
    )
  });
  expect(result.handledException).toEqual({
    exit: 0,
    stderr: expect.stringContaining(
      'handled-exception:handled-exception-marker'
    )
  });
  expect(result.contextLossExit).toMatchObject({
    type: 'crash',
    code: 'PROCESS_CRASH',
    name: 'MimicProcessCrashError',
    pid: expect.any(Number),
    message: expect.stringContaining('execution-context-loss-marker')
  });
  expect(result.replacement).toEqual({
    exit: 0,
    output: 'epoch-remains-live\n'
  });
  const teardownWorkers = await waitForWorkers(0);
  if (teardownWorkers.length !== 0) {
    throw new Error(`Worker diagnostics teardown leaked dedicated workers: ${teardownWorkers.join(', ')}`);
  }
  const reboot = await page.evaluate(async () => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const runtime = await Mimic.boot({ workdir: '/home/diagnostics-reboot' });
    try {
      const process = await runtime.spawn('echo', ['diagnostics-rebooted']);
      const reader = process.stdout.getReader();
      const decoder = new TextDecoder();
      let output = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        output += decoder.decode(value, { stream: true });
      }
      return { exit: await process.exit, output };
    } finally {
      await runtime.teardown();
    }
  });
  expect(reboot).toEqual({ exit: 0, output: 'diagnostics-rebooted\n' });
  const rebootWorkers = await waitForWorkers(0);
  if (rebootWorkers.length !== 0) {
    throw new Error(`Worker diagnostics reboot leaked dedicated workers: ${rebootWorkers.join(', ')}`);
  }
  if (pageErrors.length > 0 || consoleErrors.length > 0) {
    throw new Error(`Worker diagnostics leaked page errors:\npage=${pageErrors.join('\n')}\nconsole=${consoleErrors.join('\n')}`);
  }

  console.log(JSON.stringify({ ok: true, ...result, reboot, workerCount: rebootWorkers.length }, null, 2));
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForWorkers(expected: number): Promise<string[]> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    const workers = await currentWorkers();
    if (workers.length === expected) return workers;
    await sleep(50);
  }
  return currentWorkers();
}

async function currentWorkers(): Promise<string[]> {
  const session = await page.context().newCDPSession(page);
  try {
    const { targetInfo: pageTarget } = await session.send('Target.getTargetInfo');
    const { targetInfos } = await session.send('Target.getTargets');
    return targetInfos
      .filter(
        (target) =>
          target.type === 'worker' &&
          target.openerId === pageTarget.targetId &&
          target.url.includes('/src/runtime/')
      )
      .map((target) => target.url);
  } finally {
    await session.detach();
  }
}

});
