// The worker is registered for the `__mimic__/` directory beside
// its own script, so every URL it serves starts with that path: the page that
// registers it is not under its scope and keeps whatever controls it
// (ADR-0030). On an origin of its own (ADR-0044) it is registered for the root
// instead, and the origin's first hostname label, `<instance>--<port>`, names
// the one endpoint every request of the origin belongs to; the package's own
// documents there are the ones under the worker's directory.
const SCOPE_PATH = new URL(self.registration.scope).pathname;
const ORIGIN_LAYOUT = SCOPE_PATH === '/';
const WORKER_DIRECTORY = ORIGIN_LAYOUT ? new URL('./', self.location.href).pathname : undefined;
const ORIGIN_ENDPOINT = ORIGIN_LAYOUT ? originEndpoint(self.location.hostname) : undefined;
const ENDPOINT_PREFIX = ORIGIN_LAYOUT ? `${WORKER_DIRECTORY}__mimic__/` : SCOPE_PATH;
// PUBLISHED_ENDPOINT_SERVICE_WORKER_TOKEN is declared ahead of this program by
// scripts/published-endpoint-service-worker-asset.mjs from published-endpoint/service.ts.
const HOST_RESPONSE_TIMEOUT_MS = 35_000;
/** How often a request still waiting for its server checks that the host document is open. */
const HOST_LIVENESS_INTERVAL_MS = 10_000;
/**
 * The longest a request waits for its server while its host is open: under
 * the five minutes the browser allows one fetch event, past which it stops
 * the worker and with it every response and stream the worker is serving.
 */
const HOST_RESPONSE_LIMIT_MS = 270_000;
/** How long a request waits for its instance's host to connect again after this worker restarted. */
const HOST_RECONNECT_TIMEOUT_MS = 10_000;
/** Retired epochs answer 404 instead of asking the windows for their host; the oldest are forgotten first. */
const RETIRED_INSTANCE_LIMIT = 64;
const hostConnections = new Map();
/** The client id of each instance's host document, which a waiting request checks is still open. */
const hostClients = new Map();
/** Requests waiting for an instance's host to connect again, by instance. */
const hostWaiters = new Map();
/** Each instance's `Cross-Origin-Embedder-Policy`: the one its embedding page is served with. */
const embedderPolicies = new Map();
/**
 * Each instance's embedding page origin, which the Runtime Host document of
 * this origin names when it connects (ADR-0033). When it is another origin,
 * endpoint documents are served embeddable by it, and the scope document
 * answers `fetch` for it.
 */
const hostOrigins = new Map();
const retiredInstanceIds = new Set();
const endpointClients = new Map();
const routedUrls = new Map();
const EMBEDDER_POLICIES = ['require-corp', 'credentialless'];
/** The hosts by which a document names its own machine (ADR-0037). */
const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];
const ISOLATION_HEADERS = [
  ['cross-origin-embedder-policy', 'require-corp'],
  ['cross-origin-opener-policy', 'same-origin'],
  ['cross-origin-resource-policy', 'same-origin']
];

/** The `Cross-Origin-Resource-Policy` an embedding page may load an instance's documents under. */
function resourcePolicyFor(hostOrigin) {
  return hostOrigin && hostOrigin !== self.location.origin ? 'cross-origin' : 'same-origin';
}

/** The endpoint an origin's first hostname label names, or undefined when it names none. */
function originEndpoint(hostname) {
  const match = /^(.+)--(\d+)$/u.exec(hostname.split('.', 1)[0] ?? '');
  if (!match) return undefined;
  return { instanceId: match[1], port: Number(match[2]) };
}

/** This origin's endpoint for a URL on it; the route is left to the host: the one serving the port now. */
function originEndpointTarget(url) {
  return {
    instanceId: ORIGIN_ENDPOINT.instanceId,
    routeId: '',
    port: ORIGIN_ENDPOINT.port,
    path: `${url.pathname}${url.search}`
  };
}

