import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';
import {
  startCleanExternalConsumer,
  type CleanExternalConsumerWindow
} from './clean-external-consumer-harness';

type CleanExternalConsumerBridge =
  CleanExternalConsumerWindow['__cleanExternalConsumer'];
type CleanExternalConsumerRuntime = Awaited<
  ReturnType<CleanExternalConsumerBridge['Mimic']['boot']>
>;
type CleanExternalConsumerProcess = Awaited<
  ReturnType<CleanExternalConsumerRuntime['spawn']>
>;
type CleanExternalConsumerEndpoint =
  CleanExternalConsumerRuntime['endpoints']['current'][number];

const cleanExternalConsumerClaim = defineCompatibilityClaim({
  id: 'mimic-clean-external-consumer-v1',
  statement:
    'A clean consumer installs the packed @mimic-js/mimic artifact and uses its public Mimic API to mount, spawn, publish, terminate, tear down, and reboot a generic Node HTTP server without fallback paths',
  target: {
    kind: 'runtime-capability',
    capability: 'mimic-clean-external-consumer'
  }
});

test(cleanExternalConsumerClaim.statement, async ({ page }) => {
  test.setTimeout(180_000);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const requestedUrls: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  page.on('requestfailed', (request) => {
    requestFailures.push(`${request.failure()?.errorText ?? 'failed'} ${request.url()}`);
  });
  page.on('request', (request) => requestedUrls.push(request.url()));

  const consumer = await startCleanExternalConsumer();
  try {
    expect(consumer.consumerRoot).not.toBe('');
    expect(consumer.packedArtifact).toContain('mimic-js-mimic-');
    await page.goto(consumer.url, { waitUntil: 'domcontentloaded' });
    await expect.poll(() => page.evaluate(() => window.crossOriginIsolated)).toBe(true);
    await expect.poll(() => page.evaluate(() => Reflect.has(window, '__cleanExternalConsumer'))).toBe(true);

    const receipt = await page.evaluate(async () => {
      const bridge = readBridge();
      const first = await runCycle('first', '/home/clean-external-consumer-first');
      const reboot = await runCycle('reboot', '/home/clean-external-consumer-reboot');

      return { first, reboot };

      async function runCycle(run: 'first' | 'reboot', workdir: string) {
        const runtime = await bridge.Mimic.boot({ workdir });
        let tornDown = false;
        try {
          if (runtime.workdir !== workdir) {
            throw new Error(`Public Mimic boot changed the canonical workdir from ${workdir} to ${runtime.workdir}`);
          }
          await runtime.fs.mount({
            'server.mjs': {
              file: { contents: serverSource(run) }
            }
          });

          const process = await runtime.spawn('node', [`${runtime.workdir}/server.mjs`], { cwd: runtime.workdir });
          const output = collectOutput(process);
          const endpoint = await waitForEndpoint(runtime, 60_000);
          const response = await runtime.endpoints.fetch(new URL('runtime-proof', endpoint.url), { cache: 'no-store' });
          const body = await response.text();
          process.kill('SIGTERM');
          const exitCode = await waitForExit(process, output.text, 30_000);
          const processOutput = await output.done;
          await waitForEndpointRemoval(runtime, endpoint.url, 10_000);
          await runtime.teardown();
          tornDown = true;

          return {
            workdir: runtime.workdir,
            endpoint: { port: endpoint.address.port, sameOrigin: new URL(endpoint.url).origin === location.origin },
            response: {
              status: response.status,
              owner: response.headers.get('x-external-consumer-run'),
              body
            },
            termination: { exitCode, output: processOutput, endpointUnpublished: true },
            tornDown
          };
        } finally {
          if (!tornDown) await runtime.teardown();
        }
      }

      function readBridge(): CleanExternalConsumerBridge {
        const candidate = (
          globalThis as typeof globalThis & { readonly __cleanExternalConsumer?: unknown }
        ).__cleanExternalConsumer;
        if (!isConsumerBridge(candidate)) {
          throw new Error('Clean external consumer page did not expose window.__cleanExternalConsumer.Mimic');
        }
        return candidate;
      }

      function isConsumerBridge(
        value: unknown
      ): value is CleanExternalConsumerBridge {
        if (!isRecord(value)) return false;
        const Mimic = value.Mimic;
        return (
          typeof Mimic === 'function' &&
          typeof (Mimic as { readonly boot?: unknown }).boot === 'function'
        );
      }

      function isRecord(value: unknown): value is Record<string, unknown> {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
      }

      function serverSource(run: 'first' | 'reboot'): string {
        return [
          "import http from 'node:http';",
          '',
          `const run = ${JSON.stringify(run)};`,
          'const server = http.createServer((request, response) => {',
          "  if (request.url !== '/runtime-proof') { response.writeHead(404); response.end('not found'); return; }",
          "  response.writeHead(200, { 'content-type': 'text/plain', 'x-external-consumer-run': run });",
          "  response.end('external-consumer:' + run);",
          '});',
          "server.listen(4111, '127.0.0.1', () => console.log('external-consumer-server-ready:' + run));"
        ].join('\n');
      }

      function collectOutput(
        process: CleanExternalConsumerProcess
      ): Readonly<{ done: Promise<string>; text(): string }> {
        let text = '';
        const done = Promise.all([read(process.stdout), read(process.stderr)]).then(() => text);
        return { done, text: () => text };

        async function read(stream: ReadableStream<Uint8Array>): Promise<void> {
          const reader = stream.getReader();
          const decoder = new TextDecoder();
          try {
            while (true) {
              const { done, value } = await reader.read();
              text += decoder.decode(value, { stream: !done });
              if (done) return;
            }
          } finally {
            reader.releaseLock();
          }
        }
      }

      async function waitForEndpoint(
        runtime: CleanExternalConsumerRuntime,
        timeoutMs: number
      ): Promise<CleanExternalConsumerEndpoint> {
        const current = runtime.endpoints.current[0];
        if (current) return current;
        return new Promise<CleanExternalConsumerEndpoint>((resolve, reject) => {
          let unsubscribe: (() => void) | undefined;
          const timer = setTimeout(() => {
            unsubscribe?.();
            reject(new Error(`Timed out waiting for the Published Endpoint after ${timeoutMs}ms`));
          }, timeoutMs);
          unsubscribe = runtime.endpoints.on('published', (endpoint) => {
            clearTimeout(timer);
            unsubscribe?.();
            resolve(endpoint);
          });
        });
      }

      async function waitForEndpointRemoval(
        runtime: CleanExternalConsumerRuntime,
        endpointUrl: string,
        timeoutMs: number
      ): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (runtime.endpoints.current.every((endpoint) => endpoint.url !== endpointUrl)) return;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error(`Published Endpoint remained live after process termination: ${endpointUrl}`);
      }

      async function waitForExit(
        process: CleanExternalConsumerProcess,
        output: () => string,
        timeoutMs: number
      ): Promise<number> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            process.exit,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error(`Server process did not stop within ${timeoutMs}ms:\n${output()}`)),
                timeoutMs
              );
            })
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }
    });

    for (const cycle of [receipt.first, receipt.reboot]) {
      expect(cycle.endpoint).toEqual({ port: 4111, sameOrigin: true });
      expect(cycle.response).toEqual({
        status: 200,
        owner: cycle === receipt.first ? 'first' : 'reboot',
        body: `external-consumer:${cycle === receipt.first ? 'first' : 'reboot'}`
      });
      expect(cycle.termination.exitCode, cycle.termination.output).toBe(143);
      expect(cycle.termination.output).toContain(`external-consumer-server-ready:${cycle === receipt.first ? 'first' : 'reboot'}`);
      expect(cycle.termination.endpointUnpublished).toBe(true);
      expect(cycle.tornDown).toBe(true);
    }

    const evidence = [
      receipt.first.termination.output,
      receipt.reboot.termination.output,
      ...consoleErrors,
      ...pageErrors,
      ...requestFailures,
      ...requestedUrls
    ].join('\n');
    const forbiddenEvidence = [
      'falling back to registered command adapter',
      'registered-command-adapter',
      'esm.sh',
      'vfsPreviewFallback',
      '/src/runtime',
      '../src/runtime',
      '/tests/e2e'
    ];
    expect(forbiddenEvidence.filter((marker) => evidence.includes(marker))).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(requestFailures).toEqual([]);
  } finally {
    await consumer.close();
  }
});
