import type { VirtualAddress } from '../virtual-network';

export type PublishedEndpointProtocol = 'http' | 'https';

export type PublishedEndpointIdentity = {
  readonly routeId: string;
  readonly protocol: PublishedEndpointProtocol;
  readonly address: VirtualAddress;
};

export type PublishedEndpointPublishRequest = {
  readonly ownerId: string;
  readonly protocol: PublishedEndpointProtocol;
  readonly address: VirtualAddress;
};

export type PublishedEndpointLifecycleEvent =
  | { readonly type: 'published'; readonly endpoint: PublishedEndpointIdentity }
  | { readonly type: 'unpublished'; readonly endpoint: PublishedEndpointIdentity };

export interface PublishedEndpointAuthority {
  publish(request: PublishedEndpointPublishRequest): PublishedEndpointIdentity;
  unpublish(request: PublishedEndpointPublishRequest): void;
  releaseOwner(ownerId: string): void;
  subscribe(listener: (event: PublishedEndpointLifecycleEvent) => void): () => void;
  dispose(): void;
}

export type PublishedEndpoint = PublishedEndpointIdentity & { readonly url: string };

export type PublishedEndpointDocumentRoute = PublishedEndpoint;

export type PublishedEndpointDocumentRouteManifest = {
  readonly version: 1;
  readonly epochId: string;
  readonly routes: readonly PublishedEndpointDocumentRoute[];
};

export type PublishedEndpointDocumentRouteRequest = {
  readonly manifestVersion: 1;
  readonly instanceId: string;
  readonly routeId: string;
  readonly port: number;
};

export type PublishedEndpointDocumentCookieOpenRequest =
  PublishedEndpointDocumentRouteRequest & {
    readonly type: 'mimic:document-cookie-open';
    readonly path: string;
  };

export type PublishedEndpointHostHttpRequest = {
  readonly requestId: string;
  readonly instanceId: string;
  readonly routeId: string;
  readonly port: number;
  readonly path: string;
  readonly method: string;
  readonly url: string;
  readonly destination?: string;
  readonly headers: [string, string][];
  readonly body?: ArrayBuffer | ReadableStream<Uint8Array>;
  readonly signal?: AbortSignal;
  /**
   * Present when a document requested a loopback URL of another port of its
   * container, as `http://localhost:3333/api` (ADR-0037): the request is
   * cross-origin to the document, so the Cookie Jar takes part only for the
   * credentials mode that sends cookies to another origin. A WebSocket
   * handshake always does.
   */
  readonly loopback?: PublishedEndpointLoopbackRequest;
};

export type PublishedEndpointLoopbackRequest = {
  readonly credentials: 'omit' | 'same-origin' | 'include';
};

/**
 * The Service Worker asks the host which route serves a loopback port when a
 * document requests it, since a server may publish after the document loaded.
 */
export type PublishedEndpointHostLoopbackRouteRequest = {
  readonly instanceId: string;
  readonly protocol: PublishedEndpointProtocol;
  readonly port: number;
  /** The route of the requesting document, whose logical origin the request carries. */
  readonly initiator: { readonly routeId: string; readonly port: number };
};

/** No `routeId` when the container does not publish the port: the request goes to the network. */
export type PublishedEndpointHostLoopbackRoute = {
  readonly routeId?: string;
  /** The requesting document's logical origin, as `http://localhost:4200`, sent as `Origin`. */
  readonly origin?: string;
};

export type PublishedEndpointHostWebSocketOpenRequest =
  PublishedEndpointHostHttpRequest &
    PublishedEndpointDocumentRouteRequest & {
      readonly type: typeof PUBLISHED_ENDPOINT_WEBSOCKET_MESSAGE.open;
      /**
       * The Web Lock the document holds while it lives, which the process
       * worker serving the socket watches (ADR-0038). Absent when the
       * document has no lock manager.
       */
      readonly documentLock?: string;
    };

/** The `type` of each message on a published WebSocket's control stream. */
export const PUBLISHED_ENDPOINT_WEBSOCKET_MESSAGE = {
  open: 'published-endpoint:websocket-open',
  connect: 'published-endpoint:websocket-connect',
  close: 'published-endpoint:websocket-close',
  unrouted: 'published-endpoint:websocket-unrouted'
} as const;

/**
 * One message on a published WebSocket's control stream, the document's
 * connection to its host (ADR-0038). The document sends `open` with its
 * handshake request. The host answers once and closes the stream: `connect`
 * carries the port on which the process worker that owns the listener serves
 * the socket, `close` refuses it, and `unrouted` says the container does not
 * publish the loopback port, so the document opens a browser WebSocket.
 */
export type PublishedEndpointWebSocketMessage =
  | {
      readonly type: typeof PUBLISHED_ENDPOINT_WEBSOCKET_MESSAGE.connect;
      readonly port: MessagePort;
    }
  | {
      readonly type: typeof PUBLISHED_ENDPOINT_WEBSOCKET_MESSAGE.close;
      readonly code?: number;
      readonly reason?: string;
    }
  | {
      readonly type: typeof PUBLISHED_ENDPOINT_WEBSOCKET_MESSAGE.unrouted;
    };

/**
 * What the process worker sends the document on a published WebSocket's
 * port: messages, not frames, since the worker speaks RFC 6455 to the server
 * (ADR-0038). `open` names the accepted subprotocol and the Web Lock the
 * worker holds while it lives; `ack` counts the document's `send`s the
 * server's socket took; `close` ends the socket.
 */
