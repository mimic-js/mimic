import * as nodeHttp from 'node:http';

import { describe, expect, test, vi } from 'vitest';

import { concatHttp1Bytes, parseHttp1RequestHead, parseHttp1ResponseHead } from '../../http-1-wire-codec';
import { createVirtualNetworkAuthority } from '../../virtual-network';
import { createHttpBuiltin } from '../http';
import { createNodeNetworkBuiltin } from '../network-adapter';

type Listener = ((...args: unknown[]) => void) & { listener?: Listener };

function isListener(value: unknown): value is Listener {
  return typeof value === 'function';
}

class Emitter {
  private readonly listeners = new Map<string, Listener[]>();

  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  once(event: string, listener: Listener): this {
    const once = ((...args: unknown[]) => {
      this.removeListener(event, once);
      listener(...args);
    }) as Listener;
    once.listener = listener;
    return this.on(event, once);
  }

  off(event: string, listener: Listener): this {
    return this.removeListener(event, listener);
  }

  removeListener(event: string, listener: Listener): this {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter(
        (candidate) => candidate !== listener && candidate.listener !== listener
      )
    );
    return this;
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.length ?? 0;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }
}

class Socket extends Emitter {
  peer: Socket | undefined;
  readonly writes: Uint8Array[] = [];
  readonly localAddress = '127.0.0.1';
  readonly localPort = 8123;
  readonly remoteAddress = '127.0.0.1';
  readonly remotePort = 8123;

  write(data?: unknown, callback?: () => void): boolean {
    const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data ?? ''));
    this.writes.push(bytes);
    this.peer?.emit('data', bytes);
    callback?.();
    return true;
  }

  end(data?: unknown, callback?: () => void): this {
    if (data !== undefined) this.write(data);
    this.peer?.emit('end');
    callback?.();
    return this;
  }

  destroy(error?: Error): this {
    if (error) this.emit('error', error);
    this.emit('close');
    return this;
  }

  setEncoding(): this {
    return this;
  }

  cork(): void {}

  uncork(): void {}
}

class SocketServer extends Emitter {
  listening = false;
  connection: ((socket: Socket) => void) | undefined;

  constructor(listener?: (socket: Socket) => void) {
    super();
    this.connection = listener;
  }

  listen(): this {
    this.listening = true;
    this.emit('listening');
    return this;
  }

  close(callback?: () => void): this {
    this.listening = false;
    callback?.();
    this.emit('close');
    return this;
  }

  address(): { address: string; family: string; port: number } {
    return { address: '127.0.0.1', family: 'IPv4', port: 8123 };
  }
}

function createVirtualNet(): {
  net: Parameters<typeof createHttpBuiltin>[1];
  clientSockets: Socket[];
  connectionArgs: unknown[][];
} {
  let server: SocketServer | undefined;
  const clientSockets: Socket[] = [];
  const connectionArgs: unknown[][] = [];
  const createConnection = (...args: unknown[]): Socket => {
    connectionArgs.push(args);
    const callback = args.find((argument): argument is () => void => typeof argument === 'function');
    const client = new Socket();
    const options = args.find(
      (argument): argument is { host?: unknown } => Boolean(argument) && typeof argument === 'object'
    );
    if (!['127.0.0.1', 'localhost', '::1'].includes(String(options?.host))) {
      setTimeout(
        () => client.emit(
          'error',
          Object.assign(new Error('External raw TCP is unsupported'), {
            cause: { code: 'EXTERNAL_TRANSPORT_UNSUPPORTED' },
            code: 'ENOTSUP'
          })
        ),
        0
      );
      return client;
    }
    const accepted = new Socket();
    client.peer = accepted;
    accepted.peer = client;
    clientSockets.push(client);
    server?.connection?.(accepted);
    setTimeout(() => callback?.(), 0);
    return client;
  };
  const net: Parameters<typeof createHttpBuiltin>[1] = {
    Socket: Socket as never,
    createServer(optionsOrListener?: unknown, listener?: Listener) {
      const resolvedListener = isListener(optionsOrListener) ? optionsOrListener : listener;
      server = new SocketServer(resolvedListener);
      return server;
    },
    createConnection,
    connect: createConnection
  };
  return {
    clientSockets,
    connectionArgs,
    net
  };
}

