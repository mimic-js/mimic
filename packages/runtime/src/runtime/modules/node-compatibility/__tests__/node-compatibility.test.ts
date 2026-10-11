import { Buffer } from 'node:buffer';

import { describe, expect, test, vi } from 'vitest';

import {
  NODE_COMPATIBILITY_GLOBAL_NAMES,
  NodeCompatibilityError,
  type NodeCompatibilityGlobals
} from '../node-compatibility';
import { createNodeCompatibilityHarness } from './node-compatibility-harness';
import { EventEmitter } from '../events';
import { createNodeNetworkBuiltin } from '../network-adapter';
import { createVirtualNetworkAuthority, type VirtualNetworkSocket } from '../../virtual-network';

describe('Node Compatibility', () => {
  test('rejects an incomplete declared context-local globals contract', () => {
    const globals = nodeCompatibilityGlobals();
    const incompleteGlobals = { ...globals } as Record<string, unknown>;
    delete incompleteGlobals.TextDecoder;
    const compatibility = createNodeCompatibilityHarness({
      global: Object.create(globalThis) as typeof globalThis,
      globals: incompleteGlobals as NodeCompatibilityGlobals
    });

    expect(() => compatibility.installGlobals()).toThrowError(
      expect.objectContaining({ code: 'ERR_MISSING_NODE_COMPATIBILITY_GLOBAL' })
    );
  });

  test('net sockets remove one matching EventEmitter listener without disturbing peers', () => {
    const net = createNodeNetworkBuiltin(createVirtualNetworkAuthority(), 'process-17', {
      buffer: (value) => value,
      from: (value) => new TextEncoder().encode(value)
    });
    const socket = new net.Socket();
    let removedListenerCalls = 0;
    let removedOnceListenerCalls = 0;
    let peerListenerCalls = 0;
    const removedListener = () => {
      removedListenerCalls += 1;
    };
    const removedOnceListener = () => {
      removedOnceListenerCalls += 1;
    };

    socket.on('upgrade', removedListener);
    socket.on('upgrade', removedListener);
    socket.once('upgrade', removedOnceListener);
    socket.on('upgrade', () => {
      peerListenerCalls += 1;
    });

    const removeListener = Reflect.get(socket, 'removeListener');
    expect(typeof removeListener).toBe('function');
    expect(Reflect.apply(removeListener, socket, ['upgrade', removedListener])).toBe(socket);
    expect(Reflect.apply(removeListener, socket, ['upgrade', removedOnceListener])).toBe(socket);
    socket.emit('upgrade');

    expect(removedListenerCalls).toBe(1);
    expect(removedOnceListenerCalls).toBe(0);
    expect(peerListenerCalls).toBe(1);
  });

  test('net sockets support prepended listener ordering and one-shot removal', () => {
    const net = createNodeNetworkBuiltin(createVirtualNetworkAuthority(), 'process-17', {
      buffer: (value) => value,
      from: (value) => new TextEncoder().encode(value)
    });
    const socket = new net.Socket();
    const observed: string[] = [];

    socket.on('connect', () => observed.push('on'));
    socket.prependOnceListener('connect', () => observed.push('prepend-once'));
    socket.prependListener('connect', () => observed.push('prepend'));

    socket.emit('connect');
    socket.emit('connect');

    expect(observed).toEqual(['prepend', 'prepend-once', 'on', 'prepend', 'on']);
  });

  test('net sockets expose queued readable data for pull-based HTTP parsers', async () => {
    let remote: VirtualNetworkSocket | undefined;
    const authority = createVirtualNetworkAuthority();
    const listener = await authority.listen({ ownerId: 'server', host: '127.0.0.1', port: 443 });
    listener.onConnection((socket) => {
      remote = socket;
    });
    const net = createNodeNetworkBuiltin(authority, 'process-17', {
      buffer: (value) => value,
      from: (value) => new TextEncoder().encode(value)
    });
    const socket = net.connect({ host: '127.0.0.1', port: 443 });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    if (!remote) throw new Error('Virtual listener did not receive its socket.');

    const readable = new Promise<void>((resolve) => socket.once('readable', resolve));
    remote.write(new TextEncoder().encode('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok'));
    await readable;

    const read = Reflect.get(socket, 'read');
    expect(typeof read).toBe('function');
    expect(new TextDecoder().decode(Reflect.apply(read, socket, []))).toBe(
      'HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok'
    );
    expect(Reflect.apply(read, socket, [])).toBeNull();
    const closed = new Promise<void>((resolve) => socket.once('close', resolve));
    remote.end();
    await Promise.race([
      closed,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('Default net socket did not close after its readable side ended.')), 50)
      )
    ]);
    expect(socket.destroyed).toBe(true);
  });

  test('net servers preserve an explicit half-open response after the request stream ends', async () => {
    const authority = createVirtualNetworkAuthority();
    const serverNet = createNodeNetworkBuiltin(authority, 'server-process', {
      buffer: (value) => value,
      from: (value) => new TextEncoder().encode(value)
    });
    const clientNet = createNodeNetworkBuiltin(authority, 'client-process', {
      buffer: (value) => value,
      from: (value) => new TextEncoder().encode(value)
    });
    const server = serverNet.createServer({ allowHalfOpen: true }, (socket) => {
      socket.once('end', () => {
        setTimeout(() => socket.end('response-after-request-end'), 0);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address()?.port;
    if (!port) throw new Error('Virtual net server did not bind a port.');

    const response = await new Promise<string>((resolve, reject) => {
      const chunks: string[] = [];
      const socket = clientNet.connect({ host: '127.0.0.1', port });
      socket.once('connect', () => socket.end('request'));
      socket.on('data', (chunk) => chunks.push(new TextDecoder().decode(chunk as Uint8Array)));
      socket.once('error', reject);
      socket.once('end', () => resolve(chunks.join('')));
    });

    expect(response).toBe('response-after-request-end');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    authority.dispose();
  });

  test('projects referenced global MessagePorts onto process activity', () => {
    let active = 0;
    const runtimeGlobal = Object.create(globalThis) as typeof globalThis;
    const compatibility = createNodeCompatibilityHarness({
      global: runtimeGlobal,
      globals: nodeCompatibilityGlobals(),
      referencedActivity: {
        acquire: () => {
          active += 1;
          return () => {
            active -= 1;
          };
        }
      }
    });
    compatibility.installGlobals();
    const { port1, port2 } = new runtimeGlobal.MessageChannel() as unknown as Record<
      'port1' | 'port2',
      MessagePort & { ref(): void; unref(): void; hasRef(): boolean }
    >;

    expect(active).toBe(0);
    port1.ref();
    port1.ref();
    expect([active, port1.hasRef()]).toEqual([1, true]);
    port1.unref();
    expect([active, port1.hasRef()]).toEqual([0, false]);
    port2.ref();
    port2.close();
    expect(active).toBe(0);

    port1.close();
    compatibility.teardown();
  });

  test('installs declared globals and restores every original descriptor', () => {
    const runtimeGlobal = Object.create(null) as typeof globalThis;
    const globals = nodeCompatibilityGlobals();
    const names = ['global', 'globalThis', ...NODE_COMPATIBILITY_GLOBAL_NAMES];
    const descriptors = new Map<PropertyKey, PropertyDescriptor>();
    for (const [index, name] of names.entries()) {
      const descriptor = {
        configurable: true,
        enumerable: index % 2 === 0,
        value: Symbol(String(name)),
        writable: index % 2 !== 0
      };
      Object.defineProperty(runtimeGlobal, name, descriptor);
      descriptors.set(name, descriptor);
    }
    const compatibility = createNodeCompatibilityHarness({
      global: runtimeGlobal,
      globals
    });

    compatibility.installGlobals();

    expect(runtimeGlobal.global).toBe(runtimeGlobal);
    expect(runtimeGlobal.globalThis).toBe(runtimeGlobal);
    for (const name of NODE_COMPATIBILITY_GLOBAL_NAMES) {
      if (name !== 'Buffer' && name !== 'WebSocket' && name !== 'MessageChannel') {
        expect(runtimeGlobal[name]).toBe(globals[name]);
      }
    }
    expect(runtimeGlobal.WebSocket).not.toBe(globals.WebSocket);
    expect(Object.getPrototypeOf(runtimeGlobal.WebSocket)).toBe(globals.WebSocket);
    const buffer = compatibility.builtinModuleProvider.load('node:buffer');
    if (!buffer.found) throw new Error('Expected the context-local Buffer builtin.');
    expect(runtimeGlobal.Buffer).toBe((buffer.module as { Buffer: unknown }).Buffer);

    compatibility.teardown();

    for (const [name, descriptor] of descriptors) {
      expect(Object.getOwnPropertyDescriptor(runtimeGlobal, name)).toEqual(descriptor);
    }
  });

  test('owns browser WebSocket activity and removes callbacks during context teardown', () => {
    class FakeWebSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly CONNECTING = 0;
      readonly OPEN = 1;
      readonly CLOSING = 2;
      readonly CLOSED = 3;
      binaryType: BinaryType = 'blob';
      bufferedAmount = 0;
      extensions = '';
      onclose: ((event: CloseEvent) => unknown) | null = null;
      onerror: ((event: Event) => unknown) | null = null;
      onmessage: ((event: MessageEvent) => unknown) | null = null;
      onopen: ((event: Event) => unknown) | null = null;
      protocol = '';
      readyState = FakeWebSocket.OPEN;
      url = 'ws://runtime.test';
      closeCalls = 0;

      close(): void {
        this.closeCalls += 1;
        this.readyState = FakeWebSocket.CLOSED;
        this.dispatchEvent(new Event('close'));
      }

      send(): void {}
    }
    let active = 0;
    const runtimeGlobal = Object.create(globalThis) as typeof globalThis;
    const compatibility = createNodeCompatibilityHarness({
      global: runtimeGlobal,
      globals: {
        ...nodeCompatibilityGlobals(),
        WebSocket: FakeWebSocket as unknown as typeof WebSocket
      },
      referencedActivity: {
        acquire: () => {
          active += 1;
          return () => {
            active -= 1;
          };
        }
      }
    });
    compatibility.installGlobals();
    const socket = new runtimeGlobal.WebSocket('ws://runtime.test') as WebSocket & FakeWebSocket;
    const message = vi.fn();
    const propertyMessage = vi.fn();
    socket.addEventListener('message', message);
    socket.onmessage = propertyMessage;
    const onceMessage = vi.fn();
    socket.addEventListener('message', onceMessage, { once: true });
    socket.dispatchEvent(new MessageEvent('message', { data: 'first' }));
    socket.dispatchEvent(new MessageEvent('message', { data: 'ignored' }));
    expect(onceMessage).toHaveBeenCalledOnce();
    socket.addEventListener('message', onceMessage, { once: true });
    socket.dispatchEvent(new MessageEvent('message', { data: 'second' }));
    expect(onceMessage).toHaveBeenCalledTimes(2);
    const abortController = new AbortController();
    const signalMessage = vi.fn();
    socket.addEventListener('message', signalMessage, { signal: abortController.signal });
    abortController.abort();
    socket.addEventListener('message', signalMessage);
    socket.dispatchEvent(new MessageEvent('message', { data: 'after-abort' }));
    expect(signalMessage).toHaveBeenCalledOnce();
    message.mockClear();

    expect(active).toBe(1);
    compatibility.teardown();
    expect(socket.closeCalls).toBe(1);
    expect(active).toBe(0);
    socket.dispatchEvent(new MessageEvent('message', { data: 'late' }));
    expect(message).not.toHaveBeenCalled();
    expect(propertyMessage).not.toHaveBeenCalled();
  });

  test('adapts context-local capability clients through the engine-owned builtin port', () => {
    const runtimeGlobal = Object.create(globalThis) as typeof globalThis;
    const globals = nodeCompatibilityGlobals();
    const process = globals.process;
    const compatibility = createNodeCompatibilityHarness({
      global: runtimeGlobal,
      globals
    });

    compatibility.installGlobals();

    expect(runtimeGlobal.process).toBe(process);
    expect(runtimeGlobal.process.platform).toBe('browser');
    expect(runtimeGlobal.process.arch).toBe('wasm32');
    expect(runtimeGlobal.process.version).toBe('v22.22.3');
    expect(runtimeGlobal.process.versions.node).toBe('22.22.3');
    expect(runtimeGlobal.process.release).toEqual({
      name: 'node',
      lts: 'Jod',
      sourceUrl: 'https://nodejs.org/download/release/v22.22.3/node-v22.22.3.tar.gz',
      headersUrl: 'https://nodejs.org/download/release/v22.22.3/node-v22.22.3-headers.tar.gz'
    });
    expect(runtimeGlobal.global).toBe(runtimeGlobal);
    expect(runtimeGlobal.globalThis).toBe(runtimeGlobal);
    expect(compatibility.builtinModuleProvider.load('node:process')).toEqual({ found: true, module: process });
    const fs = compatibility.builtinModuleProvider.load('fs');
    const qualifiedFs = compatibility.builtinModuleProvider.load('node:fs');
    const net = compatibility.builtinModuleProvider.load('net');
    if (!fs.found || !qualifiedFs.found) throw new Error('Expected filesystem builtins.');
    expect(qualifiedFs.module).toBe(fs.module);
    expect(net.found).toBe(true);

    compatibility.teardown();
    expect(Object.prototype.hasOwnProperty.call(runtimeGlobal, 'process')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(runtimeGlobal, 'global')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(runtimeGlobal, 'globalThis')).toBe(false);
  });

  test('reuses one event, stream, Buffer, and encoding core across builtins', () => {
    const runtimeGlobal = Object.create(globalThis) as typeof globalThis;
    const compatibility = createNodeCompatibilityHarness({
      global: runtimeGlobal,
      globals: nodeCompatibilityGlobals()
    });
    compatibility.installGlobals();
    const load = (name: string): unknown => {
      const result = compatibility.builtinModuleProvider.load(`node:${name}`);
      if (!result.found) throw new Error(`Expected node:${name}.`);
      return result.module;
    };
    const events = load('events') as { EventEmitter: new () => object };
    const stream = load('stream') as {
      Readable: new () => object;
      Writable: new () => object;
      Transform: new () => object;
      finished: unknown;
      pipeline: unknown;
    };
    const streamPromises = load('stream/promises') as { finished: unknown; pipeline: unknown };
    const buffer = load('buffer') as { Buffer: new (...args: unknown[]) => object & { from?(value: string): object } };
    const fs = load('fs') as { createReadStream(path: string): object; createWriteStream(path: string): object };
    const http = load('http') as {
      IncomingMessage: new () => object;
      ServerResponse: new () => object;
      createServer(): object;
    };
    const zlib = load('zlib') as { createGzip(): object; gzipSync(value: string): object; Gzip: new () => object };
    const crypto = load('crypto') as { randomBytes(size: number): object };
    const querystring = load('querystring') as { unescapeBuffer(value: string): object };
    const net = load('net') as { Socket: new () => object };
    const childProcess = load('child_process') as {
      spawn(command: string): {
        stdin: ({ on(event: string, listener: () => void): unknown } & object) | null;
        stdout: object | null;
        stderr: object | null;
        on(event: string, listener: () => void): unknown;
      };
    };
    const child = childProcess.spawn('node');
    child.on('error', () => undefined);
    child.stdin?.on('error', () => undefined);

    expect(runtimeGlobal.Buffer).toBe(buffer.Buffer);
    expect((buffer.Buffer as unknown as { from(value: string): object }).from('context')).toBeInstanceOf(buffer.Buffer);
    expect(crypto.randomBytes(8)).toBeInstanceOf(buffer.Buffer);
    expect(querystring.unescapeBuffer('context')).toBeInstanceOf(buffer.Buffer);
    expect(new http.IncomingMessage()).toBeInstanceOf(stream.Readable);
    expect(new http.ServerResponse()).toBeInstanceOf(stream.Writable);
    expect(http.createServer()).toBeInstanceOf(events.EventEmitter);
    expect(fs.createReadStream('identity.txt')).toBeInstanceOf(stream.Readable);
    expect(fs.createWriteStream('identity.txt')).toBeInstanceOf(stream.Writable);
    expect(zlib.createGzip()).toBeInstanceOf(stream.Transform);
    expect(zlib.gzipSync('context')).toBeInstanceOf(buffer.Buffer);
    expect(new zlib.Gzip()).toBeInstanceOf(stream.Transform);
    expect(new net.Socket()).toBeInstanceOf(stream.Duplex);
    expect(child.stdin).toBeInstanceOf(stream.Writable);
    expect(child.stdout).toBeInstanceOf(stream.Readable);
    expect(child.stderr).toBeInstanceOf(stream.Readable);
    expect(typeof streamPromises.finished).toBe('function');
    expect(typeof streamPromises.pipeline).toBe('function');

    const otherCompatibility = createNodeCompatibilityHarness({
      global: Object.create(globalThis) as typeof globalThis,
      globals: nodeCompatibilityGlobals()
    });
    const otherBuffer = otherCompatibility.builtinModuleProvider.load('node:buffer');
    if (!otherBuffer.found) throw new Error('Expected the second context\'s Buffer builtin.');
    // Adopted ports are realm-wide, so contexts of one realm share them (ADR-0026).
    expect((otherBuffer.module as { Buffer: unknown }).Buffer).toBe(buffer.Buffer);
  });

  test('resolves assert/strict to the strict member of the one assert module', () => {
    const compatibility = createNodeCompatibilityHarness({
      global: Object.create(globalThis) as typeof globalThis,
      globals: nodeCompatibilityGlobals()
    });
    const load = (specifier: string): unknown => {
      const result = compatibility.builtinModuleProvider.load(specifier);
      if (!result.found) throw new Error(`Expected ${specifier}.`);
      return result.module;
    };
    type Assert = { equal(actual: unknown, expected: unknown): void; strictEqual: unknown; strict: Assert; default: Assert };
    const assert = load('assert') as Assert;
    const strict = load('node:assert/strict') as Assert;

    expect(compatibility.builtinModuleProvider.resolve('assert/strict')).toBe('node:assert/strict');
    expect(load('assert/strict')).toBe(strict);
    expect(load('node:assert')).toBe(assert);
    expect(strict).toBe(assert.strict);
    expect(strict).not.toBe(assert);
    expect(strict.default).toBe(strict);
    expect(strict.equal).toBe(strict.strictEqual);
    expect(() => assert.equal(1, '1')).not.toThrow();
    expect(() => strict.equal(1, '1')).toThrow(expect.objectContaining({ code: 'ERR_ASSERTION' }));
  });

  test('keeps provider failures distinct from capability-operation errors', () => {
    const providerFailure = Object.assign(new Error('builtin construction failed'), {
      code: 'NOT_FOUND',
      name: 'VirtualFileSystemError'
    });
    const compatibility = createNodeCompatibilityHarness({
      global: Object.create(globalThis) as typeof globalThis,
      globals: nodeCompatibilityGlobals(),
      httpListenerClaims: () => { throw providerFailure; }
    });

    expect(compatibility.builtinModuleProvider.resolve('node:http')).toBe('node:http');
    expect(compatibility.builtinModuleProvider.resolve('not-a-builtin')).toBeUndefined();
    expect(() => compatibility.builtinModuleProvider.load('node:http')).toThrow(providerFailure);
    expect(compatibility.builtinModuleProvider.load('not-a-builtin')).toEqual({ found: false });
    expect(() => compatibility.builtinModuleProvider.load('node:not-a-builtin')).toThrow(
      new NodeCompatibilityError('ERR_UNKNOWN_BUILTIN_MODULE', 'Unsupported builtin module: not-a-builtin')
    );
  });

});

function nodeCompatibilityGlobals(): NodeCompatibilityGlobals {
  return {
    process: {
      arch: 'wasm32',
      platform: 'browser',
      version: 'v22.22.3',
      versions: { node: '22.22.3' },
      release: nodeRelease()
    },
    console,
    Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    WebSocket,
    MessageChannel,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
    queueMicrotask
  };
}

function nodeRelease() {
  return {
    name: 'node',
    lts: 'Jod',
    sourceUrl: 'https://nodejs.org/download/release/v22.22.3/node-v22.22.3.tar.gz',
    headersUrl: 'https://nodejs.org/download/release/v22.22.3/node-v22.22.3-headers.tar.gz'
  } as const;
}

describe('cluster workers', () => {
  test("a cluster worker tells its primary each server it listens with, as Node's worker does", async () => {
    const globals = nodeCompatibilityGlobals();
    const compatibility = createNodeCompatibilityHarness({ globals });
    const sent: unknown[] = [];
    (globals.process as unknown as { env: Record<string, string> }).env.NODE_UNIQUE_ID = '4';
    const events = new EventEmitter();
    Object.assign(globals.process, {
      connected: true,
      send: (message: unknown) => sent.push(message) > 0,
      on: events.on.bind(events),
      once: events.once.bind(events)
    });
    const load = (name: string) => (compatibility.builtinModuleProvider.load(name) as { module: unknown }).module;
    const cluster = load('cluster') as { worker: { state: string } };
    const http = load('http') as {
      createServer(): { listen(port: number, callback: () => void): unknown; close(): unknown; address(): { port: number } };
    };

    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));

    expect(sent).toEqual([
      { cmd: 'NODE_CLUSTER', act: 'listening', addressType: 4, address: null, port: server.address().port }
    ]);
    expect(cluster.worker.state).toBe('listening');
    server.close();
  });
});

