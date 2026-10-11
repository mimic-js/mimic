import { createPublishedEndpointCookieJar, type PublishedEndpointCookieHeader } from './cookie-jar';
import {
  PUBLISHED_ENDPOINT_WEBSOCKET_MESSAGE,
  type PublishedEndpoint,
  type PublishedEndpointClient,
  type PublishedEndpointHostHttpRequest,
  type PublishedEndpointHostLoopbackRoute,
  type PublishedEndpointHostResponse,
  type PublishedEndpointHostWebSocketOpenRequest,
  type PublishedEndpointProtocol,
  type PublishedEndpointPublishRequest,
  type PublishedEndpointListener,
  type PublishedEndpointWebSocketMessage,
  type PublishedHttpResponse
} from './types';
import {
  injectPublishedEndpointDocumentAdapter,
  isPublishedEndpointDocumentRuntimeRequest,
  openPublishedEndpointDocumentCookie,
  openPublishedEndpointDocumentWebSocket,
  publishedEndpointDocumentRuntimeResponse
} from './document-adapter';
import {
  bindPublishedEndpointHost,
  connectPublishedEndpointServiceWorker,
  openPublishedEndpointOriginLink,
  type PublishedEndpointHostBindingOptions
} from './service-worker-host';
import {
  publishedEndpointOriginDocumentUrl,
  type PublishedEndpointLayout
} from './endpoint-layout';
import type { MessageStream } from '../worker-transport';

export interface PublishedEndpointHost {
  forOwner(ownerId: string): PublishedEndpointOwner;
  initialize(): Promise<void>;
  dispose(): Promise<void>;
}

export interface PublishedEndpointOwner {
  register(
    port: number,
    protocol: PublishedEndpointProtocol,
    server: PublishedEndpointListener
  ): void;
  /** Resolves once the endpoint is unpublished. */
  close(port: number): Promise<void>;
}

export type PublishedEndpointHostObserver = {
  readonly onPublished?: (port: number, url: string) => void;
  readonly onUnpublished?: (port: number, url: string) => void;
};

