// Measures what a consumer pays before a first program runs: the time from
// `spawn('node', ['-e', '0'])` to its exit in a freshly booted container whose
// workers come from the built package, with nothing in the HTTP cache.
//
//   pnpm build:package && node scripts/measure-cold-spawn.mjs [runs]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const runs = Number(process.argv[2] ?? 9);
const contentTypes = {
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map': 'application/json'
};

const server = createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cache-Control', 'no-store');
  const path = new URL(request.url ?? '/', 'http://measure.invalid').pathname;
  if (path === '/') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(
      '<!doctype html><title>cold spawn</title><script type="module">' +
        "import { Mimic } from '/mimic.js'; window.Mimic = Mimic;" +
        '</script>'
    );
    return;
  }
  try {
    const file = join(dist, normalize(path));
    if (!file.startsWith(dist)) throw new Error('outside dist');
    const body = await readFile(file);
    response.setHeader('Content-Type', contentTypes[extname(file)] ?? 'application/octet-stream');
    response.end(body);
  } catch {
    response.statusCode = 404;
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const samples = [];
try {
  for (let run = 0; run < runs; run += 1) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(origin);
    await page.waitForFunction(() => 'Mimic' in window);
    samples.push(
      await page.evaluate(async () => {
        const { Mimic } = window;
        const bootStarted = performance.now();
        const container = await Mimic.boot();
        const spawnStarted = performance.now();
        const process = await container.spawn('node', ['-e', '0']);
        const exitCode = await process.exit;
        const exited = performance.now();
        await container.teardown();
        if (exitCode !== 0) throw new Error(`node -e 0 exited with ${exitCode}`);
        return { boot: spawnStarted - bootStarted, spawn: exited - spawnStarted };
      })
    );
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const round = (value) => Math.round(value * 10) / 10;
console.log(
  JSON.stringify({
    runs,
    bootMedianMs: round(median(samples.map((sample) => sample.boot))),
    spawnMedianMs: round(median(samples.map((sample) => sample.spawn))),
    spawnMinMs: round(Math.min(...samples.map((sample) => sample.spawn))),
    spawnMaxMs: round(Math.max(...samples.map((sample) => sample.spawn)))
  })
);
