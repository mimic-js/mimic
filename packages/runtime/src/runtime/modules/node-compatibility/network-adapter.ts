/** Node-shaped projection over the protocol-neutral Virtual Network client. */
import {
  VirtualNetworkError,
  type VirtualNetworkAuthority,
  type VirtualNetworkListener,
  type VirtualNetworkSocket
} from '../virtual-network';
import { BlockList } from './block-list';
import { nodeErrorCodeFromDomain } from './domain-errors';
import { EventEmitter, type EventListener } from './events';
import { nodeStream as stream } from './streams';

type NodeStyleError = Error & { code: string; cause?: unknown };

type VirtualNetSocket = EventEmitter & {
  readonly localAddress: string;
  readonly localPort: number;
  readonly remoteAddress: string;
  readonly remotePort: number;
  readonly destroyed: boolean;
  readonly connecting: boolean;
  readonly pending: boolean;
  readonly readable: boolean;
  readonly writable: boolean;
  readonly readyState: 'opening' | 'open' | 'readOnly' | 'writeOnly' | 'closed';
  readonly bytesRead: number;
  readonly bytesWritten: number;
  readonly readableLength: number;
  readonly _readableState: { length: number; endEmitted: boolean };
  readonly _writableState: { length: number; needDrain: boolean };
  read(size?: number): Uint8Array | string | null;
  unshift(data: unknown): void;
  write(data?: unknown, encodingOrCallback?: string | ((error?: Error) => void), callback?: (error?: Error) => void): boolean;
  end(data?: unknown, encodingOrCallback?: string | (() => void), callback?: () => void): VirtualNetSocket;
  destroy(error?: Error): VirtualNetSocket;
  setEncoding(encoding?: string): VirtualNetSocket;
  pause(): VirtualNetSocket;
  resume(): VirtualNetSocket;
  cork(): void;
  uncork(): void;
  /** Gives the socket its connection: a Virtual Network socket, or an in-process exchange. */
  attach(socket: VirtualNetworkSocket): void;
};

type VirtualNetServer = EventEmitter & {
  readonly listening: boolean;
  listen(...args: unknown[]): VirtualNetServer;
  close(callback?: (error?: Error) => void): VirtualNetServer;
  /** A server listening on a pipe answers its path, as Node's does. */
  address(): { address: string; family: string; port: number } | string | null;
};

/** The file a Unix domain socket occupies in the file system while a server listens on it. */
export type VirtualNetPipeFiles = {
  resolve(path: string): string;
  bind(path: string): void;
  unbind(path: string): void;
};

export type VirtualNetBuiltin = {
  Socket: new () => VirtualNetSocket;
  Server: new (optionsOrListener?: unknown, listener?: EventListener) => VirtualNetServer;
  Stream: new () => VirtualNetSocket;
  BlockList: typeof BlockList;
  createServer(optionsOrListener?: unknown, listener?: EventListener): VirtualNetServer;
  createConnection(...args: unknown[]): VirtualNetSocket;
  connect(...args: unknown[]): VirtualNetSocket;
  isIP(input: string): number;
  isIPv4(input: string): boolean;
  isIPv6(input: string): boolean;
};

/** A server that starts listening, as the network reports it to a cluster worker. */
export type VirtualNetServerObserver = {
  listening(
    server: EventEmitter,
    address: { addressType: 4 | 6 | -1; address: string | null; port: number }
  ): void;
};

/**
 * Set by a server built over a net server, such as an HTTP server: the
 * server the network reports for it, and the host its caller asked for.
 */
export const NET_SERVER_OWNER = Symbol('netServerOwner');

export type NetServerOwner = { readonly server: EventEmitter; readonly host: string | null };

