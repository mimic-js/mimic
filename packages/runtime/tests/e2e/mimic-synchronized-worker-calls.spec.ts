import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';

const synchronizedWorkerCallsClaim = defineCompatibilityClaim({
  id: 'worker-threads-synchronized-calls-v1',
  statement:
    'A program calls a Worker Thread synchronously the way make-synchronized does: the thread listens with addListener, answers on a transferred port it then closes, and its Worker reads the output the stdout option keeps from the process',
  target: {
    kind: 'runtime-capability',
    capability: 'worker-threads-synchronized-calls'
  }
});

// More calls than a process had pooled signals for before they stopped running out.
const CALLS = 300;

const workerSource = [
  "import { parentPort } from 'node:worker_threads';",
  "parentPort.addListener('message', async ({ signal, port, value }) => {",
  '  await null;',
  "  if (value === 0) console.log('from the thread');",
  '  port.postMessage(value * 2);',
  '  Atomics.store(signal, 0, 1);',
  '  Atomics.notify(signal, 0, 1);',
  '  port.close();',
  '});'
].join('\n');

const entrySource = [
  "const { join } = require('node:path');",
  "const { MessageChannel, Worker, receiveMessageOnPort } = require('node:worker_threads');",
  "const worker = new Worker(join(__dirname, 'worker.mjs'), { stdout: true, stderr: true });",
  "let threadOutput = '';",
  "worker.stdout.on('data', (chunk) => { threadOutput += chunk; });",
  'const call = (value) => {',
  '  const signal = new Int32Array(new SharedArrayBuffer(4));',
  '  const { port1, port2 } = new MessageChannel();',
  '  worker.postMessage({ signal, port: port2, value }, [port2]);',
  "  if (Atomics.wait(signal, 0, 0, 20_000) === 'timed-out') throw new Error('The thread did not answer call ' + value);",
  '  return receiveMessageOnPort(port1)?.message;',
  '};',
  'const answers = [];',
  `for (let value = 0; value < ${CALLS}; value += 1) answers.push(call(value));`,
  'setTimeout(async () => {',
  '  const exit = await worker.terminate();',
  '  console.log(JSON.stringify({',
  '    answered: answers.filter((answer, value) => answer === value * 2).length,',
  '    threadOutput,',
  '    exit',
  '  }));',
  '}, 100);'
].join('\n');

test(synchronizedWorkerCallsClaim.statement, async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated)).toBe(true);

  const result = await page.evaluate(
    async ({ entry, worker }) => {
      const { Mimic } = await import('/src/runtime/index.ts');
      const { mergeProcessOutput } = await import('/tests/e2e/process-output.ts');
      const runtime = await Mimic.boot({ workdir: '/home/synchronized-worker-calls' });
      try {
        await runtime.fs.mount({
          'entry.cjs': { file: { contents: entry } },
          'worker.mjs': { file: { contents: worker } }
        });
        const process = await runtime.spawn('node', ['entry.cjs']);
        const decoder = new TextDecoder();
        let output = '';
        await mergeProcessOutput(process).pipeTo(
          new WritableStream({
            write(chunk) {
              output += decoder.decode(chunk, { stream: true });
            }
          })
        );
        return { exit: await process.exit, output };
      } finally {
        await runtime.teardown();
      }
    },
    { entry: entrySource, worker: workerSource }
  );

  // The thread's line reached the Worker's stream only: the process printed the receipt alone.
  expect(result.exit).toBe(0);
  expect(JSON.parse(result.output)).toEqual({
    answered: CALLS,
    threadOutput: 'from the thread\n',
    exit: 1
  });
});