/** The sibling origin of this one that serves another port of the same instance. */
function siblingEndpointOrigin(port) {
  const labels = self.location.hostname.split('.');
  labels[0] = `${ORIGIN_ENDPOINT.instanceId}--${port}`;
  return `${self.location.protocol}//${labels.join('.')}${self.location.port ? `:${self.location.port}` : ''}`;
}

/** Whether a window of this origin is one of the package's own, which may host an instance. */
function isHostWindowUrl(url) {
  const pathname = new URL(url).pathname;
  return ORIGIN_LAYOUT ? pathname.startsWith(WORKER_DIRECTORY) : !pathname.startsWith(ENDPOINT_PREFIX);
}

function isOrigin(value) {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (
    event.data?.type === 'published-endpoint:document-connect' &&
    event.ports[0]
  ) {
    // An endpoint document opens a connection to its host: the document's
    // own instance answers, over the host connection, with the port it sent.
    // Without a host the port is closed, so the document is refused, not left waiting.
    const target = endpointTargetFromClientUrl(
      typeof event.source?.url === 'string' ? event.source.url : undefined
    );
    const port = event.ports[0];
    event.waitUntil(
      (target ? hostConnectionFor(target.instanceId, AbortSignal.timeout(HOST_RECONNECT_TIMEOUT_MS)) : Promise.resolve(undefined))
        .then((hostConnection) => {
          if (hostConnection) hostConnection.notify.documentConnect(transfer(port, [port]));
          else connectRpc(port).close();
        })
    );
    return;
  }
  if (
    event.data?.type === 'published-endpoint:host-connect' &&
    event.ports[0]
  ) {
    // A host is the Runtime Host document of this origin, never a document
    // this worker serves: an endpoint document is application code. The host
    // names the embedding page's origin.
    if (typeof event.source?.url === 'string' && !isHostWindowUrl(event.source.url)) return;
    const hostOrigin = isOrigin(event.data.hostOrigin) ? event.data.hostOrigin : self.location.origin;
    const instanceId = event.data.instanceId;
    // A page may meet a Service Worker installed by another build.
    const tokenMatches =
      event.data.protocolToken === PUBLISHED_ENDPOINT_SERVICE_WORKER_TOKEN;
    const connection = connectRpc(event.ports[0], {
      disconnect(disconnectedInstanceId) {
        if (hostConnections.get(disconnectedInstanceId) === connection) {
          hostConnections.delete(disconnectedInstanceId);
          hostClients.delete(disconnectedInstanceId);
          embedderPolicies.delete(disconnectedInstanceId);
          hostOrigins.delete(disconnectedInstanceId);
        }
        retireInstance(disconnectedInstanceId);
        for (const [clientId, target] of endpointClients) {
          if (target.instanceId === disconnectedInstanceId) endpointClients.delete(clientId);
        }
        for (const [url, target] of routedUrls) {
          if (target.instanceId === disconnectedInstanceId) routedUrls.delete(url);
        }
      }
    });
    connection.notify.connected({
      phase: tokenMatches ? 'connected' : 'rejected',
      protocolToken: PUBLISHED_ENDPOINT_SERVICE_WORKER_TOKEN,
      instanceId
    });
    if (!tokenMatches) {
      connection.close();
      return;
    }
    hostConnections.set(instanceId, connection);
    if (typeof event.source?.id === 'string') hostClients.set(instanceId, event.source.id);
    else hostClients.delete(instanceId);
    void connection.closed.then(() => {
      if (hostConnections.get(instanceId) === connection) hostConnections.delete(instanceId);
    });
    hostOrigins.set(instanceId, hostOrigin);
    embedderPolicies.set(
      instanceId,
      EMBEDDER_POLICIES.includes(event.data.embedderPolicy)
        ? event.data.embedderPolicy
        : 'require-corp'
    );
    retiredInstanceIds.delete(instanceId);
    const waiter = hostWaiters.get(instanceId);
    hostWaiters.delete(instanceId);
    waiter?.resolve(connection);
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) {
    // A document's request to a loopback port its container publishes reaches
    // that endpoint, as on a developer machine (ADR-0037). Every other request
    // to another origin goes to the network, where the page's embedder policy
    // decides. A navigation is routed by the scope it lands in, not by this worker.
    const loopback = loopbackAddress(url);
    if (loopback && event.clientId && event.request.mode !== 'navigate') {
      event.respondWith(handleLoopbackFetch(event, url, loopback));
    }
    return;
  }
  if (url.pathname === ENDPOINT_PREFIX) {
    event.respondWith(scopeDocumentResponse());
    return;
  }
  if (ORIGIN_LAYOUT) {
    // The package's own documents on this origin, the endpoint origin
    // document above all, come from the network; everything else of the
    // origin, a subresource under the worker's directory included, is the
    // endpoint's, as the whole origin would be a server's own.
    if (event.request.mode === 'navigate' && url.pathname.startsWith(WORKER_DIRECTORY)) return;
    if (ORIGIN_ENDPOINT) event.respondWith(handleEndpointFetch(event, originEndpointTarget(url)));
    return;
  }
  const directTarget = endpointTargetFromUrl(url);
  const referrerTarget =
    endpointTargetFromRoutedReferrer(event.request.referrer, url) ??
    endpointTargetFromEndpointReferrer(event.request.referrer, url);
  if (
    event.request.mode === 'navigate' &&
    !directTarget &&
    !referrerTarget
  ) {
    releaseRoutes(event);
  }
  const clientTarget =
    event.request.mode === 'navigate'
      ? undefined
      : endpointTargetFromClient(event.clientId, url);
  const endpointTarget = directTarget ?? referrerTarget;
  if (
    !endpointTarget &&
    event.request.mode !== 'navigate' &&
    event.clientId
  ) {
    event.respondWith(handleClientAssociatedFetch(event, clientTarget));
    return;
  }
  if (!endpointTarget) return;
  associateClient(event, endpointTarget);
  rememberRoutedUrl(url, endpointTarget);
  event.respondWith(handleEndpointFetch(event, endpointTarget));
});

