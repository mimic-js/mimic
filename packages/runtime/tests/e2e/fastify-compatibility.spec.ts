import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './stack-scenario';

const fastifyCompatibilityClaim = defineCompatibilityClaim({
  id: 'fastify-5-10-0',
  statement:
    'Fastify 5.10.0 serves plugins, schemas, streams, and errors through a Published Endpoint to an application-owned fetch client',
  target: {
    kind: 'exact-graph',
    packages: { fastify: '5.10.0' },
    packageManager: { name: 'npm', version: '11.18.0' },
    lockfile: {
      format: 'npm',
      version: 3,
      path: 'compatibility/fixtures/fastify-5.10.0/package-lock.json'
    },
    virtualPlatform: { operatingSystem: 'linux', architecture: 'wasm32', runtime: 'browser', nodeVersion: '22.22.3' },
    replacements: {},
    execution: { command: 'node', entrypoint: 'server.mjs' }
  }
});

test.use({ fixture: 'fastify-5.10.0' });

test(fastifyCompatibilityClaim.statement, async ({ stack }) => {
  await stack.install();
  const server = await stack.start('node server.mjs');
  expect(server.port).toBe(5173);
  expect(new URL(server.url).origin).toBe(new URL(stack.page.url()).origin);

  expect(await server.fetch('/plugin/42')).toMatchObject({
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ ok: true, plugin: 'registered', value: 42 })
  });
  expect(await server.fetch('/stream')).toMatchObject({
    status: 200,
    headers: { 'content-type': 'text/plain', 'x-fastify-stream': 'generic-http' },
    body: 'fastify-stream'
  });
  expect(await server.fetch('/error')).toMatchObject({
    status: 418,
    body: JSON.stringify({ handled: true, message: 'representative-fastify-error' })
  });

  const vfsMiss = await server.fetch('/vfs-published-endpoint-miss.txt');
  expect(vfsMiss.status).toBe(404);
  expect(vfsMiss.body).not.toContain('this VFS-only marker must never satisfy a Fastify Published Endpoint request');

  expect(await server.fetch('/shutdown')).toMatchObject({ status: 200, body: JSON.stringify({ closing: true }) });
  await server.waitForOutput('fastify-compatibility-closed null', { timeoutMs: 5_000 });
  const { exitCode, output } = await server.exit(30_000);
  expect(exitCode).toBe(0);
  expect(output).toContain('fastify-compatibility-ready');
  expect((await server.fetch('/plugin/42')).status).toBe(404);
});
