import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';

const outboundNetworkClaim = defineCompatibilityClaim({
  id: 'browser-backed-outbound-network-v1',
  statement:
    'Mimic provides controlled outbound HTTP, HTTPS, and WebSocket transport while rejecting custom TLS and arbitrary raw-byte requests',
  target: {
    kind: 'runtime-capability',
    capability: 'browser-backed-outbound-network'
  }
});

const outboundHttpLifecycleClaim = defineCompatibilityClaim({
  id: 'outbound-http-process-lifecycle-v1',
  statement:
    'Mimic keeps a Runtime Process alive across a later-turn outbound HTTP response consumer and its completion callbacks',
  target: {
    kind: 'runtime-capability',
    capability: 'outbound-http-process-lifecycle'
  }
});

const outboundHttpBufferedBodyClaim = defineCompatibilityClaim({
  id: 'outbound-http-buffered-response-v1',
  statement:
    'Mimic preserves complete large outbound HTTP response bodies for immediate and delayed Node readable consumers',
  target: {
    kind: 'runtime-capability',
    capability: 'outbound-http-buffered-response'
  }
});

test(outboundHttpBufferedBodyClaim.statement, async ({ context, page }) => {
  test.setTimeout(120_000);
  const largeBody = Buffer.alloc(384 * 1024);
  for (let index = 0; index < largeBody.byteLength; index += 1) {
    largeBody[index] = (index * 31 + 17) % 251;
  }
  const expected = {
    status: 200,
    bytes: largeBody.byteLength,
    digest: createHash('sha256').update(largeBody).digest('hex')
  };
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await context.route(/^http:\/\/buffered-body\.example\.test\/(?:immediate|delayed)$/u, async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        'access-control-allow-origin': '*',
        'content-type': 'application/octet-stream'
      },
      body: largeBody
    });
  });
  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated)).toBe(true);

  const runs = await page.evaluate(async (source) => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const decoder = new TextDecoder();
    const run = async (workdirName: string) => {
      const runtime = await Mimic.boot({ workdir: `/home/${workdirName}` });
      try {
        await runtime.fs.mount({ 'buffered-body.cjs': { file: { contents: source } } });
        const process = await runtime.spawn('node', [`${runtime.workdir}/buffered-body.cjs`], {
          cwd: runtime.workdir
        });
        const reader = process.output.getReader();
        let output = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          output += decoder.decode(value, { stream: true });
        }
        output += decoder.decode();
        return { exitCode: await process.exit, output };
      } finally {
        await runtime.teardown();
      }
    };

    return [
      await run('outbound-http-buffered-body-first'),
      await run('outbound-http-buffered-body-reboot')
    ];
  }, outboundHttpBufferedBodyWitnessSource());

  for (const run of runs) {
    expect(run.exitCode, run.output).toBe(0);
    const resultLine = run.output
      .split('\n')
      .find((line) => line.startsWith('outbound-buffered-body-result '));
    if (!resultLine) throw new Error(`Buffered body witness did not report its result:\n${run.output}`);
    const result: unknown = JSON.parse(resultLine.slice('outbound-buffered-body-result '.length));
    expect(result).toEqual({ immediate: expected, delayed: expected });
  }
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test(outboundHttpLifecycleClaim.statement, async ({ context, page }) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await context.route('http://lifecycle.example.test/request', async (route) => {
    await new Promise<void>((resolve) => setTimeout(resolve, 75));
    await route.fulfill({
      status: 200,
      headers: {
        'access-control-allow-origin': '*',
        'content-type': 'text/plain'
      },
      body: 'lifecycle-ok'
    });
  });
  await page.goto('/mimic-test-host.html', {
    waitUntil: 'domcontentloaded'
  });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated)).toBe(
    true
  );

  const runs = await page.evaluate(async (source) => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const decoder = new TextDecoder();
    const run = async (workdirName: string) => {
      const runtime = await Mimic.boot({ workdir: `/home/${workdirName}` });
      try {
        await runtime.fs.mount({
          'outbound-lifecycle.cjs': { file: { contents: source } }
        });
        const process = await runtime.spawn(
          'node',
          [`${runtime.workdir}/outbound-lifecycle.cjs`],
          { cwd: runtime.workdir }
        );
        const reader = process.output.getReader();
        let output = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          output += decoder.decode(value, { stream: true });
        }
        output += decoder.decode();
        return { exitCode: await process.exit, output };
      } finally {
        await runtime.teardown();
      }
    };

    return [
      await run('outbound-http-lifecycle-first'),
      await run('outbound-http-lifecycle-reboot')
    ];
  }, outboundHttpLifecycleWitnessSource());

  for (const run of runs) {
    expect(run.exitCode, run.output).toBe(0);
    for (const marker of [
      'outbound-lifecycle headers 200',
      'outbound-lifecycle consumption-start',
      'outbound-lifecycle body lifecycle-ok',
      'outbound-lifecycle promise-settled',
      'outbound-lifecycle before-exit'
    ]) {
      expect(run.output).toContain(marker);
    }
    expect(run.output.indexOf('outbound-lifecycle promise-settled')).toBeLessThan(
      run.output.indexOf('outbound-lifecycle before-exit')
    );
    expect(run.output.indexOf('outbound-lifecycle headers 200')).toBeLessThan(
      run.output.indexOf('outbound-lifecycle consumption-start')
    );
  }
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test(outboundNetworkClaim.statement, async ({ context, page }) => {
  test.setTimeout(120_000);
  const webSocketServer = await startControlledWebSocketServer();
  page.on('close', () => void webSocketServer.close());
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await context.route(/^https?:\/\/outbound\.example\.test\/(?:plain|secure)$/u, async (route) => {
    const requestUrl = new URL(route.request().url());
    await route.fulfill({
      status: requestUrl.protocol === 'https:' ? 203 : 202,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-expose-headers': 'x-browser-transport',
        'content-type': 'text/plain',
        'x-browser-transport': requestUrl.protocol.slice(0, -1)
      },
      body: `${requestUrl.protocol}//${requestUrl.host}${requestUrl.pathname}`
    });
  });
  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated)).toBe(true);

  const runs = await page.evaluate(async (source) => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const decoder = new TextDecoder();

    const run = async (workdirName: string) => {
      const runtime = await Mimic.boot({ workdir: `/home/${workdirName}` });
      try {
        await runtime.fs.mount({ 'outbound.mjs': { file: { contents: source } } });
        const process = await runtime.spawn('node', [`${runtime.workdir}/outbound.mjs`], { cwd: runtime.workdir });
        const reader = process.output.getReader();
        let output = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          output += decoder.decode(value, { stream: true });
        }
        output += decoder.decode();
        return { exitCode: await process.exit, output };
      } finally {
        await runtime.teardown();
      }
    };

    return [await run('outbound-network-first'), await run('outbound-network-reboot')];
  }, outboundWitnessSource(webSocketServer.port));

  for (const run of runs) {
    expect(run.exitCode, run.output).toBe(0);
    const resultLine = run.output
      .split('\n')
      .find((line) => line.startsWith('outbound-network-result '));
    if (!resultLine) throw new Error(`Outbound witness did not report its result:\n${run.output}`);
    const result: unknown = JSON.parse(resultLine.slice('outbound-network-result '.length));
    expect(result).toEqual({
      http: { status: 202, body: 'http://outbound.example.test/plain', transport: 'http' },
      https: { status: 203, body: 'https://outbound.example.test/secure', transport: 'https' },
      websocket: 'echo:browser-runtime',
      largeWebSocket: 'x'.repeat(126),
      httpAfterWebSocketBoundary: {
        status: 202,
        body: 'http://outbound.example.test/plain',
        transport: 'http'
      },
      tlsBoundary: {
        code: 'ENOTSUP',
        message: expect.stringContaining('ca')
      },
      rawBoundary: {
        code: 'ENOTSUP',
        message: expect.stringContaining('External raw TCP')
      }
    });
  }
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await webSocketServer.close();
});