export function createPublishedEndpointHost(options: {
  readonly epochId: string;
  readonly endpoints: PublishedEndpointClient;
  readonly browserHost?: PublishedEndpointHostObserver;
  /** The embedding page's `Cross-Origin-Embedder-Policy`, served on endpoint documents too. */
  readonly embedderPolicy?: 'require-corp' | 'credentialless';
  /** Where this epoch's endpoints are served (ADR-0030, ADR-0044). */
  readonly layout: PublishedEndpointLayout;
  /** The Service Worker script on this origin, as the embedding page's build placed it (ADR-0033). */
  readonly serviceWorkerUrl: string;
  /**
   * The endpoint origin document on this origin; in the origin layout it is
   * loaded from each endpoint's own origin, at the same path (ADR-0044).
   */
  readonly endpointOriginDocumentUrl: string;
  /** The embedding page's origin: the one that frames the endpoint documents and requests them. */
  readonly hostOrigin: string;
  readonly onBackgroundFailure: (error: Error) => void;
}): PublishedEndpointHost {
  const servers = new Map<number, PublishedEndpointServerRecord>();
  const endpoints = new Map<number, PublishedEndpoint>();
  const documentCookieSessions = new Map<number, Set<DocumentCookieSession>>();
  /** Each published WebSocket's control stream, by the port that serves it. */
  const webSocketControls = new Map<number, Set<MessageStream>>();
  const cookieJar = createPublishedEndpointCookieJar();
  let disconnectHost: () => void = () => undefined;
  /** In the origin layout, the Service Worker of each port's origin is bound as the port publishes. */
  const originBindings = new Map<number, Promise<() => void>>();
  let publicationQueue = Promise.resolve();
  let disposed = false;

  const assertOpen = (): void => {
    if (disposed) throw new Error('Published Endpoint host is closed.');
  };
  const queuePublication = <Value>(operation: () => Promise<Value>): Promise<Value> => {
    const result = publicationQueue.then(operation);
    publicationQueue = result.then(
      () => undefined,
      (error: unknown) => {
        options.onBackgroundFailure(error instanceof Error ? error : new Error(String(error)));
      }
    );
    return result;
  };
  const closeDocumentCookieSessions = (port: number, reason: string): void => {
    const sessions = documentCookieSessions.get(port);
    if (!sessions) return;
    documentCookieSessions.delete(port);
    for (const session of sessions) {
      session.client.send({
        type: 'mimic:document-cookie-close',
        reason
      });
      session.client.close();
    }
  };
  const documentCookieSnapshot = (
    endpoint: PublishedEndpoint,
    path: string
  ): { readonly revision: number; readonly cookie: string } =>
    cookieJar.documentSnapshot({ endpoint, documentPath: path });
  const broadcastDocumentCookieSnapshots = (
    port: number,
    endpoint: PublishedEndpoint
  ): void => {
    for (const session of documentCookieSessions.get(port) ?? []) {
      session.client.send({
        type: 'mimic:document-cookie-snapshot',
        navigationId: session.navigationId,
        snapshot: documentCookieSnapshot(endpoint, session.path)
      });
    }
  };
  const selectRequestHeaders = (
    port: number,
    requestPath: string,
    headers: readonly PublishedEndpointCookieHeader[]
  ): [string, string][] => {
    const endpoint = endpoints.get(port);
    return mutableHeaders(
      endpoint
        ? cookieJar.selectRequestHeaders({ endpoint, requestPath, headers })
        : withoutHeader(headers, 'cookie')
    );
  };
  const storeResponseHeaders = (
    port: number,
    requestPath: string,
    headers: readonly PublishedEndpointCookieHeader[]
  ): [string, string][] => {
    const endpoint = endpoints.get(port);
    if (!endpoint) return mutableHeaders(withoutHeader(headers, 'set-cookie'));
    const stored = cookieJar.storeResponseCookies({ endpoint, requestPath, headers });
    broadcastDocumentCookieSnapshots(port, endpoint);
    return mutableHeaders(stored);
  };
  /**
   * Closes the sockets an endpoint serves when it goes. Their server's
   * connection drops without a close frame, which a browser reports as `1006`.
   */
  const closeWebSockets = (port: number): void => {
    const controls = webSocketControls.get(port);
    if (!controls) return;
    webSocketControls.delete(port);
    for (const control of controls) closeWebSocket(control, 1006, '');
  };
  const unpublishRecord = async (record: PublishedEndpointServerRecord): Promise<void> => {
    const endpoint = await record.publication;
    await options.endpoints.unpublish(record.request);
    options.browserHost?.onUnpublished?.(record.request.address.port, endpoint.url);
  };
  const register = (
    port: number,
    ownerId: string,
    protocol: PublishedEndpointProtocol,
    server: PublishedEndpointListener
  ): void => {
    assertOpen();
    const previous = servers.get(port);
    if (previous) {
      closeWebSockets(port);
      previous.server.close();
      endpoints.delete(port);
      closeDocumentCookieSessions(port, 'Published Endpoint was replaced.');
    }
    const request: PublishedEndpointPublishRequest = {
      ownerId,
      protocol,
      address: server.address
    };
    let record!: PublishedEndpointServerRecord;
    const publication = queuePublication(async () => {
      if (previous) await unpublishRecord(previous);
      if (options.browserHost && options.layout.kind === 'origin') await bindOrigin(port);
      const endpoint = await options.endpoints.publish(request);
      if (servers.get(port) === record) {
        endpoints.set(port, endpoint);
        options.browserHost?.onPublished?.(port, endpoint.url);
      }
      return endpoint;
    });
    record = { request, server, publication };
    servers.set(port, record);
  };
  const close = (port: number): Promise<void> => {
    assertOpen();
    const record = servers.get(port);
    closeWebSockets(port);
    if (!record) return Promise.resolve();
    servers.delete(port);
    endpoints.delete(port);
    closeDocumentCookieSessions(port, 'Published Endpoint is closed.');
    record.server.close();
    return queuePublication(() => unpublishRecord(record)).catch(() => undefined);
  };
  /**
   * The route that serves a loopback port, once the publications queued
   * before the request settle. The requesting document's logical origin is
   * what a browser would send as `Origin` (ADR-0037).
   */
  const resolveLoopbackRoute = async (request: {
    readonly protocol: PublishedEndpointProtocol;
    readonly port: number;
    readonly initiator?: { readonly routeId: string; readonly port: number };
  }): Promise<PublishedEndpointHostLoopbackRoute> => {
    assertOpen();
    await publicationQueue;
    const endpoint = endpoints.get(request.port);
    if (!endpoint || !servers.has(request.port) || endpoint.protocol !== request.protocol) return {};
    const initiator = request.initiator ? endpoints.get(request.initiator.port) : undefined;
    return {
      routeId: endpoint.routeId,
      ...(initiator && routeMatches(initiator.routeId, request.initiator?.routeId)
        ? { origin: `${initiator.protocol}://localhost:${initiator.address.port}` }
        : {})
    };
  };
  const handleHttp = async (
    request: PublishedEndpointHostHttpRequest
  ): Promise<PublishedEndpointHostResponse> => {
    assertOpen();
    await publicationQueue;
    const record = servers.get(request.port);
    if (!record) return missingEndpointResponse(request.port);
    // A browser sends and stores another origin's cookies only for `include`.
    const cookies = !request.loopback || request.loopback.credentials === 'include';
    const body =
      request.body instanceof ArrayBuffer ? new Blob([request.body]).stream() : request.body;
    let response: PublishedHttpResponse;
    try {
      response = await record.server.serveHttp(
        {
          method: request.method,
          url: request.path,
          headers: publishedRequestHeaders(
            request,
            cookies
              ? selectRequestHeaders(request.port, request.path, request.headers)
              : mutableHeaders(withoutHeader(request.headers, 'cookie'))
          ),
          body
        },
        { signal: request.signal }
      );
    } catch (reason) {
      return publishedHttpFidelityFailureResponse(
        'CONNECTION_FAILED',
        reason instanceof Error ? reason.message : String(reason)
      );
    }
    const unrepresentable = unrepresentableResponse(request.path, response);
    if (unrepresentable) {
      void response.body.cancel(unrepresentable.message).catch(() => undefined);
      return publishedHttpFidelityFailureResponse(unrepresentable.code, unrepresentable.message);
    }
    return {
      status: response.status,
      statusText: response.statusText,
      headers: cookies
        ? storeResponseHeaders(request.port, request.path, fetchResponseHeaders(response.headers))
        : mutableHeaders(withoutHeader(fetchResponseHeaders(response.headers), 'set-cookie')),
      body: new Uint8Array(),
      bodyStream: response.body
    };
  };
  /**
   * Hands the document a port on which the process worker that owns the
   * listener serves the socket (ADR-0038): this host selects the handshake's
   * cookies and stores the response's, and the socket's messages never pass
   * through it. The handshake's stream stays open as the socket's control
   * stream, on which this host closes the socket when its endpoint goes; the
   * document closes the stream when the socket closes.
   */
  const openWebSocket = async (
    request: PublishedEndpointHostWebSocketOpenRequest,
    control: MessageStream
  ): Promise<void> => {
    assertOpen();
    await publicationQueue;
    const record = servers.get(request.port);
    if (!record || endpoints.get(request.port)?.routeId !== request.routeId) {
      closeWebSocket(control, 1011, `No active Published Endpoint route is listening on port ${request.port}.`);
      return;
    }
    const channel = new MessageChannel();
    control.send(
      { type: PUBLISHED_ENDPOINT_WEBSOCKET_MESSAGE.connect, port: channel.port1 } satisfies PublishedEndpointWebSocketMessage,
      [channel.port1]
    );
    const head = await record.server.openWebSocket(
      {
        // A WebSocket opening handshake is a GET (RFC 6455 section 4.1).
        method: 'GET',
        url: request.path,
        headers: selectRequestHeaders(request.port, request.path, request.headers)
      },
      channel.port2,
      typeof request.documentLock === 'string' ? { documentLock: request.documentLock } : {}
    );
    if (!head) {
      // The listener's process is gone before the server answered.
      closeWebSocket(control, 1006, 'Published Endpoint server closed.');
      return;
    }
    storeResponseHeaders(request.port, request.path, head.headers);
    if (servers.get(request.port) !== record) {
      closeWebSocket(control, 1006, '');
      return;
    }
    const controls = webSocketControls.get(request.port) ?? new Set();
    controls.add(control);
    webSocketControls.set(request.port, controls);
    void control.closed.then(() => {
      controls.delete(control);
      if (controls.size === 0 && webSocketControls.get(request.port) === controls) {
        webSocketControls.delete(request.port);
      }
    });
  };
  const openDocumentCookie = (
    request: { readonly routeId: string; readonly port: number; readonly path: string },
    client: MessageStream
  ): void => {
    assertOpen();
    const endpoint = endpoints.get(request.port);
    if (!endpoint || endpoint.routeId !== request.routeId) {
      client.send({
        type: 'mimic:document-cookie-close',
        reason: 'Published Endpoint route is stale or unavailable.'
      });
      client.close();
      return;
    }
    const session: DocumentCookieSession = {
      routeId: request.routeId,
      navigationId: 0,
      path: request.path,
      client
    };
    const sessions = documentCookieSessions.get(request.port) ?? new Set();
    sessions.add(session);
    documentCookieSessions.set(request.port, sessions);
    client.subscribe((message: unknown) => {
      if (!isRecord(message) || endpoints.get(request.port)?.routeId !== session.routeId) {
        closeDocumentCookieSessions(request.port, 'Published Endpoint is closed.');
        return;
      }
      if (
        message.type === 'mimic:document-cookie-navigate' &&
        typeof message.navigationId === 'number' &&
        typeof message.path === 'string'
      ) {
        if (message.navigationId <= session.navigationId) return;
        session.navigationId = message.navigationId;
        session.path = message.path;
        client.send({
          type: 'mimic:document-cookie-snapshot',
          navigationId: session.navigationId,
          snapshot: documentCookieSnapshot(endpoint, session.path)
        });
        return;
      }
      if (
        message.type !== 'mimic:document-cookie-write' ||
        typeof message.id !== 'string' ||
        typeof message.baseRevision !== 'number' ||
        typeof message.navigationId !== 'number' ||
        typeof message.path !== 'string' ||
        typeof message.value !== 'string'
      ) {
        return;
      }
      if (message.navigationId !== session.navigationId || message.path !== session.path) {
        client.send({
          type: 'mimic:document-cookie-snapshot',
          mutationId: message.id,
          navigationId: session.navigationId,
          staleBase: true,
          snapshot: documentCookieSnapshot(endpoint, session.path)
        });
        return;
      }
      const result = cookieJar.writeDocumentCookie({
        endpoint,
        documentPath: message.path,
        baseRevision: message.baseRevision,
        value: message.value
      });
      for (const candidate of documentCookieSessions.get(request.port) ?? []) {
        candidate.client.send({
          type: 'mimic:document-cookie-snapshot',
          navigationId: candidate.navigationId,
          ...(candidate === session
            ? { mutationId: message.id, staleBase: result.staleBase }
            : {}),
          snapshot:
            candidate === session
              ? result.snapshot
              : documentCookieSnapshot(endpoint, candidate.path)
        });
      }
    });
    client.send({
      type: 'mimic:document-cookie-snapshot',
      navigationId: session.navigationId,
      snapshot: documentCookieSnapshot(endpoint, session.path)
    });
  };

  const openWebSocketOrClose = (
    request: PublishedEndpointHostWebSocketOpenRequest,
    control: MessageStream
  ): void => {
    void openWebSocket(request, control).catch(() =>
      closeWebSocket(control, 1011, 'Published Endpoint host is closed.')
    );
  };

  const bindingOptions: Omit<PublishedEndpointHostBindingOptions, 'link'> = {
    instanceId: options.epochId,
    embedderPolicy: options.embedderPolicy ?? 'require-corp',
    hostOrigin: options.hostOrigin,
    resolveLoopbackRoute,
    handleHttp: async (request) => {
      // A loopback request comes from another endpoint's document and is
      // never a document of its own: it gets no document adapter.
      if (request.loopback) return handleHttp(request);
      if (isPublishedEndpointDocumentRuntimeRequest(request)) {
        return publishedEndpointDocumentRuntimeResponse();
      }
      // An endpoint served from an origin of its own names its port only; the
      // route is the one serving the port now, as for a loopback request (ADR-0044).
      const manifest = options.endpoints.routeManifest;
      const route = manifest.routes.find(
        (candidate) =>
          candidate.address.port === request.port &&
          routeMatches(candidate.routeId, request.routeId)
      );
      if (!route) {
        return {
          status: 404,
          statusText: 'Not Found',
          headers: [['content-type', 'text/plain; charset=utf-8']],
          body: new TextEncoder().encode('Published Endpoint route is stale or unavailable.')
        };
      }
      const response = await handleHttp(request);
      const endpoint = endpoints.get(request.port);
      const snapshot =
        endpoint?.routeId === route.routeId
          ? documentCookieSnapshot(endpoint, request.path)
          : undefined;
      return injectPublishedEndpointDocumentAdapter(response, {
        manifest,
        cookie:
          route && snapshot
            ? {
                route: {
                  manifestVersion: manifest.version,
                  instanceId: manifest.epochId,
                  routeId: route.routeId,
                  port: route.address.port
                },
                publicUrl: route.url,
                logicalUrl: logicalEndpointUrl(route, request.path),
                snapshot
              }
            : undefined
      });
    },
    handleWebSocket: (request, peer) => {
      if (request.loopback) {
        // The document names only the port; the route is the one that
        // serves it now, and the network's when there is none.
        const protocol = new URL(request.url).protocol === 'wss:' ? 'https' : 'http';
        void resolveLoopbackRoute({ protocol, port: request.port }).then(
          (route) => {
            if (route.routeId) {
              openWebSocketOrClose({ ...request, routeId: route.routeId }, peer);
              return;
            }
            peer.send({
              type: PUBLISHED_ENDPOINT_WEBSOCKET_MESSAGE.unrouted
            } satisfies PublishedEndpointWebSocketMessage);
            peer.close();
          },
          () => closeWebSocket(peer, 1011, 'Published Endpoint host is closed.')
        );
        return;
      }
      openPublishedEndpointDocumentWebSocket(
        options.endpoints.routeManifest,
        request,
        peer,
        (routedRequest, routedPeer) => openWebSocketOrClose(routedRequest, routedPeer)
      );
    },
    handleDocumentCookie: (request, peer) => {
      openPublishedEndpointDocumentCookie(
        options.endpoints.routeManifest,
        request,
        peer,
        (routedRequest, client) => {
          openDocumentCookie({
            routeId: routedRequest.routeId,
            port: routedRequest.port,
            path: routedRequest.path
          }, client);
        }
      );
    }
  };
  const bind = (link: PublishedEndpointHostBindingOptions['link']): Promise<() => void> =>
    bindPublishedEndpointHost({ ...bindingOptions, link });
  /**
   * Binds the Service Worker of one port's origin, once per port: a port that
   * publishes again after its server restarted keeps its origin and its
   * worker, as a port on a developer machine keeps its address.
   */
  const bindOrigin = (port: number): Promise<() => void> => {
    if (options.layout.kind !== 'origin') return Promise.resolve(() => undefined);
    const layout = options.layout;
    let binding = originBindings.get(port);
    if (!binding) {
      binding = openPublishedEndpointOriginLink({
        documentUrl: publishedEndpointOriginDocumentUrl(layout, {
          epochId: options.epochId,
          port,
          documentUrl: options.endpointOriginDocumentUrl,
          hostOrigin: window.location.origin
        })
      }).then(bind);
      originBindings.set(port, binding);
      const opened = binding;
      binding.then(
        (disconnect) => {
          if (disposed) disconnect();
        },
        () => {
          if (originBindings.get(port) === opened) originBindings.delete(port);
        }
      );
    }
    return binding;
  };
  const disconnectOrigins = async (): Promise<void> => {
    const bindings = [...originBindings.values()];
    originBindings.clear();
    await Promise.all(bindings.map((binding) => binding.then((disconnect) => disconnect(), () => undefined)));
  };

  return {
    forOwner: (ownerId) => ({
      register: (port, protocol, server) =>
        register(port, ownerId, protocol, server),
      close
    }),
    async initialize() {
      if (!options.browserHost) return;
      // In the origin layout each port's worker is bound when the port publishes.
      if (options.layout.kind === 'origin') return;
      const disconnect = await bind(await connectPublishedEndpointServiceWorker(options.serviceWorkerUrl));
      if (disposed) {
        disconnect();
        throw new Error(
          'Runtime Host closed during Published Endpoint host binding.'
        );
      }
      disconnectHost = disconnect;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const port of [...webSocketControls.keys()]) closeWebSockets(port);
      for (const [port, record] of servers) {
        record.server.close();
        endpoints.delete(port);
        closeDocumentCookieSessions(port, 'Published Endpoint is closed.');
        void queuePublication(() => unpublishRecord(record)).catch(() => undefined);
      }
      servers.clear();
      cookieJar.dispose();
      try {
        await publicationQueue;
      } finally {
        disconnectHost();
        await disconnectOrigins();
      }
    }
  };
}

