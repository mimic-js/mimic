import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';

const publishedDocumentModeClaim = defineCompatibilityClaim({
  id: 'published-endpoint-document-mode-v1',
  statement:
    'A published HTML document keeps the rendering mode its own doctype selects, with the Published Endpoint bootstrap running from its head',
  target: {
    kind: 'runtime-capability',
    capability: 'published-endpoint-document-mode'
  }
});

test(publishedDocumentModeClaim.statement, async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));

  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated)).toBe(true);

  const documents = await page.evaluate(async (source) => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const runtime = await Mimic.boot({ workdir: '/home/document-mode' });
    try {
      await runtime.fs.mount({ 'server.mjs': { file: { contents: source } } });
      const published = new Promise<string>((resolve) => {
        runtime.endpoints.on('published', (endpoint) => resolve(endpoint.url));
      });
      const server = await runtime.spawn('node', [`${runtime.workdir}/server.mjs`]);
      const url = await Promise.race([
        published,
        server.exit.then((exitCode) => {
          throw new Error(`Document mode server exited early with ${exitCode}.`);
        })
      ]);

      const read = async (path: string) => {
        const iframe = document.createElement('iframe');
        const loaded = new Promise<void>((resolve, reject) => {
          iframe.addEventListener('load', () => resolve(), { once: true });
          iframe.addEventListener('error', () => reject(new Error(`${path} failed to load.`)), {
            once: true
          });
        });
        iframe.src = new URL(path, url).href;
        document.body.appendChild(iframe);
        await loaded;
        const child = iframe.contentDocument;
        if (!child) throw new Error(`${path} has no document.`);
        const bootstrap = child.querySelector('script[data-mimic-published-endpoint]');
        const result = {
          compatMode: child.compatMode,
          doctype: child.doctype?.name ?? null,
          bootstrapParent: bootstrap?.parentElement?.localName ?? null,
          firstHeadChild: child.head.firstElementChild?.getAttribute('name') ?? null,
          text: child.body.textContent?.trim() ?? ''
        };
        iframe.remove();
        return result;
      };

      const result = {
        withHead: await read('with-head'),
        impliedHead: await read('implied-head'),
        splitPreamble: await read('split-preamble'),
        withoutDoctype: await read('without-doctype')
      };
      server.kill('SIGTERM');
      await server.exit;
      return result;
    } finally {
      await runtime.teardown();
    }
  }, documentModeServerSource);

  const standards = {
    compatMode: 'CSS1Compat',
    doctype: 'html',
    bootstrapParent: 'head',
    firstHeadChild: 'mimic-published-endpoint'
  };
  expect(documents.withHead).toEqual({ ...standards, text: 'with head' });
  expect(documents.impliedHead).toEqual({ ...standards, text: 'implied head' });
  expect(documents.splitPreamble).toEqual({ ...standards, text: 'split preamble' });
  expect(documents.withoutDoctype).toEqual({
    compatMode: 'BackCompat',
    doctype: null,
    bootstrapParent: 'head',
    firstHeadChild: 'mimic-published-endpoint',
    text: 'without doctype'
  });
  expect(pageErrors).toEqual([]);
});

const documentModeServerSource = [
  "import http from 'node:http';",
  '',
  'const documents = {',
  "  '/with-head': ['<!doctype html>\\n<html lang=\"en\">\\n  <head>\\n    <title>with head</title>\\n  </head>\\n  <body>with head</body>\\n</html>'],",
  "  '/implied-head': ['<!DOCTYPE html><title>implied head</title><p>implied head</p>'],",
  "  '/split-preamble': ['<!doc', 'type html><!-- a > comment --><ht', 'ml><he', 'ad></head><body>split preamble</body></html>'],",
  "  '/without-doctype': ['<p>without doctype</p>']",
  '};',
  'const server = http.createServer(async (request, response) => {',
  '  const chunks = documents[request.url];',
  "  if (!chunks) { response.writeHead(404); response.end('not found'); return; }",
  "  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });",
  '  for (const chunk of chunks) {',
  '    response.write(chunk);',
  '    await new Promise((resolve) => setTimeout(resolve, 20));',
  '  }',
  '  response.end();',
  '});',
  "server.listen(4310, '127.0.0.1');"
].join('\n');
