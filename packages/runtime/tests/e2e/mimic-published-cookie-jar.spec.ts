import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';

const publishedEndpointCookieJarClaim = defineCompatibilityClaim({
  id: 'published-endpoint-cookie-jar-v1',
  statement:
    'Published Endpoints expose a CSP-safe synchronous document.cookie mirror over the endpoint- and runtime-epoch-isolated logical-origin Cookie Jar',
  target: {
    kind: 'runtime-capability',
    capability: 'published-endpoint-cookie-jar'
  }
});

test(publishedEndpointCookieJarClaim.statement, async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated)).toBe(true);

  const result = await page.evaluate(async (source) => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const { mergeProcessOutput } = await import('/tests/e2e/process-output.ts');
    const physicalCookieName = 'mimic_physical_cookie';
    const observedProcessOutput: string[] = [];
    document.cookie = `${physicalCookieName}=must-not-leak; Path=/`;

    const boot = async (workdirName: string) => {
      const runtime = await Mimic.boot({ workdir: `/home/${workdirName}` });
      await runtime.fs.mount({ 'server.mjs': { file: { contents: source } } });
      return { runtime };
    };
    const start = async (
      runtime: Awaited<ReturnType<typeof Mimic.boot>>,
      port: number
    ) => {
      const ready = new Promise<string>((resolve) => {
        const current = runtime.endpoints.current.find(
          (endpoint: { port: number }) => endpoint.port === port
        );
        if (current) {
          resolve(current.url);
          return;
        }
        const unsubscribe = runtime.endpoints.on('published', (endpoint) => {
          if (endpoint.port !== port) return;
          unsubscribe();
          resolve(endpoint.url);
        });
      });
      const process = await runtime.spawn(
        'node',
        [`${runtime.workdir}/server.mjs`, String(port)],
        { cwd: runtime.workdir }
      );
      const output = readProcessOutput(mergeProcessOutput(process));
      const url = await Promise.race([
        ready,
        process.exit.then((exitCode) => {
          throw new Error(`Cookie witness server on ${port} exited early with ${exitCode}.`);
        }),
        sleep(30_000).then(() => {
          throw new Error(`Cookie witness server on ${port} did not publish.`);
        })
      ]);
      return { process, output, url };
    };
    const stop = async (
      process: { kill(signal?: 'SIGTERM' | 'SIGKILL' | 'SIGINT'): void; exit: Promise<number> },
      output: Promise<string>
    ) => {
      process.kill('SIGTERM');
      await process.exit;
      return output;
    };
    const readCookie = async (
      runtime: Awaited<ReturnType<typeof Mimic.boot>>,
      url: string,
      path: string
    ) => {
      const response = await runtime.endpoints.fetch(new URL(path, url), { cache: 'no-store' });
      return { status: response.status, body: await response.text() };
    };
    const readWebSocketCookie = async (url: string, path: string) => {
      const token = crypto.randomUUID();
      return new Promise<string>((resolve, reject) => {
        const iframe = document.createElement('iframe');
        const finish = () => {
          clearTimeout(timeout);
          window.removeEventListener('message', receive);
          iframe.remove();
        };
        const receive = (event: MessageEvent<unknown>) => {
          if (
            typeof event.data !== 'object' ||
            event.data === null ||
            !('token' in event.data) ||
            event.data.token !== token
          ) return;
          finish();
          if ('error' in event.data) {
            reject(new Error(String(event.data.error)));
            return;
          }
          resolve('value' in event.data ? String(event.data.value) : '');
        };
        const timeout = setTimeout(() => {
          finish();
          reject(
            new Error(`Cookie witness WebSocket ${path} timed out.\n${observedProcessOutput.join('')}`)
          );
        }, 10_000);
        window.addEventListener('message', receive);
        const target = new URL('account/websocket-client', url);
        target.searchParams.set('token', token);
        target.searchParams.set('socket', path);
        iframe.src = target.href;
        document.body.appendChild(iframe);
      });
    };
    const openDocumentCookieWitness = async (url: string) => {
      const iframe = document.createElement('iframe');
      const loaded = new Promise<void>((resolve, reject) => {
        iframe.addEventListener('load', () => resolve(), { once: true });
        iframe.addEventListener('error', () => reject(new Error('Document cookie witness failed to load.')), {
          once: true
        });
      });
      iframe.src = new URL('account/document-cookie-client', url).href;
      document.body.appendChild(iframe);
      await loaded;
      const child = iframe.contentWindow;
      if (!child) throw new Error('Document cookie witness has no content window.');
      const initial = child.document.cookie;
      child.document.cookie = 'client=optimistic; Path=/account';
      const immediate = child.document.cookie;
      const requestSelection = await waitForValue('document write request selection', async () => {
        const response = await child.fetch(new URL('account/profile', url), {
          cache: 'no-store'
        });
        const value = await response.text();
        return value.includes('client=optimistic') ? value : undefined;
      });
      await child.fetch(new URL('account/concurrent', url), { cache: 'no-store' });
      const rebased = await waitForValue('concurrent response rebase', () => {
        const value = child.document.cookie;
        return value.includes('concurrent=server') ? value : undefined;
      });
      child.history.pushState(
        {},
        '',
        new URL('outside/document-cookie-client', url).pathname
      );
      const navigated = await waitForValue('history navigation snapshot', () => {
        const value = child.document.cookie;
        return value.includes('outside=only') ? value : undefined;
      });
      return {
        child,
        iframe,
        initial,
        immediate,
        requestSelection,
        rebased,
        navigated
      };
    };
    const waitForValue = async <Value>(
      label: string,
      read: () => Value | undefined | Promise<Value | undefined>
    ) => {
      const started = performance.now();
      while (performance.now() - started < 10_000) {
        const value = await read();
        if (value !== undefined) return value;
        await sleep(20);
      }
      throw new Error(`Document cookie witness did not reach its expected state: ${label}.`);
    };

    const first = await boot('published-cookie-first');
    try {
      const primary = await start(first.runtime, 5173);
      const mutation = await first.runtime.endpoints.fetch(new URL('set', primary.url), { cache: 'no-store' });
      const mutationResult = {
        status: mutation.status,
        body: await mutation.text(),
        exposedSetCookie: mutation.headers.get('set-cookie')
      };
      const webSocketSelection = await readWebSocketCookie(primary.url, 'account/socket');
      const afterWebSocketMutation = await readCookie(first.runtime, primary.url, 'account/after-websocket');
      const documentCookie = await openDocumentCookieWitness(primary.url);
      const selected = await readCookie(first.runtime, primary.url, 'account/profile');
      const outsidePath = await readCookie(first.runtime, primary.url, 'outside');
      const firstOutput = await stop(primary.process, primary.output);
      const closedDocumentCookieError = await waitForValue('endpoint close invalidation', () => {
        try {
          void documentCookie.child.document.cookie;
          return undefined;
        } catch (error) {
          return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        }
      });
      documentCookie.iframe.remove();

      const rebound = await start(first.runtime, 5173);
      const reboundSelection = await readCookie(first.runtime, rebound.url, 'account/rebound');
      const reboundOutput = await stop(rebound.process, rebound.output);

      const isolated = await start(first.runtime, 4173);
      const isolatedSelection = await readCookie(first.runtime, isolated.url, 'account/isolated');
      const isolatedOutput = await stop(isolated.process, isolated.output);

      await first.runtime.teardown();

      const reboot = await boot('published-cookie-reboot');
      try {
        const rebooted = await start(reboot.runtime, 5173);
        const rebootSelection = await readCookie(reboot.runtime, rebooted.url, 'account/reboot');
        const rebootOutput = await stop(rebooted.process, rebooted.output);
        await reboot.runtime.teardown();
        return {
          mutation: mutationResult,
          webSocketSelection,
          afterWebSocketMutation,
          documentCookie: {
            initial: documentCookie.initial,
            immediate: documentCookie.immediate,
            requestSelection: documentCookie.requestSelection,
            rebased: documentCookie.rebased,
            navigated: documentCookie.navigated,
            closedError: closedDocumentCookieError
          },
          selected,
          outsidePath,
          reboundSelection,
          isolatedSelection,
          rebootSelection,
          physicalCookie: document.cookie,
          output: [firstOutput, reboundOutput, isolatedOutput, rebootOutput].join('')
        };
      } finally {
        await reboot.runtime.teardown();
      }
    } finally {
      document.cookie = `${physicalCookieName}=; Path=/; Max-Age=0`;
      await first.runtime.teardown();
    }

    async function readProcessOutput(processOutput: ReadableStream<Uint8Array>): Promise<string> {
      const reader = processOutput.getReader();
      const decoder = new TextDecoder();
      let output = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) return output + decoder.decode();
        const decoded = decoder.decode(value, { stream: true });
        observedProcessOutput.push(decoded);
        output += decoded;
      }
    }

    function sleep(timeout: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, timeout));
    }
  }, cookieWitnessSource());

  expect(result.mutation).toEqual({
    status: 200,
    body: '',
    exposedSetCookie: null
  });
  expect(result.selected).toEqual({
    status: 200,
    body:
      'session=logical; theme=server; upgraded=websocket; client=optimistic; concurrent=server'
  });
  expect(result.webSocketSelection).toBe('session=logical; theme=server');
  expect(result.afterWebSocketMutation).toEqual({
    status: 200,
    body: 'session=logical; theme=server; upgraded=websocket'
  });
  expect(result.documentCookie.initial).toBe('theme=server');
  expect(result.documentCookie.immediate).toBe('theme=server; client=optimistic');
  expect(result.documentCookie.requestSelection).toContain('session=logical');
  expect(result.documentCookie.requestSelection).toContain('client=optimistic');
  expect(result.documentCookie.rebased).toContain('theme=server');
  expect(result.documentCookie.rebased).toContain('client=optimistic');
  expect(result.documentCookie.rebased).toContain('concurrent=server');
  expect(result.documentCookie.rebased).not.toContain('session=logical');
  expect(result.documentCookie.navigated).toBe('outside=only');
  expect(result.documentCookie.closedError).toContain('InvalidStateError');
  expect(result.outsidePath).toEqual({ status: 200, body: 'outside=only' });
  expect(result.reboundSelection).toEqual({
    status: 200,
    body:
      'session=logical; theme=server; upgraded=websocket; client=optimistic; concurrent=server'
  });
  expect(result.isolatedSelection).toEqual({ status: 200, body: '' });
  expect(result.rebootSelection).toEqual({ status: 200, body: '' });
  expect(result.physicalCookie).toContain('mimic_physical_cookie=must-not-leak');
  expect(result.output).not.toContain('falling back to registered command adapter');
  expect(result.output).not.toContain('vfsPreviewFallback');
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

