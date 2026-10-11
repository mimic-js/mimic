import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';

const processExecutionCompatibilityClaim = defineCompatibilityClaim({
  id: 'process-execution-supervisor-authority-v1',
  statement:
    'Runtime Host owns top-level process streams and lifecycle while Node Compatibility projects child/thread APIs through guarded execution ports',
  target: {
    kind: 'runtime-capability',
    capability: 'process-execution-supervisor-authority'
  }
});

test(processExecutionCompatibilityClaim.statement, async ({ page }) => {
  test.setTimeout(240_000);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];

  await page.route('**/__process-tree.html', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      headers: {
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Opener-Policy': 'same-origin'
      },
      body: '<!doctype html><title>process tree</title><main>process tree</main>'
    });
  });
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.goto('/__process-tree.html', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => window.crossOriginIsolated === true, null, { timeout: 10_000 });

  const result = await page.evaluate(async () => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const runtime = await Mimic.boot({ workdir: '/home/process-tree' });

    try {
      await runtime.fs.mount({
        nested: { directory: {} },
        'public-stdio.mjs': {
          file: {
            contents: [
              "import { existsSync } from 'node:fs';",
              "process.stdout.write('stdio-ready\\n');",
              "while (!existsSync('/home/process-tree/release-stdio')) await new Promise((resolve) => setTimeout(resolve, 5));",
              'const chunks = [];',
              'for await (const chunk of process.stdin) chunks.push(chunk);',
              'const payload = chunks[0];',
              "if (!payload || chunks.length !== 1) throw new Error('expected one binary stdin chunk');",
              'const stdoutAccepted = process.stdout.write(payload);',
              "if (stdoutAccepted) throw new Error('expected stdout backpressure');",
              "await new Promise((resolve) => process.stdout.once('drain', resolve));",
              'const stderrAccepted = process.stderr.write(new Uint8Array([0, 255, 128, 10, 13, 42]));',
              "if (!stderrAccepted) await new Promise((resolve) => process.stderr.once('drain', resolve));"
            ].join('\n')
          }
        },
        'child.mjs': {
          file: {
            contents: [
              "process.stdin.setEncoding('utf8');",
              'const chunks = [];',
              "process.stdin.on('data', (chunk) => chunks.push(chunk));",
              "process.stdin.on('end', () => {",
              "  console.log('child-identity', [process.pid, process.ppid, process.cwd(), process.env.INHERITED, process.env.CHILD_ONLY, process.argv.slice(2).join(',')].join('|'));",
              "  console.log('child-stdin-size', chunks.join('').length);",
              "  console.error('child-stderr-size', chunks.join('').length);",
              '});'
            ].join('\n')
          }
        },
        'thread-worker.mjs': {
          file: {
            contents: [
              "import { isMainThread, parentPort, threadId, workerData } from 'node:worker_threads';",
              "parentPort.on('message', (value) => {",
              "  parentPort.postMessage(['thread-message', isMainThread, process.pid, threadId, process.cwd(), process.env.WORKER_ONLY, process.argv.slice(2).join(','), workerData, value].join('|'));",
              "  if (value === 'exit') process.exit(0);",
              '});'
            ].join('\n')
          }
        },
        'terminating-thread.mjs': {
          file: {
            contents: [
              "import { writeFileSync } from 'node:fs';",
              "import { parentPort } from 'node:worker_threads';",
              "parentPort.postMessage('terminating-thread-ready');",
              "setTimeout(() => { writeFileSync('/home/process-tree/late-thread-effect.txt', 'unexpected'); parentPort.postMessage('late-thread-effect'); }, 50);",
              'await new Promise(() => {});'
            ].join('\n')
          }
        },
        'parent.mjs': {
          file: {
            contents: [
              "import { spawn } from 'node:child_process';",
              "import { existsSync } from 'node:fs';",
              "import { Worker } from 'node:worker_threads';",
              "console.log('parent-identity', [process.pid, process.ppid, process.cwd(), process.env.INHERITED, process.argv.slice(2).join(',')].join('|'));",
              'let workerBoundary;',
              'try { new Worker(\'not-a-worker.mjs\'); } catch (error) { workerBoundary = error.code; }',
              "console.log('worker-threads-boundary', workerBoundary);",
              "const worker = new Worker('/home/process-tree/thread-worker.mjs', { workerData: 'thread-fixture', argv: ['thread-arg'], env: { ...process.env, WORKER_ONLY: 'worker-value' } });",
              "console.log('worker-immediate-thread-id', worker.threadId);",
              "const workerMessage = new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });",
              "const workerExit = new Promise((resolve) => worker.once('exit', resolve));",
              "worker.postMessage('ping');",
              "console.log('worker-message', await workerMessage);",
              "worker.postMessage('exit');",
              "console.log('worker-exit', await workerExit);",
              "const terminatingWorker = new Worker('/home/process-tree/terminating-thread.mjs');",
              "let terminatingMessage = 'none';",
              "terminatingWorker.on('message', (value) => { terminatingMessage = String(value); });",
              "await new Promise((resolve, reject) => { terminatingWorker.once('message', resolve); terminatingWorker.once('error', reject); });",
              "const terminatingExit = new Promise((resolve) => terminatingWorker.once('exit', resolve));",
              "const terminationCode = await terminatingWorker.terminate();",
              "console.log('worker-termination', [terminationCode, await terminatingExit, existsSync('/home/process-tree/late-thread-effect.txt'), terminatingMessage].join('|'));",
              "const child = spawn(process.execPath, ['/home/process-tree/child.mjs', 'child-arg'], {",
              "  cwd: '/home/process-tree/nested',",
              "  env: { ...process.env, CHILD_ONLY: 'child-value' },",
              "  stdio: ['pipe', 'pipe', 'pipe']",
              '});',
              "child.stdout.setEncoding('utf8');",
              "child.stdout.on('data', (chunk) => console.log('child-output', String(chunk).trim()));",
              "child.stderr.setEncoding('utf8');",
              "child.stderr.on('data', (chunk) => console.log('child-error', String(chunk).trim()));",
              "child.stdin.on('drain', () => console.log('child-stdin-drain'));",
              'const childEvents = [];',
              "child.on('exit', (code, signal) => { childEvents.push('exit'); console.log('child-exit', code, signal ?? 'none'); });",
              "child.on('close', (code, signal) => { childEvents.push('close'); console.log('child-close', code, signal ?? 'none'); });",
              "const acceptedWithoutBackpressure = child.stdin.write('x'.repeat(32 * 1024));",
              // As in Node, a stream that is ending emits no `drain`; end once the pipe drained.
              "if (acceptedWithoutBackpressure) child.stdin.end('done'); else child.stdin.once('drain', () => child.stdin.end('done'));",
              "await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });",
              "console.log('child-event-order', childEvents.join('>'));",
              "const globalChild = spawn(process.execPath, ['/home/process-tree/global-child.mjs']);",
              "globalChild.stdout.setEncoding('utf8');",
              "globalChild.stdout.on('data', (chunk) => console.log('global-child-output', String(chunk).trim()));",
              "await new Promise((resolve) => globalChild.stdout.once('data', resolve));",
              "console.log('parent-global-pid', globalThis.process.pid);",
              "await new Promise((resolve, reject) => { globalChild.once('close', resolve); globalChild.once('error', reject); });",
              "console.log('child-stdin-accepted-without-backpressure', acceptedWithoutBackpressure);",
              "const ignored = spawn(process.execPath, ['/home/process-tree/ignored-child.mjs'], { stdio: 'ignore' });",
              "console.log('ignored-stdio-streams', ignored.stdin === null, ignored.stdout === null, ignored.stderr === null);",
              "await new Promise((resolve, reject) => { ignored.once('close', resolve); ignored.once('error', reject); });",
              "const signalled = spawn(process.execPath, ['/home/process-tree/signalled-child.mjs']);",
              "signalled.stdout.setEncoding('utf8');",
              "signalled.stdout.on('data', (chunk) => console.log('signalled-output', String(chunk).trim()));",
              'const signalledEvents = [];',
              "signalled.on('exit', (code, signal) => { signalledEvents.push('exit'); console.log('signalled-exit', code ?? 'none', signal ?? 'none'); });",
              "signalled.on('close', (code, signal) => { signalledEvents.push('close'); console.log('signalled-close', code ?? 'none', signal ?? 'none'); });",
              "await new Promise((resolve) => signalled.stdout.once('data', resolve));",
              "signalled.kill('SIGINT');",
              "await new Promise((resolve, reject) => { signalled.once('close', resolve); signalled.once('error', reject); });",
              "console.log('signalled-event-order', signalledEvents.join('>'));",
              "const ordinary130 = spawn(process.execPath, ['/home/process-tree/exit-130.mjs']);",
              "ordinary130.on('exit', (code, signal) => console.log('ordinary-130-exit', code ?? 'none', signal ?? 'none'));",
              "ordinary130.on('close', (code, signal) => console.log('ordinary-130-close', code ?? 'none', signal ?? 'none'));",
              "await new Promise((resolve, reject) => { ordinary130.once('close', resolve); ordinary130.once('error', reject); });"
            ].join('\n')
          }
        },
        'waiting-child.mjs': {
          file: {
            contents: [
              // A listener takes the signal over, as in Node; this one ends the process with it.
              "process.once('SIGTERM', () => { console.log('waiting-child-sigterm'); process.kill(process.pid, 'SIGTERM'); });",
              "console.log('waiting-child-ready', process.pid, process.ppid);",
              'await new Promise(() => {});'
            ].join('\n')
          }
        },
        'ignored-child.mjs': {
          file: {
            contents: "console.log('ignored-child-output');"
          }
        },
        'global-child.mjs': {
          file: {
            contents: "console.log('child-global-pid', globalThis.process.pid);"
          }
        },
        'signalled-child.mjs': {
          file: {
            contents: [
              "process.once('SIGINT', () => { console.log('signalled-child-sigint'); process.kill(process.pid, 'SIGINT'); });",
              "console.log('signalled-child-ready', process.pid, process.ppid);",
              'await new Promise(() => {});'
            ].join('\n')
          }
        },
        'exit-130.mjs': {
          file: {
            contents: 'process.exit(130);'
          }
        },
        'waiting-parent.mjs': {
          file: {
            contents: [
              "import { spawn } from 'node:child_process';",
              "const child = spawn(process.execPath, ['/home/process-tree/waiting-child.mjs']);",
              "child.stdout.setEncoding('utf8');",
              "child.stdout.on('data', (chunk) => console.log(String(chunk).trim()));",
              'await new Promise(() => {});'
            ].join('\n')
          }
        },
        'unrelated.mjs': {
          file: {
            contents: [
              "process.once('SIGTERM', () => { console.log('unrelated-sigterm'); process.kill(process.pid, 'SIGTERM'); });",
              "console.log('unrelated-ready', process.pid);",
              'await new Promise(() => {});'
            ].join('\n')
          }
        }
      });

      const publicProcess = await runtime.spawn('node', ['/home/process-tree/public-stdio.mjs']);
      const publicStdout = captureBinary(publicProcess.stdout);
      const publicStderr = captureBinary(publicProcess.stderr);
      const stdinWriter = publicProcess.stdin.getWriter();
      const stdinPayload = new Uint8Array(128 * 1024);
      for (let index = 0; index < stdinPayload.length; index += 1) stdinPayload[index] = (index * 17 + 3) & 0xff;
      let stdinWriteSettled = false;
      const stdinWrite = stdinWriter.write(stdinPayload).then(() => {
        stdinWriteSettled = true;
      });
      await waitForOutput(() => publicStdout.text, 'stdio-ready');
      const stdinBackpressured = !stdinWriteSettled;
      await runtime.fs.writeFile('/home/process-tree/release-stdio', 'release');
      await stdinWrite;
      await stdinWriter.close();
      const publicExit = await publicProcess.exit.then((code) => ({
        code,
        stderrClosed: publicStderr.closedBeforeExit,
        stdoutClosed: publicStdout.closedBeforeExit
      }));
      const publicStdoutBytes = await publicStdout.complete;
      const publicStderrBytes = await publicStderr.complete;
      const stdoutMarker = new TextEncoder().encode('stdio-ready\n');
      const publicStdoutPayload = publicStdoutBytes.slice(stdoutMarker.byteLength);
      const publicStdio = {
        exit: publicExit.code,
        stdinBackpressured,
        stderr: [...publicStderrBytes],
        stderrClosedBeforeExit: publicExit.stderrClosed,
        stdoutClosedBeforeExit: publicExit.stdoutClosed,
        stdoutLength: publicStdoutPayload.byteLength,
        stdoutMatchesInput:
          publicStdoutPayload.byteLength === stdinPayload.byteLength &&
          publicStdoutPayload.every((byte, index) => byte === stdinPayload[index])
      };

      const parent = await runtime.spawn('node', ['/home/process-tree/parent.mjs', 'parent-arg'], {
        env: { INHERITED: 'inherited-value' }
      });
      const parentCapture = captureOutput(parent.stdout);
      const parentExit = await Promise.race([
        parent.exit,
        sleep(15_000).then(() => {
          throw new Error(`process-tree parent timed out: ${parentCapture.text}`);
        })
      ]);
      const parentOutput = await parentCapture.complete;
      if (parentExit !== 0) throw new Error(`process-tree parent exited with ${parentExit}: ${parentOutput}`);

      const waitingParent = await runtime.spawn('node', ['/home/process-tree/waiting-parent.mjs']);
      const waitingOutput = captureOutput(waitingParent.stdout);
      await waitForOutput(() => waitingOutput.text, 'waiting-child-ready');
      const unrelated = await runtime.spawn('node', ['/home/process-tree/unrelated.mjs']);
      const unrelatedOutput = captureOutput(unrelated.stdout);
      await waitForOutput(() => unrelatedOutput.text, 'unrelated-ready');
      waitingParent.kill('SIGTERM');
      const waitingExit = await waitingParent.exit;
      const waitingText = await waitingOutput.complete;
      const unrelatedState = await Promise.race([
        unrelated.exit.then(() => 'exited'),
        sleep(100).then(() => 'running')
      ]);
      unrelated.kill('SIGTERM');
      await unrelated.exit;
      await unrelatedOutput.complete;

      const expectedCapacity = Math.min(8, Math.max(1, navigator.hardwareConcurrency - 1));
      const holders = [];
      for (let index = 0; index < expectedCapacity; index += 1) {
        holders.push(await runtime.spawn('node', ['/home/process-tree/unrelated.mjs']));
      }
      const capacityFailure = await runtime.spawn('node', ['/home/process-tree/unrelated.mjs']).then(
        () => ({ code: 'accepted', message: '' }),
        (error: unknown) => ({
          code: typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'missing-code',
          message: error instanceof Error ? error.message : String(error)
        })
      );
      for (const holder of holders) holder.kill('SIGKILL');
      await Promise.all(holders.map((holder) => holder.exit));
      const replacement = await runtime.spawn('echo', ['capacity-recovered']);
      const replacementPid = replacement.pid;
      const replacementOutput = await collectOutput(replacement.stdout);
      const replacementExit = await replacement.exit;

      await runtime.teardown();
      const teardownRuntime = await Mimic.boot({ workdir: '/home/process-tree-teardown' });
      await teardownRuntime.fs.mount({
        'waiting-child.mjs': {
          file: {
            contents: [
              "console.log('teardown-child-ready', process.pid, process.ppid);",
              'await new Promise(() => {});'
            ].join('\n')
          }
        },
        'waiting-parent.mjs': {
          file: {
            contents: [
              "import { spawn } from 'node:child_process';",
              "const child = spawn(process.execPath, ['/home/process-tree-teardown/waiting-child.mjs']);",
              "child.stdout.setEncoding('utf8');",
              "child.stdout.on('data', (chunk) => console.log(String(chunk).trim()));",
              'await new Promise(() => {});'
            ].join('\n')
          }
        },
        'non-yielding.mjs': {
          file: {
            contents:
              'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);'
          }
        }
      });
      const teardownParent = await teardownRuntime.spawn('node', ['/home/process-tree-teardown/waiting-parent.mjs']);
      const teardownOutput = captureOutput(teardownParent.stdout);
      await waitForOutput(() => teardownOutput.text, 'teardown-child-ready');
      const nonYielding = await teardownRuntime.spawn('node', [
        '/home/process-tree-teardown/non-yielding.mjs'
      ]);
      const nonYieldingError = captureOutput(nonYielding.stderr);
      await sleep(100);
      const teardownCompleted = await Promise.race([
        teardownRuntime.teardown().then(() => true),
        sleep(2_000).then(() => false)
      ]);
      const teardownExit = await teardownParent.exit;
      const nonYieldingExit = await nonYielding.exit;
      const nonYieldingErrorText = await nonYieldingError.complete;
      const teardownText = await teardownOutput.complete;
      const rebooted = await Mimic.boot({ workdir: '/home/process-tree-reboot' });
      const rebootProcess = await rebooted.spawn('echo', ['process-rebooted']);
      const rebootOutput = await collectOutput(rebootProcess.stdout);
      const rebootExit = await rebootProcess.exit;
      await rebooted.teardown();

      return {
        capacityFailure,
        expectedCapacity,
        holderPids: holders.map((holder) => holder.pid),
        parentExit,
        parentOutput,
        publicStdio,
        rebootExit,
        rebootOutput,
        replacementExit,
        replacementOutput,
        replacementPid,
        nonYieldingExit,
        nonYieldingErrorText,
        teardownCompleted,
        teardownExit,
        teardownText,
        unrelatedState,
        waitingExit,
        waitingText
      };
    } finally {
      await runtime.teardown();
    }

    async function collectOutput(output: ReadableStream<Uint8Array>): Promise<string> {
      const reader = output.getReader();
      const decoder = new TextDecoder();
      let text = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) return text;
        text += decoder.decode(value, { stream: true });
      }
    }

    function captureOutput(output: ReadableStream<Uint8Array>): { readonly text: string; complete: Promise<string> } {
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

    function captureBinary(output: ReadableStream<Uint8Array>): {
      readonly text: string;
      readonly closedBeforeExit: boolean;
      complete: Promise<Uint8Array>;
    } {
      let text = '';
      let closedBeforeExit = false;
      const chunks: Uint8Array[] = [];
      let length = 0;
      const complete = (async () => {
        const reader = output.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            closedBeforeExit = true;
            const result = new Uint8Array(length);
            let offset = 0;
            for (const chunk of chunks) {
              result.set(chunk, offset);
              offset += chunk.byteLength;
            }
            return result;
          }
          const copy = new Uint8Array(value);
          chunks.push(copy);
          length += copy.byteLength;
          text += decoder.decode(copy, { stream: true });
        }
      })();
      return {
        get text() {
          return text;
        },
        get closedBeforeExit() {
          return closedBeforeExit;
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
      throw new Error(`Timed out waiting for ${expected}`);
    }

    function sleep(milliseconds: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, milliseconds));
    }
  });

  expect(result.parentExit, result.parentOutput).toBe(0);
  expect(result.publicStdio).toEqual({
    exit: 0,
    stdinBackpressured: true,
    stderr: [0, 255, 128, 10, 13, 42],
    stderrClosedBeforeExit: true,
    stdoutClosedBeforeExit: true,
    stdoutLength: 128 * 1024,
    stdoutMatchesInput: true
  });
  const parentIdentity = result.parentOutput.match(
    /parent-identity (\d+)\|0\|\/home\/process-tree\|inherited-value\|parent-arg/
  );
  expect(parentIdentity).not.toBeNull();
  const parentPid = Number(parentIdentity?.[1]);
  expect(parentPid).toBeGreaterThan(0);
  expect(result.parentOutput).toMatch(new RegExp(`global-child-output child-global-pid (?!${parentPid}\\b)\\d+`));
  expect(result.parentOutput).toContain(`parent-global-pid ${parentPid}`);
  expect(result.parentOutput).toMatch(
    new RegExp(
      `child-output child-identity (?!${parentPid}\\|)(\\d+)\\|${parentPid}\\|/home/process-tree/nested\\|inherited-value\\|child-value\\|child-arg`
    )
  );
  expect(result.parentOutput).toContain('child-output child-stdin-size 32772');
  expect(result.parentOutput).toContain('child-error child-stderr-size 32772');
  expect(result.parentOutput).toContain('child-stdin-drain');
  expect(result.parentOutput).toContain('child-exit 0 none');
  expect(result.parentOutput).toContain('child-close 0 none');
  expect(result.parentOutput).toContain('child-event-order exit>close');
  expect(result.parentOutput).toContain('child-stdin-accepted-without-backpressure false');
  expect(result.parentOutput).toContain('ignored-stdio-streams true true true');
  expect(result.parentOutput).not.toContain('ignored-child-output');
  expect(result.parentOutput).toContain('signalled-output signalled-child-ready');
  expect(result.parentOutput).toContain('signalled-output signalled-child-sigint');
  expect(result.parentOutput).toContain('signalled-exit none SIGINT');
  expect(result.parentOutput).toContain('signalled-close none SIGINT');
  expect(result.parentOutput).toContain('signalled-event-order exit>close');
  expect(result.parentOutput).toContain('ordinary-130-exit 130 none');
  expect(result.parentOutput).toContain('ordinary-130-close 130 none');
  expect(result.parentOutput).toContain('worker-threads-boundary ERR_WORKER_PATH');
  expect(result.parentOutput).toMatch(/worker-immediate-thread-id [1-9]\d*/);
  expect(result.parentOutput).toMatch(
    new RegExp(
      `worker-message thread-message\\|false\\|${parentPid}\\|(?!0\\|)\\d+\\|/home/process-tree\\|worker-value\\|thread-arg\\|thread-fixture\\|ping`
    )
  );
  expect(result.parentOutput).toContain('worker-exit 0');
  expect(result.parentOutput).toContain('worker-termination 1|1|false|terminating-thread-ready');
  expect(result.waitingExit).toBe(143);
  expect(result.waitingText).toContain('waiting-child-ready');
  expect(result.waitingText).toContain('waiting-child-sigterm');
  expect(result.unrelatedState).toBe('running');
  expect(result.holderPids).toHaveLength(result.expectedCapacity);
  expect(new Set(result.holderPids).size).toBe(result.expectedCapacity);
  expect(result.capacityFailure).toEqual({
    code: 'CAPACITY_EXHAUSTED',
    message: `Execution Capacity ${result.expectedCapacity} is exhausted.`
  });
  expect(result.replacementPid).toBeGreaterThan(Math.max(...result.holderPids));
  expect(result.replacementExit).toBe(0);
  expect(result.replacementOutput).toContain('capacity-recovered');
  expect(result.teardownCompleted).toBe(true);
  expect(result.nonYieldingExit, result.nonYieldingErrorText).toBe(137);
  expect(result.teardownExit).toBe(137);
  expect(result.teardownText).toContain('teardown-child-ready');
  expect(result.rebootExit).toBe(0);
  expect(result.rebootOutput).toBe('process-rebooted\n');
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
