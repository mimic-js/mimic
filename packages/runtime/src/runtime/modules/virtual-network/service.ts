import type { Notify } from '../worker-transport';
import { createVirtualNetworkAuthority } from './authority';
import {
  VirtualNetworkError,
  type VirtualNetworkApi,
  type VirtualNetworkAuthority,
  type VirtualNetworkEvents,
  type VirtualNetworkListener,
  type VirtualNetworkSocket
} from './types';

export type ServeVirtualNetworkOptions = {
  readonly authority?: VirtualNetworkAuthority;
  /**
   * Serves the authority as this one owner: every listener and socket is
   * registered under it and `releaseOwner` releases it, whatever owner id the
   * caller names. A process worker is served this way, so it cannot reach
   * another process's listeners and sockets.
   */
  readonly ownerId?: string;
};

export interface VirtualNetworkService {
  readonly api: VirtualNetworkApi;
  dispose(): void;
}

export function serveVirtualNetwork(
  events: Notify<VirtualNetworkEvents>,
  options: ServeVirtualNetworkOptions = {}
): VirtualNetworkService {
  const ownsAuthority = options.authority === undefined;
  const authority = options.authority ?? createVirtualNetworkAuthority();
  const sockets = new Map<string, VirtualNetworkSocket>();
  const listeners = new Map<string, { readonly listener: VirtualNetworkListener; readonly unsubscribe: () => void }>();
  const socketDisposers = new Map<string, () => void>();
  let disposed = false;

  const observeSocket = (socket: VirtualNetworkSocket, socketId = socket.id): void => {
    if (sockets.has(socketId)) return;
    sockets.set(socketId, socket);
    const disposers = [
      socket.on('data', (event) => events.socketEvent(socketId, event)),
      socket.on('end', (event) => events.socketEvent(socketId, event)),
      socket.on('error', (event) => events.socketEvent(socketId, event)),
      socket.on('drain', (event) => events.socketEvent(socketId, event)),
      socket.on('close', (event) => {
        events.socketEvent(socketId, event);
        socketDisposers.get(socketId)?.();
        socketDisposers.delete(socketId);
        sockets.delete(socketId);
      })
    ];
    socketDisposers.set(socketId, () => {
      for (const dispose of disposers) dispose();
    });
  };

  const requireSocket = (socketId: string): VirtualNetworkSocket => {
    const socket = sockets.get(socketId);
    if (!socket) throw new VirtualNetworkError('CANCELED', `Virtual socket ${socketId} is not active.`);
    return socket;
  };

  const boundOwner = options.ownerId;
  const asOwner = <Request extends { readonly ownerId: string }>(request: Request): Request =>
    boundOwner === undefined ? request : { ...request, ownerId: boundOwner };

  const api: VirtualNetworkApi = {
    async listen(request) {
      const listener = await authority.listen(asOwner(request));
      const unsubscribe = listener.onConnection((socket) => {
        observeSocket(socket);
        events.listenerConnection(listener.id, descriptor(socket));
      });
      listeners.set(listener.id, { listener, unsubscribe });
      void listener.closed.then(() => {
        listeners.get(listener.id)?.unsubscribe();
        listeners.delete(listener.id);
        if (!disposed) events.listenerClosed(listener.id);
      });
      return { id: listener.id, ownerId: listener.ownerId, address: listener.address };
    },
    async closeListener(listenerId) {
      const active = listeners.get(listenerId);
      if (!active) throw new VirtualNetworkError('CANCELED', `Virtual listener ${listenerId} is not active.`);
      await active.listener.close();
    },
    async connect(request, socketId) {
      const socket = authority.connect(asOwner(request));
      observeSocket(socket, socketId);
      await socket.connected;
      return descriptor(socket, socketId);
    },
    write: (socketId, data) => requireSocket(socketId).write(data),
    pause: (socketId) => requireSocket(socketId).pause(),
    resume: (socketId) => requireSocket(socketId).resume(),
    end: (socketId) => requireSocket(socketId).end(),
    destroy: (socketId) => requireSocket(socketId).destroy(),
    releaseOwner: (ownerId) => authority.releaseOwner(boundOwner ?? ownerId)
  };

  return {
    api,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (ownsAuthority) authority.dispose();
      for (const { unsubscribe } of listeners.values()) unsubscribe();
      listeners.clear();
      for (const dispose of socketDisposers.values()) dispose();
      socketDisposers.clear();
      sockets.clear();
    }
  };
}

function descriptor(socket: VirtualNetworkSocket, id = socket.id) {
  return { id, localAddress: socket.localAddress, remoteAddress: socket.remoteAddress };
}
