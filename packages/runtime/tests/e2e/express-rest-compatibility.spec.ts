import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, npmExactGraph, test } from './stack-scenario';

const claim = defineCompatibilityClaim({
  id: 'express-5-2-1-rest-api',
  statement: 'Express 5.2.1 serves a JSON CRUD API, static files and error responses, and closes its server on SIGTERM before it exits 0',
  target: npmExactGraph('express-5-todo-api', { express: '5.2.1' }, 'npm start')
});

test.use({ fixture: 'express-5-todo-api' });

test(claim.statement, async ({ stack }) => {
  await stack.install();
  const server = await stack.start('npm start');

  expect(JSON.parse((await server.fetch('/health')).body)).toEqual({ status: 'ok' });

  const created = await server.fetch('/api/todos', { method: 'POST', json: { title: 'Write the report' } });
  expect(created.status, await server.output()).toBe(201);
  const todo = JSON.parse(created.body);
  // The Published Endpoint rewrites Location under its own path prefix.
  expect(created.headers.location).toMatch(new RegExp(`/api/todos/${todo.id}$`));

  const patched = await server.fetch(`/api/todos/${todo.id}`, { method: 'PATCH', json: { done: true } });
  expect(JSON.parse(patched.body)).toMatchObject({ title: 'Write the report', done: true });
  expect(JSON.parse((await server.fetch('/api/todos?done=true')).body)).toHaveLength(1);

  expect((await server.fetch('/api/todos', { method: 'POST', json: {} })).status).toBe(400);
  expect((await server.fetch(`/api/todos/${todo.id}`, { method: 'DELETE' })).status).toBe(204);
  expect(JSON.parse((await server.fetch('/nowhere')).body)).toEqual({ error: 'no route for GET /nowhere' });

  const app = await server.open('/');
  await app.getByPlaceholder('What needs doing?').fill('Ship it');
  await app.getByRole('button', { name: 'Add' }).click();
  await expect(app.getByRole('listitem')).toHaveText(['Ship it']);

  expect(await server.output()).toContain('POST /api/todos 201');
  expect(await server.stop()).toBe(0);
});