describe('Node compatibility HTTP adapter', () => {
  test('rejects a pipe destination that cannot preserve the writable stream contract', () => {
    const { net } = createVirtualNet();
    const http = createHttpBuiltin('http', net) as {
      IncomingMessage: new () => { pipe(destination: unknown): unknown; unpipe(destination?: unknown): unknown };
    };

    const incoming = new http.IncomingMessage();
    expect(() => incoming.pipe({})).toThrow(TypeError);
    const removeListenerOnly = new PipeDestination() as PipeDestination & { off?: undefined };
    Object.defineProperty(removeListenerOnly, 'off', { value: undefined });
    expect(incoming.pipe(removeListenerOnly)).toBe(removeListenerOnly);
    expect(incoming.unpipe(removeListenerOnly)).toBe(incoming);
    const missingOnce = new PipeDestination() as PipeDestination & { once?: undefined };
    Object.defineProperty(missingOnce, 'once', { value: undefined });
    expect(() => incoming.pipe(missingOnce)).toThrow(TypeError);
  });

  test('unpipes one or every IncomingMessage pipe destination with Node-compatible cleanup', async () => {
    const { net } = createVirtualNet();
    const http = createHttpBuiltin('http', net) as {
      createServer(listener: (request: PipeIncoming, response: Response) => void): { listen(port: number): unknown };
      request(options: unknown): { write(chunk: string): boolean; end(): unknown };
    };
    const observations: PipeObservation[] = [];
    http.createServer((request, response) => {
      const first = new PipeDestination();
      const second = new PipeDestination();
      const pipeEvents: string[] = [];
      first.on('pipe', (source) => pipeEvents.push(source === request ? 'first:pipe' : 'first:wrong-source'));
      first.on('unpipe', (source) => pipeEvents.push(source === request ? 'first:unpipe' : 'first:wrong-source'));
      second.on('pipe', (source) => pipeEvents.push(source === request ? 'second:pipe' : 'second:wrong-source'));
      second.on('unpipe', (source) => pipeEvents.push(source === request ? 'second:unpipe' : 'second:wrong-source'));
      const baseline = pipeListenerSnapshot(request, first, second);

      expect(request.pipe(first)).toBe(first);
      expect(request.pipe(second)).toBe(second);
      const afterPipe = pipeListenerSnapshot(request, first, second);
      if (request.url === '/one') expect(request.unpipe(first)).toBe(request);
      else expect(request.unpipe()).toBe(request);
      const afterUnpipe = pipeListenerSnapshot(request, first, second);

      request.once('end', () => {
        queueMicrotask(() => {
          observations.push({
            path: request.url,
            baseline,
            afterPipe,
            afterUnpipe,
            afterEnd: pipeListenerSnapshot(request, first, second),
            pipeEvents,
            first: { chunks: first.chunks, ended: first.ended },
            second: { chunks: second.chunks, ended: second.ended }
          });
          response.end('ok');
        });
      });
      request.resume();
    }).listen(8123);

    for (const path of ['/one', '/all']) {
      await new Promise<void>((resolve, reject) => {
        const request = http.request({ port: 8123, path, method: 'POST' });
        request.write(path === '/one' ? 'one-body' : 'all-body');
        request.end();
        const deadline = Date.now() + 1_000;
        const poll = () => {
          if (observations.some((observation) => observation.path === path)) resolve();
          else if (Date.now() >= deadline) reject(new Error(`Timed out waiting for ${path}`));
          else setTimeout(poll, 0);
        };
        poll();
      });
    }

    const one = observations.find((observation) => observation.path === '/one');
    if (!one) throw new Error('Missing /one pipe observation');
    expect(one.afterPipe.source).toEqual({ data: one.baseline.source.data + 2, end: one.baseline.source.end + 2 });
    expect(one.afterUnpipe.source).toEqual({ data: one.baseline.source.data + 1, end: one.baseline.source.end + 1 });
    expect(one.afterUnpipe.first).toEqual(one.baseline.first);
    expect(one.afterEnd.source).toEqual(one.baseline.source);
    expect(one.afterEnd.second).toEqual(one.baseline.second);
    expect(one.pipeEvents).toEqual(['first:pipe', 'second:pipe', 'first:unpipe', 'second:unpipe']);
    expect(one.first).toEqual({ chunks: [], ended: 0 });
    expect(one.second).toEqual({ chunks: ['one-body'], ended: 1 });

    const all = observations.find((observation) => observation.path === '/all');
    if (!all) throw new Error('Missing /all pipe observation');
    expect(all.afterPipe.source).toEqual({ data: all.baseline.source.data + 2, end: all.baseline.source.end + 2 });
    expect(all.afterUnpipe).toEqual(all.baseline);
    expect(all.afterEnd).toEqual(all.baseline);
    expect(all.pipeEvents).toEqual(['first:pipe', 'second:pipe', 'first:unpipe', 'second:unpipe']);
    expect(all.first).toEqual({ chunks: [], ended: 0 });
    expect(all.second).toEqual({ chunks: [], ended: 0 });
  });

  test('exposes the ServerResponse finished lifecycle consumed by stream cleanup middleware', () => {
    const { net } = createVirtualNet();
    const http = createHttpBuiltin('http', net) as {
      ServerResponse: new () => { readonly finished: boolean; readonly writableEnded: boolean; end(): unknown };
    };
    const response = new http.ServerResponse();

    expect(response.finished).toBe(false);
    expect(response.writableEnded).toBe(false);
    response.end();
    expect(response.finished).toBe(true);
    expect(response.writableEnded).toBe(true);
  });

  test('invokes callable Proxy response listeners without reading their apply property', async () => {
    const { net } = createVirtualNet();
    const http = createHttpBuiltin('http', net) as {
      createServer(listener: (request: Incoming, response: Response) => void): { listen(port: number): unknown };
      get(options: unknown, callback: (response: Incoming) => void): unknown;
    };
    http.createServer((_request, response) => response.end('proxy-ok')).listen(8123);
    const response = await readResponse((callback) => {
      const callableProxy = new Proxy(callback, {
        get(target, property, receiver) {
          if (property === 'apply') return undefined;
          return Reflect.get(target, property, receiver);
        }
      });
      return http.get({ port: 8123 }, callableProxy);
    });

    expect(response).toEqual({ status: 200, body: 'proxy-ok' });
  });

  test('links a request and its response to each other and to their socket, and writes an implicit head', async () => {
    const { net } = createVirtualNet();
    const http = createHttpBuiltin('http', net) as {
      createServer(listener: (request: Linked, response: Linked & Response) => void): { listen(port: number): unknown };
      get(options: unknown, callback: (response: Incoming) => void): unknown;
    };
    type Linked = {
      readonly socket?: object;
      readonly connection?: object;
      readonly req?: object;
      readonly _header: string | null;
      _implicitHeader(): void;
      statusCode: number;
    };
    const seen: unknown[] = [];
    http.createServer((request, response) => {
      seen.push(
        request.socket !== undefined && request.connection === request.socket,
        response.req === request,
        response.socket === request.socket && response.connection === request.socket,
        response._header
      );
      response.statusCode = 202;
      response._implicitHeader();
      seen.push(response._header);
      response.end('linked');
    }).listen(8123);

    await expect(readResponse((callback) => http.get({ port: 8123 }, callback))).resolves.toEqual({
      status: 202,
      body: 'linked'
    });
    expect(seen).toEqual([true, true, true, null, 'HTTP/1.1 202 Accepted\r\n']);
  });

  test('supports the Node URL, options, callback request overload', async () => {
    const { net, connectionArgs } = createVirtualNet();
    const http = createHttpBuiltin('http', net) as {
      createServer(listener: (request: Incoming, response: Response) => void): { listen(port: number): unknown };
      get(
        url: URL,
        options: Record<string, unknown>,
        callback: (response: Incoming) => void
      ): unknown;
    };
    http.createServer((request, response) => {
      expect(request.url).toBe('/from-options');
      response.end('overload-ok');
    }).listen(8123);

    const response = await readResponse((callback) =>
      http.get(
        new URL('http://url-host.example.test:8123/from-url'),
        { hostname: '127.0.0.1', path: '/from-options' },
        callback
      )
    );

    expect(response).toEqual({ status: 200, body: 'overload-ok' });
    expect(connectionArgs[0]?.[0]).toMatchObject({
      host: '127.0.0.1',
      port: 8123,
      transport: 'tcp'
    });
  });

  test('supports prepended ClientRequest listeners and the end(callback) overload', async () => {
    const { net } = createVirtualNet();
    const http = createHttpBuiltin('http', net) as {
      request(options: unknown): {
        abort(): void;
        end(callback: () => void): unknown;
        listeners(event: 'socket'): Array<() => void>;
        on(event: 'socket', listener: () => void): unknown;
        prependListener(event: 'socket', listener: () => void): unknown;
        prependOnceListener(event: 'socket', listener: () => void): unknown;
        removeListener(event: 'socket', listener: () => void): unknown;
      };
    };
    const request = http.request({ host: '127.0.0.1' });
    const observed: string[] = [];
    const onSocket = () => observed.push('on');
    const prependSocket = () => observed.push('prepend');
    const prependOnceSocket = () => observed.push('prepend-once');
    const socket = new Promise<void>((resolve) => {
      request.on('socket', () => {
        onSocket();
        resolve();
      });
      request.prependOnceListener('socket', prependOnceSocket);
      request.prependListener('socket', prependSocket);
    });
    expect(request.listeners('socket')).toEqual([prependSocket, prependOnceSocket, expect.any(Function)]);
    request.removeListener('socket', prependOnceSocket);
    expect(request.listeners('socket')).toEqual([prependSocket, expect.any(Function)]);
    request.prependOnceListener('socket', prependOnceSocket);
    const ended = new Promise<void>((resolve) => request.end(resolve));

    await Promise.all([socket, ended]);
    request.abort();

    expect(observed).toEqual(['prepend-once', 'prepend', 'on']);
  });

  test('aborts native Fetch and releases Process Execution activity ownership', async () => {
    const { net } = createVirtualNet();
    const activity = createActivityLifecycle();
    let signal: AbortSignal | null | undefined;
    const http = createHttpBuiltin(
      'http',
      net,
      undefined,
      activity.lifecycle,
      async (_input, init) => {
        signal = init.signal;
        return new Promise<Response>(() => undefined);
      }
    ) as {
      get(options: unknown): { abort(): void };
    };

    const request = http.get({ host: 'api.example.test' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(activity.active()).toBe(1);
    request.abort();
    expect(signal?.aborted).toBe(true);
    expect(activity.active()).toBe(0);
  });

  test('releases Process Execution activity ownership when outbound transport setup fails', async () => {
    const { net } = createVirtualNet();
    const activity = createActivityLifecycle();
    const https = createHttpBuiltin('https', net, undefined, activity.lifecycle) as {
      get(options: unknown): { on(event: 'error', listener: (error: Error) => void): unknown };
    };

    await new Promise<void>((resolve) => {
      https.get({ host: 'secure.example.test', ca: 'custom-ca' }).on('error', () => resolve());
    });
    expect(activity.active()).toBe(0);
  });

  test('releases Process Execution activity ownership when response consumption is cancelled', async () => {
    const { net, clientSockets } = createVirtualNet();
    const activity = createActivityLifecycle();
    const http = createHttpBuiltin('http', net, undefined, activity.lifecycle) as {
      get(
        options: unknown,
        callback: (response: { destroy(): void }) => void
      ): unknown;
    };
    const response = new Promise<{ destroy(): void }>((resolve) => {
      http.get({ host: '127.0.0.1' }, resolve);
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    clientSockets[0]!.peer!.write(
      new TextEncoder().encode(
        'HTTP/1.1 200 OK\r\ncontent-length: 4\r\nconnection: close\r\n\r\npa'
      )
    );
    expect(activity.active()).toBe(1);
    (await response).destroy();
    expect(activity.active()).toBe(0);
  });

  test('releases Process Execution activity ownership when the socket ends before response headers', async () => {
    const { net, clientSockets } = createVirtualNet();
    const activity = createActivityLifecycle();
    const http = createHttpBuiltin('http', net, undefined, activity.lifecycle) as {
      get(options: unknown): { on(event: 'error', listener: (error: Error) => void): unknown };
    };
    const failed = new Promise<void>((resolve) => {
      http.get({ host: '127.0.0.1' }).on('error', () => resolve());
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    clientSockets[0]!.peer!.end();
    await failed;
    expect(activity.active()).toBe(0);
  });

  test('releases Process Execution activity ownership when the socket closes without ending', async () => {
    const { net, clientSockets } = createVirtualNet();
    const activity = createActivityLifecycle();
    const http = createHttpBuiltin('http', net, undefined, activity.lifecycle) as {
      get(options: unknown): unknown;
    };

    http.get({ host: '127.0.0.1' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(activity.active()).toBe(1);
    clientSockets[0]!.destroy();
    expect(activity.active()).toBe(0);
  });

  test('retains Process Execution activity until a paused response consumes its buffered body', async () => {
    const { net, clientSockets } = createVirtualNet();
    const activity = createActivityLifecycle();
    const http = createHttpBuiltin('http', net, undefined, activity.lifecycle) as {
      get(
        options: unknown,
        callback: (response: {
          on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
          on(event: 'end', listener: () => void): unknown;
          pause(): void;
          resume(): void;
        }) => void
      ): unknown;
    };
    let resumeResponse!: () => void;
    const body = new Promise<string>((resolve) => {
      http.get({ host: '127.0.0.1' }, (response) => {
        const chunks: string[] = [];
        response.on('data', (chunk) => chunks.push(new TextDecoder().decode(chunk)));
        response.on('end', () => resolve(chunks.join('')));
        response.pause();
        resumeResponse = () => response.resume();
      });
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    clientSockets[0]!.peer!.write(
      new TextEncoder().encode(
        'HTTP/1.1 200 OK\r\ncontent-length: 4\r\nconnection: close\r\n\r\nbody'
      )
    );
    clientSockets[0]!.peer!.end();
    clientSockets[0]!.destroy();
    expect(activity.active()).toBe(1);

    resumeResponse();
    await expect(body).resolves.toBe('body');
    expect(activity.active()).toBe(0);
  });

  test('delivers every buffered response byte once when readable consumers attach after transport completion', async () => {
    const { net, clientSockets } = createVirtualNet();
    const activity = createActivityLifecycle();
    const http = createHttpBuiltin('http', net, undefined, activity.lifecycle) as {
      get(options: unknown, callback: (response: Incoming) => void): unknown;
    };
    const response = new Promise<Incoming>((resolve) => {
      http.get({ host: '127.0.0.1' }, resolve);
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    clientSockets[0]!.peer!.write(
      new TextEncoder().encode(
        'HTTP/1.1 200 OK\r\ncontent-length: 12\r\nconnection: close\r\n\r\nfirst-'
      )
    );
    clientSockets[0]!.peer!.write(new TextEncoder().encode('second'));
    clientSockets[0]!.peer!.end();

    const incoming = await response;
    const body = new Promise<string>((resolve) => {
      const chunks: string[] = [];
      incoming.on('data', (chunk) => chunks.push(new TextDecoder().decode(chunk)));
      incoming.on('end', () => resolve(chunks.join('')));
    });

    await expect(
      Promise.race([
        body,
        new Promise<string>((_resolve, reject) =>
          setTimeout(() => reject(new Error('Late HTTP response consumer did not settle.')), 50)
        )
      ])
    ).resolves.toBe('first-second');
    expect(activity.active()).toBe(0);
  });

  test('releases Process Execution activity after transport completion when no response consumer starts', async () => {
    const { net, clientSockets } = createVirtualNet();
    const activity = createActivityLifecycle();
    const http = createHttpBuiltin('http', net, undefined, activity.lifecycle) as {
      get(options: unknown, callback: () => void): unknown;
    };
    http.get({ host: '127.0.0.1' }, () => undefined);

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    clientSockets[0]!.peer!.write(
      new TextEncoder().encode(
        'HTTP/1.1 200 OK\r\ncontent-length: 4\r\nconnection: close\r\n\r\nbody'
      )
    );
    clientSockets[0]!.peer!.end();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(activity.active()).toBe(1);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(activity.active()).toBe(0);
  });

  test('retains Process Execution activity until completed response consumption starts on a later turn', async () => {
    const { net, clientSockets } = createVirtualNet();
    const activity = createActivityLifecycle();
    const http = createHttpBuiltin('http', net, undefined, activity.lifecycle) as {
      get(
        options: unknown,
        callback: (response: Incoming) => void
      ): unknown;
    };
    const observedActivity: number[] = [];
    const body = new Promise<string>((resolve) => {
      http.get({ host: '127.0.0.1' }, (response) => {
        setTimeout(() => {
          observedActivity.push(activity.active());
          const chunks: string[] = [];
          response.on('data', (chunk) => chunks.push(new TextDecoder().decode(chunk)));
          response.on('end', () => resolve(chunks.join('')));
        }, 0);
      });
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    clientSockets[0]!.peer!.write(
      new TextEncoder().encode(
        'HTTP/1.1 200 OK\r\ncontent-length: 4\r\nconnection: close\r\n\r\nbody'
      )
    );
    clientSockets[0]!.peer!.end();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(activity.active()).toBe(1);

    await expect(body).resolves.toBe('body');
    expect(observedActivity).toEqual([1]);
    expect(activity.active()).toBe(0);
  });

  test('retains Process Execution activity across multiple turns after a readable consumer declares intent', async () => {
    const { net, clientSockets } = createVirtualNet();
    const activity = createActivityLifecycle();
    type ReadableIncoming = {
      on(event: 'readable', listener: () => void): unknown;
      read(): Uint8Array | null;
    };
    const http = createHttpBuiltin('http', net, undefined, activity.lifecycle) as {
      get(options: unknown, callback: (response: ReadableIncoming) => void): unknown;
    };
    const observedActivity: number[] = [];
    const body = new Promise<string>((resolve) => {
      http.get({ host: '127.0.0.1' }, (response) => {
        let readingScheduled = false;
        response.on('readable', () => {
          if (readingScheduled) return;
          readingScheduled = true;
          setTimeout(() => {
            observedActivity.push(activity.active());
            setTimeout(() => {
              observedActivity.push(activity.active());
              setTimeout(() => {
                observedActivity.push(activity.active());
                resolve(new TextDecoder().decode(response.read() ?? new Uint8Array()));
              }, 0);
            }, 0);
          }, 0);
        });
      });
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    clientSockets[0]!.peer!.write(
      new TextEncoder().encode(
        'HTTP/1.1 200 OK\r\ncontent-length: 4\r\nconnection: close\r\n\r\nbody'
      )
    );
    clientSockets[0]!.peer!.end();

    await expect(body).resolves.toBe('body');
    expect(observedActivity).toEqual([1, 1, 1]);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(activity.active()).toBe(0);
  });

  test('abandons a readable consumer intent that never reads the completed response', async () => {
    vi.useFakeTimers();
    try {
      const { net, clientSockets } = createVirtualNet();
      const activity = createActivityLifecycle();
      const http = createHttpBuiltin('http', net, undefined, activity.lifecycle) as {
        get(
          options: unknown,
          callback: (response: { on(event: 'readable', listener: () => void): unknown }) => void
        ): unknown;
      };
      http.get({ host: '127.0.0.1' }, (response) => {
        response.on('readable', () => undefined);
      });

      await vi.advanceTimersByTimeAsync(0);
      clientSockets[0]!.peer!.write(
        new TextEncoder().encode(
          'HTTP/1.1 200 OK\r\ncontent-length: 4\r\nconnection: close\r\n\r\nbody'
        )
      );
      clientSockets[0]!.peer!.end();
      await vi.advanceTimersByTimeAsync(0);
      expect(activity.active()).toBe(1);

      await vi.advanceTimersByTimeAsync(30_000);

      expect(activity.active()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('emits readable after the response callback can finish preparing its consumer', async () => {
    const { net, clientSockets } = createVirtualNet();
    type ReadableIncoming = {
      on(event: 'readable', listener: () => void): unknown;
      read(): Uint8Array | null;
    };
    const http = createHttpBuiltin('http', net) as {
      get(options: unknown, callback: (response: ReadableIncoming) => void): unknown;
    };
    const body = new Promise<string>((resolve) => {
      http.get({ host: '127.0.0.1' }, (response) => {
        let consumerPrepared = false;
        response.on('readable', () => {
          if (!consumerPrepared) return;
          resolve(new TextDecoder().decode(response.read() ?? new Uint8Array()));
        });
        queueMicrotask(() => {
          consumerPrepared = true;
        });
      });
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    clientSockets[0]!.peer!.write(
      new TextEncoder().encode(
        'HTTP/1.1 200 OK\r\ncontent-length: 4\r\nconnection: close\r\n\r\nbody'
      )
    );
    clientSockets[0]!.peer!.end();

    await expect(
      Promise.race([
        body,
        new Promise<string>((_resolve, reject) =>
          setTimeout(() => reject(new Error('Readable response event fired before its consumer was prepared.')), 50)
        )
      ])
    ).resolves.toBe('body');
  });

  test('releases Process Execution activity when a resumed response fails to parse', async () => {
    const { net, clientSockets } = createVirtualNet();
    const activity = createActivityLifecycle();
    const http = createHttpBuiltin('http', net, undefined, activity.lifecycle) as {
      get(
        options: unknown,
        callback: (response: { on(event: 'error', listener: () => void): unknown; resume(): unknown }) => void
      ): unknown;
    };
    const errors: string[] = [];
    http.get({ host: '127.0.0.1' }, (response) => {
      response.on('error', () => errors.push('error'));
      response.resume();
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    clientSockets[0]!.peer!.write(
      new TextEncoder().encode('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\nZZ\r\n')
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(errors).toEqual(['error']);
    expect(activity.active()).toBe(0);
  });

  test('releases Process Execution activity when a partial response socket closes without ending', async () => {
    const { net, clientSockets } = createVirtualNet();
    const activity = createActivityLifecycle();
    const http = createHttpBuiltin('http', net, undefined, activity.lifecycle) as {
      get(
        options: unknown,
        callback: (response: {
          aborted: boolean;
          on(event: 'error' | 'aborted' | 'close', listener: () => void): unknown;
        }) => void
      ): unknown;
    };
    let incomingResponse!: { aborted: boolean };
    const responseLifecycle: string[] = [];
    http.get({ host: '127.0.0.1' }, (response) => {
      incomingResponse = response;
      response.on('error', () => responseLifecycle.push('error'));
      response.on('aborted', () => responseLifecycle.push('aborted'));
      response.on('close', () => responseLifecycle.push('close'));
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    clientSockets[0]!.peer!.write(
      new TextEncoder().encode(
        'HTTP/1.1 200 OK\r\ncontent-length: 4\r\nconnection: close\r\n\r\npa'
      )
    );
    expect(activity.active()).toBe(1);
    clientSockets[0]!.destroy();

    expect(incomingResponse.aborted).toBe(true);
    // As in Node, `aborted` is emitted as the message is destroyed, `error` and `close` a tick later.
    expect(responseLifecycle).toEqual(['aborted']);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(responseLifecycle).toEqual(['aborted', 'error', 'close']);
    expect(activity.active()).toBe(0);
  });

  test('routes HTTP/1 client and server traffic through the virtual network codec', async () => {
    const { net, clientSockets } = createVirtualNet();
    const http = createHttpBuiltin('http', net) as {
      createServer(listener: (request: Incoming, response: Response) => void): { listen(port: number): unknown };
      request(options: unknown, callback: (response: Incoming) => void): { write(chunk: string): boolean; end(): unknown };
    };
    const received: string[] = [];
    http.createServer((request, response) => {
      expect(request.method).toBe('POST');
      expect(request.url).toBe('/echo?x=1');
      request.on('data', (chunk: Uint8Array) => received.push(new TextDecoder().decode(chunk)));
      request.on('end', () => {
        response.setHeader('x-adapter', 'virtual-net');
        response.end(received.join('').toUpperCase());
      });
    }).listen(8123);

    const response = await new Promise<{ status: number; body: string }>((resolve) => {
      const request = http.request({ port: 8123, path: '/echo?x=1', method: 'POST' }, (incoming) => {
        const chunks: string[] = [];
        incoming.on('data', (chunk: Uint8Array) => chunks.push(new TextDecoder().decode(chunk)));
        incoming.on('end', () => resolve({ status: incoming.statusCode, body: chunks.join('') }));
      });
      request.write('hello');
      request.end();
    });

    const requestWire = concatHttp1Bytes(clientSockets[0]!.writes);
    const requestHead = parseHttp1RequestHead(requestWire)!;
    const responseWire = concatHttp1Bytes(clientSockets[0]!.peer!.writes);
    const responseHead = parseHttp1ResponseHead(responseWire)!;
    expect(received).toEqual(['hello']);
    expect(response).toEqual({ status: 200, body: 'HELLO' });
    expect(requestHead.headers).toContainEqual(['content-length', '5']);
    expect(responseHead.headers).toContainEqual(['x-adapter', 'virtual-net']);
    expect(new TextDecoder().decode(responseWire.slice(responseHead.bodyStart))).toBe('HELLO');
  });

  test('closes a completed server request when its response socket is cancelled', async () => {
    const { net } = createVirtualNet();
    type ServerIncoming = Incoming & {
      readonly aborted: boolean;
      readonly complete: boolean;
      readonly destroyed: boolean;
      readonly readableEnded: boolean;
      readonly socket: Emitter;
      once(event: 'close', listener: () => void): unknown;
    };
    const http = createHttpBuiltin('http', net) as {
      createServer(
        listener: (
          request: ServerIncoming,
          response: { write(chunk: string): boolean }
        ) => void
      ): { listen(port: number): unknown };
      get(options: unknown, callback: (response: Incoming) => void): unknown;
    };
    const lifecycle: string[] = [];
    let serverRequest!: ServerIncoming;
    http.createServer((request, response) => {
      serverRequest = request;
      request.once('close', () => lifecycle.push('request-close'));
      request.socket.once('close', () => lifecycle.push('socket-close'));
      response.write('first:');
    }).listen(8123);

    http.get({ port: 8123, path: '/cancel-response' }, (response) => {
      response.on('data', () => undefined);
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(serverRequest.complete).toBe(true);
    serverRequest.socket.emit('close');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(lifecycle).toEqual(expect.arrayContaining(['request-close', 'socket-close']));
    expect(serverRequest).toMatchObject({
      aborted: true,
      complete: true,
      destroyed: true,
      readableEnded: false
    });
  });

  test('routes controlled remote HTTP and HTTPS through native browser Fetch', async () => {
    const { net, clientSockets } = createVirtualNet();
    const fetchCalls: Array<{ input: string; init: RequestInit }> = [];
    const browserFetch = async (input: string, init: RequestInit) => {
      fetchCalls.push({ input, init });
      return new globalThis.Response('remote-ok', { status: 200 });
    };
    const http = createHttpBuiltin('http', net, undefined, undefined, browserFetch) as {
      get(options: unknown, callback: (response: Incoming) => void): {
        on(event: 'socket', listener: () => void): unknown;
      };
    };
    const https = createHttpBuiltin('https', net, undefined, undefined, browserFetch) as {
      createServer(): unknown;
      get(options: unknown, callback: (response: Incoming) => void): {
        on(event: 'error', listener: (error: Error & { code?: string }) => void): unknown;
      };
    };

    expect(() => https.createServer()).toThrow(expect.objectContaining({ code: 'ENOTSUP' }));
    const exposedSockets: unknown[] = [];
    const httpResponse = await readResponse((callback) => {
      const request = http.get({ host: 'api.example.test', port: 443 }, callback);
      request.on('socket', () => exposedSockets.push(true));
      return request;
    });
    const httpsResponse = await readResponse((callback) =>
      https.get({ host: 'secure.example.test', port: 443 }, callback)
    );

    expect(httpResponse).toEqual({ status: 200, body: 'remote-ok' });
    expect(httpsResponse).toEqual({ status: 200, body: 'remote-ok' });
    expect(fetchCalls.map(({ input }) => input)).toEqual([
      'http://api.example.test:443/',
      'https://secure.example.test/'
    ]);
    expect(fetchCalls.map(({ init }) => init.redirect)).toEqual(['follow', 'follow']);
    expect(clientSockets).toHaveLength(0);
    expect(exposedSockets).toHaveLength(0);
  });

  test('keeps wildcard and named HTTP listeners inside Virtual Network', async () => {
    const authority = createVirtualNetworkAuthority();
    const net = createNodeNetworkBuiltin(authority, 'process', {
      buffer: (value) => value,
      from: (value) => new TextEncoder().encode(value)
    });
    const http = createHttpBuiltin('http', net) as {
      createServer(listener: (_request: Incoming, response: Response) => void): {
        listen(options: { host: string; port: number }, callback: () => void): unknown;
        close(callback: () => void): unknown;
      };
      get(options: unknown, callback: (response: Incoming) => void): unknown;
    };
    const request = (host: string, port: number) =>
      readResponse((callback) => http.get({ host, port }, callback));
    const serve = async (host: string, port: number) => {
      const server = http.createServer((_request, response) => response.end(host));
      await new Promise<void>((resolve) => server.listen({ host, port }, resolve));
      return server;
    };
    const wildcard = await serve('0.0.0.0', 8123);
    const named = await serve('runtime.internal', 8124);

    await expect(request('0.0.0.0', 8123)).resolves.toEqual({ status: 200, body: '0.0.0.0' });
    await expect(request('runtime.internal', 8124)).resolves.toEqual({
      status: 200,
      body: 'runtime.internal'
    });

    await Promise.all([
      new Promise<void>((resolve) => wildcard.close(resolve)),
      new Promise<void>((resolve) => named.close(resolve))
    ]);
    authority.dispose();
  });

  test('rejects browser-unrepresentable headers and opaque redirects without opening raw sockets', async () => {
    const { net, clientSockets } = createVirtualNet();
    const fetch = vi.fn(async () => ({ type: 'opaqueredirect' }) as Response);
    const http = createHttpBuiltin('http', net, undefined, undefined, fetch) as {
      get(options: unknown): { on(event: 'error', listener: (error: Error & { code?: string }) => void): unknown };
    };
    const errorFrom = (options: unknown) => new Promise<Error & { code?: string }>((resolve) => {
      http.get(options).on('error', resolve);
    });

    await expect(errorFrom({ host: 'api.example.test', headers: { upgrade: 'h2c' } })).resolves.toMatchObject({
      code: 'ENOTSUP',
      message: expect.stringContaining('upgrade')
    });
    await expect(
      errorFrom({ host: 'api.example.test', method: 'POST', headers: { 'transfer-encoding': 'gzip' } })
    ).resolves.toMatchObject({
      code: 'ENOTSUP',
      message: expect.stringContaining('transfer-encoding')
    });
    await expect(errorFrom({ host: 'api.example.test' })).resolves.toMatchObject({
      code: 'ENOTSUP',
      message: expect.stringContaining('Opaque browser redirects')
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(clientSockets).toHaveLength(0);
  });

  test('rejects unrepresentable transport controls with a precise unsupported error before opening transport', async () => {
    const { net, clientSockets } = createVirtualNet();
    const https = createHttpBuiltin('https', net) as {
      get(options: unknown): { on(event: 'error', listener: (error: Error & { code?: string }) => void): unknown };
    };
    const errors = await Promise.all(
      [
        { ca: 'custom-ca' },
        { checkServerIdentity: () => undefined },
        { agent: { createConnection: () => undefined } }
      ].map(
        (options) =>
          new Promise<Error & { code?: string }>((resolve) => {
            https.get({ host: 'secure.example.test', ...options }).on('error', resolve);
          })
      )
    );

    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatchObject({ code: 'ENOTSUP', message: expect.stringContaining('ca') });
    expect(errors[1]).toMatchObject({ code: 'ENOTSUP', message: expect.stringContaining('checkServerIdentity') });
    expect(errors[2]).toMatchObject({ code: 'ENOTSUP', message: expect.stringContaining('agent') });
    expect(clientSockets).toHaveLength(0);
  });

  test('accepts default TLS values and standard Agent pooling owned by browser transport', async () => {
    const { net } = createVirtualNet();
    const https = createHttpBuiltin(
      'https',
      net,
      undefined,
      undefined,
      async () => new globalThis.Response('agent-ok', { status: 200 })
    ) as {
      Agent: new () => { addRequest(): void };
      get(options: unknown, callback: (response: Incoming) => void): unknown;
    };
    const response = await readResponse((callback) =>
      https.get(
        {
          host: 'secure.example.test',
          agent: new https.Agent(),
          ca: null,
          cert: null,
          key: null,
          rejectUnauthorized: true
        },
        callback
      )
    );

    expect(response).toEqual({ status: 200, body: 'agent-ok' });
  });
});

describe('Node compatibility HTTP server fidelity', () => {
  test('keeps an open response alive without a server deadline until the client disconnects', async () => {
    vi.useFakeTimers();
    const authority = createVirtualNetworkAuthority();
    try {
      const net = createNodeNetworkBuiltin(authority, 'process', {
        buffer: (value) => value,
        from: (value) => new TextEncoder().encode(value)
      });
      let published: PublishedListener | undefined;
      const http = createHttpBuiltin('http', net, {
        claim: (_port, listener) => {
          published = listener;
        },
        release: () => undefined
      }) as ServerHttp;
      const lifecycle: string[] = [];
      const idle: ServerIncoming[] = [];
      let events!: ServerOutgoing;
      http.createServer((request, response) => {
        if (request.url === '/never-answered') {
          idle.push(request);
          return;
        }
        events = response;
        request.once('close', () => lifecycle.push('request-close'));
        response.once('close', () => lifecycle.push('response-close'));
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.flushHeaders();
      }).listen(8123);
      await vi.advanceTimersByTimeAsync(0);

      const disconnect = new AbortController();
      const silentDisconnect = new AbortController();
      const exchange = (path: string, signal: AbortSignal) =>
        published!.serveHttp(
          { method: 'GET', url: path, headers: [['host', 'localhost:8123']] },
          { signal }
        );
      const eventResponse = exchange('/events', disconnect.signal);
      let silentSettled = false;
      void exchange('/never-answered', silentDisconnect.signal).then(
        () => (silentSettled = true),
        () => (silentSettled = true)
      );
      await vi.advanceTimersByTimeAsync(1);

      // `flushHeaders()` delivers the head before any body exists.
      const head = await eventResponse;
      expect(head).toMatchObject({
        status: 200,
        statusText: 'OK',
        headers: [['content-type', 'text/event-stream']],
        informational: []
      });
      const eventStream = head.body.getReader();
      const read = async () => {
        const next = eventStream.read();
        await vi.advanceTimersByTimeAsync(1);
        return new TextDecoder().decode((await next).value);
      };

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(lifecycle).toEqual([]);
      expect(events.destroyed).toBe(false);
      expect(idle).toHaveLength(1);
      expect(silentSettled).toBe(false);

      events.write('data: late\n\n');
      expect(await read()).toBe('data: late\n\n');

      disconnect.abort(new Error('client went away'));
      await vi.advanceTimersByTimeAsync(1);
      expect(lifecycle).toEqual(expect.arrayContaining(['request-close', 'response-close']));
      expect(events.destroyed).toBe(true);
      expect(events.writableFinished).toBe(false);
      // A handler that keeps streaming after the disconnect is told through
      // the write result, not through an unhandled error event.
      expect(events.write('data: ignored\n\n')).toBe(false);
      expect(() => events.end()).not.toThrow();
      silentDisconnect.abort();
      await vi.advanceTimersByTimeAsync(1);
      expect(silentSettled).toBe(true);
      expect(idle[0]!.aborted).toBe(true);
      authority.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  test('delivers a published request to the server structured, with no HTTP/1 bytes either way', async () => {
    const authority = createVirtualNetworkAuthority();
    const net = createNodeNetworkBuiltin(authority, 'process', {
      buffer: (value) => value,
      from: (value) => new TextEncoder().encode(value)
    });
    let published: PublishedListener | undefined;
    const http = createHttpBuiltin('http', net, {
      claim: (_port, listener) => {
        published = listener;
      },
      release: () => undefined
    }) as ServerHttp;
    const seen: Array<{ method: string; url: string; headers: Record<string, unknown>; body: string; remote: string }> = [];
    const socketWrites: string[] = [];
    http.createServer((request, response) => {
      const chunks: string[] = [];
      request.on('data', (chunk: Uint8Array) => chunks.push(new TextDecoder().decode(chunk)));
      request.on('end', () => {
        const socket = request.socket as unknown as { remoteAddress: string; write(text: string): boolean };
        seen.push({
          method: request.method,
          url: request.url,
          headers: { ...request.headers },
          body: chunks.join(''),
          remote: socket.remoteAddress
        });
        socketWrites.push(String(socket.write('not part of the response')));
        response.setHeader('x-app', ['one', 'two']);
        response.writeHead(201, 'Made');
        response.write('first:');
        response.end('second');
      });
    }).listen(8123);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const requestBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('a'));
        controller.enqueue(new TextEncoder().encode('b'));
        controller.close();
      }
    });
    const response = await published!.serveHttp(
      {
        method: 'POST',
        url: '/things?x=1',
        headers: [
          ['host', 'localhost:8123'],
          ['transfer-encoding', 'chunked'],
          ['x-tag', 'one'],
          ['x-tag', 'two']
        ],
        body: requestBody
      },
      {}
    );

    expect(seen).toEqual([
      {
        method: 'POST',
        url: '/things?x=1',
        headers: { host: 'localhost:8123', 'transfer-encoding': 'chunked', 'x-tag': 'one, two' },
        body: 'ab',
        remote: '127.0.0.1'
      }
    ]);
    expect(socketWrites).toEqual(['true']);
    // The handler's head as it set it: no framing or persistence header.
    expect(response).toMatchObject({
      status: 201,
      statusText: 'Made',
      headers: [['x-app', 'one'], ['x-app', 'two']],
      informational: []
    });
    expect(await readText(response.body)).toBe('first:second');
    authority.dispose();
  });

  test('reports interim responses and fails a body that ends with trailers', async () => {
    const authority = createVirtualNetworkAuthority();
    const net = createNodeNetworkBuiltin(authority, 'process', {
      buffer: (value) => value,
      from: (value) => new TextEncoder().encode(value)
    });
    let published: PublishedListener | undefined;
    const http = createHttpBuiltin('http', net, {
      claim: (_port, listener) => {
        published = listener;
      },
      release: () => undefined
    }) as ServerHttp;
    http.createServer((request, response) => {
      const served = response as ServerOutgoing & {
        writeEarlyHints(hints: Record<string, string>): void;
        addTrailers(trailers: Record<string, string>): void;
      };
      if (request.url === '/hints') served.writeEarlyHints({ link: '</a.css>; rel=preload' });
      served.writeHead(200, { 'content-type': 'text/plain' });
      served.write('body');
      if (request.url === '/trailers') served.addTrailers({ 'x-checksum': 'abc' });
      served.end();
    }).listen(8123);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const serve = (url: string) => published!.serveHttp({ method: 'GET', url, headers: [] }, {});

    const hinted = await serve('/hints');
    expect(hinted.informational).toEqual([103]);
    expect(await readText(hinted.body)).toBe('body');
    const trailed = await serve('/trailers');
    expect(trailed.informational).toEqual([]);
    await expect(readText(trailed.body)).rejects.toThrow('cannot carry trailers');
    authority.dispose();
  });

  test('refuses a WebSocket its publication routes to a server that close() was called on', async () => {
    const authority = createVirtualNetworkAuthority();
    const net = createNodeNetworkBuiltin(authority, 'process', {
      buffer: (value) => value,
      from: (value) => new TextEncoder().encode(value)
    });
    let published: PublishedListener | undefined;
    const http = createHttpBuiltin('http', net, {
      claim: (_port, listener) => {
        published = listener;
      },
      release: () => undefined
    }) as ServerHttp & {
      createServer(): {
        on(event: 'upgrade', listener: () => void): unknown;
        listen(port: number): unknown;
        close(): unknown;
      };
    };
    let upgrades = 0;
    const server = http.createServer();
    server.on('upgrade', () => {
      upgrades += 1;
    });
    server.listen(8124);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A development server closes its sockets and then its server; a client
    // that saw its socket close probes for the server at once.
    server.close();

    const events: string[] = [];
    published!.openWebSocket(
      { method: 'GET', url: '/', headers: [['upgrade', 'websocket'], ['sec-websocket-protocol', 'vite-ping']] },
      {
        onHead: () => events.push('head'),
        onData: () => true,
        onEnd: () => events.push('end'),
        onClose: () => events.push('close')
      }
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(upgrades).toBe(0);
    expect(events).toEqual(['close']);
    authority.dispose();
  });

  test('hands an upgraded request its socket and opens the WebSocket from the head the program writes', async () => {
    const authority = createVirtualNetworkAuthority();
    const net = createNodeNetworkBuiltin(authority, 'process', {
      buffer: (value) => value,
      from: (value) => new TextEncoder().encode(value)
    });
    let published: PublishedListener | undefined;
    const http = createHttpBuiltin('http', net, {
      claim: (_port, listener) => {
        published = listener;
      },
      release: () => undefined
    }) as ServerHttp & {
      createServer(): {
        on(event: 'upgrade', listener: (request: ServerIncoming, socket: UpgradeSocket, head: Uint8Array) => void): unknown;
        listen(port: number): unknown;
      };
    };
    const received: string[] = [];
    let upgraded: { url: string; key: unknown; head: number } | undefined;
    const server = http.createServer();
    server.on('upgrade', (request, socket, head) => {
      upgraded = { url: request.url, key: request.headers['sec-websocket-key'], head: head.byteLength };
      socket.on('data', (chunk: Uint8Array) => {
        received.push(new TextDecoder().decode(chunk));
        socket.write(new TextEncoder().encode(`echo:${new TextDecoder().decode(chunk)}`));
      });
      socket.on('end', () => received.push('<end>'));
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n' +
          'sec-websocket-protocol: chat\r\nset-cookie: s=1\r\n\r\nhello'
      );
    });
    server.listen(8123);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const events: unknown[] = [];
    const connection = published!.openWebSocket(
      {
        method: 'GET',
        url: '/socket',
        headers: [
          ['upgrade', 'websocket'],
          ['connection', 'Upgrade'],
          ['sec-websocket-key', 'key'],
          ['sec-websocket-version', '13']
        ]
      },
      {
        onHead: (response) => events.push({ head: response }),
        onData: (bytes) => {
          events.push(new TextDecoder().decode(bytes));
          return true;
        },
        onEnd: () => events.push('end'),
        onClose: () => events.push('close')
      }
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const delivered: string[] = [];
    connection.send(new TextEncoder().encode('ping'), () => delivered.push('ping'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    connection.end();
    await new Promise((resolve) => setTimeout(resolve, 0));
    connection.close();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(upgraded).toEqual({ url: '/socket', key: 'key', head: 0 });
    expect(received).toEqual(['ping', '<end>']);
    expect(delivered).toEqual(['ping']);
    expect(events).toEqual([
      {
        head: {
          status: 101,
          statusText: 'Switching Protocols',
          headers: [
            ['upgrade', 'websocket'],
            ['connection', 'Upgrade'],
            ['sec-websocket-protocol', 'chat'],
            ['set-cookie', 's=1']
          ]
        }
      },
      'hello',
      'echo:ping',
      // The program's socket does not allow half-open: it ends after the client.
      'end',
      'close'
    ]);
    authority.dispose();
  });

  test('holds an upgraded socket\'s writes while the client has not read them, and its bytes while it is paused', async () => {
    const authority = createVirtualNetworkAuthority();
    const net = createNodeNetworkBuiltin(authority, 'process', {
      buffer: (value) => value,
      from: (value) => new TextEncoder().encode(value)
    });
    let published: PublishedListener | undefined;
    const http = createHttpBuiltin('http', net, {
      claim: (_port, listener) => {
        published = listener;
      },
      release: () => undefined
    }) as ServerHttp & {
      createServer(): {
        on(event: 'upgrade', listener: (request: ServerIncoming, socket: UpgradeSocket, head: Uint8Array) => void): unknown;
        listen(port: number): unknown;
      };
    };
    let serverSocket!: UpgradeSocket & { pause(): void; resume(): void };
    const drains: string[] = [];
    const received: string[] = [];
    const server = http.createServer();
    server.on('upgrade', (_request, socket) => {
      serverSocket = socket as typeof serverSocket;
      socket.on('data', (chunk: Uint8Array) => received.push(new TextDecoder().decode(chunk)));
      socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n');
    });
    server.listen(8124);
    await new Promise((resolve) => setTimeout(resolve, 0));

    let accepting = false;
    const chunks: string[] = [];
    const connection = published!.openWebSocket(
      { method: 'GET', url: '/socket', headers: [['upgrade', 'websocket']] },
      {
        onHead: () => undefined,
        onData: (bytes) => {
          chunks.push(new TextDecoder().decode(bytes));
          return accepting;
        },
        onEnd: () => undefined,
        onClose: () => undefined
      }
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    serverSocket.write('first', () => drains.push('first'));
    serverSocket.write('second', () => drains.push('second'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chunks).toEqual(['first']);
    expect(drains).toEqual([]);
    accepting = true;
    connection.resume();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chunks).toEqual(['first', 'second']);
    expect(drains).toEqual(['first', 'second']);

    serverSocket.pause();
    const delivered: string[] = [];
    connection.send(new TextEncoder().encode('held'), () => delivered.push('held'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toEqual([]);
    expect(delivered).toEqual([]);
    serverSocket.resume();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toEqual(['held']);
    expect(delivered).toEqual(['held']);
    connection.close();
    authority.dispose();
  });

  test('emits close on the response when the socket closes mid-response', async () => {
    const { net, clientSockets } = createVirtualNet();
    const http = createHttpBuiltin('http', net) as ServerHttp;
    const lifecycle: string[] = [];
    let serverRequest!: ServerIncoming;
    let serverResponse!: ServerOutgoing;
    http.createServer((request, response) => {
      serverRequest = request;
      serverResponse = response;
      request.once('close', () => lifecycle.push('request-close'));
      response.once('finish', () => lifecycle.push('response-finish'));
      response.once('close', () => lifecycle.push('response-close'));
      response.write('partial');
    }).listen(8123);
    const client = connectRaw(net);
    client.send('GET /stream HTTP/1.1\r\nHost: localhost:8123\r\n\r\n');

    expect(lifecycle).toEqual([]);
    clientSockets[0]!.peer!.emit('close');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(lifecycle).toEqual(['request-close', 'response-close']);
    expect(serverRequest.aborted).toBe(true);
    expect(serverResponse.destroyed).toBe(true);
  });

  test('finishes before closing when the client leaves once it holds the whole body', async () => {
    const authority = createVirtualNetworkAuthority();
    const net = createNodeNetworkBuiltin(authority, 'process', {
      buffer: (value) => value,
      from: (value) => new TextEncoder().encode(value)
    });
    const http = createHttpBuiltin('http', net) as ServerHttp & {
      get(options: unknown, callback: (response: Incoming) => void): unknown;
    };
    const lifecycle: string[] = [];
    const closed = new Promise<void>((resolve) => {
      http.createServer((_request, response) => {
        response.once('finish', () => lifecycle.push('finish'));
        response.once('close', () => {
          lifecycle.push('close');
          resolve();
        });
        response.end('complete');
      }).listen(8123);
    });

    await expect(readResponse((callback) => http.get({ port: 8123 }, callback))).resolves.toEqual({
      status: 200,
      body: 'complete'
    });
    await closed;

    expect(lifecycle).toEqual(['finish', 'close']);
    authority.dispose();
  });

  test('matches the Node status code table', () => {
    const { net } = createVirtualNet();
    const http = createHttpBuiltin('http', net) as ServerHttp & {
      STATUS_CODES: Record<number, string>;
      ServerResponse: new () => { statusCode: number; statusMessage: string };
    };

    expect(http.STATUS_CODES).toEqual({ ...nodeHttp.STATUS_CODES });
    expect(http.STATUS_CODES[201]).toBe('Created');
    expect(http.STATUS_CODES[223]).toBeUndefined();

    const response = new http.ServerResponse();
    expect(response.statusMessage).toBe('OK');
    response.statusCode = 201;
    expect(response.statusMessage).toBe('Created');
    response.statusCode = 429;
    expect(response.statusMessage).toBe('Too Many Requests');
    response.statusMessage = 'Slow Down';
    response.statusCode = 308;
    expect(response.statusMessage).toBe('Slow Down');

    http.createServer((_request, served) => {
      served.statusCode = 201;
      served.end('made');
    }).listen(8123);
    const client = connectRaw(net);
    client.send('POST /things HTTP/1.1\r\nHost: localhost:8123\r\nConnection: close\r\n\r\n');
    expect(client.text()).toMatch(/^HTTP\/1\.1 201 Created\r\n/u);
  });

  test('delivers request headers as sent and adds no transport header to the response', () => {
    const { net } = createVirtualNet();
    const http = createHttpBuiltin('http', net) as ServerHttp;
    const seen: Array<{ url: string; headers: Record<string, unknown>; rawHeaders: string[] }> = [];
    http.createServer((request, response) => {
      seen.push({ url: request.url, headers: { ...request.headers }, rawHeaders: [...request.rawHeaders] });
      response.setHeader('x-app', 'yes');
      response.end('ok');
    }).listen(8123);

    const bare = connectRaw(net);
    bare.send('GET /src/main.ts?v=1 HTTP/1.1\r\nConnection: close\r\n\r\n');
    const browser = connectRaw(net);
    browser.send(
      'GET /src/App.tsx HTTP/1.1\r\nHost: localhost:8123\r\nAccept: text/html\r\nSec-Fetch-Dest: document\r\n' +
        'X-Tag: one\r\nX-Tag: two\r\nCookie: a=1\r\nCookie: b=2\r\nUser-Agent: first\r\nUser-Agent: second\r\n' +
        'Connection: close\r\n\r\n'
    );

    // Nothing is fabricated for a script-looking path that sent no headers...
    expect(seen[0]).toEqual({
      url: '/src/main.ts?v=1',
      headers: { connection: 'close' },
      rawHeaders: ['connection', 'close']
    });
    // ...and what the client did send is not rewritten by path.
    expect(seen[1]!.headers).toEqual({
      host: 'localhost:8123',
      accept: 'text/html',
      'sec-fetch-dest': 'document',
      'x-tag': 'one, two',
      cookie: 'a=1; b=2',
      'user-agent': 'first',
      connection: 'close'
    });
    expect(seen[1]!.rawHeaders).toHaveLength(20);

    const head = parseHttp1ResponseHead(new TextEncoder().encode(bare.text()))!;
    expect(head.headers).toEqual([
      ['x-app', 'yes'],
      ['content-length', '2'],
      ['connection', 'close']
    ]);
  });

  test('has no buffered dispatch path that retains response bytes', () => {
    const { net } = createVirtualNet();
    const http = createHttpBuiltin('http', net) as {
      IncomingMessage: { prototype: Record<string, unknown> };
      Server: { prototype: Record<string, unknown> };
      ServerResponse: { prototype: Record<string, unknown> } & (new () => Record<string, unknown>);
    };

    expect(http.Server.prototype.dispatchNodeRequest).toBeUndefined();
    expect(http.IncomingMessage.prototype.setBody).toBeUndefined();
    expect(http.IncomingMessage.prototype.deliverBody).toBeUndefined();
    expect(http.ServerResponse.prototype.body).toBeUndefined();
    const response = new http.ServerResponse();
    (response as unknown as { write(chunk: string): boolean }).write('streamed');
    expect(response.chunks).toBeUndefined();
  });

  test('keeps a connection open across self-delimited responses and closes it otherwise', () => {
    vi.useFakeTimers();
    try {
      const { net } = createVirtualNet();
      const http = createHttpBuiltin('http', net) as ServerHttp;
      const urls: string[] = [];
      http.createServer((request, response) => {
        urls.push(request.url);
        if (request.url === '/stream') {
          response.write('un');
          response.end('framed');
          return;
        }
        response.end(`body:${request.url}`);
      }).listen(8123);
      const client = connectRaw(net);

      client.send('GET /one HTTP/1.1\r\nHost: localhost:8123\r\n\r\n');
      expect(client.text()).toBe(
        'HTTP/1.1 200 OK\r\ncontent-length: 9\r\nconnection: keep-alive\r\nkeep-alive: timeout=5\r\n\r\nbody:/one'
      );
      expect(client.ended()).toBe(false);

      client.reset();
      // Pipelined requests are answered in order on the same connection.
      client.send(
        'GET /two HTTP/1.1\r\nHost: localhost:8123\r\n\r\nGET /three HTTP/1.1\r\nHost: localhost:8123\r\nConnection: close\r\n\r\n'
      );
      expect(urls).toEqual(['/one', '/two', '/three']);
      expect(client.text()).toContain('connection: keep-alive\r\nkeep-alive: timeout=5\r\n\r\nbody:/two');
      expect(client.text()).toMatch(/content-length: 11\r\nconnection: close\r\n\r\nbody:\/three$/u);
      expect(client.ended()).toBe(true);

      // A response without Content-Length or chunked framing is delimited
      // by closing the connection.
      const streaming = connectRaw(net);
      streaming.send('GET /stream HTTP/1.1\r\nHost: localhost:8123\r\n\r\n');
      expect(streaming.text()).toBe('HTTP/1.1 200 OK\r\nconnection: close\r\n\r\nunframed');
      expect(streaming.ended()).toBe(true);

      // An idle persistent connection is closed after keepAliveTimeout.
      const idle = connectRaw(net);
      idle.send('GET /idle HTTP/1.1\r\nHost: localhost:8123\r\n\r\n');
      expect(idle.ended()).toBe(false);
      vi.advanceTimersByTime(5_000);
      expect(idle.ended()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('closes idle connections with closeIdleConnections and every connection with closeAllConnections', async () => {
    // Next.js's dev server calls closeAllConnections() when it shuts down on SIGINT.
    const { net } = createVirtualNet();
    const http = createHttpBuiltin('http', net) as ServerHttp;
    const server = http.createServer((request, response) => {
      if (request.url !== '/hang') response.end('done');
    }) as ReturnType<ServerHttp['createServer']> & { closeIdleConnections(): void; closeAllConnections(): void };
    server.listen(8123);
    const open = (path: string) => {
      const socket = net.createConnection({ port: 8123, host: '127.0.0.1' }) as unknown as Socket;
      const state = { closed: false, data: '' };
      socket.on('data', (chunk) => {
        state.data += new TextDecoder().decode(chunk as Uint8Array);
      });
      // The server's side of the connection is its peer.
      (socket as Socket & { peer: Socket }).peer.on('close', () => {
        state.closed = true;
      });
      socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost:8123\r\n\r\n`);
      return state;
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    const idle = open('/idle');
    const active = open('/hang');
    await settle();
    expect(idle.data).toContain('done');

    server.closeIdleConnections();
    await settle();
    expect([idle.closed, active.closed]).toEqual([true, false]);

    server.closeAllConnections();
    await settle();
    expect(active.closed).toBe(true);
  });

  test('answers a malformed request head with 400 instead of dropping the socket', () => {
    const { net } = createVirtualNet();
    const http = createHttpBuiltin('http', net) as ServerHttp;
    const requests: string[] = [];
    const server = http.createServer((request, response) => {
      requests.push(request.url);
      response.end();
    });
    server.listen(8123);

    for (const head of [
      'NOT A REQUEST LINE\r\n\r\n',
      'GET / HTTP/9.9\r\nHost: localhost\r\n\r\n',
      'POST /length HTTP/1.1\r\nHost: localhost\r\nContent-Length: nope\r\n\r\n'
    ]) {
      const client = connectRaw(net);
      client.send(head);
      expect(client.text()).toBe('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
      expect(client.ended()).toBe(true);
    }
    const oversized = connectRaw(net);
    oversized.send(`GET / HTTP/1.1\r\nX-Fill: ${'a'.repeat(17 * 1024)}`);
    expect(oversized.text()).toBe('HTTP/1.1 431 Request Header Fields Too Large\r\nconnection: close\r\n\r\n');
    expect(requests).toEqual([]);

    // Like Node, a clientError listener takes over the socket.
    const clientErrors: Array<string | undefined> = [];
    server.on('clientError', (error: Error & { code?: string }, socket: Socket) => {
      clientErrors.push(error.code);
      socket.end('HTTP/1.1 418 Custom\r\n\r\n');
    });
    const handled = connectRaw(net);
    handled.send('BROKEN\r\n\r\n');
    expect(clientErrors).toEqual(['HPE_INVALID_METHOD']);
    expect(handled.text()).toBe('HTTP/1.1 418 Custom\r\n\r\n');
  });

  test('accepts the positional host and string port listen overloads', () => {
    const listenCalls: unknown[][] = [];
    const net = {
      Socket: Socket as never,
      createServer() {
        const socketServer = {
          listening: false,
          on: () => socketServer,
          once: () => socketServer,
          listen(...args: unknown[]) {
            listenCalls.push(args);
            return socketServer;
          },
          close: () => socketServer,
          address: () => null
        };
        return socketServer;
      },
      createConnection(): never {
        throw new Error('not used by the listen overloads');
      },
      connect(): never {
        throw new Error('not used by the listen overloads');
      }
    };
    const http = createHttpBuiltin('http', net) as { createServer(): { listen(...args: unknown[]): unknown } };

    http.createServer().listen(3000, 'runtime.internal', () => undefined);
    http.createServer().listen('3001', '0.0.0.0');
    http.createServer().listen(3002, 511, () => undefined);
    http.createServer().listen(3003, '::');
    http.createServer().listen({ port: '3004', host: 'localhost' });
    http.createServer().listen(() => undefined);

    expect(listenCalls).toEqual([
      [3000, 'runtime.internal'],
      [3001, '0.0.0.0'],
      [3002, '127.0.0.1'],
      [3003, '0.0.0.0'],
      [{ port: 3004, host: 'localhost' }],
      [0, '127.0.0.1']
    ]);
    expect(() => http.createServer().listen(70_000)).toThrow(expect.objectContaining({ code: 'ERR_SOCKET_BAD_PORT' }));
    // A leading string that is not a port names a Unix domain socket.
    http.createServer().listen('/tmp/server.sock');
    expect(listenCalls.at(-1)).toEqual(['/tmp/server.sock']);
  });

  test('negotiates Expect: 100-continue between the virtual client and server', async () => {
    const { net } = createVirtualNet();
    const http = createHttpBuiltin('http', net) as ServerHttp & {
      request(options: unknown, callback: (response: Incoming) => void): {
        on(event: 'continue', listener: () => void): unknown;
        end(chunk: string): unknown;
      };
    };
    http.createServer((request, response) => {
      const chunks: string[] = [];
      request.on('data', (chunk: Uint8Array) => chunks.push(new TextDecoder().decode(chunk)));
      request.on('end', () => response.end(chunks.join('').toUpperCase()));
    }).listen(8123);

    let continued = 0;
    const response = await readResponse((callback) => {
      const request = http.request(
        { port: 8123, method: 'PUT', headers: { expect: '100-continue', 'content-length': '4' } },
        callback
      );
      request.on('continue', () => {
        continued += 1;
        request.end('body');
      });
      return request;
    });

    expect(continued).toBe(1);
    expect(response).toEqual({ status: 200, body: 'BODY' });
  });
});

describe('Node compatibility HTTP client over browser Fetch', () => {
  test('sends the request without browser-owned headers instead of failing it', async () => {
    const { net, clientSockets } = createVirtualNet();
    const fetchCalls: RequestInit[] = [];
    const http = createHttpBuiltin('http', net, undefined, undefined, async (_input, init) => {
      fetchCalls.push(init);
      return new globalThis.Response('sent', { status: 200 });
    }) as {
      request(options: unknown, callback: (response: Incoming) => void): {
        on(event: 'continue', listener: () => void): unknown;
        end(chunk?: string): unknown;
      };
    };

    let continued = 0;
    const response = await readResponse((callback) => {
      const request = http.request(
        {
          host: 'api.example.test',
          method: 'POST',
          headers: {
            cookie: 'session=secret',
            origin: 'https://app.example.test',
            referer: 'https://app.example.test/page',
            expect: '100-continue',
            'accept-encoding': 'gzip',
            'transfer-encoding': 'chunked',
            'content-length': '4',
            'x-custom': 'kept'
          }
        },
        callback
      );
      request.on('continue', () => {
        continued += 1;
        request.end('body');
      });
      return request;
    });

    expect(response).toEqual({ status: 200, body: 'sent' });
    expect(continued).toBe(1);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.headers).toEqual([['x-custom', 'kept']]);
    expect(fetchCalls[0]).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' });
    expect(clientSockets).toHaveLength(0);
  });

  test('sends a credential-free cross-origin GET as a CORS-simple request', async () => {
    const { net } = createVirtualNet();
    const fetchCalls: RequestInit[] = [];
    const https = createHttpBuiltin('https', net, undefined, undefined, async (_input, init) => {
      fetchCalls.push(init);
      return new globalThis.Response('{}', { status: 200 });
    }) as { get(options: unknown, callback: (response: Incoming) => void): unknown };
    const telemetry = {
      accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*',
      'user-agent': 'npm/11.18.0 node/v22.22.3 browser wasm32',
      'npm-command': 'install',
      'pacote-version': '21.5.1'
    };

    await readResponse((callback) => https.get({ host: 'registry.npmjs.org', path: '/picocolors', headers: telemetry }, callback));
    await readResponse((callback) =>
      https.get(
        { host: 'registry.example.test', path: '/private', headers: { ...telemetry, authorization: 'Bearer token' } },
        callback
      )
    );

    expect(fetchCalls.map((init) => init.headers)).toEqual([
      [['accept', telemetry.accept]],
      [...Object.entries(telemetry), ['authorization', 'Bearer token']]
    ]);
  });

  test('follows redirects because Fetch cannot expose a 3xx response', async () => {
    const { net } = createVirtualNet();
    const fetchCalls: RequestInit[] = [];
    const http = createHttpBuiltin('http', net, undefined, undefined, async (_input, init) => {
      fetchCalls.push(init);
      return new globalThis.Response('landed', { status: 200 });
    }) as { get(options: unknown, callback: (response: Incoming) => void): unknown };

    const response = await readResponse((callback) => http.get({ host: 'api.example.test', path: '/moved' }, callback));

    expect(response).toEqual({ status: 200, body: 'landed' });
    expect(fetchCalls.map((init) => init.redirect)).toEqual(['follow']);
  });

  test('exposes the standard Agent shape without delegating transport to it', () => {
    const { net } = createVirtualNet();
    const http = createHttpBuiltin('http', net) as {
      Agent: new (options?: Record<string, unknown>) => Record<string, unknown>;
      globalAgent: Record<string, unknown>;
    };
    const agent = new http.Agent({ keepAlive: true, maxSockets: 4 });

    expect(agent).toMatchObject({
      keepAlive: true,
      maxSockets: 4,
      defaultPort: 80,
      protocol: 'http:',
      options: { keepAlive: true, maxSockets: 4 }
    });
    expect(http.globalAgent).toMatchObject({ keepAlive: false, maxSockets: Infinity });
  });

  test('an Agent subclass can listen to itself and call the base methods, as agentkeepalive does', () => {
    const { net } = createVirtualNet();
    const http = createHttpBuiltin('http', net) as {
      Agent: new (options?: Record<string, unknown>) => {
        on(event: string, listener: (...args: unknown[]) => void): unknown;
        emit(event: string, ...args: unknown[]): boolean;
        getName(options: Record<string, unknown>): string;
        keepSocketAlive(socket: object): boolean;
      };
    };
    class KeepAliveAgent extends http.Agent {
      freed: unknown[] = [];
      constructor() {
        super({ keepAlive: true });
        this.on('free', (socket) => this.freed.push(socket));
      }
    }
    const agent = new KeepAliveAgent();
    agent.emit('free', 'socket');

    expect(agent.freed).toEqual(['socket']);
    expect(agent.getName({ host: 'registry.npmjs.org', port: 443 })).toBe('registry.npmjs.org:443:');
    expect(agent.keepSocketAlive({})).toBe(true);
  });

  test('Agent.getName keys a request as Node does, leaving out an empty host and port', () => {
    const { net } = createVirtualNet();
    const http = createHttpBuiltin('http', net) as {
      Agent: new () => { getName(options?: Record<string, unknown>): string };
    };
    const agent = new http.Agent();

    expect([
      agent.getName(),
      agent.getName({ host: 'h', port: null }),
      agent.getName({ host: '', port: 80 }),
      agent.getName({ host: 'h', port: 0 }),
      agent.getName({ host: 'h', port: '8080' }),
      agent.getName({ host: 'h', port: 80, localAddress: '1.2.3.4', family: 6 }),
      agent.getName({ socketPath: '/run/s.sock' }),
      agent.getName({ host: null, family: 4 })
    ]).toEqual([
      'localhost::',
      'h::',
      'localhost:80:',
      'h::',
      'h:8080:',
      'h:80:1.2.3.4:6',
      'localhost:::/run/s.sock',
      'localhost:::4'
    ]);
  });
});

type PublishedListener = Parameters<NonNullable<Parameters<typeof createHttpBuiltin>[2]>['claim']>[1];

type UpgradeSocket = {
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  write(data: string | Uint8Array): boolean;
};

type ServerIncoming = Incoming & {
  readonly socket: unknown;
  readonly aborted: boolean;
  readonly headers: Record<string, unknown>;
  readonly rawHeaders: string[];
  once(event: 'close', listener: () => void): unknown;
};

type ServerOutgoing = {
  statusCode: number;
  readonly destroyed: boolean;
  readonly writableFinished: boolean;
  setHeader(name: string, value: string): void;
  writeHead(status: number, headers?: Record<string, string>): unknown;
  flushHeaders(): void;
  write(chunk: string): boolean;
  end(chunk?: string): unknown;
  once(event: 'close' | 'finish', listener: () => void): unknown;
};

type ServerHttp = {
  createServer(listener: (request: ServerIncoming, response: ServerOutgoing) => void): {
    listen(port: number): unknown;
    on(event: 'clientError', listener: (error: Error & { code?: string }, socket: Socket) => void): unknown;
  };
};

function connectRaw(net: Parameters<typeof createHttpBuiltin>[1]): {
  send(text: string): void;
  text(): string;
  ended(): boolean;
  reset(): void;
} {
  const socket = net.createConnection({ port: 8123, host: '127.0.0.1' }) as unknown as Socket;
  let chunks: Uint8Array[] = [];
  let ended = false;
  socket.on('data', (chunk) => chunks.push(chunk as Uint8Array));
  socket.on('end', () => {
    ended = true;
  });
  return {
    send: (text) => void socket.write(text),
    text: () => new TextDecoder().decode(concatHttp1Bytes(chunks)),
    ended: () => ended,
    reset: () => {
      chunks = [];
    }
  };
}

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}

async function readResponse(
  start: (callback: (response: Incoming) => void) => unknown
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    start((response) => {
      const chunks: string[] = [];
      response.on('data', (chunk: Uint8Array) => chunks.push(new TextDecoder().decode(chunk)));
      response.on('end', () => resolve({ status: response.statusCode, body: chunks.join('') }));
    });
  });
}

type Incoming = {
  readonly method: string;
  readonly url: string;
  readonly statusCode: number;
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
};

type PipeIncoming = Incoming & {
  listenerCount(event: string): number;
  once(event: 'end', listener: () => void): PipeIncoming;
  pipe(destination: PipeDestination): PipeDestination;
  resume(): PipeIncoming;
  unpipe(destination?: PipeDestination): PipeIncoming;
};

type PipeListenerSnapshot = {
  source: { data: number; end: number };
  first: { close: number; finish: number; unpipe: number };
  second: { close: number; finish: number; unpipe: number };
};

type PipeObservation = {
  path: string;
  baseline: PipeListenerSnapshot;
  afterPipe: PipeListenerSnapshot;
  afterUnpipe: PipeListenerSnapshot;
  afterEnd: PipeListenerSnapshot;
  pipeEvents: string[];
  first: { chunks: string[]; ended: number };
  second: { chunks: string[]; ended: number };
};

class PipeDestination extends Emitter {
  readonly chunks: string[] = [];
  ended = 0;

  write(chunk: unknown): boolean {
    this.chunks.push(chunk instanceof Uint8Array ? new TextDecoder().decode(chunk) : String(chunk));
    return true;
  }

  end(): this {
    this.ended += 1;
    this.emit('finish');
    return this;
  }
}

function pipeListenerSnapshot(
  source: PipeIncoming,
  first: PipeDestination,
  second: PipeDestination
): PipeListenerSnapshot {
  const destination = (target: PipeDestination) => ({
    close: target.listenerCount('close'),
    finish: target.listenerCount('finish'),
    unpipe: target.listenerCount('unpipe')
  });
  return {
    source: { data: source.listenerCount('data'), end: source.listenerCount('end') },
    first: destination(first),
    second: destination(second)
  };
}

type Response = {
  setHeader(name: string, value: string): void;
  end(chunk: string): unknown;
};

function createActivityLifecycle(): {
  readonly lifecycle: { acquire(): () => void };
  active(): number;
} {
  let active = 0;
  return {
    lifecycle: {
      acquire() {
        active += 1;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          active -= 1;
        };
      }
    },
    active: () => active
  };
}

describe('servers of a cluster worker', () => {
  const textBytes = { buffer: (value: Uint8Array) => value, from: (value: string) => new TextEncoder().encode(value) };
  type ListeningServer = {
    listen(...args: unknown[]): unknown;
    close(callback?: () => void): unknown;
    on(event: string, listener: (error: Error) => void): unknown;
    address(): { port: number } | string | null;
    listening: boolean;
  };

  test('the network reports each server that starts listening with the address Node gives a cluster primary', async () => {
    const reported: Array<[unknown, unknown]> = [];
    const net = createNodeNetworkBuiltin(
      createVirtualNetworkAuthority(),
      'process',
      textBytes,
      undefined,
      { resolve: (path) => path, bind: () => undefined, unbind: () => undefined },
      { listening: (server, address) => reported.push([server, address]) }
    );
    const http = createHttpBuiltin('http', net, { claim: () => undefined, release: () => undefined }) as {
      createServer(): ListeningServer;
    };
    const listen = (server: ListeningServer, ...args: unknown[]) =>
      new Promise<ListeningServer>((resolve) => server.listen(...args, () => resolve(server)));

    const anyHost = await listen(http.createServer(), 0);
    const ipv6 = await listen(http.createServer(), 4302, '::');
    const loopback = await listen(net.createServer() as unknown as ListeningServer, 4303, 'localhost');
    const pipe = await listen(http.createServer(), '/run/cluster.sock');

    expect(reported).toEqual([
      [anyHost, { addressType: 4, address: null, port: (anyHost.address() as { port: number }).port }],
      [ipv6, { addressType: 6, address: '::', port: 4302 }],
      [loopback, { addressType: 4, address: '127.0.0.1', port: 4303 }],
      [pipe, { addressType: -1, address: '/run/cluster.sock', port: -1 }]
    ]);
    // The HTTP server is reported, not the socket server under it.
    expect(reported[0]![0]).toBe(anyHost);
    for (const server of [anyHost, ipv6, loopback, pipe]) server.close();
  });

  test('a port another process listens on is a server error, as a busy port is in Node', async () => {
    const authority = createVirtualNetworkAuthority();
    const first = createHttpBuiltin('http', createNodeNetworkBuiltin(authority, 'worker-1', textBytes)) as {
      createServer(): ListeningServer;
    };
    const second = createHttpBuiltin('http', createNodeNetworkBuiltin(authority, 'worker-2', textBytes)) as {
      createServer(): ListeningServer;
    };
    const listening = first.createServer();
    await new Promise<void>((resolve) => listening.listen(4310, '127.0.0.1', resolve));

    const busy = second.createServer();
    const error = await new Promise<Error>((resolve) => {
      busy.on('error', resolve);
      busy.listen(4310, '127.0.0.1');
    });

    expect(error).toMatchObject({
      message: 'listen EADDRINUSE: address already in use 127.0.0.1:4310',
      code: 'EADDRINUSE',
      errno: -98,
      syscall: 'listen',
      address: '127.0.0.1',
      port: 4310
    });
    expect(busy.listening).toBe(false);
    listening.close();
    authority.dispose();
  });
});

describe('HTTP over a Unix domain socket', () => {
  test('a server listening on localhost reports the loopback address it is bound to, as webpack-dev-server parses it', async () => {
    const net = createNodeNetworkBuiltin(createVirtualNetworkAuthority(), 'process', {
      buffer: (value) => value,
      from: (value) => new TextEncoder().encode(value)
    }, undefined, { resolve: (path) => path, bind: () => undefined, unbind: () => undefined });
    const http = createHttpBuiltin('http', net, { claim: () => undefined, release: () => undefined }) as {
      createServer(): { listen(port: number, host: string, callback: () => void): unknown; address(): unknown; close(): unknown };
    };
    const httpServer = http.createServer();
    await new Promise<void>((resolve) => httpServer.listen(4200, 'localhost', resolve));
    const netServer = net.createServer();
    await new Promise<void>((resolve) => netServer.listen(4201, 'localhost', () => resolve()));
    const ipv6Server = http.createServer();
    await new Promise<void>((resolve) => ipv6Server.listen(4202, '::', resolve));

    expect(httpServer.address()).toEqual({ address: '127.0.0.1', family: 'IPv4', port: 4200 });
    expect(netServer.address()).toEqual({ address: '127.0.0.1', family: 'IPv4', port: 4201 });
    expect(ipv6Server.address()).toEqual({ address: '::', family: 'IPv6', port: 4202 });
    httpServer.close();
    netServer.close();
    ipv6Server.close();
  });

  test('a server listening on a path answers requests made with socketPath, and is not published', async () => {
    const net = createNodeNetworkBuiltin(createVirtualNetworkAuthority(), 'process', {
      buffer: (value) => value,
      from: (value) => new TextEncoder().encode(value)
    }, undefined, { resolve: (path) => path, bind: () => undefined, unbind: () => undefined });
    const claimed: number[] = [];
    const http = createHttpBuiltin('http', net, {
      claim: (port) => {
        claimed.push(port);
      },
      release: () => undefined
    }) as {
      createServer(listener: (request: { url: string }, response: { end(body: string): void }) => void): {
        listen(path: string, callback: () => void): unknown;
        address(): unknown;
        close(callback?: () => void): unknown;
      };
      get(
        options: { socketPath: string; path: string },
        callback: (response: { statusCode: number; on(event: string, listener: (chunk?: Uint8Array) => void): void }) => void
      ): { on(event: string, listener: (error: Error) => void): void };
    };
    const server = http.createServer((request, response) => response.end(`served ${request.url}`));
    await new Promise<void>((resolve) => server.listen('/tmp/nitro/worker.sock', resolve));

    expect(server.address()).toBe('/tmp/nitro/worker.sock');
    expect(claimed).toEqual([]);

    const body = await new Promise<string>((resolve, reject) => {
      http
        .get({ socketPath: '/tmp/nitro/worker.sock', path: '/api/hello' }, (response) => {
          let text = '';
          response.on('data', (chunk) => (text += new TextDecoder().decode(chunk)));
          response.on('end', () => resolve(`${response.statusCode} ${text}`));
        })
        .on('error', reject);
    });
    expect(body).toBe('200 served /api/hello');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