async function handleClientAssociatedFetch(event, rememberedTarget) {
  const client = event.clientId
    ? await self.clients.get(event.clientId)
    : undefined;
  const currentTarget = client
    ? endpointTargetFromClientUrl(client.url)
    : undefined;
  if (!currentTarget) {
    if (event.clientId) endpointClients.delete(event.clientId);
    return fetch(event.request);
  }
  const target =
    rememberedTarget && sameEndpointTarget(currentTarget, rememberedTarget)
      ? rememberedTarget
      : {
          instanceId: currentTarget.instanceId,
          routeId: currentTarget.routeId,
          port: currentTarget.port,
          navigationUrl: currentTarget.navigationUrl ?? client.url
        };
  if (event.clientId) {
    endpointClients.set(event.clientId, {
      instanceId: target.instanceId,
      routeId: target.routeId,
      port: target.port,
      navigationUrl: target.navigationUrl
    });
  }
  const url = new URL(event.request.url);
  const requestTarget = {
    ...target,
    path: `${url.pathname}${url.search}`
  };
  rememberRoutedUrl(url, requestTarget);
  return handleEndpointFetch(event, requestTarget);
}

function loopbackAddress(url) {
  if (!LOOPBACK_HOSTNAMES.includes(url.hostname)) return undefined;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  const protocol = url.protocol === 'https:' ? 'https' : 'http';
  return { protocol, port: url.port ? Number(url.port) : protocol === 'https' ? 443 : 80 };
}

/**
 * The host resolves the port when the request is made, since a server may
 * publish after the document loaded; a port it does not publish, or a client
 * that is no endpoint document, sends the request to the network unchanged.
 */
async function handleLoopbackFetch(event, url, loopback) {
  const client = await self.clients.get(event.clientId);
  const initiator =
    (client ? endpointTargetFromClientUrl(client.url) : undefined) ??
    endpointClients.get(event.clientId);
  if (!initiator?.instanceId || retiredInstanceIds.has(initiator.instanceId)) {
    return fetch(event.request);
  }
  const route = await resolveLoopbackRoute(
    {
      instanceId: initiator.instanceId,
      protocol: loopback.protocol,
      port: loopback.port,
      initiator: { routeId: initiator.routeId, port: initiator.port }
    },
    event.request.signal
  );
  if (!route?.routeId) return fetch(event.request);
  return handleEndpointFetch(event, {
    instanceId: initiator.instanceId,
    routeId: route.routeId,
    port: loopback.port,
    path: `${url.pathname}${url.search}`,
    loopback: { origin: route.origin }
  });
}

