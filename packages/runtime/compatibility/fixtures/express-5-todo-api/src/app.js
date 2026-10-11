import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { errorHandler, notFound } from './middleware/errors.js';
import { requestLog } from './middleware/request-log.js';
import { todosRouter } from './routes/todos.js';
import { createTodoStore } from './store.js';

const publicDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp() {
  const app = express();
  const todos = createTodoStore();

  app.disable('x-powered-by');
  app.use(requestLog);
  app.use(express.json());
  app.use(express.static(publicDirectory));

  app.get('/health', (_request, response) => {
    response.json({ status: 'ok' });
  });
  app.use('/api/todos', todosRouter(todos));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