describe('Unix domain sockets', () => {
  test('a server listening on a path is reached by connecting to that path, and its file lives while it listens', async () => {
    const files = new Set<string>();
    const net = createNodeNetworkBuiltin(
      createVirtualNetworkAuthority(),
      'process-23',
      { buffer: (value) => value, from: (value) => new TextEncoder().encode(value) },
      undefined,
      {
        resolve: (path) => (path.startsWith('/') ? path : `/home/project/${path}`),
        bind: (path) => files.add(path),
        unbind: (path) => files.delete(path)
      }
    );
    const received: string[] = [];
    const server = net.createServer((socket) => {
      // The client hangs up as soon as it has the reply.
      socket.on('error', () => undefined);
      socket.on('data', (chunk: Uint8Array) => {
        received.push(new TextDecoder().decode(chunk));
        socket.write('pong');
      });
    });
    await new Promise<void>((resolve) => server.listen('vite-node.sock', () => resolve()));

    expect(server.address()).toBe('/home/project/vite-node.sock');
    expect([...files]).toEqual(['/home/project/vite-node.sock']);

    const reply = await new Promise<string>((resolve, reject) => {
      const client = net.connect({ path: '/home/project/vite-node.sock' });
      let text = '';
      client.on('data', (chunk: Uint8Array) => {
        text += new TextDecoder().decode(chunk);
        client.destroy();
        resolve(text);
      });
      client.on('error', reject);
      client.write('ping');
    });
    expect(reply).toBe('pong');
    expect(received).toEqual(['ping']);

    const refused = await new Promise<unknown>((resolve) => {
      net.connect('/home/project/missing.sock').on('error', resolve);
    });
    expect(refused).toMatchObject({ code: 'ECONNREFUSED' });

    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect([...files]).toEqual([]);
  });
});