async function resolveLoopbackRoute(request, signal) {
  const resolve = (connection, callSignal) =>
    callUntilAborted(() => connection.remote.resolveLoopbackRoute(request), callSignal);
  const hostConnection = await hostConnectionFor(request.instanceId, signal);
  if (!hostConnection) return undefined;
  return resolve(
    hostConnection,
    AbortSignal.any([signal, AbortSignal.timeout(HOST_RESPONSE_TIMEOUT_MS)])
  );
}

function endpointTargetFromClientUrl(value) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return endpointTargetFromUrl(url) ?? routedUrls.get(cacheKey(url));
  } catch {
    return undefined;
  }
}

function sameEndpointTarget(left, right) {
  return left?.instanceId === right.instanceId &&
    left?.routeId === right.routeId &&
    left?.port === right.port;
}

function retireInstance(instanceId) {
  retiredInstanceIds.delete(instanceId);
  retiredInstanceIds.add(instanceId);
  for (const retired of retiredInstanceIds) {
    if (retiredInstanceIds.size <= RETIRED_INSTANCE_LIMIT) break;
    retiredInstanceIds.delete(retired);
  }
}

/**
 * The document at the scope itself: a page the Service Worker controls and
 * nothing else. `endpoints.fetch()` requests endpoints from a hidden frame of
 * it, since a request is routed by the document that makes it, and the
 * embedding page is outside the scope. An embedding page on another origin
 * cannot call the frame's `fetch`, so the document serves it over a
 * MessagePort to the host origins connected at the time it is served.
 */
function scopeDocumentResponse() {
  const connectedHostOrigins = [...new Set(hostOrigins.values())];
  const crossOrigin = connectedHostOrigins.some((origin) => origin !== self.location.origin);
  const program = `${WORKER_TRANSPORT_SOURCE}\n(${scopeDocumentProgram.toString()})(${JSON.stringify(connectedHostOrigins)});`;
  const headers = new Headers([
    ['content-type', 'text/html; charset=utf-8'],
    ['cache-control', 'no-store'],
    ...ISOLATION_HEADERS
  ]);
  headers.set('cross-origin-resource-policy', crossOrigin ? 'cross-origin' : 'same-origin');
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>Mimic endpoints</title>' +
      `<script>${program.replace(/<\/script/giu, '<\\/script')}</script>`,
    { status: 200, headers }
  );
}

/**
 * Runs inside the scope document, with the Worker Transport in scope. Serves
 * `PublishedEndpointScopeDocumentApi` (endpoint-fetch.ts) to the embedding
 * page: one browser `fetch` per request, from a document the worker controls.
 */
function scopeDocumentProgram(hostOrigins) {
  const streamsTransfer = (() => {
    try {
      const stream = new ReadableStream();
      structuredClone(stream, { transfer: [stream] });
      return true;
    } catch {
      return false;
    }
  })();
  addEventListener('message', (event) => {
    if (
      !hostOrigins.includes(event.origin) ||
      event.source !== window.parent ||
      event.data?.type !== 'published-endpoint:fetch-connect' ||
      !event.ports[0]
    ) {
      return;
    }
    const controllers = new Map();
    connectRpc(event.ports[0], {
      async fetch(request) {
        const controller = new AbortController();
        controllers.set(request.requestId, controller);
        try {
          const init = {
            method: request.method,
            headers: request.headers.map(([name, value]) => [name, value]),
            redirect: request.redirect,
            cache: request.cache,
            signal: controller.signal
          };
          if (request.body !== undefined) {
            init.body = request.body;
            if (request.body instanceof ReadableStream) init.duplex = 'half';
          }
          const response = await fetch(request.url, init);
          const body = response.body
            ? streamsTransfer
              ? response.body
              : await response.arrayBuffer()
            : null;
          const result = {
            status: response.status,
            statusText: response.statusText,
            headers: [...response.headers.entries()],
            url: response.url,
            redirected: response.redirected,
            body
          };
          if (body instanceof ReadableStream) transfer(result, [body]);
          return result;
        } finally {
          controllers.delete(request.requestId);
        }
      },
      abort(requestId) {
        controllers.get(requestId)?.abort();
      }
    });
  });
}

