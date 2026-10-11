import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './stack-scenario';

const expressCompatibilityClaim = defineCompatibilityClaim({
  id: 'express-5-2-1-published-endpoint-vfs-miss',
  statement:
    'Express 5.2.1 serves its exact graph through an application-owned Published Endpoint client, returns an ordinary 404 for a VFS-only miss, stays healthy, and closes cleanly',
  target: {
    kind: 'exact-graph',
    packages: { express: '5.2.1' },
    packageManager: { name: 'npm', version: '11.18.0' },
    lockfile: {
      format: 'npm',
      version: 3,
      path: 'compatibility/fixtures/express-5.2.1/package-lock.json'
    },
    virtualPlatform: { operatingSystem: 'linux', architecture: 'wasm32', runtime: 'browser', nodeVersion: '22.22.3' },
    replacements: {},
    execution: { command: 'node', entrypoint: 'server.mjs' }
  }
});

test.use({ fixture: 'express-5.2.1' });

test(expressCompatibilityClaim.statement, async ({ stack }) => {
  await stack.install();
  const server = await stack.start('node server.mjs');
  expect(server.port).toBe(5173);

  const stream = await server.fetch('/compatibility/express');
  expect(stream).toMatchObject({
    status: 206,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'x-express-proof': 'mimic' },
    body: 'stream-body'
  });
  await server.waitForOutput('express-compatibility-loopback-end ["stream-","body"]', { timeoutMs: 10_000 });

  const staticFile = await server.fetch('/static/public.txt');
  expect(staticFile).toMatchObject({ status: 200, body: 'unmodified-express-static' });
  expect(staticFile.headers.etag).toMatch(/^W\//);

  expect(await server.fetch('/compatibility/error')).toMatchObject({
    status: 503,
    headers: { 'x-express-error': 'handled' },
    body: JSON.stringify({ error: 'express-intentional-error' })
  });

  const vfsMiss = await server.fetch('/vfs-published-endpoint-miss.txt', { timeoutMs: 5_000 });
  expect(vfsMiss.status).toBe(404);
  expect(vfsMiss.body).not.toContain('this file must never satisfy an Express Published Endpoint miss');

  expect(await server.fetch('/compatibility/close')).toMatchObject({
    status: 202,
    headers: { 'x-express-close': 'graceful' },
    body: 'closing'
  });
  const { exitCode, output } = await server.exit(10_000);
  expect(exitCode).toBe(0);
  expect((await server.fetch('/', { timeoutMs: 2_000 })).status).not.toBe(200);

  expect(output).toContain('express-compatibility-stream-first');
  expect(output).toContain('express-compatibility-stream-end');
  expect(output).toContain('express-compatibility-loopback-data 1 stream-');
  expect(output).toContain('express-compatibility-loopback-data 2 body');
  expect(output).toMatch(/express-static-stat \/home\/[^ ]+\/public\.txt true 25 true/);
  expect(output).toContain('express-static-finish');
  expect(output).toContain('express-static-close');
  expect(output).not.toContain('express-compatibility-loopback-error');
  expect(output).not.toContain('TypeError: req.unpipe is not a function');
  expect(output).toContain('express-compatibility-close ok null');
});
