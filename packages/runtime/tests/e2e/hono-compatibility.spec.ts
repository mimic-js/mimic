import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, npmExactGraph, test } from './stack-scenario';

const claim = defineCompatibilityClaim({
  id: 'hono-4-13-13-tsx-notes-api',
  statement:
    'Hono 4.13.13 on @hono/node-server 2.1.3 serves a validated JSON API from TypeScript sources run by tsx 4.23.15',
  target: npmExactGraph(
    'hono-4-notes-api',
    { hono: '4.13.13', '@hono/node-server': '2.1.3', '@hono/zod-validator': '0.9.1', zod: '4.6.5', tsx: '4.23.15' },
    'npm start'
  )
});

test.use({ fixture: 'hono-4-notes-api' });

test(claim.statement, async ({ stack }) => {
  await stack.install();
  const server = await stack.start('npm start');

  expect(JSON.parse((await server.fetch('/health')).body).status).toBe('ok');

  const created = await server.fetch('/api/notes', { method: 'POST', json: { title: 'Probe' } });
  expect(created.status).toBe(201);
  expect(created.headers['access-control-allow-origin']).toBe('*');
  const note = JSON.parse(created.body);
  expect(note).toMatchObject({ title: 'Probe', body: '' });

  expect((await server.fetch('/api/notes', { method: 'POST', json: { title: '' } })).status).toBe(400);
  expect(JSON.parse((await server.fetch('/api/notes')).body)).toEqual([note]);
  expect(JSON.parse((await server.fetch('/api/notes/missing')).body)).toEqual({ error: 'note not found' });
  expect((await server.fetch(`/api/notes/${note.id}`, { method: 'DELETE' })).status).toBe(204);
  // Hono's logger colours the status.
  expect(await server.output()).toMatch(/--> POST \/api\/notes .*201/);
});
