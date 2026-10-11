import { describe, expect, test } from 'vitest';

import { Http1ChunkBodyDecoder, parseHttp1ResponseHead } from '../../http-1-wire-codec';
import { nodeStream, type NodeTransformStream } from '../streams';
import { createTlsBuiltin, type TlsSocket } from '../tls';

type FetchCall = { url: string; init: RequestInit; body?: string };

describe('node:tls over browser Fetch', () => {
  test('frames an HTTP/1.1 request written to the socket into one Fetch and answers with chunked HTTP/1.1', async () => {
    const registry = fakeRegistry({
      'https://registry.npmjs.org/left-pad': () =>
        new Response('{"name":"left-pad"}', {
          status: 200,
          headers: { 'content-type': 'application/json', 'content-length': '19', 'content-encoding': 'gzip', etag: '"abc"' }
        })
    });
    const tls = createTlsBuiltin(undefined, { fetch: registry.fetch });
    const socket = connected(tls);
    const connection = await socket.ready;

    expect(connection.alpnProtocol).toBe('http/1.1');
    expect(connection.authorized).toBe(true);
    expect(connection.connecting).toBe(false);
    connection.write(
      'GET /left-pad HTTP/1.1\r\nhost: registry.npmjs.org\r\nuser-agent: pnpm/11\r\naccept: application/json\r\nconnection: keep-alive\r\n\r\n'
    );

    const response = await socket.response();
    expect(registry.calls).toEqual([
      expect.objectContaining({
        url: 'https://registry.npmjs.org/left-pad',
        init: expect.objectContaining({ method: 'GET', headers: [['accept', 'application/json']], redirect: 'follow' })
      })
    ]);
    expect(response.head).toMatchObject({ status: 200, statusText: 'OK', chunked: true });
    expect(response.head.headers).toEqual([
      ['content-type', 'application/json'],
      ['etag', '"abc"'],
      ['transfer-encoding', 'chunked'],
      ['connection', 'keep-alive']
    ]);
    expect(response.body).toBe('{"name":"left-pad"}');
    connection.destroy();
  });

  test('keeps the connection for the next request, sends a body, and ends with the program', async () => {
    const registry = fakeRegistry({
      'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk': async (_url, init) =>
        new Response(`echo:${new TextDecoder().decode(init.body as ArrayBuffer)}`, { status: 200 }),
      'https://registry.npmjs.org/is-odd': () => new Response(null, { status: 304 })
    });
    const tls = createTlsBuiltin(undefined, { fetch: registry.fetch });
    const socket = connected(tls);
    const connection = await socket.ready;

    connection.write('POST /-/npm/v1/security/advisories/bulk HTTP/1.1\r\nhost: registry.npmjs.org\r\ncontent-type: application/json\r\ncontent-length: 11\r\n\r\n');
    connection.write('{"a":"b"}');
    connection.write('xy');
    const first = await socket.response();
    connection.write('GET /is-odd HTTP/1.1\r\nhost: registry.npmjs.org\r\ntransfer-encoding: chunked\r\n\r\n0\r\n\r\n');
    const second = await socket.response();
    connection.end();
    await socket.closed;

    expect(registry.calls.map((call) => [call.init.method, call.body])).toEqual([
      ['POST', '{"a":"b"}xy'],
      ['GET', undefined]
    ]);
    expect(first.body).toBe('echo:{"a":"b"}xy');
    expect(second.head).toMatchObject({ status: 304, statusText: 'Not Modified', chunked: false });
    expect(second.head.headers).toEqual([['connection', 'keep-alive']]);
    expect(socket.events).toEqual(['connect', 'secureConnect', 'ready', 'end', 'close']);
  });

  test('answers HEAD without a body and streams a response body in several chunks', async () => {
    const registry = fakeRegistry({
      'https://registry.npmjs.org/is-odd/-/is-odd-3.0.1.tgz': (_url, init) =>
        init.method === 'HEAD'
          ? new Response(null, { status: 200, headers: { 'content-length': '3000' } })
          : new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('part one,'));
                  controller.enqueue(new TextEncoder().encode('part two'));
                  controller.close();
                }
              }),
              { status: 200, headers: { 'content-type': 'application/octet-stream' } }
            )
    });
    const tls = createTlsBuiltin(undefined, { fetch: registry.fetch });
    const socket = connected(tls);
    const connection = await socket.ready;

    connection.write('HEAD /is-odd/-/is-odd-3.0.1.tgz HTTP/1.1\r\nhost: registry.npmjs.org\r\n\r\n');
    const head = await socket.response({ head: true });
    connection.write('GET /is-odd/-/is-odd-3.0.1.tgz HTTP/1.1\r\nhost: registry.npmjs.org\r\n\r\n');
    const tarball = await socket.response();

    expect(head.head.headers).toEqual([['content-length', '3000'], ['connection', 'keep-alive']]);
    expect(tarball.body).toBe('part one,part two');
    expect(tarball.raw).toContain('9\r\npart one,\r\n8\r\npart two\r\n0\r\n\r\n');
    connection.destroy();
  });

  test('destroys the socket with a connection error when Fetch fails', async () => {
    const tls = createTlsBuiltin(undefined, { fetch: () => Promise.reject(new TypeError('Failed to fetch')) });
    const socket = connected(tls);
    const connection = await socket.ready;

    connection.write('GET / HTTP/1.1\r\nhost: registry.npmjs.org\r\n\r\n');
    const error = await socket.error;

    expect(error).toMatchObject({ code: 'ECONNREFUSED', message: 'Browser Fetch failed: Failed to fetch' });
    expect(connection.destroyed).toBe(true);
    expect(socket.events).toEqual(['connect', 'secureConnect', 'ready', 'error', 'close']);
  });

  test('refuses an HTTP upgrade and leaves loopback TLS to the Virtual Network', async () => {
    const tls = createTlsBuiltin(undefined, { fetch: () => Promise.reject(new Error('not reached')) });
    const socket = connected(tls);
    const connection = await socket.ready;

    connection.write('GET /socket HTTP/1.1\r\nhost: registry.npmjs.org\r\nconnection: upgrade\r\nupgrade: websocket\r\n\r\n');

    await expect(socket.error).resolves.toMatchObject({ code: 'ENOTSUP' });
    const loopback: unknown[] = [];
    const withNetwork = createTlsBuiltin(
      { connect: (...args: unknown[]) => { loopback.push(args); return {}; } } as never,
      { fetch: () => Promise.reject(new Error('not reached')) }
    );
    withNetwork.connect({ host: '127.0.0.1', port: 8443 });
    expect(loopback).toEqual([[{ host: '127.0.0.1', port: 8443, transport: 'tls' }]]);
  });

  test('wraps an existing Duplex as Node does and reports the handshake it cannot run as an error event', async () => {
    const tls = createTlsBuiltin(undefined, { fetch: () => Promise.reject(new Error('not reached')) });
    const wrapped = new nodeStream.PassThrough();

    // http2-wrapper takes Node's JSStreamSocket this way when it is loaded.
    const socket = new tls.TLSSocket(wrapped) as { encrypted: boolean; _handle: { _parentWrap: object } };
    expect(socket.encrypted).toBe(true);
    const JSStreamSocket = socket._handle._parentWrap.constructor as new (stream: unknown) => NodeTransformStream;
    expect(JSStreamSocket.name).toBe('JSStreamSocket');
    const relayed = new nodeStream.PassThrough();
    const adapter = new JSStreamSocket(relayed);
    const echoed = new Promise((resolve) => adapter.once('data', (chunk: unknown) => resolve(String(chunk))));
    adapter.write('ping');
    await expect(echoed).resolves.toBe('ping');

    const connection = tls.connect({ socket: new nodeStream.PassThrough(), servername: 'example.com' }) as NodeTransformStream;
    const failure = new Promise((resolve) => connection.once('error', resolve));
    await expect(failure).resolves.toMatchObject({ code: 'ENOTSUP', syscall: 'tls' });
    expect(connection.destroyed).toBe(true);
  });
});

