import type { Page } from '@playwright/test';

import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';
import {
  startBundledConsumer,
  type BundledConsumerKind,
  type CleanExternalConsumerWindow
} from './clean-external-consumer-harness';

const bundlerConsumerClaim = defineCompatibilityClaim({
  id: 'mimic-bundler-consumers-v1',
  statement:
    'A consumer bundled by Vite or webpack 5 from the packed @mimic-js/runtime artifact boots the container, runs a Node HTTP server, loads its Published Endpoint, and opens a SQLite database',
  target: {
    kind: 'runtime-capability',
    capability: 'mimic-bundler-consumers'
  }
});

const missingHeaderClaim = defineCompatibilityClaim({
  id: 'mimic-missing-header-errors-v1',
  statement:
    'Booting a bundled consumer whose server omits the cross-origin isolation headers fails with one error that names them',
  target: {
    kind: 'runtime-capability',
    capability: 'mimic-missing-header-errors'
  }
});

for (const [kind, title] of [
  ['vite-dev', 'the Vite development server'],
  ['vite-preview', 'a Vite production build'],
  ['webpack', 'a webpack 5 production build']
] as const satisfies readonly (readonly [BundledConsumerKind, string])[]) {
  test(`${bundlerConsumerClaim.statement}: ${title}`, async ({ page }) => {
    test.setTimeout(300_000);
    const pageErrors: string[] = [];
    const requestedUrls: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
    page.on('request', (request) => requestedUrls.push(request.url()));

    const consumer = await startBundledConsumer(kind);
    try {
      await openConsumer(page, consumer.url);
      expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true);

      const receipt = await page.evaluate(async () => {
        const { Mimic } = (window as unknown as CleanExternalConsumerWindow)
          .__cleanExternalConsumer;
        const runtime = await Mimic.boot({ workdir: '/home/bundled-consumer' });
        try {
          await runtime.fs.mount({
            'server.mjs': {
              file: {
                contents: [
                  "import http from 'node:http';",
                  "http.createServer((request, response) => response.end('bundled:' + request.url)).listen(4120);"
                ].join('\n')
              }
            },
            'database.mjs': {
              file: {
                contents: [
                  "import { DatabaseSync } from 'node:sqlite';",
                  "const database = new DatabaseSync(':memory:');",
                  "console.log('answer:' + database.prepare('SELECT 40 + 2 AS answer').get().answer);"
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
            server.exit.then((exitCode) => {
              throw new Error(`The server exited early with ${exitCode}.`);
            })
          ]);
          const response = await runtime.endpoints.fetch(new URL('runtime-proof', url), { cache: 'no-store' });
          const body = await response.text();
          server.kill('SIGTERM');
          const serverExit = await server.exit;

          const database = await runtime.spawn('node', ['database.mjs']);
          let databaseOutput = '';
          const reader = database.output.getReader();
          const decoder = new TextDecoder();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            databaseOutput += decoder.decode(value, { stream: true });
          }
          return {
            endpointSameOrigin: new URL(url).origin === location.origin,
            response: { status: response.status, body },
            serverExit,
            database: { exit: await database.exit, output: databaseOutput.trim() }
          };
        } finally {
          await runtime.teardown();
        }
      });

      expect(receipt).toEqual({
        endpointSameOrigin: true,
        response: { status: 200, body: 'bundled:/runtime-proof' },
        serverExit: 143,
        database: { exit: 0, output: 'answer:42' }
      });
      expect(pageErrors).toEqual([]);
      // Every runtime file came from the consumer's own server.
      expect(requestedUrls.filter((url) => !url.startsWith(consumer.url))).toEqual([]);
    } finally {
      await consumer.close();
    }
  });
}

test(missingHeaderClaim.statement, async ({ page }) => {
  test.setTimeout(300_000);
  const consumer = await startBundledConsumer('webpack');
  try {
    const bootError = async (target: Page, url: string): Promise<string> => {
      await openConsumer(target, url);
      return target.evaluate(async () => {
        const { Mimic } = (window as unknown as CleanExternalConsumerWindow)
          .__cleanExternalConsumer;
        try {
          const runtime = await Mimic.boot();
          await runtime.teardown();
          return 'booted';
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      });
    };

    expect(await bootError(page, await consumer.serveWithout('cross-origin-isolation'))).toBe(
      'Mimic.boot() requires a cross-origin isolated page: serve the embedding page with the ' +
        '"Cross-Origin-Opener-Policy: same-origin" and "Cross-Origin-Embedder-Policy: require-corp" headers.'
    );
  } finally {
    await consumer.close();
  }
});

async function openConsumer(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await expect
    .poll(() => page.evaluate(() => Reflect.has(window, '__cleanExternalConsumer')), { timeout: 60_000 })
    .toBe(true);
}