type PublishedEndpointServerRecord = {
  readonly request: PublishedEndpointPublishRequest;
  readonly server: PublishedEndpointListener;
  readonly publication: Promise<PublishedEndpoint>;
};

type DocumentCookieSession = {
  readonly routeId: string;
  navigationId: number;
  path: string;
  readonly client: MessageStream;
};

function logicalEndpointUrl(
  endpoint: {
    readonly protocol: PublishedEndpointProtocol;
    readonly address: { readonly host: string; readonly port: number };
  },
  path: string
): string {
  const host = endpoint.address.host.includes(':')
    ? `[${endpoint.address.host.replace(/^\[|\]$/gu, '')}]`
    : endpoint.address.host;
  return new URL(
    path,
    `${endpoint.protocol}://${host}:${endpoint.address.port}/`
  ).href;
}

/** Whether a request's route is `routeId`; a request that names no route means the current one. */
function routeMatches(routeId: string, requested: string | undefined): boolean {
  return requested === '' || requested === routeId;
}

function withoutHeader(
  headers: readonly PublishedEndpointCookieHeader[],
  excludedName: string
): PublishedEndpointCookieHeader[] {
  return headers.filter(([name]) => name.toLowerCase() !== excludedName);
}

function mutableHeaders(
  headers: readonly PublishedEndpointCookieHeader[]
): [string, string][] {
  return headers.map(([name, value]) => [name, value]);
}