function releaseRoutes(event) {
  if (event.clientId) endpointClients.delete(event.clientId);
  if (event.resultingClientId) endpointClients.delete(event.resultingClientId);
  routedUrls.clear();
}

function endpointTargetFromUrl(url) {
  if (ORIGIN_LAYOUT) {
    // A document under the worker's directory is the package's, not the endpoint's.
    if (!ORIGIN_ENDPOINT || url.pathname.startsWith(WORKER_DIRECTORY)) return undefined;
    return originEndpointTarget(url);
  }
  if (!url.pathname.startsWith(ENDPOINT_PREFIX)) return undefined;
  const parts = url.pathname.slice(ENDPOINT_PREFIX.length).split('/');
  const instanceId = parts.shift();
  const routeId = decodeURIComponent(parts.shift() ?? '');
  const port = Number(parts.shift());
  return {
    instanceId,
    routeId,
    port,
    path: `/${parts.join('/')}${url.search}`
  };
}

function endpointTargetFromEndpointReferrer(referrer, url) {
  if (!referrer) return undefined;
  try {
    const referrerUrl = new URL(referrer);
    if (referrerUrl.origin !== url.origin) return undefined;
    const target = endpointTargetFromUrl(referrerUrl);
    if (!target) return undefined;
    return {
      instanceId: target.instanceId,
      routeId: target.routeId,
      port: target.port,
      path: `${url.pathname}${url.search}`,
      navigationUrl: referrerUrl.href
    };
  } catch {
    return undefined;
  }
}

function endpointTargetFromRoutedReferrer(referrer, url) {
  if (!referrer) return undefined;
  try {
    const referrerUrl = new URL(referrer);
    if (referrerUrl.origin !== url.origin) return undefined;
    const target = routedUrls.get(cacheKey(referrerUrl));
    if (!target) return undefined;
    return {
      instanceId: target.instanceId,
      routeId: target.routeId,
      port: target.port,
      path: `${url.pathname}${url.search}`,
      navigationUrl: target.navigationUrl
    };
  } catch {
    return undefined;
  }
}

function endpointTargetFromClient(clientId, url) {
  if (!clientId) return undefined;
  const target = endpointClients.get(clientId);
  if (!target) return undefined;
  return {
    instanceId: target.instanceId,
    routeId: target.routeId,
    port: target.port,
    path: `${url.pathname}${url.search}`,
    navigationUrl: target.navigationUrl
  };
}

function associateClient(event, target) {
  const clientId =
    event.resultingClientId ||
    (event.request.mode === 'navigate' ? undefined : event.clientId);
  if (!clientId) return;
  target.navigationUrl ||= event.request.url;
  endpointClients.set(clientId, {
    instanceId: target.instanceId,
    routeId: target.routeId,
    port: target.port,
    navigationUrl: event.request.url
  });
}

function rememberRoutedUrl(url, target) {
  routedUrls.set(cacheKey(url), {
    instanceId: target.instanceId,
    routeId: target.routeId,
    port: target.port,
    navigationUrl: target.navigationUrl
  });
}

function cacheKey(url) {
  return `${url.origin}${url.pathname}${url.search}`;
}