function cookieWitnessSource(): string {
  return [
    "import http from 'node:http';",
    "import { createHash } from 'node:crypto';",
    '',
    'const port = Number(process.argv[2]);',
    'const keepAlive = setTimeout(() => {}, 120_000);',
    'const server = http.createServer((request, response) => {',
    "  if (request.url?.startsWith('/account/websocket-client')) {",
    "    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });",
    "    response.end(`<!doctype html><script>",
    "      const query = new URLSearchParams(location.search);",
    "      const target = new URL(query.get('socket') || 'socket', location.href);",
    "      target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';",
    "      const socket = new WebSocket(target);",
    "      socket.addEventListener('message', (event) => {",
    "        parent.postMessage({ token: query.get('token'), value: event.data }, location.origin);",
    "        socket.close();",
    "      }, { once: true });",
    "      socket.addEventListener('error', () => {",
    "        parent.postMessage({ token: query.get('token'), error: 'Cookie witness WebSocket failed.' }, location.origin);",
    "      }, { once: true });",
    "    <\\/script>`);",
    '    return;',
    '  }',
    "  if (request.url === '/set') {",
    "    response.setHeader('set-cookie', [",
    "      'session=logical; Path=/account; HttpOnly; SameSite=Strict',",
    "      'theme=server; Path=/account',",
    "      'outside=only; Path=/outside'",
    '    ]);',
    "    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });",
    "    response.end(request.headers.cookie || '');",
    '    return;',
    '  }',
    "  if (request.url === '/account/concurrent') {",
    "    response.setHeader('set-cookie', 'concurrent=server; Path=/account');",
    "    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });",
    "    response.end(request.headers.cookie || '');",
    '    return;',
    '  }',
    "  if (request.url === '/account/document-cookie-client') {",
    "    response.writeHead(200, {",
    "      'content-type': 'text/html; charset=utf-8',",
    "      'content-security-policy': \"default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'\"",
    '    });',
    "    response.end('<!doctype html><html><head><title>document cookie witness</title></head><body>ready</body></html>');",
    '    return;',
    '  }',
    "  response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });",
    "  response.end(request.headers.cookie || '');",
    '});',
    "server.on('upgrade', (request, socket) => {",
    "  console.log('cookie-upgrade', request.url, request.headers.cookie || 'none');",
    "  const key = request.headers['sec-websocket-key'];",
    "  const accept = createHash('sha1')",
    "    .update(String(key) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')",
    "    .digest('base64');",
    '  socket.write([',
    "    'HTTP/1.1 101 Switching Protocols',",
    "    'Connection: Upgrade',",
    "    'Upgrade: websocket',",
    "    'Sec-WebSocket-Accept: ' + accept,",
    "    'Set-Cookie: upgraded=websocket; Path=/account; HttpOnly',",
    "    '',",
    "    ''",
    "  ].join('\\r\\n'));",
    "  const payload = Buffer.from(request.headers.cookie || '');",
    '  socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));',
    '});',
    "server.listen(port, '127.0.0.1');",
    'void keepAlive;'
  ].join('\n');
}
