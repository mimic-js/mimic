import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';

const publishedLoopbackRoutingClaim = defineCompatibilityClaim({
  id: 'published-endpoint-loopback-routing-v1',
  statement:
    "A published document's requests to loopback ports of its container reach the servers that publish them, including one published after the document loaded, while other loopback ports stay on the network",
  target: {
    kind: 'runtime-capability',
    capability: 'published-endpoint-loopback-routing'
  }
});

const APP_PORT = 4200;
const API_PORT = 3333;
/** No server of the container listens here. */
const CLOSED_PORT = 3999;

const appSource = String.raw`
import http from 'node:http';
http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><html><head><title>App</title></head><body><h1>app</h1></body></html>');
}).listen(${APP_PORT});
`;

// One pixel, as a PNG.
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

const apiSource = String.raw`
import http from 'node:http';
import { createHash } from 'node:crypto';
const ALLOWED_ORIGIN = 'http://localhost:${APP_PORT}';
const cors = (request) =>
  request.headers.origin === ALLOWED_ORIGIN
    ? {
        'access-control-allow-origin': ALLOWED_ORIGIN,
        'access-control-allow-credentials': 'true',
        'access-control-expose-headers': 'x-api-origin',
        vary: 'origin'
      }
    : {};
const server = http.createServer((request, response) => {
  const json = (value, headers = {}) => {
    response.writeHead(200, {
      'content-type': 'application/json',
      'x-api-origin': request.headers.origin ?? '',
      ...cors(request),
      ...headers
    });
    response.end(JSON.stringify(value));
  };
  if (request.url === '/api/products?limit=2') {
    json({ products: ['lamp', 'chair'], origin: request.headers.origin ?? null, host: request.headers.host });
    return;
  }
  if (request.url === '/api/echo' && request.method === 'POST') {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => json({ method: request.method, contentType: request.headers['content-type'], body: JSON.parse(body) }));
    return;
  }
  if (request.url === '/api/login') {
    json({ ok: true }, { 'set-cookie': 'api_session=signed-in; Path=/' });
    return;
  }
  if (request.url === '/api/cookie') {
    json({ cookie: request.headers.cookie ?? '' });
    return;
  }
  if (request.url === '/pixel.png') {
    response.writeHead(200, { 'content-type': 'image/png' });
    response.end(Buffer.from('${PIXEL}', 'base64'));
    return;
  }
  response.writeHead(404, cors(request));
  response.end('missing');
});
// A minimal WebSocket echo for short text frames.
server.on('upgrade', (request, socket) => {
  const accept = createHash('sha1')
    .update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  const origin = request.headers.origin ?? '';
  socket.on('data', (frame) => {
    const opcode = frame[0] & 0x0f;
    if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
    const length = frame[1] & 0x7f;
    const mask = frame.subarray(2, 6);
    const payload = Buffer.from(frame.subarray(6, 6 + length).map((byte, index) => byte ^ mask[index % 4]));
    const reply = Buffer.from('echo:' + payload.toString() + ':' + origin);
    socket.write(Buffer.concat([Buffer.from([0x81, reply.length]), reply]));
  });
});
server.listen(${API_PORT});
`;

