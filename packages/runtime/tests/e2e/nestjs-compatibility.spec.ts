import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, npmExactGraph, test } from './stack-scenario';

const claim = defineCompatibilityClaim({
  id: 'nestjs-12-1-2-tasks-api',
  statement:
    'NestJS 12.1.2 builds with the Nest CLI 12.0.8 on TypeScript 6.0.3 and serves validated controllers on Express',
  target: npmExactGraph(
    'nestjs-12-tasks-api',
    {
      '@nestjs/core': '12.1.2',
      '@nestjs/common': '12.1.2',
      '@nestjs/platform-express': '12.1.2',
      '@nestjs/cli': '12.0.8',
      'class-validator': '0.15.1',
      typescript: '6.0.3'
    },
    'npm run start:prod'
  )
});

test.use({ fixture: 'nestjs-12-tasks-api' });

test(claim.statement, async ({ stack }) => {
  await stack.install();
  const build = await stack.run('npm run build', { timeoutMs: 240_000 });
  expect(build.exitCode, build.output).toBe(0);
  expect(await stack.exists('dist/tasks/tasks.controller.js')).toBe(true);

  const server = await stack.start('npm run start:prod');

  const created = await server.fetch('/tasks', { method: 'POST', json: { title: 'Probe', ignored: true } });
  expect(created.status).toBe(201);
  const task = JSON.parse(created.body);
  expect(task).toEqual({ id: task.id, title: 'Probe', description: '', done: false });

  const rejected = await server.fetch('/tasks', { method: 'POST', json: {} });
  expect(rejected.status).toBe(400);
  expect(JSON.parse(rejected.body).message).toContain('title should not be empty');

  const completed = await server.fetch(`/tasks/${task.id}/complete`, { method: 'PATCH' });
  expect(JSON.parse(completed.body).done).toBe(true);
  expect((await server.fetch('/tasks/missing')).status).toBe(404);
  expect((await server.fetch(`/tasks/${task.id}`, { method: 'DELETE' })).status).toBe(204);
  expect(JSON.parse((await server.fetch('/tasks')).body)).toEqual([]);
  expect(await server.output()).toContain('Nest application successfully started');
});
