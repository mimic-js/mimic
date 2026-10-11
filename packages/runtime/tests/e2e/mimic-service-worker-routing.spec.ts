import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { expect, test } from '@playwright/test';

import {
  PUBLISHED_ENDPOINT_SERVICE_WORKER_TOKEN
} from '../../src/runtime/modules/published-endpoint/service';
import { connectRpc, type RpcPort } from '../../src/runtime/modules/worker-transport';

type Listener = (event: Record<string, unknown>) => void;

class MockMessageChannel {
  readonly port1 = new MockMessagePort();
  readonly port2 = new MockMessagePort();

  constructor() {
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
}

class MockMessagePort {
  peer?: MockMessagePort;
  onmessage?: (event: { data: unknown; ports: MockMessagePort[] }) => void;
  readonly listeners = new Set<(event: { data: unknown; ports: MockMessagePort[] }) => void>();

  postMessage(data: unknown, transfer: unknown[] = []): void {
    const ports = transfer.filter(
      (value): value is MockMessagePort => value instanceof MockMessagePort
    );
    setTimeout(() => {
      const event = { data, ports };
      this.peer?.onmessage?.(event);
      for (const listener of this.peer?.listeners ?? []) listener(event);
    }, 0);
  }

  addEventListener(
    type: string,
    listener: (event: { data: unknown; ports: MockMessagePort[] }) => void
  ): void {
    if (type === 'message') this.listeners.add(listener);
  }

  removeEventListener(
    type: string,
    listener: (event: { data: unknown; ports: MockMessagePort[] }) => void
  ): void {
    if (type === 'message') this.listeners.delete(listener);
  }

  start(): void {}

  close(): void {
    this.onmessage = undefined;
    this.listeners.clear();
  }
}

test('the RPC preserves stream pressure and the Service Worker rejects a stale token', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });

  const result = await page.evaluate(async (expectedToken) => {
    const { connectRpc, transfer } = await import(
      '/src/runtime/modules/worker-transport/index.ts'
    );
    const channel = new MessageChannel();
    let resolveReceived!: (stream: ReadableStream<number>) => void;
    const received = new Promise<ReadableStream<number>>((resolve) => {
      resolveReceived = resolve;
    });
    const server = connectRpc(channel.port1, {
      receive: (stream: ReadableStream<number>) => resolveReceived(stream)
    });
    const client = connectRpc<{ receive(stream: ReadableStream<number>): void }>(
      channel.port2
    );
    let pulls = 0;
    const stream = new ReadableStream<number>(
      {
        pull(controller) {
          controller.enqueue(pulls++);
          if (pulls === 100) controller.close();
        }
      },
      { highWaterMark: 0 }
    );
    client.notify.receive(transfer(stream, [stream]));
    const reader = (await received).getReader();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const pullsBeforeRead = pulls;
    const first = await reader.read();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const pullsAfterRead = pulls;
    await reader.cancel();
    client.close();
    await server.closed;

    // The page registers the worker for a scope it is not under itself, so
    // the registration's own worker, not `ready` or `controller`, says when
    // it is active.
    const registration = await navigator.serviceWorker.register(
      '/src/runtime/modules/published-endpoint/service-worker.js',
      {
        scope: '/src/runtime/modules/published-endpoint/__mimic__/',
        updateViaCache: 'none'
      }
    );
    const worker = registration.installing ?? registration.waiting ?? registration.active;
    if (!worker) throw new Error('Published Endpoint Service Worker did not install.');
    await new Promise<void>((resolve, reject) => {
      const check = (): void => {
        if (worker.state === 'activated') resolve();
        else if (worker.state === 'redundant') reject(new Error('Service Worker became redundant.'));
      };
      worker.addEventListener('statechange', check);
      check();
    });
    const controller = navigator.serviceWorker.controller?.scriptURL ?? null;
    const hostChannel = new MessageChannel();
    const diagnostic = new Promise<unknown>((resolve) => {
      connectRpc(hostChannel.port1, { connected: resolve });
    });
    worker.postMessage(
      {
        type: 'published-endpoint:host-connect',
        instanceId: 'stale-browser-runtime',
        protocolToken: `${expectedToken}-stale`
      },
      [hostChannel.port2]
    );

    return {
      controller,
      diagnostic: await diagnostic,
      first,
      pullsAfterRead,
      pullsBeforeRead
    };
  }, PUBLISHED_ENDPOINT_SERVICE_WORKER_TOKEN);

  // The registering page stays uncontrolled: the scope is the endpoints' directory.
  expect(result.controller).toBeNull();

  expect(result).toMatchObject({
    diagnostic: {
      phase: 'rejected',
      protocolToken: PUBLISHED_ENDPOINT_SERVICE_WORKER_TOKEN,
      instanceId: 'stale-browser-runtime'
    },
    first: { done: false, value: 0 }
  });
  expect(result.pullsBeforeRead).toBeLessThan(100);
  expect(result.pullsAfterRead).toBeLessThan(100);
  expect(pageErrors).toEqual([]);
});

