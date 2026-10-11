import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';

const forkClaim = defineCompatibilityClaim({
  id: 'node-compatibility-child-process-fork-ipc-v1',
  statement:
    'Mimic forks Node children with an IPC channel: messages in both directions, in order, from before the child starts, and disconnect when either side ends',
  target: {
    kind: 'runtime-capability',
    capability: 'node-compatibility-child-process-fork-ipc'
  }
});

test(forkClaim.statement, async ({ page }) => {
  test.setTimeout(120_000);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => message.type() === 'error' && consoleErrors.push(message.text()));
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));

  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated), { timeout: 10_000 }).toBe(true);

  const result = await page.evaluate(async () => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const { mergeProcessOutput } = await import('/tests/e2e/process-output.ts');
    const runtime = await Mimic.boot({ workdir: '/home/fork' });
    try {
      await runtime.fs.mount({
        // The shape of nx's task runner: the parent sends the task at once and
        // reads the child's piped output; the child answers and exits.
        'parent.cjs': {
          file: {
            contents: [
              "const { fork } = require('node:child_process');",
              "const child = fork(__dirname + '/child.cjs', ['task-arg'], { stdio: ['inherit', 'pipe', 'pipe', 'ipc'], execArgv: ['--no-warnings'] });",
              'const events = [];',
              "for (let index = 0; index < 3; index += 1) child.send({ index, at: new Date(index) });",
              "child.stdout.on('data', (chunk) => events.push('stdout ' + String(chunk).trim()));",
              "child.on('message', (message) => events.push('message ' + JSON.stringify(message)));",
              "child.on('disconnect', () => events.push('disconnect'));",
              "child.on('exit', (code) => events.push('exit ' + code + ' connected=' + child.connected));",
              "child.on('close', () => console.log(JSON.stringify({ pid: typeof child.pid, events })));"
            ].join('\n')
          }
        },
        'child.cjs': {
          file: {
            contents: [
              'const received = [];',
              "console.log('argv', process.argv.slice(2).join(','), 'execArgv', process.execArgv.join(','), 'connected', process.connected);",
              "process.on('message', (message) => {",
              '  received.push(message);',
              '  if (received.length < 3) return;',
              "  process.send({ received }, () => process.exit(0));",
              '});'
            ].join('\n')
          }
        },
        // A child that lives on after its parent: it hears the disconnect.
        'orphan-parent.cjs': {
          file: {
            contents: [
              "const { fork } = require('node:child_process');",
              "const child = fork(__dirname + '/orphan.cjs');",
              "child.on('message', (message) => { console.log('parent heard', message); process.exit(0); });"
            ].join('\n')
          }
        },
        'orphan.cjs': {
          file: {
            contents: [
              "process.on('disconnect', () => { console.log('orphan disconnected', process.connected); process.exit(0); });",
              "process.send('ready');"
            ].join('\n')
          }
        },
        // ngcc's shape: the primary forks workers that take tasks over the channel.
        'cluster.cjs': {
          file: {
            contents: [
              "const cluster = require('node:cluster');",
              'if (cluster.isPrimary) {',
              '  const done = [];',
              "  cluster.on('message', (worker, message) => {",
              '    done.push(message);',
              '    if (done.length < 2) return;',
              "    console.log('primary', JSON.stringify(done.sort((a, b) => a.worker - b.worker)));",
              "    for (const worker of Object.values(cluster.workers)) worker.send('stop');",
              '  });',
              "  cluster.on('online', (worker) => worker.send({ task: worker.id * 10 }));",
              '  cluster.fork();',
              '  cluster.fork();',
              '} else {',
              "  cluster.worker.on('message', (message) => {",
              "    if (message === 'stop') process.exit(0);",
              '    process.send({ worker: cluster.worker.id, result: message.task + 1 });',
              '  });',
              '}'
            ].join('\n')
          }
        },
        // A process started without fork has no channel.
        'plain.cjs': {
          file: { contents: "console.log(typeof process.send, process.connected === undefined || process.connected === false);" }
        }
      });

      return {
        fork: await run(['parent.cjs']),
        orphan: await run(['orphan-parent.cjs']),
        plain: await run(['plain.cjs']),
        cluster: await run(['cluster.cjs'])
      };
    } finally {
      await runtime.teardown();
    }

    async function run(args: string[]) {
      const process = await runtime.spawn('node', args);
      const reader = mergeProcessOutput(process).getReader();
      const decoder = new TextDecoder();
      let output = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        output += decoder.decode(value, { stream: true });
      }
      return { exitCode: await process.exit, output };
    }
  });

  expect(result.fork.exitCode, result.fork.output).toBe(0);
  const forked = JSON.parse(result.fork.output.trim().split('\n').at(-1)!) as { pid: string; events: string[] };
  expect(forked.pid).toBe('number');
  expect(forked.events.slice(0, 2)).toEqual([
    'stdout argv task-arg execArgv --no-warnings connected true',
    `message ${JSON.stringify({
      received: [0, 1, 2].map((index) => ({ index, at: new Date(index).toISOString() }))
    })}`
  ]);
  // The channel and the process end together; Node orders their events either way.
  expect(forked.events.slice(2).sort()).toEqual(['disconnect', 'exit 0 connected=false']);

  expect(result.orphan.exitCode, result.orphan.output).toBe(0);
  expect(result.orphan.output).toContain('parent heard ready');
  expect(result.plain).toEqual({ exitCode: 0, output: 'undefined true\n' });
  expect(result.cluster.exitCode, result.cluster.output).toBe(0);
  expect(result.cluster.output).toBe(
    `primary ${JSON.stringify([{ worker: 1, result: 11 }, { worker: 2, result: 21 }])}\n`
  );
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
