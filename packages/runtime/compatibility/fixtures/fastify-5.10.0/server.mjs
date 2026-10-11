import Fastify from 'fastify';
import { Readable } from 'node:stream';

const app = Fastify({ logger: false });

await app.register(async (instance) => {
  instance.addSchema({
    $id: 'proof-response',
    type: 'object',
    required: ['ok', 'plugin', 'value'],
    properties: {
      ok: { type: 'boolean' },
      plugin: { type: 'string' },
      value: { type: 'integer' }
    }
  });
  instance.get('/plugin/:value', {
    schema: { params: { type: 'object', required: ['value'], properties: { value: { type: 'integer' } } },
      response: { 200: { $ref: 'proof-response#' } } }
  }, async (request) => ({ ok: true, plugin: "registered", value: request.params.value }));
});

app.get('/stream', async (_request, reply) => {
  reply.header('x-fastify-stream', 'generic-http');
  reply.type('text/plain');
  return reply.send(Readable.from(['fastify', '-', 'stream']));
});

app.get('/error', async () => {
  const error = new Error('representative-fastify-error');
  error.statusCode = 418;
  throw error;
});

app.setErrorHandler((error, _request, reply) => {
  reply.status(error.statusCode ?? 500).send({ handled: true, message: error.message });
});

app.get('/shutdown', async (_request, reply) => {
  reply.send({ closing: true });
  setTimeout(async () => {
    try {
      await app.close();
      console.log('fastify-compatibility-closed', JSON.stringify(app.server.address()));
    } catch (error) {
      console.error('fastify-compatibility-close-error', error?.stack ?? error);
    }
  }, 0);
});

await app.listen({ port: 5173, host: '127.0.0.1' });
console.log('fastify-compatibility-ready', JSON.stringify(app.server.address()));