function outboundHttpLifecycleWitnessSource(): string {
  return String.raw`
const http = require('node:http');

process.once('beforeExit', () => {
  console.log('outbound-lifecycle before-exit');
});
const request = http.get('http://lifecycle.example.test/request', (response) => {
  console.log('outbound-lifecycle headers', response.statusCode);
  setImmediate(() => {
    console.log('outbound-lifecycle consumption-start');
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => {
      console.log('outbound-lifecycle body', body);
      Promise.resolve().then(() => {
        console.log('outbound-lifecycle promise-settled');
      });
    });
  });
});
request.on('error', (error) => {
  console.error('outbound-lifecycle error', error.stack || error.message);
  process.exitCode = 1;
});
`;
}

function outboundHttpBufferedBodyWitnessSource(): string {
  return String.raw`
const { createHash } = require('node:crypto');
const http = require('node:http');

const consume = (mode, delay) => new Promise((resolve, reject) => {
  const request = http.get('http://buffered-body.example.test/' + mode, (response) => {
    const attach = () => {
      const hash = createHash('sha256');
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.byteLength;
        hash.update(chunk);
      });
      response.on('end', () => {
        resolve({ status: response.statusCode, bytes, digest: hash.digest('hex') });
      });
      response.on('error', reject);
    };
    if (delay === 0) attach();
    else setTimeout(attach, delay);
  });
  request.on('error', reject);
});

Promise.all([
  consume('immediate', 0),
  consume('delayed', 100)
]).then(([immediate, delayed]) => {
  console.log('outbound-buffered-body-result', JSON.stringify({ immediate, delayed }));
}).catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
`;
}

