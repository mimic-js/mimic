import http from 'node:http';
import * as wsModule from 'ws';

const { WebSocketServer } = wsModule;
console.log('ws-exports', typeof wsModule.default, typeof WebSocketServer, Object.keys(wsModule).sort().join(','));
const server = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><h1 id="status">ws connecting</h1><script>
    const socket = new WebSocket(new URL('/socket', location.href).href.replace(/^http/, 'ws'), 'ws-compatibility');
    const textMessages = [];
    const binaryMessages = [];
    const rejectedEvents = [];
    let exchangeComplete = false;
    const report = () => {
      if (!exchangeComplete || rejectedEvents.length !== 2) return;
      document.getElementById('status').textContent = 'ws graph works';
      parent.postMessage({ type: 'ws-compatibility-result', textMessages, binaryMessages, rejectedEvents, protocol: socket.protocol }, location.origin);
      socket.close(1000, 'done');
    };
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('open', () => { socket.send('browser-client'); socket.send(new Uint8Array([5, 8, 13, 21])); });
    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') textMessages.push({ length: event.data.length, prefix: event.data.slice(0, 22) });
      else binaryMessages.push(Array.from(new Uint8Array(event.data)));
      if (textMessages.length !== 2 || binaryMessages.length !== 1) return;
      exchangeComplete = true;
      report();
    });
    const rejected = new WebSocket(new URL('/reject', location.href).href.replace(/^http/, 'ws'), 'ws-compatibility');
    rejected.addEventListener('error', () => { rejectedEvents.push('error'); report(); });
    rejected.addEventListener('close', (event) => { rejectedEvents.push('close:' + event.code + ':' + event.wasClean); report(); });
  </script>`);
});
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, verifyClient: ({ req }) => req.url !== '/reject' });
server.on('upgrade', (request, socket, head) => {
  console.log('ws-upgrade', request.url, request.headers.upgrade, request.headers['sec-websocket-protocol']);
  wss.handleUpgrade(request, socket, head, (webSocket) => {
    wss.emit('connection', webSocket, request);
  });
});
wss.on('connection', (socket, request) => {
  console.log('ws-connection', request.url, socket.protocol);
  let receivedMessages = 0;
  socket.on('error', (error) => console.log('ws-error', error.message));
  socket.on('close', (code, reason) => {
    console.log('ws-close', code, reason.toString());
    wss.close(() => {
      console.log('wss-close');
      server.close((error) => console.log('http-close', error?.message ?? 'ok'));
    });
  });
  socket.on('pong', (data) => console.log('ws-pong', data.toString()));
  socket.on('message', (data, isBinary) => {
    receivedMessages += 1;
    console.log('ws-message', isBinary ? Array.from(data).join(',') : data.toString(), isBinary);
    if (receivedMessages !== 2) return;
    socket.send('fragment-', { fin: false });
    socket.send('complete', { fin: true });
    socket.send(new Uint8Array([21, 13, 8, 5]), { binary: true });
    socket.ping('health');
    const payload = 'server:browser-client:' + 'x'.repeat(32 * 1024);
    socket.send(payload, (error) => console.log('ws-backpressure-callback', error?.message ?? 'ok', socket.bufferedAmount));
    console.log('ws-backpressure-after-send', socket.bufferedAmount);
  });
});
server.listen(5173, '127.0.0.1');