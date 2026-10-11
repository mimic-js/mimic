import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';

const publishedWebSocketTransportClaim = defineCompatibilityClaim({
  id: 'published-endpoint-websocket-transport-v1',
  statement:
    'A published document WebSocket keeps send order, drains bufferedAmount as the server reads, holds a flooding server, reports a dropped server as an abnormal closure, survives a Service Worker restart and closes when its server process dies',
  target: {
    kind: 'runtime-capability',
    capability: 'published-endpoint-websocket-transport'
  }
});

const PORT = 4400;
const FLOOD_FRAMES = 24;
const FLOOD_FRAME_BYTES = 256 * 1024;

const serverSource = String.raw`
import http from 'node:http';
import { createHash } from 'node:crypto';

const server = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><html><head><title>Sockets</title></head><body><h1>sockets</h1></body></html>');
});

function frame(opcode, payload) {
  const length = payload.length;
  const header = length < 126 ? Buffer.from([0x80 | opcode, length])
    : length <= 0xffff ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
    : Buffer.concat([Buffer.from([0x80 | opcode, 127, 0, 0, 0, 0]), Buffer.from([length >>> 24, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff])]);
  return Buffer.concat([header, payload]);
}

/** Calls onFrame(opcode, payload) for each masked client frame. */
function readFrames(socket, onFrame) {
  let pending = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      if (pending.length < 2) return;
      let length = pending[1] & 0x7f;
      let offset = 2;
      if (length === 126) { if (pending.length < 4) return; length = pending.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (pending.length < 10) return; length = pending.readUInt32BE(6); offset = 10; }
      if (pending.length < offset + 4 + length) return;
      const mask = pending.subarray(offset, offset + 4);
      const payload = Buffer.from(pending.subarray(offset + 4, offset + 4 + length));
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      const opcode = pending[0] & 0x0f;
      pending = pending.subarray(offset + 4 + length);
      onFrame(opcode, payload);
    }
  });
}

server.on('upgrade', (request, socket) => {
  const accept = createHash('sha1')
    .update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const path = request.url;
  if (path === '/abrupt') {
    socket.write(frame(1, Buffer.from('bye-soon')));
    setTimeout(() => socket.destroy(), 50);
    return;
  }
  if (path === '/flood') {
    // Each write's callback runs once the socket took it; a document that
    // reads slowly holds the last of them.
    readFrames(socket, (opcode) => {
      if (opcode === 8) {
        socket.end(frame(8, Buffer.alloc(0)));
        return;
      }
      const started = Date.now();
      let pending = ${FLOOD_FRAMES};
      for (let index = 0; index < ${FLOOD_FRAMES}; index += 1) {
        socket.write(frame(2, Buffer.alloc(${FLOOD_FRAME_BYTES}, index)), () => {
          pending -= 1;
          if (pending === 0) console.log('flood-written-after', Date.now() - started);
        });
      }
    });
    return;
  }
  readFrames(socket, (opcode, payload) => {
    console.log('frame', path, opcode, opcode === 1 ? payload.toString() : payload.length);
    if (opcode === 1) socket.write(frame(1, Buffer.from('echo:' + payload.toString().slice(0, 32))));
    if (opcode === 8) socket.end(frame(8, payload.subarray(0, 2)));
  });
});

server.listen(${PORT});
`;

type TransportWindow = Window & {
  transportRuntime: import('../../src/runtime').Mimic;
  transportServer: import('../../src/runtime').MimicProcess;
  transportOutput: string[];
  heldSocket?: WebSocket;
  heldEvents?: string[];
};

