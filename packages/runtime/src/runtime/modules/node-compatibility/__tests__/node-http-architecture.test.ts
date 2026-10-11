import { describe, expect, test } from 'vitest';

import { createHttpBuiltin } from '../http';

describe('Node http virtual network architecture', () => {
  test('http Server exposes the timeout configuration contract used by generic frameworks', () => {
    const unusedNet = {
      createServer() {
        throw new Error('not used by the server timeout contract');
      },
      createConnection() {
        throw new Error('not used by the server timeout contract');
      },
      connect() {
        throw new Error('not used by the server timeout contract');
      }
    };
    const http = createHttpBuiltin('http', unusedNet) as {
      createServer(): {
        timeout: number;
        setTimeout(timeout: number, callback?: () => void): unknown;
        emit(event: string): boolean;
      };
    };
    const server = http.createServer();
    let timedOut = false;

    expect(server.setTimeout(30_000, () => (timedOut = true))).toBe(server);
    expect(server.timeout).toBe(30_000);
    server.emit('timeout');
    expect(timedOut).toBe(true);
  });

  test('http Server forwards the object listen overload to the virtual socket server', () => {
    const listenCalls: unknown[][] = [];
    const socketServer = {
      listening: false,
      on() {
        return this;
      },
      once() {
        return this;
      },
      listen(...args: unknown[]) {
        listenCalls.push(args);
        return this;
      },
      close() {
        return this;
      },
      address() {
        return { address: '127.0.0.1', family: 'IPv4', port: 5173 };
      }
    };
    const net = {
      createServer() {
        return socketServer;
      },
      createConnection() {
        throw new Error('not used by the object listen contract');
      },
      connect() {
        throw new Error('not used by the object listen contract');
      }
    };
    const http = createHttpBuiltin('http', net) as { createServer(): { listen(options: { port: number; host: string }): unknown } };
    const server = http.createServer();

    expect(server.listen({ port: 5173, host: '127.0.0.1' })).toBe(server);
    expect(listenCalls).toEqual([[{ port: 5173, host: '127.0.0.1' }]]);
  });

  test('http Server keeps accepted sockets half-open until the response is written', () => {
    const createServerCalls: unknown[][] = [];
    const socketServer = {
      listening: false,
      on() {
        return this;
      },
      once() {
        return this;
      },
      listen() {
        return this;
      },
      close() {
        return this;
      },
      address() {
        return { address: '127.0.0.1', family: 'IPv4', port: 5173 };
      }
    };
    const net = {
      createServer(...args: unknown[]) {
        createServerCalls.push(args);
        return socketServer;
      },
      createConnection() {
        throw new Error('not used by the half-open server contract');
      },
      connect() {
        throw new Error('not used by the half-open server contract');
      }
    };
    const http = createHttpBuiltin('http', net) as {
      createServer(): { listen(port: number): unknown };
    };

    http.createServer().listen(5173);

    expect(createServerCalls).toHaveLength(1);
    expect(createServerCalls[0]?.[0]).toEqual({ allowHalfOpen: true });
    expect(createServerCalls[0]?.[1]).toEqual(expect.any(Function));
  });

  test('http.createServer preserves the options plus request-listener overload', () => {
    const unusedNet = {
      createServer() {
        throw new Error('not used by the createServer overload contract');
      },
      createConnection() {
        throw new Error('not used by the createServer overload contract');
      },
      connect() {
        throw new Error('not used by the createServer overload contract');
      }
    };
    const http = createHttpBuiltin('http', unusedNet) as {
      createServer(options: Record<string, unknown>, listener: () => void): {
        emit(event: string): boolean;
        listenerCount(event: string): number;
      };
    };
    let called = false;
    const server = http.createServer({ keepAlive: true }, () => {
      called = true;
    });

    expect(server.listenerCount('request')).toBe(1);
    expect(() => server.emit('request')).not.toThrow();
    expect(called).toBe(true);
  });

  test('http Server completes close callbacks before the virtual process can drain', async () => {
    let emitListening: (() => void) | undefined;
    const socketServer = {
      on(event: string, listener: () => void) {
        if (event === 'listening') emitListening = listener;
        return this;
      },
      listen() {
        emitListening?.();
        return this;
      },
      close() {
        return this;
      },
      address() {
        return { address: '127.0.0.1', family: 'IPv4', port: 5173 };
      }
    };
    const net = {
      createServer() {
        return socketServer;
      },
      createConnection() {
        throw new Error('not used by the close contract');
      },
      connect() {
        throw new Error('not used by the close contract');
      }
    };
    const closeEvents: string[] = [];
    const http = createHttpBuiltin('http', net, {
      claim() {},
      release() {
        return () => closeEvents.push('bridge-complete');
      }
    }) as {
      createServer(): {
        listen(port: number): unknown;
        close(callback: () => void): unknown;
        on(event: string, listener: () => void): unknown;
      };
    };
    const server = http.createServer();
    server.listen(5173);
    server.on('close', () => closeEvents.push('server-close'));

    server.close(() => {
      closeEvents.push('callback');
    });
    expect(closeEvents).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closeEvents).toEqual(['callback', 'server-close', 'bridge-complete']);
  });

  test('http Server does not publish when close wins a pending bind', async () => {
    let emitListening: (() => void) | undefined;
    const socketServer = {
      on(event: string, listener: () => void) {
        if (event === 'listening') emitListening = listener;
        return this;
      },
      listen() {
        return this;
      },
      close() {
        return this;
      },
      address() {
        return { address: '127.0.0.1', family: 'IPv4', port: 49152 };
      }
    };
    const net = {
      createServer() {
        return socketServer;
      },
      createConnection() {
        throw new Error('not used by the pending bind contract');
      },
      connect() {
        throw new Error('not used by the pending bind contract');
      }
    };
    const events: string[] = [];
    const http = createHttpBuiltin('http', net, {
      claim(port) {
        events.push(`publish:${port}`);
      },
      release(port) {
        events.push(`unpublish:${port}`);
      }
    }) as {
      createServer(): {
        listen(port: number): unknown;
        close(callback: () => void): unknown;
      };
    };
    const server = http.createServer();

    server.listen(0);
    server.close(() => events.push('closed'));
    expect(events).toEqual([]);
    emitListening?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toEqual(['closed']);
  });

  test('http Server completes a delayed close after bind failure without unpublishing', async () => {
    let emitError: ((error: Error) => void) | undefined;
    const socketServer = {
      on(event: string, listener: (error: Error) => void) {
        if (event === 'error') emitError = listener;
        return this;
      },
      listen() {
        return this;
      },
      close() {
        return this;
      },
      address() {
        return null;
      }
    };
    const http = createHttpBuiltin('http', {
      createServer() {
        return socketServer;
      },
      createConnection() {
        throw new Error('not used by the failed bind contract');
      },
      connect() {
        throw new Error('not used by the failed bind contract');
      }
    }, {
      claim() {
        throw new Error('failed bind must not publish');
      },
      release() {
        throw new Error('failed bind must not unpublish');
      }
    }) as {
      createServer(): {
        listen(port: number): unknown;
        close(callback: () => void): unknown;
        on(event: string, listener: () => void): unknown;
      };
    };
    const events: string[] = [];
    const server = http.createServer();
    server.on('error', () => {
      setTimeout(() => server.close(() => events.push('closed')), 0);
    });

    server.listen(8126);
    emitError?.(new Error('address unavailable'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toEqual(['closed']);
  });

  test('exposes the Node 22.12.0 HTTP method contract', () => {
    const unusedNet = {
      createServer() {
        throw new Error('not used by the HTTP method contract');
      },
      createConnection() {
        throw new Error('not used by the HTTP method contract');
      },
      connect() {
        throw new Error('not used by the HTTP method contract');
      }
    };
    const methods = [
      'ACL',
      'BIND',
      'CHECKOUT',
      'CONNECT',
      'COPY',
      'DELETE',
      'GET',
      'HEAD',
      'LINK',
      'LOCK',
      'M-SEARCH',
      'MERGE',
      'MKACTIVITY',
      'MKCALENDAR',
      'MKCOL',
      'MOVE',
      'NOTIFY',
      'OPTIONS',
      'PATCH',
      'POST',
      'PROPFIND',
      'PROPPATCH',
      'PURGE',
      'PUT',
      'QUERY',
      'REBIND',
      'REPORT',
      'SEARCH',
      'SOURCE',
      'SUBSCRIBE',
      'TRACE',
      'UNBIND',
      'UNLINK',
      'UNLOCK',
      'UNSUBSCRIBE'
    ];

    expect(createHttpBuiltin('http', unusedNet)).toMatchObject({
      METHODS: methods,
      maxHeaderSize: 16 * 1024,
      default: { METHODS: methods }
    });
  });

});
