import type { Remote } from '../worker-transport';
import { VirtualNetworkError, type VirtualAddress, type VirtualNetworkApi, type VirtualNetworkClient, type VirtualNetworkConnectRequest, type VirtualNetworkEvents, type VirtualNetworkListener, type VirtualNetworkListenRequest, type VirtualNetworkSocket, type VirtualNetworkSocketDescriptor, type VirtualNetworkSocketEvent } from './types';

const HIGH_WATER_MARK = 16 * 1024;

export function createVirtualNetworkClient(api: Remote<VirtualNetworkApi>): VirtualNetworkClient {
  return new VirtualNetworkClientImplementation(api);
}

class VirtualNetworkClientImplementation implements VirtualNetworkClient {
  readonly events: VirtualNetworkEvents;
  readonly #api: Remote<VirtualNetworkApi>;
  readonly #listeners = new Map<string, RemoteListener>();
  readonly #sockets = new Map<string, RemoteSocket>();
  #nextSocketId = 0;
  #closed = false;

  constructor(api: Remote<VirtualNetworkApi>) {
    this.#api = api;
    this.events = {
      listenerConnection: (listenerId, descriptor) => {
        if (this.#closed) return;
        const listener = this.#listeners.get(listenerId);
        const socket = this.createAcceptedSocket(descriptor);
        listener?.accept(socket);
      },
      socketEvent: (socketId, event) => {
        if (this.#closed) return;
        this.#sockets.get(socketId)?.receive(event);
      },
      listenerClosed: (listenerId) => {
        if (this.#closed) return;
        this.#listeners.get(listenerId)?.remoteClose();
        this.#listeners.delete(listenerId);
      }
    };
  }

  async listen(request: VirtualNetworkListenRequest): Promise<VirtualNetworkListener> {
    this.assertOpen();
    const response = await this.#api.listen(request).catch(rethrowNormalized);
    const listener = new RemoteListener(response.id, response.ownerId, response.address, () => this.closeListener(response.id));
    this.#listeners.set(listener.id, listener);
    return listener;
  }

  connect(request: VirtualNetworkConnectRequest): VirtualNetworkSocket {
    this.assertOpen();
    const socketId = `remote-socket-${++this.#nextSocketId}`;
    const socket = new RemoteSocket(socketId, { host: '0.0.0.0', port: 0 }, { host: request.host, port: request.port }, (name, payload) =>
      this.socketOperation(socketId, name, payload)
    );
    this.#sockets.set(socket.id, socket);
    void this.#api.connect(request, socket.id).then(
      (descriptor) => socket.connect(descriptor),
      (reason: unknown) => socket.fail(toVirtualNetworkError(reason))
    );
    return socket;
  }

  async releaseOwner(ownerId: string): Promise<void> {
    this.assertOpen();
    await this.#api.releaseOwner(ownerId).catch(rethrowNormalized);
  }

  dispose(): void {
    this.close();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of this.#listeners.values()) listener.remoteClose();
    for (const socket of this.#sockets.values()) socket.fail(new VirtualNetworkError('CANCELED', 'The Virtual Network client closed.'));
    this.#listeners.clear();
    this.#sockets.clear();
  }

  private createAcceptedSocket(descriptor: VirtualNetworkSocketDescriptor): RemoteSocket {
    const existing = this.#sockets.get(descriptor.id);
    if (existing) return existing;
    const socket = new RemoteSocket(descriptor.id, descriptor.localAddress, descriptor.remoteAddress, (name, payload) =>
      this.socketOperation(descriptor.id, name, payload)
    );
    socket.connect(descriptor);
    this.#sockets.set(socket.id, socket);
    return socket;
  }

  private async closeListener(listenerId: string): Promise<void> {
    await this.#api.closeListener(listenerId).catch(rethrowNormalized);
  }

  private async socketOperation(
    socketId: string,
    name: 'write' | 'pause' | 'resume' | 'end' | 'destroy',
    payload?: Uint8Array
  ): Promise<boolean | void> {
    if (name === 'write') return this.#api.write(socketId, payload ?? new Uint8Array());
    await this.#api[name](socketId);
  }

  private assertOpen(): void {
    if (this.#closed) throw new VirtualNetworkError('VIRTUAL_NETWORK_CLOSED', 'The Virtual Network client is closed.');
  }
}

class RemoteListener implements VirtualNetworkListener {
  readonly #connections = new Set<(socket: VirtualNetworkSocket) => void>();
  readonly closed: Promise<void>;
  readonly #closeRemote: () => Promise<void>;
  #resolveClosed!: () => void;
  #isClosed = false;

  constructor(readonly id: string, readonly ownerId: string, readonly address: VirtualAddress, closeRemote: () => Promise<void>) {
    this.#closeRemote = closeRemote;
    this.closed = new Promise((resolve) => (this.#resolveClosed = resolve));
  }

  onConnection(listener: (socket: VirtualNetworkSocket) => void): () => void {
    if (this.#isClosed) return () => undefined;
    this.#connections.add(listener);
    return () => this.#connections.delete(listener);
  }

  async close(): Promise<void> {
    if (!this.#isClosed) await this.#closeRemote();
    this.remoteClose();
    await this.closed;
  }

  remoteClose(): void {
    if (this.#isClosed) return;
    this.#isClosed = true;
    this.#connections.clear();
    this.#resolveClosed();
  }

  accept(socket: VirtualNetworkSocket): void {
    if (!this.#isClosed) for (const listener of this.#connections) listener(socket);
  }
}

class RemoteSocket implements VirtualNetworkSocket {
  readonly connected: Promise<void>;
  readonly closed: Promise<void>;
  readonly #listeners = new Map<VirtualNetworkSocketEvent['type'], Set<(event: never) => void>>();
  readonly #operate: (name: 'write' | 'pause' | 'resume' | 'end' | 'destroy', payload?: Uint8Array) => Promise<boolean | void>;
  #resolveConnected!: () => void;
  #rejectConnected!: (reason: VirtualNetworkError) => void;
  #resolveClosed!: () => void;
  #localAddress: VirtualAddress;
  #remoteAddress: VirtualAddress;
  #connected = false;
  #closed = false;
  #paused = false;
  #queuedBytes = 0;
  #needsDrain = false;
  #remoteDrainPending = false;
  #drainEpoch = 0;
  #writesAwaitingDisposition = 0;
  #pendingWrites: Uint8Array[] = [];
  #operationQueue = Promise.resolve();

  constructor(readonly id: string, localAddress: VirtualAddress, remoteAddress: VirtualAddress, operate: (name: 'write' | 'pause' | 'resume' | 'end' | 'destroy', payload?: Uint8Array) => Promise<boolean | void>) {
    this.#localAddress = localAddress;
    this.#remoteAddress = remoteAddress;
    this.#operate = operate;
    this.connected = new Promise((resolve, reject) => {
      this.#resolveConnected = resolve;
      this.#rejectConnected = reject;
    });
    void this.connected.catch(() => undefined);
    this.closed = new Promise((resolve) => (this.#resolveClosed = resolve));
  }

  get localAddress(): VirtualAddress { return this.#localAddress; }
  get remoteAddress(): VirtualAddress { return this.#remoteAddress; }

  on<Type extends VirtualNetworkSocketEvent['type']>(type: Type, listener: (event: Extract<VirtualNetworkSocketEvent, { readonly type: Type }>) => void): () => void {
    const listeners = this.#listeners.get(type) ?? new Set<(event: never) => void>();
    listeners.add(listener as (event: never) => void);
    this.#listeners.set(type, listeners);
    return () => listeners.delete(listener as (event: never) => void);
  }

  write(data: Uint8Array): boolean {
    if (this.#closed) return false;
    const copy = data.slice();
    this.#queuedBytes += copy.byteLength;
    const accepted = this.#queuedBytes < HIGH_WATER_MARK;
    if (!accepted) {
      this.#needsDrain = true;
    }
    if (this.#connected) void this.send(copy); else this.#pendingWrites.push(copy);
    return accepted;
  }

  pause(): void { this.#paused = true; void this.perform('pause').catch((reason: unknown) => this.fail(toVirtualNetworkError(reason))); }
  resume(): void { this.#paused = false; void this.perform('resume').catch((reason: unknown) => this.fail(toVirtualNetworkError(reason))); }
  end(): void { if (!this.#closed) void this.perform('end').catch((reason: unknown) => this.fail(toVirtualNetworkError(reason))); }
  destroy(reason?: VirtualNetworkError): void {
    if (this.#closed) return;
    void this.perform('destroy').catch(() => undefined);
    const cancellation = reason ?? new VirtualNetworkError('CANCELED', 'The Virtual Network connection was cancelled.');
    if (!this.#connected) this.#rejectConnected(cancellation);
    this.finish(reason);
  }

  connect(descriptor: VirtualNetworkSocketDescriptor): void {
    if (this.#closed) return;
    this.#localAddress = descriptor.localAddress;
    this.#remoteAddress = descriptor.remoteAddress;
    this.#connected = true;
    this.#resolveConnected();
    for (const pending of this.#pendingWrites.splice(0)) void this.send(pending);
  }

  receive(event: VirtualNetworkSocketEvent): void {
    if (this.#closed) return;
    // Connect request results carry the canonical structured failure. The
    // authority may emit error/close first on another message lane; defer to
    // the request result so cross-realm Error cloning cannot weaken its code.
    if (!this.#connected && (event.type === 'error' || event.type === 'close')) return;
    if (event.type === 'close') { this.finish(); return; }
    if (event.type === 'error') { this.emit(event); return; }
    if (event.type === 'drain') {
      this.#drainEpoch += 1;
      this.#remoteDrainPending = false;
      this.emitDrainIfReady();
      return;
    }
    this.emit(event);
  }

  fail(reason: VirtualNetworkError): void {
    if (!this.#connected) this.#rejectConnected(reason);
    this.finish(reason);
  }

  private async send(data: Uint8Array): Promise<void> {
    const drainEpoch = this.#drainEpoch;
    this.#writesAwaitingDisposition += 1;
    try {
      const accepted = await this.perform('write', data);
      if (accepted === false && drainEpoch === this.#drainEpoch) this.#remoteDrainPending = true;
    } catch (reason) {
      this.fail(toVirtualNetworkError(reason));
    } finally {
      this.#writesAwaitingDisposition -= 1;
      this.#queuedBytes = Math.max(0, this.#queuedBytes - data.byteLength);
      this.emitDrainIfReady();
    }
  }

  private emitDrainIfReady(): void {
    if (
      !this.#needsDrain ||
      this.#remoteDrainPending ||
      this.#writesAwaitingDisposition > 0 ||
      this.#queuedBytes >= HIGH_WATER_MARK
    ) return;
    this.#needsDrain = false;
    this.emit({ type: 'drain' });
  }

  private perform(name: 'write' | 'pause' | 'resume' | 'end' | 'destroy', payload?: Uint8Array): Promise<boolean | void> {
    const operation = this.#operationQueue.then(() => this.#operate(name, payload));
    this.#operationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private finish(reason?: VirtualNetworkError): void {
    if (this.#closed) return;
    this.#closed = true;
    if (reason) this.emit({ type: 'error', error: { code: reason.code, message: reason.message } });
    this.emit({ type: 'close' });
    this.#resolveClosed();
  }

  private emit(event: VirtualNetworkSocketEvent): void {
    for (const listener of this.#listeners.get(event.type) ?? []) listener(event as never);
  }
}

function rethrowNormalized(reason: unknown): never {
  throw toVirtualNetworkError(reason);
}

// Not a copy of Worker Transport's `normalizeError`: it maps any rejection to
// the Virtual Network's own error and code, which callers match on.
function toVirtualNetworkError(reason: unknown): VirtualNetworkError {
  if (reason instanceof VirtualNetworkError) return reason;
  if (reason && typeof reason === 'object' && 'code' in reason && typeof reason.code === 'string') {
    return new VirtualNetworkError(reason.code as VirtualNetworkError['code'], reason instanceof Error ? reason.message : String((reason as { message?: unknown }).message ?? reason));
  }
  return new VirtualNetworkError(
    'CANCELED',
    reason instanceof Error ? reason.message : reason && typeof reason === 'object' ? JSON.stringify(reason) : String(reason)
  );
}
