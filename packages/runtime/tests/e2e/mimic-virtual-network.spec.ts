import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';
import {
  disposeRuntimeHostWorkerHook,
  installRuntimeHostWorkerHook
} from './runtime-host-worker-hook';

const CRASH_MESSAGE = 'mimic:crash-js-process-worker';

const virtualNetworkCompatibilityClaim = defineCompatibilityClaim({
  id: 'virtual-network-supervisor-authority-v1',
  statement: 'Mimic processes share byte-exact loopback, lifecycle, refusal, and backpressure through one Virtual Network owner',
  target: {
    kind: 'runtime-capability',
    capability: 'virtual-network-supervisor-authority'
  }
});

test(virtualNetworkCompatibilityClaim.statement, async ({ page }) => {
  test.setTimeout(90_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));

  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated)).toBe(true);
  // Process workers belong to the Runtime Host Worker: the hook crashes the
  // newest running one there when the page asks. The Runtime Host keeps a
  // spare process worker ahead of demand (ADR-0031), so the newest worker
  // created is the idle spare; a worker runs a process once the host first
  // posts to it.
  await installRuntimeHostWorkerHook(
    page,
    [
      'const NativeWorker = globalThis.Worker;',
      'const runningWorkers = [];',
      'self.addEventListener("message", (event) => {',
      `  if (event.data?.type !== ${JSON.stringify(CRASH_MESSAGE)}) return;`,
      '  const crashWorker = runningWorkers.at(-1);',
      "  const crash = new Error('forced browser claim worker crash');",
      "  crashWorker?.dispatchEvent(new ErrorEvent('error', { error: crash, message: crash.message }));",
      '  crashWorker?.terminate();',
      '});',
      'globalThis.Worker = class extends NativeWorker {',
      '  constructor(scriptURL, options) {',
      '    super(scriptURL, options);',
      "    if (options?.name !== 'mimic-js-process') return;",
      '    const post = this.postMessage.bind(this);',
      '    this.postMessage = (...args) => {',
      '      if (!runningWorkers.includes(this)) runningWorkers.push(this);',
      '      return post(...args);',
      '    };',
      '  }',
      '};'
    ].join('\n')
  );

  const result = await page.evaluate(async (crashMessage) => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const { mergeProcessOutput } = await import('/tests/e2e/process-output.ts');
    const runtime = await Mimic.boot({ workdir: '/home/virtual-network' });
    const readOutput = async (process: Awaited<ReturnType<typeof runtime.spawn>>) => {
      const decoder = new TextDecoder();
      const reader = mergeProcessOutput(process).getReader();
      let text = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    };
    try {
      await runtime.fs.mount({
        'server.mjs': {
          file: {
            contents: [
              "import http from 'node:http';",
              'setTimeout(() => {}, 120_000);',
              "const server = http.createServer((_request, response) => {",
              "  response.writeHead(200, { 'content-type': 'application/octet-stream' });",
              "  response.end(new Uint8Array([0, 127, 128, 255]));",
              '});',
              "server.listen(8123, '127.0.0.1', () => console.log('shared-network-server', process.pid));"
            ].join('\n')
          }
        },
        'client.mjs': {
          file: {
            contents: [
              "import http from 'node:http';",
              'const timeout = setTimeout(() => { throw new Error(\'shared network timed out\'); }, 10_000);',
              "const request = http.get({ hostname: '127.0.0.1', port: 8123, path: '/' }, (response) => {",
              '  const chunks = [];',
              "  response.on('data', (chunk) => chunks.push(...chunk));",
              "  response.on('end', () => { clearTimeout(timeout); console.log('shared-network-client', process.pid, response.statusCode, chunks.join(',')); });",
              '});',
              "request.on('error', (error) => { clearTimeout(timeout); console.error('shared-network-error', error.code, error.message); });"
            ].join('\n')
          }
        },
        'lifecycle.mjs': {
          file: {
            contents: [
              "import net from 'node:net';",
              'await new Promise((resolve, reject) => {',
              '  const server = net.createServer((socket) => {',
              '    let received = 0;',
              "    socket.on('data', (chunk) => { received += chunk.length; });",
              '    socket.pause();',
              "    console.log('lifecycle-peer-paused');",
              "    setTimeout(() => { console.log('lifecycle-peer-resuming'); socket.resume(); }, 300);",
              "    socket.on('end', () => { socket.end(); server.close(() => {",
              "      console.log('lifecycle-server-closed', received);",
              '      const rebound = net.createServer();',
              "      rebound.listen(8124, '127.0.0.1', () => rebound.close(() => { console.log('lifecycle-address-reused'); resolve(); }));",
              '    }); });',
              '  });',
              "  server.on('error', reject);",
              "  server.listen(8124, '127.0.0.1', () => {",
              "    console.log('lifecycle-server-ready', process.pid);",
              "    const socket = net.connect({ host: '127.0.0.1', port: 8124 });",
              "    socket.on('connect', () => setTimeout(() => {",
              "      const accepted = socket.write(new Uint8Array(16 * 1024), () => console.log('lifecycle-write-callback'));",
              "      console.log('lifecycle-write-return', accepted);",
              '      if (accepted) socket.end();',
              "      else socket.once('drain', () => { console.log('lifecycle-drain'); socket.end(); });",
              '    }, 100));',
              "    socket.on('error', reject);",
              '  });',
              '});'
            ].join('\n')
          }
        },
        'refused-client.mjs': {
          file: {
            contents: [
              "import net from 'node:net';",
              'await new Promise((resolve) => {',
              "  const socket = net.connect({ host: '127.0.0.1', port: 8999 });",
              "  socket.on('error', (error) => console.log('refused-client', error.code, error.message));",
              "  socket.on('close', resolve);",
              '});'
            ].join('\n')
          }
        },
        'cancelled-client.mjs': {
          file: {
            contents: [
              "import net from 'node:net';",
              'await new Promise((resolve) => {',
              "  const socket = net.connect({ host: '127.0.0.1', port: 8998 });",
              "  socket.on('error', (error) => console.log('cancelled-client', error.code));",
              "  socket.on('close', resolve);",
              "  socket.destroy(Object.assign(new Error('cancelled by browser claim'), { code: 'ECANCELED' }));",
              '});'
            ].join('\n')
          }
        },
        'crash-server.mjs': {
          file: {
            contents: [
              "import http from 'node:http';",
              'setTimeout(() => {}, 120_000);',
              "http.createServer((_request, response) => response.end()).listen(8125, '127.0.0.1', () => console.log('crash-server-ready'));"
            ].join('\n')
          }
        },
        'crash-rebind.mjs': {
          file: {
            contents: [
              "import net from 'node:net';",
              'await new Promise((resolve, reject) => {',
              '  const server = net.createServer();',
              "  server.on('error', reject);",
              "  server.listen(8125, '127.0.0.1', () => server.close(() => { console.log('crash-address-reused'); resolve(); }));",
              '});'
            ].join('\n')
          }
        }
      });

      const waitForPort = (port: number) => new Promise<void>((resolve) => {
        const unsubscribe = runtime.endpoints.on('published', (endpoint) => {
          if (endpoint.port !== port) return;
          unsubscribe();
          resolve();
        });
      });
      const ready = waitForPort(8123);
      const server = await runtime.spawn('node', [`${runtime.workdir}/server.mjs`]);
      const serverOutputPromise = readOutput(server);
      await Promise.race([
        ready,
        server.exit.then((code) => {
          throw new Error(`server exited before listen: ${code}`);
        }),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('server-ready timed out')), 20_000))
      ]);

      const client = await runtime.spawn('node', [`${runtime.workdir}/client.mjs`]);
      const clientOutputPromise = readOutput(client);
      const clientExit = await client.exit;
      const clientOutput = await clientOutputPromise;
      server.kill('SIGTERM');
      const serverExit = await server.exit;
      const serverOutput = await serverOutputPromise;

      const lifecycle = await runtime.spawn('node', [`${runtime.workdir}/lifecycle.mjs`]);
      const lifecycleOutputPromise = readOutput(lifecycle);
      const lifecycleExit = await lifecycle.exit;
      const lifecycleOutput = await lifecycleOutputPromise;
      const refusedClient = await runtime.spawn('node', [`${runtime.workdir}/refused-client.mjs`]);
      const refusedClientOutputPromise = readOutput(refusedClient);
      const refusedClientExit = await refusedClient.exit;
      const refusedClientOutput = await refusedClientOutputPromise;
      const cancelledClient = await runtime.spawn('node', [`${runtime.workdir}/cancelled-client.mjs`]);
      const cancelledClientOutputPromise = readOutput(cancelledClient);
      const cancelledClientExit = await cancelledClient.exit;
      const cancelledClientOutput = await cancelledClientOutputPromise;
      const crashReady = waitForPort(8125);
      const crashServer = await runtime.spawn('node', [`${runtime.workdir}/crash-server.mjs`]);
      const crashServerOutputPromise = readOutput(crashServer);
      await Promise.race([
        crashReady,
        crashServer.exit.then((code) => {
          throw new Error(`crash server exited before listen: ${code}`);
        }),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('crash server-ready timed out')), 20_000))
      ]);
      (
        globalThis as typeof globalThis & {
          __postToMimicRuntimeHostWorker(message: unknown): Promise<void>;
        }
      ).__postToMimicRuntimeHostWorker({ type: crashMessage });
      const crashServerOutcome = await Promise.race([
        crashServer.exit,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('crashed worker exit timed out')), 20_000))
      ]).then(
        (code) => ({ type: 'exit' as const, code }),
        (error: unknown) => ({
          type: 'crash' as const,
          code:
            error &&
            typeof error === 'object' &&
            'code' in error &&
            typeof error.code === 'string'
              ? error.code
              : undefined,
          message: error instanceof Error ? error.message : String(error),
          name: error instanceof Error ? error.name : 'Error',
          pid:
            error &&
            typeof error === 'object' &&
            'pid' in error &&
            typeof error.pid === 'number'
              ? error.pid
              : undefined
        })
      );
      // A crash that never lands leaves the server listening; end it so the
      // claim fails on the outcome instead of waiting for output that never closes.
      if (crashServerOutcome.type === 'crash' && crashServerOutcome.message === 'crashed worker exit timed out') {
        crashServer.kill('SIGKILL');
      }
      const crashServerOutput = await crashServerOutputPromise.catch(
        (error: unknown) =>
          error instanceof Error ? error.message : String(error)
      );
      const crashRebind = await runtime.spawn('node', [`${runtime.workdir}/crash-rebind.mjs`]);
      const crashRebindOutputPromise = readOutput(crashRebind);
      const crashRebindExit = await crashRebind.exit;
      const crashRebindOutput = await crashRebindOutputPromise;
      return {
        clientExit,
        clientOutput,
        serverExit,
        serverOutput,
        lifecycleExit,
        lifecycleOutput,
        refusedClientExit,
        refusedClientOutput,
        cancelledClientExit,
        cancelledClientOutput,
        crashServerOutcome,
        crashServerOutput,
        crashRebindExit,
        crashRebindOutput
      };
    } finally {
      await runtime.teardown();
    }
  }, CRASH_MESSAGE).finally(() => disposeRuntimeHostWorkerHook(page));

  expect(await page.evaluate(() => 'responsive')).toBe('responsive');

  expect(result.clientExit, result.clientOutput).toBe(0);
  expect(result.clientOutput).toContain('shared-network-client 1000001 200 0,127,128,255');
  expect(result.clientOutput).not.toContain('shared-network-error');
  expect(result.serverOutput).toContain('shared-network-server 1');
  expect(result.serverExit).toBe(143);
  expect(result.lifecycleExit, result.lifecycleOutput).toBe(0);
  expect(result.lifecycleOutput).toContain('lifecycle-write-return false');
  expect(result.lifecycleOutput).toContain('lifecycle-drain');
  expect(result.lifecycleOutput).toContain('lifecycle-write-callback');
  expect(result.lifecycleOutput).toContain('lifecycle-peer-paused');
  expect(result.lifecycleOutput).toContain('lifecycle-peer-resuming');
  expect(result.lifecycleOutput).toContain('lifecycle-server-closed 16384');
  expect(result.lifecycleOutput).toContain('lifecycle-address-reused');
  const lifecycleDrainEvents = [
    'lifecycle-peer-paused',
    'lifecycle-write-return false',
    'lifecycle-peer-resuming',
    'lifecycle-drain'
  ];
  const lifecycleDrainPositions = lifecycleDrainEvents.map((event) => result.lifecycleOutput.indexOf(event));
  expect(lifecycleDrainPositions).toEqual([...lifecycleDrainPositions].sort((a, b) => a - b));
  expect(result.lifecycleOutput.indexOf('lifecycle-write-callback')).toBeGreaterThan(
    result.lifecycleOutput.indexOf('lifecycle-peer-resuming')
  );
  expect(result.refusedClientExit, result.refusedClientOutput).toBe(0);
  expect(result.refusedClientOutput).toContain('refused-client ECONNREFUSED');
  expect(result.cancelledClientExit, result.cancelledClientOutput).toBe(0);
  expect(result.cancelledClientOutput).toContain('cancelled-client ECANCELED');
  expect(result.crashServerOutcome, result.crashServerOutput).toMatchObject({
    type: 'crash',
    code: 'PROCESS_CRASH',
    name: 'MimicProcessCrashError'
  });
  expect(result.crashServerOutput).toContain('forced browser claim worker crash');
  expect(result.crashRebindExit, result.crashRebindOutput).toBe(0);
  expect(result.crashRebindOutput).toContain('crash-address-reused');
  expect(pageErrors).toEqual([]);
});
