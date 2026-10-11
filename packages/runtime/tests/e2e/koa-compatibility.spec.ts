import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, npmExactGraph, test } from './stack-scenario';

const claim = defineCompatibilityClaim({
  id: 'koa-3-2-1-bookmarks',
  statement: 'Koa 3.2.1 serves a router, a JSON body parser, middleware headers, and static files',
  target: npmExactGraph(
    'koa-3-bookmarks',
    { koa: '3.2.1', '@koa/router': '15.7.0', '@koa/bodyparser': '6.1.0', 'koa-static': '5.0.0' },
    'npm start'
  )
});

test.use({ fixture: 'koa-3-bookmarks' });

test(claim.statement, async ({ stack }) => {
  await stack.install();
  const server = await stack.start('npm start');

  const created = await server.fetch('/api/bookmarks', { method: 'POST', json: { url: 'https://example.com/a' } });
  expect(created.status).toBe(201);
  expect(created.headers['x-response-time']).toMatch(/^\d+ms$/);
  expect(JSON.parse(created.body)).toEqual({ id: 1, url: 'https://example.com/a', title: 'example.com' });

  const rejected = await server.fetch('/api/bookmarks', { method: 'POST', json: { url: 'nope' } });
  expect(rejected.status).toBe(422);
  expect(JSON.parse(rejected.body)).toEqual({ error: 'url must be an absolute URL' });

  expect(JSON.parse((await server.fetch('/api/bookmarks')).body)).toHaveLength(1);
  expect((await server.fetch('/api/bookmarks', { method: 'DELETE' })).status).toBe(405);
  expect((await server.fetch('/index.html')).body).toContain('<h1>Bookmarks</h1>');
});
