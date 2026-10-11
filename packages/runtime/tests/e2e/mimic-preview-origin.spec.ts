import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';
import { e2ePort } from './browser-runtime-helpers';

const previewOriginClaim = defineCompatibilityClaim({
  id: 'published-endpoint-preview-origin-v1',
  statement:
    'Published Endpoints are served from the preview origin boot() names, where their documents cannot reach the embedding page, while endpoints.fetch(), the Cookie Jar and in-document requests keep working',
  target: {
    kind: 'runtime-capability',
    capability: 'published-endpoint-preview-origin'
  }
});

// The claims run against http://127.0.0.1:<port> (MIMIC_E2E_PORT, 4179 by
// default); the same server answers on http://localhost:<port>, a different origin to the browser (ADR-0032).
const PREVIEW_ORIGIN = `http://localhost:${e2ePort}`;

test(previewOriginClaim.statement, async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));

  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated)).toBe(true);

  const result = await page.evaluate(async (previewOrigin) => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const invalid = await Mimic.boot({ previewOrigin: 'preview.example' }).then(
      () => 'resolved',
      (error: unknown) => (error instanceof TypeError ? error.message : 'rejected otherwise')
    );
    const runtime = await Mimic.boot({ previewOrigin });
    document.cookie = 'page_cookie=stays-on-the-page; Path=/';
    await runtime.fs.mount({
      'server.mjs': {
        file: {
          contents: [
            "import http from 'node:http';",
            'http.createServer((request, response) => {',
            "  if (request.url === '/') {",
            "    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });",
            "    response.end('<!doctype html><html><head><title>Preview</title></head><body><h1 id=\"title\">served from the preview origin</h1></body></html>');",
            '    return;',
            '  }',
            "  if (request.url === '/api/hello') {",
            "    let body = '';",
            "    request.on('data', (chunk) => { body += chunk; });",
            "    request.on('end', () => {",
            "      response.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'session=abc; Path=/' });",
            "      response.end(`hello:${request.method}:${body}`);",
            '    });',
            '    return;',
            '  }',
            "  if (request.url === '/api/cookie') {",
            "    response.writeHead(200, { 'content-type': 'text/plain' });",
            "    response.end(`cookie:${request.headers.cookie ?? ''}`);",
            '    return;',
            '  }',
            "  if (request.url === '/redirect') {",
            "    response.writeHead(302, { location: '/api/cookie' });",
            '    response.end();',
            '    return;',
            '  }',
            "  response.writeHead(404); response.end('missing');",
            '}).listen(3000);'
          ].join('\n')
        }
      }
    });
    const published = new Promise<{ url: string }>((resolve) => {
      runtime.endpoints.on('published', (endpoint) => resolve(endpoint));
    });
    const server = await runtime.spawn('node', ['server.mjs']);
    const endpoint = await published;

    const hello = await runtime.endpoints.fetch(new URL('api/hello', endpoint.url), {
      method: 'POST',
      body: 'ping',
      cache: 'no-store'
    });
    const helloText = await hello.text();
    const cookie = await runtime.endpoints.fetch(new URL('api/cookie', endpoint.url), { cache: 'no-store' });
    const cookieText = await cookie.text();
    const redirected = await runtime.endpoints.fetch(new URL('redirect', endpoint.url), { cache: 'no-store' });
    const redirectedText = await redirected.text();
    const aborter = new AbortController();
    aborter.abort();
    const aborted = await runtime.endpoints
      .fetch(new URL('api/cookie', endpoint.url), { signal: aborter.signal })
      .then(() => 'resolved', (error: unknown) => (error instanceof Error ? error.name : 'rejected otherwise'));

    const iframe = document.createElement('iframe');
    iframe.id = 'preview';
    await new Promise<void>((resolve, reject) => {
      iframe.addEventListener('load', () => resolve(), { once: true });
      iframe.addEventListener('error', () => reject(new Error('The preview failed to load.')), { once: true });
      iframe.src = endpoint.url;
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
      url: endpoint.url,
      helloText,
      helloSetCookieExposed: hello.headers.has('set-cookie'),
      cookieText,
      redirectedStatus: redirected.status,
      redirectedText,
      aborted,
      frameDocumentReachable,
      pageCookie: document.cookie,
      serverPid: server.pid
    };
  }, PREVIEW_ORIGIN);

  expect(result.invalid).toContain('previewOrigin must be');
  expect(new URL(result.url).origin).toBe(PREVIEW_ORIGIN);
  expect(result.helloText).toBe('hello:POST:ping');
  // The project's Set-Cookie went to the Cookie Jar, not to the browser.
  expect(result.helloSetCookieExposed).toBe(false);
  expect(result.cookieText).toBe('cookie:session=abc');
  expect(result.redirectedStatus).toBe(200);
  expect(result.redirectedText).toBe('cookie:session=abc');
  expect(result.aborted).toBe('AbortError');
  // The preview is cross-origin to the page: neither side reads the other.
  expect(result.frameDocumentReachable).toBe(false);
  expect(result.pageCookie).toContain('page_cookie=stays-on-the-page');
  expect(result.pageCookie).not.toContain('session=');

  const preview = page.frames().find((frame) => frame.url() === result.url);
  expect(preview, 'the preview frame').toBeDefined();
  const inFrame = await preview!.evaluate(async () => {
    let parentDocumentReachable: boolean;
    try {
      parentDocumentReachable = window.parent.document !== undefined;
    } catch {
      parentDocumentReachable = false;
    }
    const response = await fetch('/api/hello', { method: 'POST', body: 'from-frame' });
    return {
      origin: window.location.origin,
      title: document.querySelector('#title')?.textContent ?? '',
      parentDocumentReachable,
      helloText: await response.text(),
      pageCookieVisible: document.cookie.includes('page_cookie')
    };
  });
  expect(inFrame.origin).toBe(PREVIEW_ORIGIN);
  expect(inFrame.title).toBe('served from the preview origin');
  expect(inFrame.parentDocumentReachable).toBe(false);
  expect(inFrame.helloText).toBe('hello:POST:from-frame');
  expect(inFrame.pageCookieVisible).toBe(false);
  // The document's cookie mirror shows the Cookie Jar's cookie, through the host page.
  await expect.poll(() => preview!.evaluate(() => document.cookie)).toContain('session=abc');

  expect(pageErrors).toEqual([]);
});