// The headers a Published Endpoint adds to a request. Everything else reaches
// the endpoint's server exactly as the browser sent it, after the Cookie Jar
// selected its `cookie` header. Each compensates for something a Service
// Worker cannot observe:
//
// | Header              | Why the endpoint supplies it                          |
// | ------------------- | ----------------------------------------------------- |
// | `sec-fetch-dest`    | Browsers add it after the Service Worker, so it is    |
// |                     | rebuilt from `Request.destination` (`''` is `empty`). |
// |                     | Dev servers pick module transform or HTML from it.    |
// | `host`              | Never exposed to a Service Worker: the endpoint's     |
// |                     | loopback authority.                                   |
// | `content-length` /  | Never exposed to a Service Worker, yet they tell a    |
// | `transfer-encoding` | server that a body exists: its length when the body   |
// |                     | was buffered, `chunked` when it streams.              |
function publishedRequestHeaders(
  request: {
    readonly port: number;
    readonly method: string;
    readonly destination?: string;
    readonly body?: ArrayBuffer | ReadableStream<Uint8Array>;
  },
  headers: readonly PublishedEndpointCookieHeader[]
): [string, string][] {
  const ordinary: [string, string][] = [];
  let hasFetchDestination = false;
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (lower === 'host' || lower === 'content-length' || lower === 'transfer-encoding') continue;
    if (lower === 'sec-fetch-dest') hasFetchDestination = true;
    ordinary.push([name, value]);
  }
  if (!hasFetchDestination && request.destination !== undefined) {
    ordinary.push(['sec-fetch-dest', request.destination || 'empty']);
  }
  ordinary.push(['host', `localhost:${request.port}`]);
  if (request.body instanceof ReadableStream) ordinary.push(['transfer-encoding', 'chunked']);
  else if (request.body) ordinary.push(['content-length', String(request.body.byteLength)]);
  else if (request.method !== 'GET' && request.method !== 'HEAD') ordinary.push(['content-length', '0']);
  return ordinary;
}