function fakeRegistry(routes: Record<string, (url: string, init: RequestInit) => Response | Promise<Response>>) {
  const calls: FetchCall[] = [];
  return {
    calls,
    async fetch(url: string, init: RequestInit): Promise<Response> {
      calls.push({
        url,
        init,
        body: init.body instanceof ArrayBuffer ? new TextDecoder().decode(init.body) : undefined
      });
      const route = routes[url];
      if (!route) return new Response('missing', { status: 404 });
      return route(url, init);
    }
  };
}

function connected(tls: ReturnType<typeof createTlsBuiltin>) {
  const events: string[] = [];
  const received: Uint8Array[] = [];
  let notify: (() => void) | undefined;
  let resolveError!: (error: unknown) => void;
  let resolveClosed!: () => void;
  const error = new Promise<unknown>((resolve) => { resolveError = resolve; });
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const connection = tls.connect({ host: 'registry.npmjs.org', port: 443, servername: 'registry.npmjs.org', ALPNProtocols: ['http/1.1'] }) as TlsSocket;
  for (const name of ['connect', 'secureConnect', 'ready', 'end', 'close', 'error', 'timeout']) {
    connection.on(name, (...args: unknown[]) => {
      events.push(name);
      if (name === 'error') resolveError(args[0]);
      if (name === 'close') resolveClosed();
    });
  }
  connection.on('data', (chunk: Uint8Array) => {
    received.push(new Uint8Array(chunk));
    notify?.();
  });
  const ready = new Promise<TlsSocket>((resolve) => connection.once('secureConnect', () => resolve(connection)));
  const buffered = (): Uint8Array => {
    const total = received.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of received) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  };
  const consume = (count: number): void => {
    const rest = buffered().slice(count);
    received.length = 0;
    if (rest.byteLength > 0) received.push(rest);
  };
  return {
    ready,
    events,
    error,
    closed,
    /** The next complete response on the socket, as its head, decoded body and raw bytes. */
    async response(options: { head?: boolean } = {}) {
      while (true) {
        const bytes = buffered();
        const head = parseHttp1ResponseHead(bytes);
        if (head) {
          if (options.head || !head.chunked) {
            consume(head.bodyStart);
            return { head, body: '', raw: new TextDecoder().decode(bytes.slice(0, head.bodyStart)) };
          }
          const chunks: Uint8Array[] = [];
          const decoder = new Http1ChunkBodyDecoder((chunk) => chunks.push(chunk), () => undefined, () => undefined);
          decoder.push(bytes.slice(head.bodyStart));
          if (decoder.complete) {
            const consumed = bytes.byteLength - decoder.remainder.byteLength;
            consume(consumed);
            return {
              head,
              body: new TextDecoder().decode(concat(chunks)),
              raw: new TextDecoder().decode(bytes.slice(0, consumed))
            };
          }
        }
        await new Promise<void>((resolve) => { notify = resolve; });
      }
    }
  };
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