export function createNodeNetworkBuiltin(
  authority: VirtualNetworkAuthority,
  ownerId: string,
  bytes: {
    readonly buffer: (value: Uint8Array) => Uint8Array;
    readonly from: (value: string, encoding?: string) => Uint8Array;
  },
  // Write callbacks are macrotasks; a context supplies an unclamped queue for them.
  queue: (callback: () => void) => unknown = (callback) => globalThis.setTimeout(callback, 0),
  pipeFiles?: VirtualNetPipeFiles,
  observer?: VirtualNetServerObserver
): VirtualNetBuiltin & { default: VirtualNetBuiltin } {
  // A Unix domain socket is a Virtual Network address of its own: the host
  // `unix:<absolute path>` on one port, which no TCP host shares.
  const pipeOf = (args: unknown[]): string | undefined => {
    const options = args.find((arg): arg is { path?: unknown } => Boolean(arg) && typeof arg === 'object');
    const path = typeof options?.path === 'string' ? options.path
      : typeof args[0] === 'string' && !/^\d+$/u.test(args[0]) ? args[0]
        : undefined;
    return path === undefined ? undefined : pipeFiles?.resolve(path) ?? path;
  };

  class Socket extends stream.Duplex implements VirtualNetSocket {
    connecting = false;
    pending = false;
    localAddress = '127.0.0.1';
    localPort = 0;
    remoteAddress = '127.0.0.1';
    remotePort = 0;
    bytesRead = 0;
    bytesWritten = 0;
    allowHalfOpen = false;
    #socket: VirtualNetworkSocket | undefined;
    #paused = false;

    constructor() {
      super({
        autoDestroy: false,
        // As in Node, a socket emits `close` itself, telling whether an error closed it.
        emitClose: false,
        highWaterMark: 16 * 1024,
        read() {
          const target = this as Socket;
          // The stream reads ahead on its own after a program paused it; the transport stays paused.
          if (target.#paused && target.readableFlowing === false) return;
          target.#socket?.resume();
        },
        write(chunk, encoding, callback) {
          (this as Socket).writeToTransport(chunk, encoding, callback);
        },
        final(callback) {
          (this as Socket).#socket?.end();
          queue(callback);
        },
        destroy(error, callback) {
          const target = this as Socket;
          target.connecting = false;
          target.pending = false;
          target.#socket?.destroy(error ? virtualError(error) : undefined);
          callback(error);
          queueMicrotask(() => target.emit('close', Boolean(error)));
        }
      });
    }

    /** Pausing a socket stops reading from its transport, as Node stops reading its handle. */
    override pause(): this {
      this.#paused = true;
      this.#socket?.pause();
      return super.pause();
    }

    override resume(): this {
      this.#paused = false;
      super.resume();
      this.#socket?.resume();
      return this;
    }

    get readyState(): VirtualNetSocket['readyState'] {
      if (this.destroyed) return 'closed';
      if (this.readable && this.writable) return 'open';
      if (this.readable) return 'readOnly';
      if (this.writable) return 'writeOnly';
      return 'closed';
    }

    override read(size?: number): Uint8Array | string | null {
      return super.read(size) as Uint8Array | string | null;
    }

    connect(...args: unknown[]): this {
      const options = args.find(
        (arg): arg is { allowHalfOpen?: unknown } => Boolean(arg) && typeof arg === 'object'
      );
      this.allowHalfOpen = options?.allowHalfOpen === true;
      const callback = parseCallback(args);
      const pipe = pipeOf(args);
      const port = pipe === undefined ? parsePort(args) : PIPE_PORT;
      const host = pipe === undefined ? parseHost(args) : `${PIPE_HOST_PREFIX}${pipe}`;
      const transport = parseTransport(args);
      this.connecting = true;
      this.pending = true;
      try {
        this.attach(
          authority.connect({ ownerId, host, port, transport })
        );
      } catch (error) {
        this.fail(error);
        return this;
      }
      void this.#socket?.connected.then(
        () => {
          if (this.destroyed) return;
          this.connecting = false;
          this.pending = false;
          this.updateAddresses();
          callback?.();
          this.emit('connect');
        },
        () => undefined
      );
      return this;
    }

    attach(socket: VirtualNetworkSocket): void {
      this.#socket = socket;
      this.updateAddresses();
      socket.on('data', ({ data }) => {
        this.bytesRead += data.byteLength;
        const chunk = bytes.buffer(data);
        if (!this.push(chunk)) socket.pause();
      });
      socket.on('end', () => {
        this.resume();
        this.push(null);
        if (!this.allowHalfOpen) this.end();
      });
      socket.on('error', ({ error }) => this.fail(error));
      socket.on('close', () => {
        if (!this.destroyed) this.destroy();
      });
    }

    setTimeout(_timeout: number, callback?: () => void): this {
      if (callback) this.on('timeout', callback);
      return this;
    }

    setNoDelay(): this { return this; }
    setKeepAlive(): this { return this; }
    cork(): void {}
    uncork(): void {}
    ref(): this { return this; }
    unref(): this { return this; }

    address(): { address: string; family: string; port: number } {
      return { address: this.localAddress, family: 'IPv4', port: this.localPort };
    }

    private fail(reason: unknown): void {
      if (this.destroyed) return;
      this.connecting = false;
      this.pending = false;
      this.destroy(toNodeError(reason));
    }

    private writeToTransport(chunk: unknown, encoding: string, callback: (error?: Error | null) => void): void {
      if (!this.#socket) {
        callback(nodeError('EPIPE', 'This socket has been ended by the other party'));
        return;
      }
      const data = typeof chunk === 'string' ? bytes.from(chunk, encoding) : toBytes(chunk ?? '');
      if (this.connecting) {
        // Node holds what is written before the connection opens and sends it once it has.
        const socket = this.#socket;
        void socket.connected.then(
          () => this.writeToTransport(data, encoding, callback),
          () => callback()
        );
        return;
      }
      this.bytesWritten += data.byteLength;
      if (this.#socket.write(data)) queue(callback);
      else {
        const unsubscribe = this.#socket.on('drain', () => {
          unsubscribe();
          callback();
        });
      }
    }

    private updateAddresses(): void {
      if (!this.#socket) return;
      this.localAddress = this.#socket.localAddress.host;
      this.localPort = this.#socket.localAddress.port;
      this.remoteAddress = this.#socket.remoteAddress.host;
      this.remotePort = this.#socket.remoteAddress.port;
    }

  }

  class Server extends EventEmitter implements VirtualNetServer {
    listening = false;
    connections = 0;
    #listener: VirtualNetworkListener | undefined;
    #listenPromise: Promise<void> | undefined;
    #host = '127.0.0.1';
    #port = 0;
    #pipe: string | undefined;
    readonly #allowHalfOpen: boolean;

    constructor(optionsOrListener?: unknown, listener?: EventListener) {
      super();
      const options =
        optionsOrListener && typeof optionsOrListener === 'object'
          ? optionsOrListener as { allowHalfOpen?: unknown }
          : undefined;
      this.#allowHalfOpen = options?.allowHalfOpen === true;
      const resolvedListener =
        typeof optionsOrListener === 'function' ? optionsOrListener as EventListener : listener;
      if (resolvedListener) this.on('connection', resolvedListener);
    }

    listen(...args: unknown[]): this {
      const callback = parseCallback(args);
      this.#pipe = pipeOf(args);
      this.#host = this.#pipe === undefined ? parseHost(args) : `${PIPE_HOST_PREFIX}${this.#pipe}`;
      this.#port = this.#pipe === undefined ? parsePort(args) : PIPE_PORT;
      const requestedHost = requestedHostOf(args);
      this.#listenPromise = authority.listen({ ownerId, host: this.#host, port: this.#port }).then(
        (listener) => {
          this.#listener = listener;
          this.#host = listener.address.host;
          this.#port = listener.address.port;
          if (this.#pipe !== undefined) pipeFiles?.bind(this.#pipe);
          this.listening = true;
          void listener.onConnection((socket) => {
            const nodeSocket = new Socket();
            nodeSocket.allowHalfOpen = this.#allowHalfOpen;
            nodeSocket.attach(socket);
            this.connections += 1;
            nodeSocket.once('close', () => {
              this.connections = Math.max(0, this.connections - 1);
            });
            this.emit('connection', nodeSocket);
          });
          // Node runs the callback as a 'listening' listener, with the server as `this`.
          callback?.call(this);
          this.emit('listening');
          if (observer) {
            const owner = (this as { [NET_SERVER_OWNER]?: NetServerOwner })[NET_SERVER_OWNER];
            observer.listening(
              owner?.server ?? this,
              this.#pipe !== undefined
                ? { addressType: -1, address: this.#pipe, port: -1 }
                : clusterAddress(owner ? owner.host : requestedHost, this.#port)
            );
          }
          return undefined;
        },
        (error) => {
          this.emit('error', listenError(toNodeError(error), this.#pipe ?? this.#host, this.#pipe === undefined ? this.#port : undefined));
        }
      );
      return this;
    }

    close(callback?: (error?: Error) => void): this {
      const release = async (listener: VirtualNetworkListener) => {
        await listener.close();
        // Node removes a pipe's file when its server closes.
        if (this.#pipe !== undefined) pipeFiles?.unbind(this.#pipe);
        callback?.();
        this.emit('close');
      };
      // A listening server lets its port go at once, as Node's does: the
      // release is sent before anything the caller does next, so a `listen`
      // on the same port right after `close()` finds it free.
      const listener = this.#listener;
      if (listener && this.listening) {
        this.listening = false;
        this.#listener = undefined;
        void release(listener).catch((error: unknown) => callback?.(toNodeError(error)));
        return this;
      }
      const close = async () => {
        await this.#listenPromise;
        const started = this.#listener;
        if (!started || !this.listening) {
          callback?.(nodeError('ERR_SERVER_NOT_RUNNING', 'Server is not running'));
          return;
        }
        this.listening = false;
        this.#listener = undefined;
        await release(started);
      };
      void close().catch((error: unknown) => callback?.(toNodeError(error)));
      return this;
    }

    address(): { address: string; family: string; port: number } | string | null {
      if (!this.listening) return null;
      return this.#pipe ?? boundAddress(this.#host, this.#port);
    }

    getConnections(callback: (error: Error | null, count: number) => void): void {
      callback(null, this.connections);
    }

    ref(): this { return this; }
    unref(): this { return this; }
  }

  const createConnection = (...args: unknown[]) => new Socket().connect(...args);
  const net: VirtualNetBuiltin = {
    Socket,
    Server,
    Stream: Socket,
    BlockList,
    connect: createConnection,
    createConnection,
    createServer: (optionsOrListener?: unknown, listener?: EventListener) =>
      new Server(optionsOrListener, listener),
    isIP: (input: string) => (net.isIPv4(input) ? 4 : net.isIPv6(input) ? 6 : 0),
    isIPv4: (input: string) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(input),
    isIPv6: (input: string) => input.includes(':')
  };
  return { ...net, default: net };
}

const PIPE_HOST_PREFIX = 'unix:';
const PIPE_PORT = 1;

function parsePort(args: unknown[]): number {
  const options = args.find((arg): arg is { port?: unknown; path?: unknown } => Boolean(arg) && typeof arg === 'object');
  const candidate = options?.port ?? args.find((arg) => typeof arg === 'number' || typeof arg === 'string');
  if (candidate === undefined || candidate === null) return 0;
  const port = Number(candidate);
  return Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : 0;
}

/**
 * What `server.address()` reports for a server listening on `host`: the
 * address it is bound to, as Node reports it. `localhost` is bound to its
 * IPv4 loopback address; a name the runtime cannot resolve stays as given.
 */
export function boundAddress(host: string, port: number): { address: string; family: string; port: number } {
  const address = host === 'localhost' ? '127.0.0.1' : host;
  return { address, family: address.includes(':') ? 'IPv6' : 'IPv4', port };
}

/** The host a `listen()` call names, or null when it names none. */
function requestedHostOf(args: unknown[]): string | null {
  const options = args.find((arg): arg is { host?: unknown } => Boolean(arg) && typeof arg === 'object');
  const host = options ? options.host : args.find((arg, index) => index > 0 && typeof arg === 'string');
  return typeof host === 'string' && host.length > 0 ? host : null;
}

/** What Node's cluster worker reports of a TCP server: the host it was asked for, a name resolved. */
function clusterAddress(host: string | null, port: number): { addressType: 4 | 6; address: string | null; port: number } {
  if (host === null) return { addressType: 4, address: null, port };
  const { address, family } = boundAddress(host, port);
  return { addressType: family === 'IPv6' ? 6 : 4, address, port };
}

/** A failed `listen()`, with the fields and message Node gives it. */
function listenError(error: NodeStyleError, address: string, port: number | undefined): NodeStyleError {
  if ((error as { code?: unknown }).code !== 'EADDRINUSE') return error;
  const where = port === undefined ? address : `${address}:${port}`;
  return Object.assign(error, {
    message: `listen EADDRINUSE: address already in use ${where}`,
    errno: -98,
    syscall: 'listen',
    address,
    ...(port === undefined ? {} : { port })
  });
}

function parseHost(args: unknown[]): string {
  const options = args.find(
    (arg): arg is { host?: unknown; hostname?: unknown } => Boolean(arg) && typeof arg === 'object'
  );
  const host = options?.host ?? options?.hostname ?? args.find((arg) => typeof arg === 'string' && !/^\d+$/u.test(arg));
  return typeof host === 'string' && host.length > 0 ? host : '127.0.0.1';
}

function parseTransport(args: unknown[]): 'tcp' | 'tls' {
  const options = args.find(
    (arg): arg is { transport?: unknown } => Boolean(arg) && typeof arg === 'object'
  );
  return options?.transport === 'tls' ? 'tls' : 'tcp';
}

function parseCallback(args: unknown[]): (() => void) | undefined {
  return args.find((arg): arg is () => void => typeof arg === 'function');
}

function toBytes(input: unknown): Uint8Array {
  if (typeof input === 'string') return new TextEncoder().encode(input);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return new Uint8Array(input as ArrayLike<number>);
}

function toNodeError(reason: unknown): NodeStyleError {
  if (reason && typeof reason === 'object' && 'code' in reason && typeof reason.code === 'string') {
    const message = 'message' in reason && typeof reason.message === 'string' ? reason.message : String(reason);
    return Object.assign(
      nodeError(nodeErrorCodeFromDomain('virtual-network', reason.code) ?? reason.code, message),
      { cause: reason }
    );
  }
  return nodeError('ECANCELED', reason instanceof Error ? reason.message : String(reason));
}

function nodeError(code: string, message: string): NodeStyleError {
  return Object.assign(new Error(message), { code });
}

function virtualError(error: Error): VirtualNetworkError {
  return new VirtualNetworkError('CANCELED', error.message);
}
