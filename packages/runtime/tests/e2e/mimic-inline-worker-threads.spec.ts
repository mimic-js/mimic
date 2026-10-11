import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';

const inlineWorkerThreadsCompatibilityClaim = defineCompatibilityClaim({
  id: 'process-execution-inline-worker-threads-v1',
  statement:
    'Mimic executes inline CommonJS worker_threads through Process Execution with failure cleanup, teardown, and reboot',
  target: {
    kind: 'runtime-capability',
    capability: 'process-execution-inline-worker-threads'
  }
});

test(inlineWorkerThreadsCompatibilityClaim.statement, async ({ page }) => {
  test.setTimeout(180_000);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated), { timeout: 10_000 }).toBe(true);

  const result = await page.evaluate(async () => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const runtime = await Mimic.boot({ workdir: '/home/inline-worker-threads' });

    try {
      await runtime.fs.mount({
        'helper.cjs': {
          file: { contents: "module.exports = 'required-from-cwd';" }
        },
        'entry.cjs': {
          file: {
            contents: [
              "const { existsSync } = require('node:fs');",
              "const { MessageChannel, Worker } = require('node:worker_threads');",
              'void (async () => {',
              'const invalid = {};',
              "try { new Worker('inline source without eval'); } catch (error) { invalid.withoutEval = error.code; }",
              "try { new Worker(new URL('file:///worker.cjs'), { eval: true }); } catch (error) { invalid.urlWithEval = error.code; }",
              "const source = [",
              "  \"const { isMainThread, parentPort, threadId, workerData } = require('node:worker_threads');\",",
              "  \"const helper = require('./helper.cjs');\",",
              "  \"parentPort.postMessage({ isMainThread, pid: process.pid, threadId, workerData, argv: process.argv.slice(2), env: process.env.WORKER_ONLY, coerced: [process.env.WORKER_NUMBER, process.env.WORKER_UNSET], helper, filename: __filename, dirname: __dirname });\"",
              "].join('\\n');",
              "const successful = new Worker(source, { eval: true, workerData: 'fixture', argv: ['thread-arg'], env: { WORKER_ONLY: 'worker-value', WORKER_NUMBER: 3, WORKER_UNSET: undefined }, resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 4 } });",
              "const successfulMessagePromise = new Promise((resolve, reject) => { successful.once('message', resolve); successful.once('error', reject); });",
              "const successfulExitPromise = new Promise((resolve) => successful.once('exit', resolve));",
              'const successfulMessage = await successfulMessagePromise;',
              'const successfulExit = await successfulExitPromise;',
              "const transferring = new Worker(\"const { parentPort, receiveMessageOnPort } = require('node:worker_threads'); parentPort.once('message', ({ port, requestSignal }) => { parentPort.postMessage('port-ready'); Atomics.wait(requestSignal, 0, 0); const { port: nested, signal } = receiveMessageOnPort(port).message; Atomics.store(signal, 0, 0); nested.postMessage('request'); Atomics.wait(signal, 0, 0); parentPort.postMessage(receiveMessageOnPort(nested).message); });\", { eval: true });",
              'const channel = new MessageChannel();',
              'const nestedChannel = new MessageChannel();',
              'const requestSignal = new Int32Array(new SharedArrayBuffer(4));',
              'const sharedSignal = new Int32Array(new SharedArrayBuffer(4));',
              "nestedChannel.port1.once('message', () => { nestedChannel.port1.postMessage('through-port'); Atomics.store(sharedSignal, 0, 7); Atomics.notify(sharedSignal, 0); });",
              "const transferredMessage = new Promise((resolve, reject) => { transferring.on('message', (value) => { if (value === 'port-ready') setTimeout(() => { channel.port1.postMessage({ port: nestedChannel.port2, signal: sharedSignal }, [nestedChannel.port2]); Atomics.store(requestSignal, 0, 1); Atomics.notify(requestSignal, 0); }, 25); else resolve(value); }); transferring.once('error', reject); });",
              'const transferringExitPromise = new Promise((resolve) => transferring.once("exit", resolve));',
              'transferring.postMessage({ port: channel.port2, requestSignal }, [channel.port2]);',
              'const transferred = await transferredMessage;',
              'await transferringExitPromise;',
              "const syncWorker = new Worker(\"const { parentPort, receiveMessageOnPort } = require('node:worker_threads'); parentPort.once('message', ({ port, signal }) => { port.on('message', () => {}); parentPort.postMessage('sync-ready'); let requestCount = 0; while (true) { Atomics.wait(signal, 0, requestCount); requestCount = Atomics.load(signal, 0); let entry; while ((entry = receiveMessageOnPort(port)) !== undefined) { const response = new Uint8Array(entry.message.byteLength * 2); response[0] = entry.message[0]; port.postMessage(response, [response.buffer]); Atomics.add(signal, 1, 1); Atomics.notify(signal, 1); } } });\", { eval: true });",
              'const syncChannel = new MessageChannel();',
              'const syncSignal = new Int32Array(new SharedArrayBuffer(8));',
              "const syncReady = new Promise((resolve, reject) => { syncWorker.once('message', resolve); syncWorker.once('error', reject); });",
              'syncWorker.unref();',
              'syncWorker.postMessage({ port: syncChannel.port2, signal: syncSignal }, [syncChannel.port2]);',
              'await syncReady;',
              "const syncResponse = new Promise((resolve) => syncChannel.port1.once('message', resolve));",
              'const syncTask = new Uint8Array(133_108);',
              'syncTask[0] = 7;',
              'syncChannel.port1.postMessage(syncTask, [syncTask.buffer]);',
              'Atomics.add(syncSignal, 0, 1);',
              'Atomics.notify(syncSignal, 0);',
              "const syncFastPath = await Promise.race([syncResponse.then((value) => [value.byteLength, value[0]]), new Promise((resolve) => setTimeout(() => resolve('timeout'), 2_000))]);",
              'const syncTermination = await syncWorker.terminate();',
              "const burstWorker = new Worker(\"const { parentPort } = require('node:worker_threads'); parentPort.once('message', (port) => { let received = 0; port.on('message', (value) => { parentPort.postMessage('burst:' + value); received += 1; if (received === 2) { port.close(); parentPort.postMessage('burst-closed'); setTimeout(() => {}, 50); } }); parentPort.postMessage('burst-ready'); });\", { eval: true });",
              'const burstChannel = new MessageChannel();',
              'const burstMessages = [];',
              'let closeBurstPort;',
              'const burstPortClosed = new Promise((resolve) => { closeBurstPort = resolve; });',
              "const burstReady = new Promise((resolve, reject) => { burstWorker.on('message', (value) => { if (value === 'burst-ready') resolve(); else if (value === 'burst-closed') closeBurstPort(); else burstMessages.push(value); }); burstWorker.once('error', reject); });",
              'const burstExitPromise = new Promise((resolve) => burstWorker.once("exit", resolve));',
              'burstWorker.postMessage(burstChannel.port2, [burstChannel.port2]);',
              'await burstReady;',
              "burstChannel.port1.postMessage('one');",
              "burstChannel.port1.postMessage('two');",
              'while (burstMessages.length < 2) await new Promise((resolve) => setTimeout(resolve, 0));',
              'await burstPortClosed;',
              "burstChannel.port1.postMessage('after-close-one');",
              "burstChannel.port1.postMessage('after-close-two');",
              'await burstExitPromise;',
              "const failing = new Worker(\"const fs = require('node:fs'); setTimeout(() => fs.writeFileSync('/home/inline-worker-threads/late-failure-effect', 'unexpected'), 25); throw new Error('inline failure');\", { eval: true });",
              "const failureErrorPromise = new Promise((resolve) => failing.once('error', resolve));",
              "const failureExitPromise = new Promise((resolve) => failing.once('exit', resolve));",
              'const failureError = await failureErrorPromise;',
              'const failureExit = await failureExitPromise;',
              "const terminating = new Worker(\"const fs = require('node:fs'); const { parentPort } = require('node:worker_threads'); parentPort.postMessage('terminate-ready'); setTimeout(() => fs.writeFileSync('/home/inline-worker-threads/late-terminate-effect', 'unexpected'), 50);\", { eval: true });",
              "const terminatingReady = await new Promise((resolve, reject) => { terminating.once('message', resolve); terminating.once('error', reject); });",
              "const terminatingExitPromise = new Promise((resolve) => terminating.once('exit', resolve));",
              'const terminationCode = await terminating.terminate();',
              'const terminatingExit = await terminatingExitPromise;',
              'await new Promise((resolve) => setTimeout(resolve, 75));',
              'console.log(JSON.stringify({',
              '  invalid,',
              '  parentPid: process.pid,',
              '  successfulMessage,',
              '  successfulExit,',
              '  resourceLimits: successful.resourceLimits,',
              '  transferred: { value: transferred, signal: Atomics.load(sharedSignal, 0) },',
              '  syncFastPath,',
              '  syncTermination,',
              '  burstMessages,',
              '  failure: { message: failureError.message, exit: failureExit, lateEffect: existsSync("/home/inline-worker-threads/late-failure-effect") },',
              '  termination: { ready: terminatingReady, code: terminationCode, exit: terminatingExit, lateEffect: existsSync("/home/inline-worker-threads/late-terminate-effect") }',
              '}));',
              '})();'
            ].join('\n')
          }
        },
        'teardown-parent.cjs': {
          file: {
            contents: [
              "const { Worker } = require('node:worker_threads');",
              "const worker = new Worker(\"const { parentPort } = require('node:worker_threads'); parentPort.postMessage('teardown-ready'); setInterval(() => {}, 1000);\", { eval: true });",
              "worker.on('message', (value) => console.log(value));"
            ].join('\n')
          }
        }
      });

      const process = await runtime.spawn('node', ['/home/inline-worker-threads/entry.cjs']);
      const output = await collectOutput(process.stdout);
      const errorOutput = await collectOutput(process.stderr);
      const exit = await process.exit;
      const rootEntries = (await runtime.fs.readdir(runtime.workdir)).map(String).sort();

      const teardownParent = await runtime.spawn('node', [
        '/home/inline-worker-threads/teardown-parent.cjs'
      ]);
      const teardownOutput = captureOutput(teardownParent.stdout);
      const teardownError = captureOutput(teardownParent.stderr);
      await Promise.race([
        waitForOutput(() => teardownOutput.text, 'teardown-ready'),
        teardownParent.exit.then(async (code) => {
          throw new Error(
            `Teardown parent exited ${code}: stdout=${await teardownOutput.complete} stderr=${await teardownError.complete}`
          );
        })
      ]);
      const teardownCompleted = await Promise.race([
        runtime.teardown().then(() => true),
        sleep(2_000).then(() => false)
      ]);
      const teardownExit = await teardownParent.exit;
      const teardownText = await teardownOutput.complete;
      const teardownErrorText = await teardownError.complete;

      return {
        exit,
        output,
        errorOutput,
        rootEntries,
        teardownCompleted,
        teardownExit,
        teardownText,
        teardownErrorText
      };
    } finally {
      await runtime.teardown();
    }

    async function collectOutput(output: ReadableStream<Uint8Array>): Promise<string> {
      return captureOutput(output).complete;
    }

    function captureOutput(
      output: ReadableStream<Uint8Array>
    ): { readonly text: string; readonly complete: Promise<string> } {
      let text = '';
      const complete = (async () => {
        const reader = output.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) return text;
          text += decoder.decode(value, { stream: true });
        }
      })();
      return {
        get text() {
          return text;
        },
        complete
      };
    }

    async function waitForOutput(read: () => string, expected: string): Promise<void> {
      const startedAt = Date.now();
      while (Date.now() - startedAt < 5_000) {
        if (read().includes(expected)) return;
        await sleep(25);
      }
      throw new Error(`Timed out waiting for ${expected}: ${read()}`);
    }

    function sleep(milliseconds: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, milliseconds));
    }
  });

  expect(result.exit, `${result.output}\n${result.errorOutput}`).toBe(0);
  const receipt = JSON.parse(result.output) as {
    invalid: { withoutEval: string; urlWithEval: string };
    parentPid: number;
    successfulMessage: {
      isMainThread: boolean;
      pid: number;
      threadId: number;
      workerData: string;
      argv: string[];
      env: string;
      coerced: string[];
      helper: string;
      filename: string;
      dirname: string;
    };
    successfulExit: number;
    resourceLimits: Record<string, number>;
    transferred: { value: string; signal: number };
    syncFastPath: [number, number] | string;
    syncTermination: number;
    burstMessages: string[];
    failure: { message: string; exit: number; lateEffect: boolean };
    termination: { ready: string; code: number; exit: number; lateEffect: boolean };
  };
  expect(receipt.invalid).toEqual({
    withoutEval: 'ERR_WORKER_PATH',
    urlWithEval: 'ERR_INVALID_ARG_VALUE'
  });
  expect(receipt.successfulMessage).toEqual({
    isMainThread: false,
    pid: receipt.parentPid,
    threadId: expect.any(Number),
    workerData: 'fixture',
    argv: ['thread-arg'],
    env: 'worker-value',
    coerced: ['3', 'undefined'],
    helper: 'required-from-cwd',
    filename: '[worker eval]',
    dirname: '.'
  });
  expect(receipt.successfulMessage.threadId).toBeGreaterThan(0);
  expect(receipt.successfulExit).toBe(0);
  expect(receipt.resourceLimits).toEqual({ maxOldGenerationSizeMb: 64, stackSizeMb: 4 });
  expect(receipt.transferred).toEqual({ value: 'through-port', signal: 7 });
  expect(receipt.syncFastPath).toEqual([266_216, 7]);
  expect(receipt.syncTermination).toBe(1);
  expect(receipt.burstMessages).toEqual(['burst:one', 'burst:two']);
  expect(receipt.failure).toEqual({
    message: expect.stringContaining('inline failure'),
    exit: 1,
    lateEffect: false
  });
  expect(receipt.termination).toEqual({
    ready: 'terminate-ready',
    code: 1,
    exit: 1,
    lateEffect: false
  });
  expect(result.rootEntries).toEqual(['entry.cjs', 'helper.cjs', 'teardown-parent.cjs']);
  expect(result.teardownCompleted).toBe(true);
  expect(result.teardownExit).toBe(137);
  expect(result.teardownText).toContain('teardown-ready');
  expect(result.teardownErrorText).toBe('');

  const teardownWorkers = await waitForRuntimeWorkers(0);
  expect(teardownWorkers).toEqual([]);

  const reboot = await page.evaluate(async () => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const runtime = await Mimic.boot({ workdir: '/home/inline-worker-reboot' });
    try {
      await runtime.fs.mount({
        'entry.cjs': {
          file: {
            contents: [
              "const { MessageChannel, Worker } = require('node:worker_threads');",
              'void (async () => {',
              "const worker = new Worker(\"const { parentPort } = require('node:worker_threads'); parentPort.once('message', (port) => { port.once('message', (value) => parentPort.postMessage(value)); parentPort.postMessage('ready'); });\", { eval: true });",
              'const channel = new MessageChannel();',
              "const messages = []; const ready = new Promise((resolve, reject) => { worker.on('message', (value) => value === 'ready' ? resolve() : messages.push(value)); worker.once('error', reject); });",
              'worker.postMessage(channel.port2, [channel.port2]);',
              'await ready;',
              "channel.port1.postMessage('inline-worker-rebooted');",
              'while (messages.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));',
              'const message = messages[0];',
              'console.log(message);',
              '})();'
            ].join('\n')
          }
        }
      });
      const process = await runtime.spawn('node', ['/home/inline-worker-reboot/entry.cjs']);
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
  expect(reboot).toEqual({ exit: 0, output: 'inline-worker-rebooted\n' });
  expect(await waitForRuntimeWorkers(0)).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);

  async function waitForRuntimeWorkers(expected: number): Promise<string[]> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 5_000) {
      const workers = await currentRuntimeWorkers();
      if (workers.length === expected) return workers;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return currentRuntimeWorkers();
  }

  async function currentRuntimeWorkers(): Promise<string[]> {
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