test(publishedLoopbackRoutingClaim.statement, async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));

  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated)).toBe(true);

  // The application server publishes and its document loads before the API exists.
  const appUrl = await page.evaluate(
    async ({ appSource, apiSource }) => {
      const { Mimic } = await import('/src/runtime/index.ts');
      const runtime = await Mimic.boot({ workdir: '/home/loopback' });
      (window as unknown as { loopbackRuntime: unknown }).loopbackRuntime = runtime;
      await runtime.fs.mount({
        'app.mjs': { file: { contents: appSource } },
        'api.mjs': { file: { contents: apiSource } }
      });
      const published = new Promise<string>((resolve) => {
        runtime.endpoints.on('published', (endpoint) => resolve(endpoint.url));
      });
      await runtime.spawn('node', ['app.mjs']);
      const url = await published;
      const iframe = document.createElement('iframe');
      await new Promise<void>((resolve, reject) => {
        iframe.addEventListener('load', () => resolve(), { once: true });
        iframe.addEventListener('error', () => reject(new Error('The application failed to load.')), {
          once: true
        });
        iframe.src = url;
        document.body.appendChild(iframe);
      });
      return url;
    },
    { appSource, apiSource }
  );
  const app = page.frames().find((frame) => frame.url() === appUrl);
  expect(app, 'the application frame').toBeDefined();

  // Before the API publishes, its port is not the container's.
  const beforeApi = await app!.evaluate(
    (port) =>
      fetch(`http://localhost:${port}/api/products?limit=2`).then(
        (response) => `status ${response.status}`,
        (error: unknown) => (error instanceof TypeError ? 'TypeError' : 'rejected otherwise')
      ),
    API_PORT
  );

  await page.evaluate(async (apiPort) => {
    const runtime = (window as unknown as {
      loopbackRuntime: import('../../src/runtime').Mimic;
    }).loopbackRuntime;
    const published = new Promise<void>((resolve) => {
      const unsubscribe = runtime.endpoints.on('published', (endpoint) => {
        if (endpoint.address.port !== apiPort) return;
        unsubscribe();
        resolve();
      });
    });
    await runtime.spawn('node', ['api.mjs']);
    await published;
  }, API_PORT);

  const result = await app!.evaluate(
    async ({ apiPort, closedPort, networkPort }) => {
      const api = `http://localhost:${apiPort}`;
      const products = await fetch(`${api}/api/products?limit=2`);
      const echo = await fetch(`http://127.0.0.1:${apiPort}/api/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'lamp' })
      });
      const xhr = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open('GET', `${api}/api/products?limit=2`);
        request.onload = () => resolve({ status: request.status, body: request.responseText });
        request.onerror = () => reject(new Error('XMLHttpRequest failed.'));
        request.send();
      });
      await fetch(`${api}/api/login`, { credentials: 'include' });
      const withCredentials = await fetch(`${api}/api/cookie`, { credentials: 'include' }).then((response) =>
        response.json()
      );
      const withoutCredentials = await fetch(`${api}/api/cookie`).then((response) => response.json());
      const image = await new Promise<number>((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element.naturalWidth);
        element.onerror = () => reject(new Error('The loopback image failed to load.'));
        element.src = `${api}/pixel.png`;
      });
      const socket = await new Promise<string>((resolve, reject) => {
        const webSocket = new WebSocket(`ws://localhost:${apiPort}/ws`);
        webSocket.onopen = () => webSocket.send('ping');
        webSocket.onmessage = (event) => {
          resolve(String(event.data));
          webSocket.close();
        };
        webSocket.onerror = () => reject(new Error('The loopback WebSocket failed.'));
      });
      const closedSocket = await new Promise<{ code: number; error: boolean }>((resolve) => {
        const webSocket = new WebSocket(`ws://localhost:${closedPort}/ws`);
        let error = false;
        webSocket.onerror = () => {
          error = true;
        };
        webSocket.onclose = (event) => resolve({ code: event.code, error });
      });
      const closedPortFetch = await fetch(`http://localhost:${closedPort}/`).then(
        (response) => `status ${response.status}`,
        (error: unknown) => (error instanceof TypeError ? 'TypeError' : 'rejected otherwise')
      );
      // The claims' own server answers on this port and allows this origin:
      // only the network gives a "cors" response, a routed one is "basic".
      const network = await fetch(`http://localhost:${networkPort}/mimic-test-host.html`);
      return {
        products: {
          status: products.status,
          type: products.type,
          body: await products.json(),
          exposedHeader: products.headers.get('x-api-origin')
        },
        echo: { status: echo.status, body: await echo.json() },
        xhr: { status: xhr.status, body: JSON.parse(xhr.body) },
        withCredentials,
        withoutCredentials,
        image,
        socket,
        closedSocket,
        closedPortFetch,
        network: { status: network.status, type: network.type },
        documentCookie: document.cookie
      };
    },
    { apiPort: API_PORT, closedPort: CLOSED_PORT, networkPort: new URL(page.url()).port }
  );

  await page.evaluate(() =>
    (window as unknown as { loopbackRuntime: { teardown(): Promise<void> } }).loopbackRuntime.teardown()
  );

  expect(beforeApi).toBe('TypeError');
  expect(result.products.status).toBe(200);
  expect(result.products.type).toBe('basic');
  // The server sees the document's logical origin and its own loopback authority.
  expect(result.products.body).toEqual({
    products: ['lamp', 'chair'],
    origin: `http://localhost:${APP_PORT}`,
    host: `localhost:${API_PORT}`
  });
  expect(result.products.exposedHeader).toBe(`http://localhost:${APP_PORT}`);
  expect(result.echo).toEqual({
    status: 200,
    body: { method: 'POST', contentType: 'application/json', body: { name: 'lamp' } }
  });
  expect(result.xhr.status).toBe(200);
  expect(result.xhr.body.products).toEqual(['lamp', 'chair']);
  // Another origin's cookies travel only with `credentials: 'include'`.
  expect(result.withCredentials).toEqual({ cookie: 'api_session=signed-in' });
  expect(result.withoutCredentials).toEqual({ cookie: '' });
  expect(result.documentCookie).not.toContain('api_session');
  expect(result.image).toBe(1);
  expect(result.socket).toBe(`echo:ping:http://localhost:${APP_PORT}`);
  expect(result.closedSocket).toEqual({ code: 1006, error: true });
  expect(result.closedPortFetch).toBe('TypeError');
  expect(result.network).toEqual({ status: 200, type: 'cors' });
  expect(pageErrors).toEqual([]);
});