export type PublishedWebSocketServerMessage =
  | { readonly type: 'open'; readonly protocol: string; readonly lock?: string }
  | { readonly type: 'message'; readonly data: string | ArrayBuffer }
  | { readonly type: 'ack'; readonly count: number }
  | {
      readonly type: 'close';
      readonly code: number;
      readonly reason: string;
      readonly wasClean: boolean;
    };

/**
 * What the document sends the process worker on a published WebSocket's
 * port. `ack` counts the `message`s the document dispatched. `close` starts
 * the closing handshake, with no `code` for an empty close frame; `abort`
 * drops the connection without one.
 */
export type PublishedWebSocketClientMessage =
  | { readonly type: 'send'; readonly data: string | ArrayBuffer }
  | { readonly type: 'ack'; readonly count: number }
  | { readonly type: 'close'; readonly code?: number; readonly reason: string }
  | { readonly type: 'abort' };

export type PublishedEndpointHostHttpResponseMessage = {
  readonly status: number;
  readonly statusText?: string;
  readonly headers: [string, string][];
  readonly body: ArrayBuffer | ReadableStream<Uint8Array>;
};

export type PublishedEndpointHostResponse = {
  readonly status: number;
  readonly statusText?: string;
  readonly headers: [string, string][];
  readonly body: Uint8Array;
  readonly bodyStream?: ReadableStream<Uint8Array>;
};

/**
 * A published HTTP request as the listener's server receives it: method,
 * target, headers and a body stream, with no HTTP/1 framing.
 */
export type PublishedHttpRequest = {
  readonly method: string;
  /** The request target (path and query), as `IncomingMessage.url` reports it. */
  readonly url: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body?: ReadableStream<Uint8Array>;
};

export type PublishedHttpResponseHead = {
  readonly status: number;
  readonly statusText: string;
  readonly headers: [string, string][];
};

export type PublishedHttpResponse = PublishedHttpResponseHead & {
  /** Interim statuses the server sent before its final head. */
  readonly informational: readonly number[];
  /** Errors when the response ends with trailers, which Fetch cannot carry. */
  readonly body: ReadableStream<Uint8Array>;
};

/**
 * The server side of a published WebSocket as bytes: the listener's
 * `http.Server` emitted `upgrade` with a socket whose bytes these are.
 */
export type PublishedEndpointWebSocketConnectionObserver = {
  /** The server's response head: 101 switches protocols, any other status refuses. */
  onHead(response: PublishedHttpResponseHead): void;
  /** Bytes the server wrote after a 101 head; `false` holds its writes until `resume()`. */
  onData(bytes: Uint8Array): boolean;
  /** The server ended its side of the socket. */
  onEnd(): void;
  /** The socket closed. */
  onClose(): void;
};

export type PublishedEndpointWebSocketConnection = {
  /** Writes client bytes to the server; `delivered` runs once its socket took them. */
  send(bytes: Uint8Array, delivered?: () => void): void;
  /** The server may write again after `onData` returned `false`. */
  resume(): void;
  /** Ends the client's side of the socket. */
  end(): void;
  close(): void;
};

/** A listener's server, inside the process worker that owns it. */
export type PublishedEndpointServer = {
  readonly address: { readonly host: string; readonly port: number };
  serveHttp(
    request: PublishedHttpRequest,
    options: { readonly signal?: AbortSignal }
  ): Promise<PublishedHttpResponse>;
  openWebSocket(
    request: PublishedHttpRequest,
    observer: PublishedEndpointWebSocketConnectionObserver
  ): PublishedEndpointWebSocketConnection;
  close(): void;
};

/** A listener as the Published Endpoint host reaches it, in another context. */
export type PublishedEndpointListener = {
  readonly address: { readonly host: string; readonly port: number };
  serveHttp(
    request: PublishedHttpRequest,
    options: { readonly signal?: AbortSignal }
  ): Promise<PublishedHttpResponse>;
  /**
   * Serves a WebSocket to the document on `client` (ADR-0038). Resolves with
   * the server's response head, whose cookies the host stores, or `undefined`
   * when the socket closed before the server answered.
   */
  openWebSocket(
    request: PublishedHttpRequest,
    client: MessagePort,
    options: { readonly documentLock?: string }
  ): Promise<PublishedHttpResponseHead | undefined>;
  close(): void;
};

export interface PublishedEndpointCollection {
  readonly current: readonly PublishedEndpoint[];
  on<Type extends PublishedEndpointLifecycleEvent['type']>(
    type: Type,
    listener: (endpoint: PublishedEndpoint) => void
  ): () => void;
  /**
   * Requests a Published Endpoint URL from the embedding page, as `fetch`
   * would from a document served by the endpoint. The page itself is outside
   * the Service Worker's scope, so its own `fetch` does not reach an endpoint.
   * The response belongs to the container's epoch: read it before `teardown()`.
   */
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
}

export interface PublishedEndpointClient extends PublishedEndpointCollection {
  readonly routeManifest: PublishedEndpointDocumentRouteManifest;
  /** Receives lifecycle events; expose it to the serving side. */
  readonly events: PublishedEndpointEvents;
  publish(request: PublishedEndpointPublishRequest): Promise<PublishedEndpoint>;
  unpublish(request: PublishedEndpointPublishRequest): Promise<void>;
  releaseOwner(ownerId: string): Promise<void>;
  close(): void;
}

/** The operations the endpoint registry serves to another context. */
export interface PublishedEndpointApi {
  initialize(epochId: string): void;
  publish(request: PublishedEndpointPublishRequest): PublishedEndpointIdentity;
  unpublish(request: PublishedEndpointPublishRequest): void;
  releaseOwner(ownerId: string): void;
}

/** The lifecycle events a served registry delivers back to its client. */
export interface PublishedEndpointEvents {
  lifecycle(event: PublishedEndpointLifecycleEvent): void;
}
