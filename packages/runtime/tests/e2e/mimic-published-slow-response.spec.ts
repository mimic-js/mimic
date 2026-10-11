import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';

const slowResponseClaim = defineCompatibilityClaim({
  id: 'published-endpoint-slow-response-v1',
  statement:
    'A Published Endpoint request waits for a server that answers after its first build, as long as the host serving it is open',
  target: {
    kind: 'runtime-capability',
    capability: 'published-endpoint-slow-response'
  }
});

// webpack-dev-server holds each request until its first build ends, which in
// the browser can take minutes. The server here answers after 40 seconds.
const SERVER = [
  "import http from 'node:http';",
  'const started = Date.now();',
  'http.createServer((request, response) => {',
  '  setTimeout(() => response.end(`answered after ${Math.round((Date.now() - started) / 1000)}s`), 40_000);',
  "}).listen(4310, () => console.log('listening'));"
].join('\n');

test(slowResponseClaim.statement, async ({ page }) => {
  test.setTimeout(150_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));

  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated)).toBe(true);

  const result = await page.evaluate(async (source) => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const runtime = await Mimic.boot({ workdir: '/home/slow' });
    try {
      await runtime.fs.mount({ 'server.mjs': { file: { contents: source } } });
      const published = new Promise<string>((resolve) => {
        const unsubscribe = runtime.endpoints.on('published', (endpoint) => {
          unsubscribe();
          resolve(endpoint.url);
        });
      });
      const process = await runtime.spawn('node', ['server.mjs']);
      const url = await published;
      const response = await runtime.endpoints.fetch(url, { cache: 'no-store' });
      const body = await response.text();
      process.kill('SIGTERM');
      await process.exit;
      return { status: response.status, body };
    } finally {
      await runtime.teardown();
    }
  }, SERVER);

  expect(result.status).toBe(200);
  expect(result.body).toMatch(/^answered after 4\d+s$/u);
  expect(pageErrors).toEqual([]);
});
