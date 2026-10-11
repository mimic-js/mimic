export type VirtualAddress = { readonly host: string; readonly port: number };

export type VirtualNetworkErrorCode =
  | 'ADDRESS_IN_USE'
  | 'CONNECTION_REFUSED'
  | 'CANCELED'
  | 'EXTERNAL_TRANSPORT_UNSUPPORTED'
  | 'UNSUPPORTED'
  | 'VIRTUAL_NETWORK_CLOSED';

export class VirtualNetworkError extends Error {
  readonly code: VirtualNetworkErrorCode;

  constructor(code: VirtualNetworkErrorCode, message: string) {
    super(message);
    this.name = 'VirtualNetworkError';
    this.code = code;
  }
}

export type VirtualNetworkErrorData = { readonly code: VirtualNetworkErrorCode; readonly message: string };

export type VirtualNetworkSocketEvent =
  | { readonly type: 'data'; readonly data: Uint8Array }
  | { readonly type: 'end' }
  | { readonly type: 'close' }
  | { readonly type: 'error'; readonly error: VirtualNetworkErrorData }
  | { readonly type: 'drain' };

export interface VirtualNetworkSocket {
  readonly id: string;
  readonly localAddress: VirtualAddress;
  readonly remoteAddress: VirtualAddress;
  readonly connected: Promise<void>;
  readonly closed: Promise<void>;
  on<Type extends VirtualNetworkSocketEvent['type']>(
    type: Type,
    listener: (event: Extract<VirtualNetworkSocketEvent, { readonly type: Type }>) => void
  ): () => void;
  write(data: Uint8Array): boolean;
  pause(): void;
  resume(): void;
  end(): void;
  destroy(reason?: VirtualNetworkError): void;
}

export interface VirtualNetworkListener {
  readonly id: string;
  readonly ownerId: string;
  readonly address: VirtualAddress;
  readonly closed: Promise<void>;
  onConnection(listener: (socket: VirtualNetworkSocket) => void): () => void;
  close(): Promise<void>;
}

export type VirtualNetworkListenRequest = { readonly ownerId: string; readonly host: string; readonly port: number };
export type VirtualNetworkConnectRequest = {
  readonly ownerId: string;
  readonly host: string;
  readonly port: number;
  readonly transport?: 'tcp' | 'tls';
};

export interface VirtualNetworkAuthority {
  listen(request: VirtualNetworkListenRequest): Promise<VirtualNetworkListener>;
  connect(request: VirtualNetworkConnectRequest): VirtualNetworkSocket;
  releaseOwner(ownerId: string): Promise<void>;
  dispose(): void;
}

export interface VirtualNetworkClient extends VirtualNetworkAuthority {
  /** Receives the authority's socket and listener events; expose it to the serving side. */
  readonly events: VirtualNetworkEvents;
  close(): void;
}

export type VirtualNetworkSocketDescriptor = {
  readonly id: string;
  readonly localAddress: VirtualAddress;
  readonly remoteAddress: VirtualAddress;
};

export type VirtualNetworkListenerDescriptor = {
  readonly id: string;
  readonly ownerId: string;
  readonly address: VirtualAddress;
};

/** The operations a Virtual Network authority serves to another context. */
export interface VirtualNetworkApi {
  listen(request: VirtualNetworkListenRequest): Promise<VirtualNetworkListenerDescriptor>;
  closeListener(listenerId: string): Promise<void>;
  connect(
    request: VirtualNetworkConnectRequest,
    socketId: string
  ): Promise<VirtualNetworkSocketDescriptor>;
  write(socketId: string, data: Uint8Array): boolean;
  pause(socketId: string): void;
  resume(socketId: string): void;
  end(socketId: string): void;
  destroy(socketId: string): void;
  releaseOwner(ownerId: string): Promise<void>;
}

/** The events a served authority delivers back to its client. */
export interface VirtualNetworkEvents {
  listenerConnection(listenerId: string, socket: VirtualNetworkSocketDescriptor): void;
  socketEvent(socketId: string, event: VirtualNetworkSocketEvent): void;
  listenerClosed(listenerId: string): void;
}
