const http = require('node:http');
const { readFileSync } = require('node:fs');
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const path = pathname === '/' ? 'index.html' : pathname.slice(1);
  try { response.setHeader('content-type', path.endsWith('.js') ? 'text/javascript' : 'text/html'); response.end(readFileSync(path)); } catch { response.statusCode = 404; response.end('missing'); }
});
server.listen(5173);