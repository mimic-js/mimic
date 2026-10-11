import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { logger } from 'hono/logger';
import { z } from 'zod';

import { createNoteStore } from './notes.js';

const notes = createNoteStore();

const noteInput = z.object({
  title: z.string().min(1).max(120),
  body: z.string().default('')
});

export const app = new Hono();

app.use(logger());
app.use('/api/*', cors());

app.get('/health', (context) => context.json({ status: 'ok', uptime: process.uptime() }));

app.get('/api/notes', (context) => context.json(notes.list()));

app.post('/api/notes', zValidator('json', noteInput), (context) => {
  const note = notes.create(context.req.valid('json'));
  return context.json(note, 201);
});

app.get('/api/notes/:id', (context) => {
  const note = notes.get(context.req.param('id'));
  if (!note) throw new HTTPException(404, { message: 'note not found' });
  return context.json(note);
});

app.delete('/api/notes/:id', (context) => {
  if (!notes.remove(context.req.param('id'))) throw new HTTPException(404, { message: 'note not found' });
  return context.body(null, 204);
});

app.onError((error, context) => {
  if (error instanceof HTTPException) return context.json({ error: error.message }, error.status);
  console.error(error);
  return context.json({ error: 'internal error' }, 500);
});