test(publishedWebSocketTransportClaim.statement, async ({ page }) => {
  test.setTimeout(180_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));

  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated)).toBe(true);

  const appUrl = await page.evaluate(async (serverSource) => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const runtime = await Mimic.boot({ workdir: '/home/websocket-transport' });
    const state = window as unknown as TransportWindow;
    state.transportRuntime = runtime;
    state.transportOutput = [];
    await runtime.fs.mount({ 'server.mjs': { file: { contents: serverSource } } });
    const published = new Promise<string>((resolve) => {
      runtime.endpoints.on('published', (endpoint) => resolve(endpoint.url));
    });
    const server = await runtime.spawn('node', ['server.mjs']);
    state.transportServer = server;
    const decoder = new TextDecoder();
    void (async () => {
      const reader = server.output.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        state.transportOutput.push(decoder.decode(value));
      }
    })();
    const url = await published;
    const iframe = document.createElement('iframe');
    await new Promise<void>((resolve) => {
      iframe.addEventListener('load', () => resolve(), { once: true });
      iframe.src = url;
      document.body.appendChild(iframe);
    });
    return url;
  }, serverSource);
  const app = page.frames().find((frame) => frame.url() === appUrl);
  expect(app, 'the application frame').toBeDefined();

  const result = await app!.evaluate(
    async ({ floodFrames, floodFrameBytes }) => {
      const socketUrl = (path: string) => {
        const url = new URL(path, location.href);
        url.protocol = 'ws:';
        url.pathname = new URL(location.href).pathname.replace(/\/$/u, '') + path;
        return url.href;
      };
      const opened = (path: string) =>
        new Promise<WebSocket>((resolve, reject) => {
          const socket = new WebSocket(socketUrl(path));
          socket.binaryType = 'arraybuffer';
          socket.addEventListener('open', () => resolve(socket), { once: true });
          socket.addEventListener('error', () => reject(new Error(`${path} failed to open`)), { once: true });
        });
      const closed = (socket: WebSocket) =>
        new Promise<string>((resolve) =>
          socket.addEventListener('close', (event) => resolve(`${event.code}:${event.reason}:${event.wasClean}`), {
            once: true
          })
        );

      // A Blob read asynchronously still reaches the server before the text sent after it.
      const ordered = await opened('/ordered');
      const orderedClosed = closed(ordered);
      ordered.send(new Blob([new Uint8Array([1, 2, 3, 4])]));
      ordered.send('after-blob');
      ordered.close(1000, 'ordered-done');
      const orderedClose = await orderedClosed;

      // bufferedAmount counts the sends the server's socket has not taken.
      const buffered = await opened('/buffered');
      const echoes: string[] = [];
      const echoed = new Promise<void>((resolve) => {
        buffered.addEventListener('message', (event) => {
          echoes.push(String(event.data).slice(0, 12));
          if (echoes.length === 3) resolve();
        });
      });
      const large = 'x'.repeat(100_000);
      buffered.send(large);
      buffered.send(large);
      buffered.send(large);
      const queued = buffered.bufferedAmount;
      await echoed;
      const started = performance.now();
      while (buffered.bufferedAmount > 0 && performance.now() - started < 5_000) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const drained = buffered.bufferedAmount;
      buffered.close();

      // A server that drops its socket without a close frame closes abnormally.
      const abruptEvents: string[] = [];
      const abrupt = new WebSocket(socketUrl('/abrupt'));
      await new Promise<void>((resolve) => {
        abrupt.addEventListener('message', (event) => abruptEvents.push(`message:${String(event.data)}`));
        abrupt.addEventListener('error', () => abruptEvents.push('error'));
        abrupt.addEventListener('close', (event) => {
          abruptEvents.push(`close:${event.code}:${event.wasClean}`);
          resolve();
        });
      });

      // Every frame of a flooding server arrives, in order, while the server
      // waits for a document that takes 20 ms over each message.
      const flood = await opened('/flood');
      const floodSeen: number[] = [];
      let floodBytes = 0;
      const flooded = new Promise<void>((resolve) => {
        flood.addEventListener('message', (event) => {
          const until = performance.now() + 20;
          while (performance.now() < until);
          const bytes = new Uint8Array(event.data as ArrayBuffer);
          floodSeen.push(bytes[0]);
          floodBytes += bytes.byteLength;
          if (floodSeen.length === floodFrames) resolve();
        });
      });
      flood.send('go');
      await flooded;
      flood.close();

      // A shared listener sees its own socket as `this`, and the handler attribute runs.
      const thisChecks: boolean[] = [];
      function shared(this: WebSocket, event: Event) {
        thisChecks.push(this === event.currentTarget);
      }
      const first = await opened('/first');
      const second = await opened('/second');
      first.addEventListener('message', shared);
      second.addEventListener('message', shared);
      const handled = new Promise<string>((resolve) => {
        second.onmessage = (event) => resolve(String(event.data));
      });
      first.send('one');
      second.send('two');
      const handlerMessage = await handled;
      await new Promise((resolve) => setTimeout(resolve, 50));
      first.close();
      second.close();

      const external = new WebSocket('wss://published-websocket-transport.invalid/');
      const externalIsWebSocket = external instanceof WebSocket;
      external.close();

      return {
        orderedClose,
        queued,
        drained,
        echoes,
        abruptEvents,
        floodInOrder: floodSeen.every((value, index) => value === index),
        floodBytes: floodBytes === floodFrames * floodFrameBytes,
        thisChecks,
        handlerMessage,
        externalIsWebSocket
      };
    },
    { floodFrames: FLOOD_FRAMES, floodFrameBytes: FLOOD_FRAME_BYTES }
  );

  expect(result).toEqual({
    orderedClose: '1000:ordered-done:true',
    queued: 300_000,
    drained: 0,
    echoes: ['echo:xxxxxxx', 'echo:xxxxxxx', 'echo:xxxxxxx'],
    abruptEvents: ['message:bye-soon', 'error', 'close:1006:false'],
    floodInOrder: true,
    floodBytes: true,
    thisChecks: [true, true],
    handlerMessage: 'echo:two',
    externalIsWebSocket: true
  });
  const output = () => page.evaluate(() => (window as unknown as TransportWindow).transportOutput.join(''));
  await expect.poll(output).toContain('frame /ordered 8');
  const orderedFrames = (await output())
    .split('\n')
    .filter((line) => line.startsWith('frame /ordered'));
  expect(orderedFrames).toEqual(['frame /ordered 2 4', 'frame /ordered 1 after-blob', 'frame /ordered 8 14']);
  // The server's writes waited for the document instead of piling up in it:
  // the last of them was taken only after most of the document's 20 ms reads.
  await expect.poll(output).toContain('flood-written-after');
  const floodWrittenAfter = Number(/flood-written-after (\d+)/u.exec(await output())?.[1]);
  expect(floodWrittenAfter).toBeGreaterThan(200);

  // The browser stops an idle Service Worker; a socket opened afterwards reaches its host again.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  const afterRestart = await app!.evaluate(async () => {
    const url = new URL('restarted', location.href);
    url.protocol = 'ws:';
    const socket = new WebSocket(url.href);
    return new Promise<string>((resolve) => {
      socket.onopen = () => socket.send('after-restart');
      socket.onmessage = (event) => {
        resolve(String(event.data));
        socket.close();
      };
      socket.onclose = (event) => resolve(`closed:${event.code}`);
    });
  });
  expect(afterRestart).toBe('echo:after-restart');
  const documentAfterRestart = await app!.evaluate(() => fetch(location.href).then((response) => response.status));
  expect(documentAfterRestart).toBe(200);

  // A socket whose server process dies closes abnormally.
  await app!.evaluate(async () => {
    const state = window as unknown as TransportWindow;
    const url = new URL('held', location.href);
    url.protocol = 'ws:';
    const socket = new WebSocket(url.href);
    state.heldSocket = socket;
    state.heldEvents = [];
    socket.addEventListener('error', () => state.heldEvents!.push('error'));
    socket.addEventListener('close', (event) => state.heldEvents!.push(`close:${event.code}:${event.wasClean}`));
    await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  });
  await page.evaluate(async () => {
    const state = window as unknown as TransportWindow;
    state.transportServer.kill('SIGKILL');
    await state.transportServer.exit.catch(() => undefined);
  });
  await expect
    .poll(() => app!.evaluate(() => (window as unknown as TransportWindow).heldEvents))
    .toEqual(['error', 'close:1006:false']);

  await page.evaluate(() => (window as unknown as TransportWindow).transportRuntime.teardown());
  expect(pageErrors).toEqual([]);
});