test('Published Endpoint Service Worker routes generic HTTP without preview policy', async () => {
  const listeners = new Map<string, Listener>();
  const mockClients = new Map<string, { url: string }>();
  const networkRequests: string[] = [];
  const context = vm.createContext({
    console,
    URL,
    Request,
    Response,
    Headers,
    ReadableStream,
    AbortController,
    AbortSignal,
    TextDecoder,
    TextEncoder,
    MessageChannel: MockMessageChannel,
    setTimeout,
    clearTimeout,
    async fetch(request: Request) {
      networkRequests.push(request.url);
      return new Response(`network:${request.url}`);
    },
    crypto: { randomUUID: () => 'published-endpoint-request' },
    self: {
      location: { origin: 'http://127.0.0.1:5177' },
      registration: { scope: 'http://127.0.0.1:5177/__mimic__/' },
      addEventListener(type: string, listener: Listener) {
        listeners.set(type, listener);
      },
      skipWaiting() {},
      clients: {
        claim() {},
        async get(clientId: string) {
          return mockClients.get(clientId);
        },
        async matchAll() {
          return [];
        }
      }
    }
  });
  const source = readFileSync(
    'src/runtime/modules/published-endpoint/service-worker.js',
    'utf8'
  );
  vm.runInContext(source, context);

  expect(source).not.toMatch(/preview|vite|dev-server/i);
  expect(source).not.toContain('importScripts');

  // The scope itself is a document the worker serves: `endpoints.fetch()`
  // requests endpoints from a frame of it.
  const scopeDocument = await dispatchFetch(listeners, 'http://127.0.0.1:5177/__mimic__/', {
    mode: 'navigate'
  });
  expect(scopeDocument?.status).toBe(200);
  expect(scopeDocument?.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(scopeDocument?.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
  expect(await scopeDocument?.text()).toContain('<!doctype html>');

  const rejectedChannel = new MockMessageChannel();
  const rejection = new Promise<unknown>((resolve) => {
    connectRpc(rejectedChannel.port1 as unknown as RpcPort, { connected: resolve });
  });
  listeners.get('message')?.({
    data: {
      type: 'published-endpoint:host-connect',
      instanceId: 'incompatible-runtime',
      protocolToken: `${PUBLISHED_ENDPOINT_SERVICE_WORKER_TOKEN}-stale`
    },
    ports: [rejectedChannel.port2]
  });
  await expect(rejection).resolves.toMatchObject({
    phase: 'rejected',
    instanceId: 'incompatible-runtime',
    protocolToken: PUBLISHED_ENDPOINT_SERVICE_WORKER_TOKEN
  });

  const requests: Array<{
    requestId: string;
    instanceId: string;
    routeId: string;
    port: number;
    path: string;
    method: string;
    headers: [string, string][];
  }> = [];
  const connectHost = (hostChannel: MockMessageChannel, instanceId = 'runtime-1', embedderPolicy?: string) => {
    const connection = connectRpc<{ disconnect(instanceId: string): void }>(hostChannel.port1 as unknown as RpcPort, {
      connected: () => undefined,
      cancelHttp: () => undefined,
      http(request: (typeof requests)[number]) {
        requests.push(request);
        const body = new TextEncoder().encode(`routed:${request.method}:${request.path}`).buffer;
        return {
          status: request.path === '/redirect' ? 302 : 200,
          statusText: 'OK',
          headers: [
            ['content-type', 'text/plain'],
            ...(request.path === '/redirect'
              ? ([['location', '/next?via=redirect']] as [string, string][])
              : [])
          ],
          body
        };
      }
    });
    listeners.get('message')?.({
      data: {
        type: 'published-endpoint:host-connect',
        instanceId,
        protocolToken: PUBLISHED_ENDPOINT_SERVICE_WORKER_TOKEN,
        ...(embedderPolicy === undefined ? {} : { embedderPolicy })
      },
      ports: [hostChannel.port2]
    });
    return connection;
  };
  const hostConnection = connectHost(new MockMessageChannel());

  // Another origin is never published here: the request goes to the network.
  mockClients.set('cross-origin-client', {
    url: 'http://127.0.0.1:5177/__mimic__/runtime-1/route-1/5173/'
  });
  expect(
    await dispatchFetch(listeners, 'http://cdn.example/font.woff2', { clientId: 'cross-origin-client' })
  ).toBeUndefined();
  expect(
    await dispatchFetch(listeners, 'http://cdn.example/__mimic__/runtime-1/route-1/5173/')
  ).toBeUndefined();

  mockClients.set('endpoint-client', {
    url: 'http://127.0.0.1:5177/__mimic__/runtime-1/route-1/5173/'
  });
  const direct = await dispatchFetch(
    listeners,
    'http://127.0.0.1:5177/__mimic__/runtime-1/route-1/5173/api?query=1',
    { method: 'POST', body: 'payload', resultingClientId: 'endpoint-client' }
  );
  const subresource = await dispatchFetch(
    listeners,
    'http://127.0.0.1:5177/src/main.js?import',
    { clientId: 'endpoint-client' }
  );
  const redirect = await dispatchFetch(
    listeners,
    'http://127.0.0.1:5177/__mimic__/runtime-1/route-1/5173/redirect'
  );

  expect(requests).toMatchObject([
    {
      instanceId: 'runtime-1',
      routeId: 'route-1',
      port: 5173,
      path: '/api?query=1',
      method: 'POST'
    },
    {
      instanceId: 'runtime-1',
      routeId: 'route-1',
      port: 5173,
      path: '/src/main.js?import',
      method: 'GET'
    },
    {
      instanceId: 'runtime-1',
      routeId: 'route-1',
      port: 5173,
      path: '/redirect',
      method: 'GET'
    }
  ]);
  expect(await direct?.text()).toBe('routed:POST:/api?query=1');
  expect(await subresource?.text()).toBe('routed:GET:/src/main.js?import');
  expect(direct?.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
  expect(redirect?.headers.get('location')).toBe(
    '/__mimic__/runtime-1/route-1/5173/next?via=redirect'
  );

  // An instance names the embedder policy its page is served with; its documents carry the same.
  connectHost(new MockMessageChannel(), 'runtime-credentialless', 'credentialless');
  const credentialless = await dispatchFetch(
    listeners,
    'http://127.0.0.1:5177/__mimic__/runtime-credentialless/route-1/5173/'
  );
  expect(credentialless?.headers.get('cross-origin-embedder-policy')).toBe('credentialless');
  expect(credentialless?.headers.get('cross-origin-opener-policy')).toBe('same-origin');

  mockClients.set('host-client', {
    url: 'http://127.0.0.1:5177/mimic-test-host.html'
  });
  mockClients.set('late-endpoint-client', {
    url: 'http://127.0.0.1:5177/__mimic__/runtime-1/route-1/5173/'
  });
  await dispatchFetch(
    listeners,
    'http://127.0.0.1:5177/__mimic__/runtime-1/route-1/5173/',
    { clientId: 'host-client', mode: 'navigate' }
  );
  await dispatchFetch(listeners, 'http://127.0.0.1:5177/src/bootstrap.js', {
    clientId: 'late-endpoint-client',
    referrer:
      'http://127.0.0.1:5177/__mimic__/runtime-1/route-1/5173/'
  });
  const lateHmrImport = await dispatchFetch(
    listeners,
    'http://127.0.0.1:5177/src/App.js?t=123',
    { clientId: 'late-endpoint-client' }
  );
  expect(await lateHmrImport?.text()).toBe(
    'routed:GET:/src/App.js?t=123'
  );

  hostConnection.notify.disconnect('runtime-1');
  connectHost(new MockMessageChannel());
  const recoveredHmrImport = await dispatchFetch(
    listeners,
    'http://127.0.0.1:5177/src/App.js?t=456',
    { clientId: 'late-endpoint-client' }
  );
  expect(await recoveredHmrImport?.text()).toBe(
    'routed:GET:/src/App.js?t=456'
  );

  mockClients.get('endpoint-client')!.url =
    'http://127.0.0.1:5177/mimic-test-host.html';
  const hostWorker = await dispatchFetch(
    listeners,
    'http://127.0.0.1:5177/src/runtime/modules/process-execution/node-process-worker.ts?worker_file&type=module',
    { clientId: 'endpoint-client', destination: 'worker' }
  );
  expect(await hostWorker?.text()).toContain('network:');
  expect(networkRequests).toHaveLength(1);
});

test('the Service Worker leaves the embedding page to its own Service Worker', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });

  // The application registers a worker of its own for the whole origin first.
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/consumer-service-worker.js', { scope: '/' });
    await navigator.serviceWorker.ready;
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null)).toContain(
    '/consumer-service-worker.js'
  );

  const result = await page.evaluate(async () => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const runtime = await Mimic.boot({ workdir: '/home/coexisting-consumer' });
    try {
      await runtime.fs.mount({
        'server.mjs': {
          file: {
            contents: [
              "import http from 'node:http';",
              'http.createServer((request, response) => {',
              "  if (request.url === '/document') {",
              "    response.setHeader('content-type', 'text/html; charset=utf-8');",
              "    response.end('<h1>served:' + request.url + '</h1>');",
              '    return;',
              '  }',
              "  response.setHeader('content-type', 'text/plain; charset=utf-8');",
              "  response.end('served:' + request.url);",
              '}).listen(4310);'
            ].join('\n')
          }
        }
      });
      const published = new Promise<string>((resolve) => {
        runtime.endpoints.on('published', (endpoint) => resolve(endpoint.url));
      });
      const server = await runtime.spawn('node', ['server.mjs']);
      const url = await Promise.race([
        published,
        server.exit.then((code) => {
          throw new Error(`The server exited early with ${code}.`);
        })
      ]);

      const fromPage = await runtime.endpoints.fetch(new URL('from-page', url), { cache: 'no-store' });
      const document = await new Promise<string>((resolve, reject) => {
        const iframe = window.document.createElement('iframe');
        iframe.addEventListener('load', () => {
          const heading = iframe.contentDocument?.querySelector('h1')?.textContent;
          iframe.remove();
          if (heading) resolve(heading);
          else reject(new Error('The endpoint document did not render.'));
        });
        iframe.src = new URL('document', url).href;
        window.document.body.append(iframe);
      });
      const consumerProbe = await fetch('/consumer-service-worker-probe', { cache: 'no-store' });
      const registrations = (await navigator.serviceWorker.getRegistrations()).map((registration) =>
        new URL(registration.scope).pathname
      );
      server.kill('SIGTERM');
      await server.exit;
      return {
        endpointPath: new URL(url).pathname,
        fromPage: { status: fromPage.status, body: await fromPage.text() },
        document,
        consumerProbe: await consumerProbe.text(),
        controller: navigator.serviceWorker.controller?.scriptURL ?? null,
        registrations: registrations.sort()
      };
    } finally {
      await runtime.teardown();
    }
  });

  expect(result).toMatchObject({
    fromPage: { status: 200, body: 'served:/from-page' },
    document: 'served:/document',
    consumerProbe: 'answered by the consumer',
    registrations: ['/', '/src/runtime/modules/published-endpoint/__mimic__/']
  });
  expect(result.endpointPath).toMatch(
    /^\/src\/runtime\/modules\/published-endpoint\/__mimic__\/[^/]+\/[^/]+\/4310\/$/u
  );
  expect(result.controller).toContain('/consumer-service-worker.js');
  expect(pageErrors).toEqual([]);
});