async function handleEndpointFetch(event, target) {
  const request = event.request;
  const { instanceId, routeId, port, path } = target;
  if (!instanceId || typeof routeId !== 'string' || !Number.isFinite(port)) {
    return new Response('Malformed Published Endpoint URL.', { status: 400 });
  }
  if (retiredInstanceIds.has(instanceId)) {
    return new Response('Published Endpoint route is stale or unavailable.', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' }
    });
  }
  const hostConnection = await hostConnectionFor(instanceId, request.signal);
  const body =
    request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : await requestBody(request);
  const requestHeaders = [...request.headers.entries()];
  // The browser adds `Origin` after this worker; a loopback request is
  // cross-origin, so the server sees the requesting document's origin.
  if (target.loopback?.origin && !request.headers.has('origin')) {
    requestHeaders.push(['origin', target.loopback.origin]);
  }
  const message = {
    requestId: crypto.randomUUID(),
    instanceId,
    routeId,
    port,
    path,
    method: request.method,
    url: request.url,
    destination: request.destination,
    headers: requestHeaders,
    body,
    ...(target.loopback ? { loopback: { credentials: request.credentials } } : {})
  };
  const response = hostConnection
    ? await requestHost(hostConnection, message, request.signal)
    : undefined;
  if (!response) {
    return new Response('Published Endpoint host page did not answer the request.', {
      status: 504,
      headers: { 'content-type': 'text/plain; charset=utf-8' }
    });
  }
  const headers = publishedResponseHeaders(response.headers, target);
  const noBody =
    request.method === 'HEAD' ||
    response.status === 204 ||
    response.status === 205 ||
    response.status === 304;
  if (noBody && response.body instanceof ReadableStream) {
    void response.body.cancel().catch(() => undefined);
  }
  return new Response(noBody ? null : copyResponseBody(response.body), {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function copyResponseBody(body) {
  if (!body) return undefined;
  if (body instanceof ArrayBuffer) return body.slice(0);
  if (ArrayBuffer.isView(body)) {
    return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
  }
  return body;
}

// The host page delivers the response's own headers; the Service Worker adds
// only what its origin needs: a routed Location and cross-origin isolation.
// A loopback response keeps its loopback Location, which the browser resolves
// against the loopback URL, and is cross-origin to the document that loads it.
function publishedResponseHeaders(headers, target) {
  const published = new Headers(headers ?? []);
  if (!target.loopback) rewritePublishedRedirectLocation(published, target);
  for (const [name, value] of ISOLATION_HEADERS) published.set(name, value);
  published.set(
    'cross-origin-embedder-policy',
    embedderPolicies.get(target.instanceId) ?? 'require-corp'
  );
  published.set(
    'cross-origin-resource-policy',
    target.loopback ? 'cross-origin' : resourcePolicyFor(hostOrigins.get(target.instanceId))
  );
  return published;
}

function rewritePublishedRedirectLocation(headers, target) {
  const location = headers.get('location');
  if (!location) return;
  let resolved;
  try {
    resolved = new URL(
      location,
      `http://localhost:${target.port}${target.path || '/'}`
    );
  } catch {
    return;
  }
  const relative =
    !location.startsWith('//') && !/^[a-z][a-z0-9+.-]*:/i.test(location);
  const sameVirtualEndpoint =
    resolved.port === String(target.port) &&
    ['localhost', '127.0.0.1', '0.0.0.0'].includes(resolved.hostname);
  const loopback = !relative && ['localhost', '127.0.0.1', '0.0.0.0'].includes(resolved.hostname);
  if (ORIGIN_LAYOUT) {
    // The endpoint is the root of this origin; another loopback port of the
    // instance is the root of its sibling origin.
    if (!relative && !loopback) return;
    const port = resolved.port || (resolved.protocol === 'https:' ? '443' : '80');
    const origin = relative || port === String(target.port) ? '' : siblingEndpointOrigin(port);
    headers.set('location', `${origin}${resolved.pathname}${resolved.search}${resolved.hash}`);
    return;
  }
  if (!relative && !sameVirtualEndpoint) return;
  headers.set(
    'location',
    `${ENDPOINT_PREFIX}${target.instanceId}/${encodeURIComponent(target.routeId)}/${target.port}${resolved.pathname}${resolved.search}${resolved.hash}`
  );
}

/**
 * A form's body is read whole: Chromium errors the stream of a body that holds
 * a file part partway through, and a form is never an incremental upload. Any
 * other body stays a stream, so a `duplex: 'half'` request arrives as it is sent.
 */
function requestBody(request) {
  const contentType = request.headers.get('content-type') ?? '';
  if (/^multipart\/form-data\b/i.test(contentType)) return request.arrayBuffer();
  return request.body;
}

function requestHost(connection, message, signal) {
  if (
    typeof ReadableStream !== 'undefined' &&
    message.body instanceof ReadableStream
  ) {
    transfer(message, [message.body]);
  }
  const answered = new AbortController();
  return requestUntilAborted(
    connection,
    message,
    AbortSignal.any([signal, hostLost(message.instanceId, answered.signal)])
  ).finally(() => answered.abort());
}

/**
 * Aborts once the instance's host document is gone, or once the request has
 * waited as long as one fetch event may. A server answers when it is ready
 * (a webpack dev server holds a request until its first build ends), so a
 * request waits for as long as the host serving it is open, as a browser
 * waits for a server, but not past the browser's limit: a fetch event still
 * pending then stops the worker, and every other response it is serving with
 * it (a navigation the page abandoned held Nuxt's progress stream and its
 * reload hostage). Until `answered` aborts, the host is looked for among the
 * windows every few seconds. A host whose client is unknown has the response
 * deadline instead.
 */
function hostLost(instanceId, answered) {
  const clientId = hostClients.get(instanceId);
  if (!clientId) return AbortSignal.timeout(HOST_RESPONSE_TIMEOUT_MS);
  const lost = new AbortController();
  const timer = setInterval(() => {
    void self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      if (!clients.some((client) => client.id === clientId)) lost.abort();
    }, () => undefined);
  }, HOST_LIVENESS_INTERVAL_MS);
  const stop = () => clearInterval(timer);
  answered.addEventListener('abort', stop, { once: true });
  lost.signal.addEventListener('abort', stop, { once: true });
  return AbortSignal.any([lost.signal, AbortSignal.timeout(HOST_RESPONSE_LIMIT_MS)]);
}

