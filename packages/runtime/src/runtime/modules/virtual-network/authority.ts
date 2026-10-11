import {
  VirtualNetworkError,
  type VirtualAddress,
  type VirtualNetworkAuthority,
  type VirtualNetworkConnectRequest,
  type VirtualNetworkErrorCode,
  type VirtualNetworkListener,
  type VirtualNetworkListenRequest,
  type VirtualNetworkSocket,
  type VirtualNetworkSocketEvent
} from './types';

const HIGH_WATER_MARK = 16 * 1024;
const FIRST_EPHEMERAL_PORT = 30_000;

export function createVirtualNetworkAuthority(): VirtualNetworkAuthority {
  const listeners = new Map<string, Listener>();
  const sockets = new Map<string, Socket>();
  let nextListenerId = 0;
  let nextSocketId = 0;
  let closed = false;

  const assertOpen = (): void => {
    if (closed) throw error('VIRTUAL_NETWORK_CLOSED', 'The Virtual Network authority is closed.');
  };

  const releaseSocket = (socket: Socket): void => {
    sockets.delete(socket.id);
  };

  return {
    async listen(request) {
      assertOpen();
      const address = allocateAddress(request, listeners, sockets);
      const listener = new Listener(`listener-${++nextListenerId}`, request.ownerId, address, () => listeners.delete(listener.id));
      listeners.set(listener.id, listener);
      return listener;
    },
    connect(request) {
      assertOpen();
      const host = connectHost(request.host);
      const client = new Socket(`socket-${++nextSocketId}`, request.ownerId, { host: '127.0.0.1', port: allocateEphemeralPort(listeners, sockets) }, {
        host,
        port: request.port
      }, releaseSocket);
      sockets.set(client.id, client);
      queueMicrotask(() => {
        if (closed || client.isClosed) {
          client.fail(error('CANCELED', 'The Virtual Network connection was cancelled.'));
          return;
        }
        if (request.transport === 'tls' && isLoopbackHost(request.host)) {
          client.fail(error('UNSUPPORTED', `TLS is unsupported for loopback connection: ${request.host}:${request.port}`));
          return;
        }
        const listener = findListener(listeners, host, request.port);
        if (listener) {
          const server = new Socket(`socket-${++nextSocketId}`, listener.ownerId, listener.address, client.localAddress, releaseSocket);
          sockets.set(server.id, server);
          client.attach(server);
          server.attach(client);
          listener.accept(server);
          server.resolveConnected();
          client.resolveConnected();
          return;
        }
        if (isLoopbackHost(request.host)) {
          client.fail(error('CONNECTION_REFUSED', `Connection refused: ${request.host}:${request.port}`));
          return;
        }
        client.fail(error(
          'EXTERNAL_TRANSPORT_UNSUPPORTED',
          `External raw ${request.transport === 'tls' ? 'TLS' : 'TCP'} is unsupported: ${request.host}:${request.port}`
        ));
      });
      return client;
    },
    async releaseOwner(ownerId) {
      for (const listener of [...listeners.values()]) if (listener.ownerId === ownerId) await listener.close();
      for (const socket of [...sockets.values()]) if (socket.ownerId === ownerId) socket.destroy();
    },
    dispose() {
      if (closed) return;
      closed = true;
      for (const listener of [...listeners.values()]) void listener.close();
      for (const socket of [...sockets.values()]) socket.destroy(error('CANCELED', 'The Virtual Network authority was disposed.'));
    }
  };
}

class Listener implements VirtualNetworkListener {
  readonly #connections = new Set<(socket: VirtualNetworkSocket) => void>();
  readonly #onClose: () => void;
  readonly closed: Promise<void>;
  #resolveClosed!: () => void;
  #isClosed = false;

