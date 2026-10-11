import express from 'express';
import fs from 'node:fs';
import http from 'node:http';

const app = express();
const keepAlive = setTimeout(() => {}, 120_000);
app.get('/compatibility/express', (_request, response) => {
  response.status(206).set({ 'content-type': 'text/plain; charset=utf-8', 'transfer-encoding': 'chunked', 'x-express-proof': 'mimic' });
  console.log('express-compatibility-stream-first');
  response.write('stream-');
  setTimeout(() => { console.log('express-compatibility-stream-end'); response.end('body'); }, 25);
});

app.use('/static', (_request, response, next) => { response.on('finish', () => console.log('express-static-finish')); response.on('close', () => console.log('express-static-close')); next(); });
app.use('/static', express.static(process.cwd(), { setHeaders: (_response, path, stat) => console.log('express-static-stat', path, stat instanceof fs.Stats, stat.size, stat.isFile()) }));

app.get('/compatibility/error', (_request, _response, next) => {
  next(new Error('express-intentional-error'));
});

app.get('/compatibility/close', (_request, response) => {
  response.once('finish', () => {
    server.close((error) => {
      console.log('express-compatibility-close', error?.message ?? 'ok', JSON.stringify(server.address()));
      clearTimeout(keepAlive);
    });
  });
  response.status(202).set({ 'content-type': 'text/plain; charset=utf-8', 'x-express-close': 'graceful' }).send('closing');
});

app.use((error, _request, response, _next) => {
  console.log('express-compatibility-error', error.message);
  response.status(503).set('x-express-error', 'handled').json({ error: error.message });
});

const server = app.listen(5173, '127.0.0.1', () => {
  console.log('express-compatibility-server-ready', JSON.stringify(server.address()));
  const request = http.get({ hostname: '127.0.0.1', port: 5173, path: '/compatibility/express' }, (response) => {
    const chunks = [];
    response.setEncoding('utf8');
    response.on('data', (chunk) => { chunks.push(chunk); console.log('express-compatibility-loopback-data', chunks.length, chunk); });
    response.on('end', () => console.log('express-compatibility-loopback-end', JSON.stringify(chunks)));
  });
  request.on('error', (error) => console.log('express-compatibility-loopback-error', error.message));
});
