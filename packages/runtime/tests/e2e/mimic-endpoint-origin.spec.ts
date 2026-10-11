import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';
import { e2ePort } from './browser-runtime-helpers';

const endpointOriginClaim = defineCompatibilityClaim({
  id: 'published-endpoint-origin-per-port-v1',
  statement:
    'With a wildcard preview origin each Published Endpoint is served from the root of an origin of its own, so a client-side router sees the path its server sees and a reload at a nested path renders it, while endpoints.fetch(), redirects, the Cookie Jar and loopback requests keep working',
  target: {
    kind: 'runtime-capability',
    capability: 'published-endpoint-origin-per-port'
  }
});

// The claims run against http://127.0.0.1:<port> (MIMIC_E2E_PORT, 4179 by
// default); the same server answers on every http://*.localhost:<port>, which Chromium resolves to the loopback
// address by itself, so each port gets an origin of its own (ADR-0044).
const PREVIEW_ORIGIN = `http://*.localhost:${e2ePort}`;
const ROUTER_PORT = 4200;
const API_PORT = 3001;
// Beside the Service Worker, which the development server serves from its source directory.
const WORKER_DIRECTORY = '/src/runtime/modules/published-endpoint/';

/**
 * A single-page application with a router of its own: the server answers
 * every page path with the same document, whose script renders the view
 * `location.pathname` names and pushes a new path on a link click, as a
 * framework router does. A second server stands for another port of the
 * project that the document reaches by its loopback address.
 */
const SERVERS = `
import http from 'node:http';
const page = \`<!doctype html><html><head><meta charset="utf-8"><title>Router</title></head><body>
<nav><a id="to-about" href="/about">About</a></nav>
<main id="view"></main>
<script src="${WORKER_DIRECTORY}app.js"></script>
<script>
  const routes = { '/': 'home', '/about': 'about' };
  const render = () => {
    document.getElementById('view').textContent = routes[location.pathname] ?? 'missing:' + location.pathname;
  };
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href]');
    if (!link) return;
    event.preventDefault();
    history.pushState(null, '', link.getAttribute('href'));
    render();
  });
  addEventListener('popstate', render);
  render();
</script>
</body></html>\`;
http.createServer((request, response) => {
  const path = request.url.split('?')[0];
  if (path === '/api/hello') {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'session=abc; Path=/' });
      response.end(\`hello:\${request.method}:\${body}\`);
    });
    return;
  }
  if (path === '/api/path') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(\`path:\${request.url};host:\${request.headers.host};cookie:\${request.headers.cookie ?? ''}\`);
    return;
  }
  if (path === '/redirect') {
    response.writeHead(302, { location: 'http://localhost:${ROUTER_PORT}/api/path' });
    response.end();
    return;
  }
  if (path === '/redirect-sibling') {
    response.writeHead(302, { location: 'http://localhost:${API_PORT}/hello' });
    response.end();
    return;
  }
  if (path === '${WORKER_DIRECTORY}app.js') {
    // The application's own file under the directory the package's files are served from.
    response.writeHead(200, { 'content-type': 'text/javascript' });
    response.end("document.documentElement.dataset.ownScript = 'loaded';");
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(page);
}).listen(${ROUTER_PORT});
http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain' });
  response.end(\`hello from ${API_PORT}:\${request.url};origin:\${request.headers.origin ?? ''}\`);
}).listen(${API_PORT});
`;