function outboundWitnessSource(webSocketPort: number): string {
  return String.raw`
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const request = (client, url) => new Promise((resolve, reject) => {
  const operation = client.get(url, (response) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => resolve({
      status: response.statusCode,
      body,
      transport: response.headers['x-browser-transport']
    }));
  });
  operation.on('error', reject);
});

const unsupportedRequest = (start) => new Promise((resolve) => {
  const operation = start();
  operation.on('error', (error) => resolve({ code: error.code, message: error.message }));
});

const outboundWebSocket = (message) => new Promise((resolve, reject) => {
  const socket = new WebSocket('ws://0.0.0.0:${webSocketPort}/socket');
  socket.onopen = () => socket.send(message);
  socket.onmessage = (event) => {
    socket.close();
    resolve(event.data);
  };
  socket.onerror = () => reject(new Error('Native browser WebSocket failed.'));
});

const rawBoundary = new Promise((resolve) => {
  const socket = net.connect({ host: 'outbound.example.test', port: 80 }, () => {
    socket.end(new Uint8Array([0, 255, 1, 2]));
  });
  socket.on('error', (error) => resolve({ code: error.code, message: error.message }));
});

const [plain, secure, websocket, largeWebSocket, tlsBoundary, raw] = await Promise.all([
  request(http, 'http://outbound.example.test/plain'),
  request(https, 'https://outbound.example.test/secure'),
  outboundWebSocket('browser-runtime'),
  outboundWebSocket('oversized-response'),
  unsupportedRequest(() => https.get({ host: 'outbound.example.test', ca: 'custom-ca' })),
  rawBoundary
]);
const httpAfterWebSocketBoundary = await request(http, 'http://outbound.example.test/plain');

console.log('outbound-network-result', JSON.stringify({
  http: plain,
  https: secure,
  websocket,
  largeWebSocket,
  httpAfterWebSocketBoundary,
  tlsBoundary,
  rawBoundary: raw
}));
`;
}

async function startControlledWebSocketServer(): Promise<{
  readonly port: number;
  close(): Promise<void>;
}> {
  const server = createServer();
  server.on('upgrade', (request, socket) => {
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string' || request.url !== '/socket') {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Connection: Upgrade',
        'Upgrade: websocket',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        ''
      ].join('\r\n')
    );
    socket.on('data', (data) => {
      if (data.byteLength < 6 || (data[1] & 0x80) === 0) return;
      const length = data[1] & 0x7f;
      if (length > 125 || data.byteLength < 6 + length) return;
      const mask = data.subarray(2, 6);
      const payload = data.subarray(6, 6 + length).map((value, index) => value ^ (mask[index % 4] ?? 0));
      if ((data[0] & 0x0f) === 0x8) {
        socket.end(Buffer.concat([Buffer.from([0x88, payload.byteLength]), payload]));
        return;
      }
      const response = Buffer.from(`echo:${payload.toString('utf8')}`);
      if (payload.toString('utf8') === 'oversized-response') {
        const oversized = Buffer.alloc(126, 'x');
        socket.write(Buffer.concat([Buffer.from([0x81, 126, 0, oversized.byteLength]), oversized]));
        return;
      }
      socket.write(Buffer.concat([Buffer.from([0x81, response.byteLength]), response]));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Controlled WebSocket server did not bind a TCP port.');
  }
  let closed = false;
  return {
    port: address.port,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  };
}