// An aborted or timed-out request releases the host's exchange explicitly.
function requestUntilAborted(connection, message, signal) {
  return callUntilAborted(() => connection.remote.http(message), signal, () =>
    connection.notify.cancelHttp(message.requestId)
  );
}

/** A host call's result, or `undefined` once it fails or `signal` aborts. */
function callUntilAborted(call, signal, onAbort) {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const abort = () => {
      onAbort?.();
      resolve(undefined);
    };
    signal.addEventListener('abort', abort, { once: true });
    call().then(
      (result) => {
        signal.removeEventListener('abort', abort);
        resolve(result);
      },
      () => {
        signal.removeEventListener('abort', abort);
        resolve(undefined);
      }
    );
  });
}

/**
 * The instance's host connection. The browser stops an idle worker and its
 * connections with it, so a worker without one asks the windows outside its
 * scope, where the Runtime Host documents are, for the instance's host, which
 * connects again (ADR-0038). Resolves `undefined` for a retired instance, or
 * once `signal` aborts or the host does not connect in time.
 */
function hostConnectionFor(instanceId, signal) {
  const current = hostConnections.get(instanceId);
  if (current) return Promise.resolve(current);
  if (!instanceId || retiredInstanceIds.has(instanceId)) return Promise.resolve(undefined);
  let waiter = hostWaiters.get(instanceId);
  if (!waiter) {
    let resolve;
    const connected = new Promise((resolveConnection) => {
      resolve = resolveConnection;
    });
    waiter = { connected, resolve };
    hostWaiters.set(instanceId, waiter);
    const current = waiter;
    setTimeout(() => {
      if (hostWaiters.get(instanceId) !== current) return;
      hostWaiters.delete(instanceId);
      current.resolve(undefined);
    }, HOST_RECONNECT_TIMEOUT_MS);
    void self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (!isHostWindowUrl(client.url)) continue;
        client.postMessage({ type: 'published-endpoint:host-lost', instanceId });
      }
    });
  }
  const connected = waiter.connected;
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(undefined);
      return;
    }
    const abort = () => resolve(undefined);
    signal.addEventListener('abort', abort, { once: true });
    connected.then((connection) => {
      signal.removeEventListener('abort', abort);
      resolve(connection);
    });
  });
}