  constructor(
    readonly id: string,
    readonly ownerId: string,
    readonly address: VirtualAddress,
    onClose: () => void
  ) {
    this.#onClose = onClose;
    this.closed = new Promise((resolve) => (this.#resolveClosed = resolve));
  }

  onConnection(listener: (socket: VirtualNetworkSocket) => void): () => void {
    if (this.#isClosed) return () => undefined;
    this.#connections.add(listener);
    return () => this.#connections.delete(listener);
  }

  accept(socket: Socket): void {
    if (this.#isClosed) {
      socket.destroy(error('CONNECTION_REFUSED', 'The listener closed before accepting the connection.'));
      return;
    }
    for (const listener of this.#connections) listener(socket);
  }

  async close(): Promise<void> {
    if (!this.#isClosed) {
      this.#isClosed = true;
      this.#connections.clear();
      this.#onClose();
      this.#resolveClosed();
    }
    await this.closed;
  }
}

class Socket implements VirtualNetworkSocket {
  readonly #listeners = new Map<VirtualNetworkSocketEvent['type'], Set<(event: never) => void>>();
  readonly closed: Promise<void>;
  readonly connected: Promise<void>;
  readonly ownerId: string;
  readonly #onClosed: (socket: Socket) => void;
  #resolveClosed!: () => void;
  #resolveConnected!: () => void;
  #rejectConnected!: (reason: VirtualNetworkError) => void;
  #connectedSettled = false;
  #peer: Socket | undefined;
  #paused = false;
  #pending: Array<{ readonly data: Uint8Array; readonly acknowledge: () => void }> = [];
  #pendingEnd = false;
  #queuedBytes = 0;
  #needsDrain = false;
  #readable = true;
  #writable = true;
  #isClosed = false;

  constructor(
    readonly id: string,
    ownerId: string,
    readonly localAddress: VirtualAddress,
    readonly remoteAddress: VirtualAddress,
    onClosed: (socket: Socket) => void
  ) {
    this.ownerId = ownerId;
    this.#onClosed = onClosed;
    this.closed = new Promise((resolve) => (this.#resolveClosed = resolve));
    this.connected = new Promise((resolve, reject) => {
      this.#resolveConnected = resolve;
      this.#rejectConnected = reject;
    });
    void this.connected.catch(() => undefined);
  }

  get isClosed(): boolean {
    return this.#isClosed;
  }

  attach(peer: Socket): void {
    this.#peer = peer;
  }

  resolveConnected(): void {
    if (this.#isClosed || this.#connectedSettled) return;
    this.#connectedSettled = true;
    this.#resolveConnected();
  }

  on<Type extends VirtualNetworkSocketEvent['type']>(
    type: Type,
    listener: (event: Extract<VirtualNetworkSocketEvent, { readonly type: Type }>) => void
  ): () => void {
    const listeners = this.#listeners.get(type) ?? new Set<(event: never) => void>();
    listeners.add(listener as (event: never) => void);
    this.#listeners.set(type, listeners);
    return () => listeners.delete(listener as (event: never) => void);
  }

  write(data: Uint8Array): boolean {
    if (this.#isClosed || !this.#writable || !this.#peer) {
      this.fail(error('CANCELED', 'Cannot write to a closed virtual socket.'));
      return false;
    }
    const copy = data.slice();
    this.#queuedBytes += copy.byteLength;
    const accepted = this.#queuedBytes < HIGH_WATER_MARK;
    if (!accepted) this.#needsDrain = true;
    queueMicrotask(() => {
      if (!this.#isClosed) {
        this.#peer?.receive(copy, () => this.acknowledge(copy.byteLength));
      }
    });
    return accepted;
  }

  pause(): void {
    this.#paused = true;
  }

  resume(): void {
    if (!this.#paused) return;
    this.#paused = false;
    while (!this.#paused && this.#pending.length > 0) {
      const pending = this.#pending.shift();
      if (!pending) break;
      this.emit({ type: 'data', data: pending.data });
      pending.acknowledge();
    }
    if (!this.#paused && this.#pendingEnd && this.#pending.length === 0) this.receiveEnd();
  }

  end(): void {
    if (this.#isClosed || !this.#writable) return;
    this.#writable = false;
    queueMicrotask(() => {
      this.#peer?.receiveEnd();
      this.finishIfClosed();
    });
  }

  destroy(reason?: VirtualNetworkError): void {
    if (this.#isClosed) return;
    this.#isClosed = true;
    this.#readable = false;
    this.#writable = false;
    this.#pending.length = 0;
    if (!this.#connectedSettled) this.rejectConnected(reason ?? error('CANCELED', 'The Virtual Network connection was cancelled.'));
    if (reason) this.emit({ type: 'error', error: { code: reason.code, message: reason.message } });
    this.emit({ type: 'close' });
    this.#resolveClosed();
    this.#onClosed(this);
    const peer = this.#peer;
    this.#peer = undefined;
    if (peer && peer.#peer === this) {
      peer.#peer = undefined;
      peer.destroy(reason);
    }
  }

  fail(reason: VirtualNetworkError): void {
    this.rejectConnected(reason);
    this.destroy(reason);
  }

  private rejectConnected(reason: VirtualNetworkError): void {
    if (this.#connectedSettled) return;
    this.#connectedSettled = true;
    this.#rejectConnected(reason);
  }

  private receive(data: Uint8Array, acknowledge: () => void): void {
    if (this.#isClosed || !this.#readable) return;
    if (this.#paused) {
      this.#pending.push({ data, acknowledge });
      return;
    }
    this.emit({ type: 'data', data });
    acknowledge();
  }

  private acknowledge(byteLength: number): void {
    if (this.#isClosed) return;
    this.#queuedBytes = Math.max(0, this.#queuedBytes - byteLength);
    if (this.#needsDrain && this.#queuedBytes < HIGH_WATER_MARK) {
      this.#needsDrain = false;
      this.emit({ type: 'drain' });
    }
  }

  private receiveEnd(): void {
    if (this.#isClosed || !this.#readable) return;
    if (this.#paused || this.#pending.length > 0) {
      this.#pendingEnd = true;
      return;
    }
    this.#pendingEnd = false;
    this.#readable = false;
    this.emit({ type: 'end' });
    this.finishIfClosed();
  }

  private finishIfClosed(): void {
    if (!this.#readable && !this.#writable) this.destroy();
  }

  private emit(event: VirtualNetworkSocketEvent): void {
    for (const listener of this.#listeners.get(event.type) ?? []) listener(event as never);
  }
}

function allocateAddress(
  request: VirtualNetworkListenRequest,
  listeners: ReadonlyMap<string, Listener>,
  sockets: ReadonlyMap<string, Socket>
): VirtualAddress {
  if (!Number.isInteger(request.port) || request.port < 0 || request.port > 65_535) {
    throw error('ADDRESS_IN_USE', `Invalid virtual port: ${request.port}`);
  }
  const port = request.port === 0 ? allocateEphemeralPort(listeners, sockets) : request.port;
  const host = normalizeHost(request.host);
  if (hasBindConflict(listeners, host, port)) throw error('ADDRESS_IN_USE', `Address already in use: ${host}:${port}`);
  return { host, port };
}

function allocateEphemeralPort(listeners: ReadonlyMap<string, Listener>, sockets: ReadonlyMap<string, Socket>): number {
  for (let port = FIRST_EPHEMERAL_PORT; port <= 65_535; port += 1) {
    if (!hasBindConflict(listeners, '127.0.0.1', port) && ![...sockets.values()].some((socket) => socket.localAddress.port === port)) {
      return port;
    }
  }
  throw error('ADDRESS_IN_USE', 'No virtual ephemeral ports are available.');
}

function hasBindConflict(listeners: ReadonlyMap<string, Listener>, host: string, port: number): boolean {
  const normalized = normalizeHost(host);
  return [...listeners.values()].some(
    (listener) =>
      listener.address.port === port &&
      (listener.address.host === normalized || listener.address.host === '0.0.0.0' || normalized === '0.0.0.0')
  );
}

function findListener(listeners: ReadonlyMap<string, Listener>, host: string, port: number): Listener | undefined {
  const normalized = normalizeHost(host);
  return [...listeners.values()].find(
    (listener) => listener.address.port === port && (listener.address.host === normalized || listener.address.host === '0.0.0.0')
  );
}

function normalizeHost(host: string): string {
  const normalized = host.trim().toLowerCase();
  return normalized === '' || normalized === 'localhost' || normalized.endsWith('.localhost')
    ? '127.0.0.1'
    : normalized;
}

/** The address a connection to `host` reaches: the unspecified address means this host, as on Linux. */
function connectHost(host: string): string {
  const normalized = normalizeHost(host);
  return normalized === '0.0.0.0' || normalized === '::' ? '127.0.0.1' : normalized;
}

/**
 * Whether a host names this runtime itself: the whole 127/8 block, the
 * unspecified address (a connection to it reaches the local host), IPv6
 * loopback, `localhost` and every `*.localhost` name (RFC 6761). The Virtual
 * Network answers every loopback host, with a listener or with a refusal;
 * only a host outside this set may leave the runtime. Node Compatibility's
 * `node:tls` decides with the same predicate which hosts it hands to Fetch,
 * so no loopback address slips out through a disagreement between the two.
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.*)\]$/u, '$1');
  if (normalized === '' || normalized === 'localhost' || normalized.endsWith('.localhost')) return true;
  // A Unix domain socket, which Node Compatibility addresses as `unix:<path>`.
  if (normalized.startsWith('unix:')) return true;
  if (normalized === '0.0.0.0' || normalized === '::' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
    return true;
  }
  const ipv4 = normalized.startsWith('::ffff:') ? normalized.slice('::ffff:'.length) : normalized;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(ipv4);
}

function error(code: VirtualNetworkErrorCode, message: string): VirtualNetworkError {
  return new VirtualNetworkError(code, message);
}