test(endpointOriginClaim.statement, async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));

  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated)).toBe(true);

  const result = await page.evaluate(
    async ({ previewOrigin, servers, routerPort, apiPort, port }) => {
      const { Mimic } = await import('/src/runtime/index.ts');
      const invalid = await Mimic.boot({ previewOrigin: `http://preview-*.localhost:${port}` }).then(
        () => 'resolved',
        (error: unknown) => (error instanceof TypeError ? error.message : 'rejected otherwise')
      );
      const runtime = await Mimic.boot({ previewOrigin });
      document.cookie = 'page_cookie=stays-on-the-page; Path=/';
      await runtime.fs.mount({ 'servers.mjs': { file: { contents: servers } } });
      const urls = new Map<number, string>();
      const published = new Promise<void>((resolve) => {
        runtime.endpoints.on('published', (endpoint) => {
          urls.set(endpoint.address.port, endpoint.url);
          if (urls.size === 2) resolve();
        });
      });
      await runtime.spawn('node', ['servers.mjs']);
      await published;
      const routerUrl = urls.get(routerPort)!;
      const apiUrl = urls.get(apiPort)!;

      const hello = await runtime.endpoints.fetch(new URL('/api/hello', routerUrl), {
        method: 'POST',
        body: 'ping',
        cache: 'no-store'
      });
      const helloText = await hello.text();
      const redirected = await runtime.endpoints.fetch(new URL('/redirect', routerUrl), { cache: 'no-store' });
      const redirectedText = await redirected.text();
      const sibling = await runtime.endpoints.fetch(new URL('/hello?from=page', apiUrl), { cache: 'no-store' });
      const siblingText = await sibling.text();
      const foreign = await runtime.endpoints
        .fetch(`${new URL(routerUrl).protocol}//other--${routerPort}.localhost:${port}/`)
        .then(() => 'resolved', (error: unknown) => (error instanceof TypeError ? 'TypeError' : 'rejected otherwise'));

      const iframe = document.createElement('iframe');
      iframe.id = 'preview';
      await new Promise<void>((resolve, reject) => {
        iframe.addEventListener('load', () => resolve(), { once: true });
        iframe.addEventListener('error', () => reject(new Error('The preview failed to load.')), { once: true });
        iframe.src = routerUrl;
        document.body.appendChild(iframe);
      });
      let frameDocumentReachable: boolean;
      try {
        frameDocumentReachable = iframe.contentWindow?.document !== undefined;
      } catch {
        frameDocumentReachable = false;
      }
      return {
        invalid,
        routerUrl,
        apiUrl,
        helloText,
        helloSetCookieExposed: hello.headers.has('set-cookie'),
        redirectedStatus: redirected.status,
        redirectedText,
        siblingText,
        foreign,
        frameDocumentReachable,
        pageCookie: document.cookie
      };
    },
    { previewOrigin: PREVIEW_ORIGIN, servers: SERVERS, routerPort: ROUTER_PORT, apiPort: API_PORT, port: e2ePort }
  );

  expect(result.invalid).toContain('wildcard previewOrigin');
  // Each port is the root of an origin of its own, named by the epoch and the port.
  const routerOrigin = new URL(result.routerUrl);
  expect(routerOrigin.pathname).toBe('/');
  expect(routerOrigin.host).toMatch(new RegExp(`^[0-9a-f-]{36}--${ROUTER_PORT}\\.localhost:${e2ePort}$`));
  const epochId = routerOrigin.hostname.split('--')[0];
  expect(result.apiUrl).toBe(`http://${epochId}--${API_PORT}.localhost:${e2ePort}/`);
  expect(result.helloText).toBe('hello:POST:ping');
  // The project's Set-Cookie went to the Cookie Jar, not to the browser.
  expect(result.helloSetCookieExposed).toBe(false);
  // A loopback Location of the same port is the root of this origin; the jar's cookie went with the request.
  expect(result.redirectedStatus).toBe(200);
  expect(result.redirectedText).toBe(`path:/api/path;host:localhost:${ROUTER_PORT};cookie:session=abc`);
  expect(result.siblingText).toBe(`hello from ${API_PORT}:/hello?from=page;origin:`);
  // Another epoch's origin is not this container's.
  expect(result.foreign).toBe('TypeError');
  // The preview is cross-origin to the page: neither side reads the other.
  expect(result.frameDocumentReachable).toBe(false);
  expect(result.pageCookie).toContain('page_cookie=stays-on-the-page');
  expect(result.pageCookie).not.toContain('session=');

  const preview = page.frames().find((frame) => frame.url() === result.routerUrl);
  expect(preview, 'the preview frame').toBeDefined();
  const viewText = (): Promise<string> =>
    preview!
      .evaluate(() => `${document.readyState}:${location.pathname}:${document.getElementById('view')?.textContent ?? ''}`)
      .catch(() => 'navigating');
  // The router sees `/`, the path its server sees, and renders its index route.
  await expect.poll(viewText).toBe('complete:/:home');
  const inFrame = await preview!.evaluate(async (apiPort) => {
    let parentDocumentReachable: boolean;
    try {
      parentDocumentReachable = window.parent.document !== undefined;
    } catch {
      parentDocumentReachable = false;
    }
    const own = await fetch('/api/path?from=frame');
    const loopback = await fetch(`http://localhost:${apiPort}/hello?from=frame`);
    return {
      origin: window.location.origin,
      ownScript: document.documentElement.dataset.ownScript,
      parentDocumentReachable,
      ownText: await own.text(),
      loopbackText: await loopback.text(),
      pageCookieVisible: document.cookie.includes('page_cookie')
    };
  }, API_PORT);
  expect(inFrame.origin).toBe(routerOrigin.origin);
  // A subresource under the package's directory is the application's, not the package's.
  expect(inFrame.ownScript).toBe('loaded');
  expect(inFrame.parentDocumentReachable).toBe(false);
  expect(inFrame.ownText).toBe(`path:/api/path?from=frame;host:localhost:${ROUTER_PORT};cookie:session=abc`);
  // A document's request to another loopback port of its container reaches that port (ADR-0037).
  expect(inFrame.loopbackText).toBe(`hello from ${API_PORT}:/hello?from=frame;origin:http://localhost:${ROUTER_PORT}`);
  expect(inFrame.pageCookieVisible).toBe(false);
  // The document's cookie mirror shows the Cookie Jar's cookie at the root path.
  await expect.poll(() => preview!.evaluate(() => document.cookie)).toContain('session=abc');

  // A client-side navigation pushes the nested path, and a reload there is
  // answered by the server at that path: the router renders it again.
  await preview!.click('#to-about');
  await expect.poll(viewText).toBe('complete:/about:about');
  await preview!.evaluate(() => {
    location.reload();
  });
  await expect.poll(viewText).toBe('complete:/about:about');
  expect(preview!.url()).toBe(new URL('/about', result.routerUrl).href);

  // A redirect to another loopback port of the container lands on that port's origin.
  await page.evaluate((url) => {
    (document.getElementById('preview') as HTMLIFrameElement).src = url;
  }, new URL('/redirect-sibling', result.routerUrl).href);
  const siblingUrl = new URL('/hello', result.apiUrl).href;
  await expect.poll(() => preview!.url()).toBe(siblingUrl);
  await expect
    .poll(() => preview!.evaluate(() => document.body.textContent).catch(() => 'navigating'))
    .toBe(`hello from ${API_PORT}:/hello;origin:`);

  expect(pageErrors).toEqual([]);
});