// Fields that describe one connection rather than the message (RFC 9110
// section 7.6.1), or a coding the browser does not undo for a Service Worker
// response: a Fetch `Response` carries none of them.
const connectionResponseHeaders = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'transfer-encoding',
  'upgrade'
]);

function fetchResponseHeaders(
  headers: readonly PublishedEndpointCookieHeader[]
): PublishedEndpointCookieHeader[] {
  return headers.filter(([name]) => !connectionResponseHeaders.has(name.toLowerCase()));
}

type PublishedHttpFidelityFailureCode =
  | 'CONNECTION_FAILED'
  | 'UNREPRESENTABLE_INFORMATIONAL_RESPONSE'
  | 'UNREPRESENTABLE_TRAILERS';

function unrepresentableResponse(
  path: string,
  response: PublishedHttpResponse
): { readonly code: PublishedHttpFidelityFailureCode; readonly message: string } | undefined {
  if (response.status < 200 || response.informational.length > 0) {
    const statuses =
      response.status < 200 ? [...response.informational, response.status] : response.informational;
    return {
      code: 'UNREPRESENTABLE_INFORMATIONAL_RESPONSE',
      message: `The document Fetch boundary cannot represent HTTP informational responses (${statuses.join(', ')}) for ${path}.`
    };
  }
  if (response.headers.some(([name]) => name.toLowerCase() === 'trailer')) {
    return {
      code: 'UNREPRESENTABLE_TRAILERS',
      message: `The document Fetch boundary cannot represent HTTP response trailers for ${path}.`
    };
  }
  return undefined;
}

function closeWebSocket(
  client: MessageStream,
  code: number,
  reason: string
): void {
  client.send({
    type: PUBLISHED_ENDPOINT_WEBSOCKET_MESSAGE.close,
    code,
    reason
  } satisfies PublishedEndpointWebSocketMessage);
  client.close();
}

function missingEndpointResponse(port: number): PublishedEndpointHostResponse {
  return {
    status: 404,
    statusText: 'Not Found',
    headers: [['content-type', 'text/plain; charset=utf-8']],
    body: new TextEncoder().encode(`No Published Endpoint is listening on port ${port}.`)
  };
}

function publishedHttpFidelityFailureResponse(
  code: PublishedHttpFidelityFailureCode,
  message: string
): PublishedEndpointHostResponse {
  return {
    status: 502,
    statusText: 'Bad Gateway',
    headers: [
      ['content-type', 'text/plain; charset=utf-8'],
      ['x-mimic-fidelity-error', code]
    ],
    body: new TextEncoder().encode(message)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