const runtimeOriginClaim = defineCompatibilityClaim({
  id: 'runtime-host-preview-origin-v1',
  statement:
    "A project's processes hold the preview origin's ambient authority and not the embedding page's, and the container fails when its Runtime Host document is removed",
  target: {
    kind: 'runtime-capability',
    capability: 'runtime-host-preview-origin'
  }
});

test(runtimeOriginClaim.statement, async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));

  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated)).toBe(true);

  const result = await page.evaluate(async (previewOrigin) => {
    const { Mimic } = await import('/src/runtime/index.ts');
    // Something of the page's origin a project must not see: a database and a cookie.
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('page-secret', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('secrets');
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
    document.cookie = 'page_cookie=stays-on-the-page; Path=/';
    const runtime = await Mimic.boot({ previewOrigin });
    const probe = await runtime.spawn('node', [
      '--input-type=module',
      '-e',
      [
        // The program's global inherits from the worker's real one, whose
        // platform getters answer for the worker scope only.
        'const scope = Object.getPrototypeOf(globalThis);',
        'const databases = await scope.indexedDB.databases();',
        'process.stdout.write(JSON.stringify({',
        '  origin: scope.location.origin,',
        '  databases: databases.map((database) => database.name),',
        "  cookie: typeof scope.document === 'undefined' ? 'no-document' : 'document'",
        '}));'
      ].join('\n')
    ]);
    const probeOutput = await new Response(probe.output).text();
    const probeExit = await probe.exit;
    const pending = await runtime.spawn('node', ['-e', 'await new Promise(() => {});']);
    const frame = document.querySelector('iframe[title="Mimic runtime host"]');
    const frameOrigin = frame instanceof HTMLIFrameElement ? new URL(frame.src).origin : 'missing';
    frame?.remove();
    const pendingFailure = await pending.exit.then(
      (code) => `exit:${code}`,
      (error: unknown) => (error instanceof Error ? `${error.name}:${error.message}` : 'rejected otherwise')
    );
    const teardownFailure = await runtime.teardown().then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? `${error.name}:${error.message}` : 'rejected otherwise')
    );
    const rebooted = await Mimic.boot({ previewOrigin });
    await rebooted.teardown();
    return { probeOutput, probeExit, frameOrigin, pendingFailure, teardownFailure };
  }, PREVIEW_ORIGIN);

  expect(result.probeExit, result.probeOutput).toBe(0);
  expect(result.frameOrigin).toBe(PREVIEW_ORIGIN);
  // The program's ambient origin is the preview origin's: its storage is that origin's, and empty.
  expect(JSON.parse(result.probeOutput)).toEqual({ origin: PREVIEW_ORIGIN, databases: [], cookie: 'no-document' });
  expect(result.pendingFailure).toContain('MimicProcessCrashError');
  expect(result.pendingFailure).toContain('Runtime Host document unloaded');
  expect(result.teardownFailure).toContain('RuntimeEpochFailedError');
  expect(result.teardownFailure).toContain('Runtime Host document unloaded');
  expect(pageErrors).toEqual([]);
});
