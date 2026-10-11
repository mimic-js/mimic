import { Router } from 'express';

import { HttpError } from '../middleware/errors.js';

export function todosRouter(todos) {
  const router = Router();

  router.get('/', (request, response) => {
    const { done } = request.query;
    const all = todos.list();
    response.json(done === undefined ? all : all.filter((todo) => String(todo.done) === done));
  });

  router.post('/', (request, response) => {
    const title = typeof request.body?.title === 'string' ? request.body.title.trim() : '';
    if (title === '') throw new HttpError(400, 'title is required');
    const todo = todos.create(title);
    response.status(201).location(`/api/todos/${todo.id}`).json(todo);
  });

  router.get('/:id', (request, response) => {
    const todo = todos.get(request.params.id);
    if (!todo) throw new HttpError(404, 'todo not found');
    response.json(todo);
  });

  router.patch('/:id', (request, response) => {
    const { title, done } = request.body ?? {};
    const todo = todos.update(request.params.id, {
      ...(typeof title === 'string' ? { title } : {}),
      ...(typeof done === 'boolean' ? { done } : {})
    });
    if (!todo) throw new HttpError(404, 'todo not found');
    response.json(todo);
  });

  router.delete('/:id', (request, response) => {
    if (!todos.remove(request.params.id)) throw new HttpError(404, 'todo not found');
    response.status(204).end();
  });

  return router;
}