test('a credentialless page gets credentialless endpoint documents, which load cross-origin resources', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  await page.route('**/__credentialless-host.html', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      headers: {
        'Cross-Origin-Embedder-Policy': 'credentialless',
        'Cross-Origin-Opener-Policy': 'same-origin'
      },
      body: '<!doctype html><title>credentialless host</title><main>credentialless host</main>'
    });
  });
  await page.goto('/__credentialless-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated)).toBe(true);

  // The test host on 127.0.0.1 is another origin for `localhost`, and sends no CORP header.
  const crossOriginUrl = new URL(page.url());
  crossOriginUrl.hostname = 'localhost';
  crossOriginUrl.pathname = '/mimic-test-host.html';

  const result = await page.evaluate(async (crossOrigin) => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const runtime = await Mimic.boot({
      workdir: '/home/credentialless-consumer',
      embedderPolicy: 'credentialless'
    });
    try {
      await runtime.fs.mount({
        'server.mjs': {
          file: {
            contents: [
              "import http from 'node:http';",
              'http.createServer((request, response) => {',
              "  response.setHeader('content-type', 'text/html; charset=utf-8');",
              "  response.end('<h1>credentialless preview</h1>');",
              '}).listen(4320);'
            ].join('\n')
          }
        }
      });
      const published = new Promise<string>((resolve) => {
        runtime.endpoints.on('published', (endpoint) => resolve(endpoint.url));
      });
      const server = await runtime.spawn('node', ['server.mjs']);
      const url = await Promise.race([
        published,
        server.exit.then((code) => {
          throw new Error(`The server exited early with ${code}.`);
        })
      ]);
      const document = await runtime.endpoints.fetch(url, { cache: 'no-store' });
      const embedderPolicy = document.headers.get('cross-origin-embedder-policy');
      await document.text();

      // From a document the endpoint serves: a no-cors request to another
      // origin without CORP, which `require-corp` would block.
      const crossOriginLoad = await new Promise<string>((resolve, reject) => {
        const iframe = window.document.createElement('iframe');
        iframe.addEventListener('load', () => {
          const win = iframe.contentWindow;
          if (!win) return reject(new Error('The endpoint document has no window.'));
          win
            .fetch(crossOrigin, { mode: 'no-cors', cache: 'no-store' })
            .then((response) => resolve(response.type), (error: unknown) => resolve(`rejected: ${String(error)}`))
            .finally(() => iframe.remove());
        });
        iframe.src = url;
        window.document.body.append(iframe);
      });
      server.kill('SIGTERM');
      await server.exit;
      return { embedderPolicy, crossOriginLoad };
    } finally {
      await runtime.teardown();
    }
  }, crossOriginUrl.href);

  expect(result).toEqual({ embedderPolicy: 'credentialless', crossOriginLoad: 'opaque' });
  expect(pageErrors).toEqual([]);
});

async function dispatchFetch(
  listeners: ReadonlyMap<string, Listener>,
  url: string,
  init: {
    body?: BodyInit;
    clientId?: string;
    destination?: string;
    method?: string;
    mode?: RequestMode;
    referrer?: string;
    resultingClientId?: string;
  } = {}
): Promise<Response | undefined> {
  let responsePromise: Promise<Response> | undefined;
  const request = new Request(url, {
    body: init.body,
    method: init.method
  });
  if (init.mode) Object.defineProperty(request, 'mode', { value: init.mode });
  Object.defineProperty(request, 'referrer', { value: init.referrer ?? '' });
  if (init.destination) Object.defineProperty(request, 'destination', { value: init.destination });
  listeners.get('fetch')?.({
    request,
    clientId: init.clientId ?? '',
    resultingClientId: init.resultingClientId ?? '',
    respondWith(value: Promise<Response>) {
      responsePromise = value;
    }
  });
  return responsePromise;
}
