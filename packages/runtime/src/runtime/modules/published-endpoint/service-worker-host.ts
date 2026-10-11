import {
  PUBLISHED_ENDPOINT_WEBSOCKET_MESSAGE,
  type PublishedEndpointDocumentCookieOpenRequest,
  type PublishedEndpointHostHttpRequest,
  type PublishedEndpointHostHttpResponseMessage,
  type PublishedEndpointHostLoopbackRoute,
  type PublishedEndpointHostLoopbackRouteRequest,
  type PublishedEndpointHostResponse,
  type PublishedEndpointHostWebSocketOpenRequest
} from './types';
import { PUBLISHED_ENDPOINT_SERVICE_WORKER_TOKEN } from './service';
import { publishedEndpointScopeUrlBeside } from './endpoint-layout';
import {
  connectRpc,
  openMessageStream,
  transfer,
  type MessageStream,
  type RpcConnection
} from '../worker-transport';

export type PublishedEndpointHostBindingOptions = {
  readonly instanceId: string;
  /** Served as `Cross-Origin-Embedder-Policy` on this instance's endpoint responses. */
  readonly embedderPolicy: 'require-corp' | 'credentialless';
  /** How this host reaches the Service Worker; the binding owns it and disposes it with the connection. */
  readonly link: PublishedEndpointServiceWorkerLink;
  /**
   * The embedding page's origin. The worker serves this instance's documents
   * embeddable by it, and the scope document answers `fetch` for it; the host
   * itself is this document, on the origin that serves the endpoints.
   */
  readonly hostOrigin: string;
  readonly handleHttp: (
    request: PublishedEndpointHostHttpRequest
  ) => Promise<PublishedEndpointHostResponse>;
  readonly resolveLoopbackRoute: (
    request: PublishedEndpointHostLoopbackRouteRequest
  ) => Promise<PublishedEndpointHostLoopbackRoute>;
  readonly handleWebSocket: (
    request: PublishedEndpointHostWebSocketOpenRequest,
    client: MessageStream
  ) => void;
  readonly handleDocumentCookie: (
    request: PublishedEndpointDocumentCookieOpenRequest,
    client: MessageStream
  ) => void;
};

/**
 * What the host document serves to the Service Worker. The Service Worker is
 * a separately installed artifact, so its protocol token is still negotiated.
 */
interface PublishedEndpointHostPageApi {
  connected(diagnostic: {
    readonly instanceId: string;
    readonly phase: 'connected' | 'rejected';
    readonly protocolToken: string;
  }): void;
  http(request: PublishedEndpointHostHttpRequest): Promise<PublishedEndpointHostHttpResponseMessage>;
  cancelHttp(requestId: string): void;
  /** The route that serves a loopback port a document requested, at the time it requests it. */
  resolveLoopbackRoute(
    request: PublishedEndpointHostLoopbackRouteRequest
  ): Promise<PublishedEndpointHostLoopbackRoute>;
  /**
   * An endpoint document opened a connection to its host: the document posted
   * the port to the Service Worker that serves it, which forwards it here.
   */
  documentConnect(port: MessagePort): void;
}

/** What the Service Worker serves to the host document. */
interface PublishedEndpointServiceWorkerApi {
  disconnect(instanceId: string): void;
}

type PublishedEndpointServiceWorkerPost = (
  message: Record<string, unknown>,
  transfer: Transferable[]
) => void;

/**
 * How the host document reaches the Service Worker that routes an instance's
 * endpoints: the worker of its own origin directly, or, for an endpoint
 * served from an origin of its own (ADR-0044), through the endpoint origin
 * document it opens in a hidden frame there.
 */
export interface PublishedEndpointServiceWorkerLink {
  /** Posts to the worker; `host-connect` carries the host's end of a channel. */
  readonly post: PublishedEndpointServiceWorkerPost;
  /** Messages the worker posts back to the host, with where to answer them. */
  subscribe(
    listener: (message: unknown, source: PublishedEndpointServiceWorkerPost) => void
  ): () => void;
  dispose(): void;
}

/** The Service Worker of this document's origin, registered beside its script (ADR-0030). */
export async function connectPublishedEndpointServiceWorker(
  serviceWorkerUrl: string
): Promise<PublishedEndpointServiceWorkerLink> {
  const worker = await ensurePublishedEndpointServiceWorker(serviceWorkerUrl);
  return {
    post: (message, transfer) => worker.postMessage(message, transfer),
    subscribe(listener) {
      // The worker that asks may be a newer version than the one bound: answer the one asking.
      const onMessage = (event: MessageEvent<unknown>): void => {
        const source = event.source;
        if (!(source instanceof ServiceWorker)) return;
        listener(event.data, (message, transfer) => source.postMessage(message, transfer));
      };
      navigator.serviceWorker.addEventListener('message', onMessage);
      return () => navigator.serviceWorker.removeEventListener('message', onMessage);
    },
    dispose() {}
  };
}

const ENDPOINT_ORIGIN_DOCUMENT_TIMEOUT_MS = 30_000;

/**
 * The Service Worker of one endpoint's own origin (ADR-0044), reached through
 * the endpoint origin document (`published-endpoint-origin.html`) opened in a
 * hidden frame of that origin: a document of another origin can neither
 * register a worker there nor post to it. The document registers the worker
 * for the origin's root, forwards `host-connect` to it, and relays the
 * worker's `host-lost` back here.
 */
export function openPublishedEndpointOriginLink(options: {
  /** The endpoint origin document, with its `host` and `worker` query parameters. */
  readonly documentUrl: string;
}): Promise<PublishedEndpointServiceWorkerLink> {
  const origin = new URL(options.documentUrl).origin;
  return new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe');
    iframe.hidden = true;
    iframe.setAttribute('aria-hidden', 'true');
    iframe.title = `Mimic endpoint origin ${origin}`;
    const listeners = new Set<(message: unknown, source: PublishedEndpointServiceWorkerPost) => void>();
    const post: PublishedEndpointServiceWorkerPost = (message, transfer) => {
      const content = iframe.contentWindow;
      if (!content) throw new Error(`The endpoint origin document of ${origin} is closed.`);
      content.postMessage(message, origin, transfer);
    };
    let ready = false;
    const dispose = (): void => {
      window.removeEventListener('message', onMessage);
      listeners.clear();
      iframe.remove();
    };
    const fail = (message: string): void => {
      window.clearTimeout(timeout);
      dispose();
      reject(new Error(message));
    };
    const timeout = window.setTimeout(() => {
      fail(
        `The origin ${origin} did not answer: it must serve this package's assets at ${new URL(options.documentUrl).pathname} ` +
          'with Cross-Origin-Embedder-Policy, Cross-Origin-Resource-Policy: cross-origin and Service-Worker-Allowed: / headers (see the README).'
      );
    }, ENDPOINT_ORIGIN_DOCUMENT_TIMEOUT_MS);
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (event.origin !== origin || event.source !== iframe.contentWindow) return;
      const data = event.data;
      if (!isRecord(data)) return;
      if (ready) {
        for (const listener of listeners) listener(data, post);
        return;
      }
      if (data.type === 'published-endpoint:origin-ready') {
        ready = true;
        window.clearTimeout(timeout);
        resolve({
          post,
          subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          dispose
        });
        return;
      }
      if (data.type === 'published-endpoint:origin-failed') {
        fail(`The endpoint origin document of ${origin} failed: ${String(data.message)}`);
      }
    };
    window.addEventListener('message', onMessage);
    iframe.src = options.documentUrl;
    (document.body ?? document.documentElement).append(iframe);
  });
}

export async function bindPublishedEndpointHost(
  options: PublishedEndpointHostBindingOptions
): Promise<() => void> {
  const link = options.link;
  let resolveConnection: () => void = () => undefined;
  let rejectConnection: (reason: Error) => void = () => undefined;
  const connectionAcknowledged = new Promise<void>((resolve, reject) => {
    resolveConnection = resolve;
    rejectConnection = reject;
  });
  void connectionAcknowledged.catch(() => undefined);
  const connectionTimeout = window.setTimeout(
    () => {
      rejectConnection(
        new Error('Service Worker did not acknowledge the Published Endpoint host.')
      );
    },
    10_000
  );
  const httpCancellations = new Map<string, AbortController>();
  // Documents served from a Published Endpoint are application code: only the
  // connection shape and the instance they name are trusted here. The first
  // message names what the connection is for; any other closes it, so the
  // document learns it was refused.
  const acceptDocumentConnection = (port: MessagePort): void => {
    const client = openMessageStream(port);
    const unsubscribe = client.subscribe((message) => {
      unsubscribe();
      if (isRecord(message) && message.instanceId === options.instanceId) {
        if (message.type === PUBLISHED_ENDPOINT_WEBSOCKET_MESSAGE.open) {
          options.handleWebSocket(message as PublishedEndpointHostWebSocketOpenRequest, client);
          return;
        }
        if (message.type === 'mimic:document-cookie-open') {
          options.handleDocumentCookie(
            message as PublishedEndpointDocumentCookieOpenRequest,
            client
          );
          return;
        }
      }
      client.close();
    });
  };
  const pageApi: PublishedEndpointHostPageApi = {
    connected(diagnostic) {
      if (diagnostic.instanceId !== options.instanceId) return;
      window.clearTimeout(connectionTimeout);
      if (
        diagnostic.phase === 'connected' &&
        diagnostic.protocolToken === PUBLISHED_ENDPOINT_SERVICE_WORKER_TOKEN
      ) {
        resolveConnection();
        return;
      }
      rejectConnection(
        new Error(
          `Published Endpoint host negotiation failed: protocol token ${diagnostic.protocolToken}/${PUBLISHED_ENDPOINT_SERVICE_WORKER_TOKEN}.`
        )
      );
    },
    async http(request) {
      if (request.instanceId !== options.instanceId) {
        throw new Error('The Published Endpoint request belongs to another runtime instance.');
      }
      const cancellation = new AbortController();
      httpCancellations.set(request.requestId, cancellation);
      try {
        const response = await options.handleHttp({ ...request, signal: cancellation.signal });
        const body = response.bodyStream ?? toArrayBuffer(response.body);
        return transfer(
          {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
            body
          },
          [body]
        );
      } catch (error: unknown) {
        const body = toArrayBuffer(
          new TextEncoder().encode(
            error instanceof Error ? error.stack ?? error.message : String(error)
          )
        );
        return transfer(
          {
            status: 500,
            headers: [['content-type', 'text/plain; charset=utf-8']],
            body
          },
          [body]
        );
      } finally {
        httpCancellations.delete(request.requestId);
      }
    },
    cancelHttp(requestId) {
      httpCancellations.get(requestId)?.abort();
    },
    resolveLoopbackRoute(request) {
      // As for `http`: another instance's host does not answer.
      if (request.instanceId !== options.instanceId) {
        throw new Error('The loopback request belongs to another runtime instance.');
      }
      return options.resolveLoopbackRoute(request);
    },
    documentConnect(port) {
      if (port instanceof MessagePort) acceptDocumentConnection(port);
    }
  };
  // The browser stops an idle Service Worker, and with it the worker's host
  // connections. A worker that needs this instance's host again asks the
  // windows for it, and this host connects again (ADR-0038).
  let hostConnection: RpcConnection<PublishedEndpointServiceWorkerApi> | undefined;
  const connectHost = (target: PublishedEndpointServiceWorkerPost): void => {
    const channel = new MessageChannel();
    const previous = hostConnection;
    hostConnection = connectRpc<PublishedEndpointServiceWorkerApi>(channel.port1, pageApi);
    previous?.close();
    target(
      {
        type: 'published-endpoint:host-connect',
        instanceId: options.instanceId,
        protocolToken: PUBLISHED_ENDPOINT_SERVICE_WORKER_TOKEN,
        embedderPolicy: options.embedderPolicy,
        hostOrigin: options.hostOrigin
      },
      [channel.port2]
    );
  };
  const unsubscribe = link.subscribe((message, source) => {
    if (
      !isRecord(message) ||
      message.type !== 'published-endpoint:host-lost' ||
      message.instanceId !== options.instanceId
    ) {
      return;
    }
    connectHost(source);
  });
  try {
    connectHost(link.post);
  } catch (error) {
    window.clearTimeout(connectionTimeout);
    unsubscribe();
    hostConnection?.close();
    link.dispose();
    throw error;
  }

  let isDisconnected = false;
  const disconnect = (): void => {
    if (isDisconnected) return;
    isDisconnected = true;
    window.clearTimeout(connectionTimeout);
    unsubscribe();
    hostConnection?.notify.disconnect(options.instanceId);
    hostConnection?.close();
    link.dispose();
  };
  try {
    await connectionAcknowledged;
  } catch (error) {
    disconnect();
    throw error;
  }
  return disconnect;
}

export async function ensurePublishedEndpointServiceWorker(serviceWorkerUrl: string): Promise<ServiceWorker> {
  if (!('serviceWorker' in navigator)) {
    throw new Error('Service Workers are required for Published Endpoint routing.');
  }
  const registration = await navigator.serviceWorker.register(
    serviceWorkerUrl,
    { scope: publishedEndpointScopeUrlBeside(serviceWorkerUrl), updateViaCache: 'none' }
  );
  await registration.update();
  if (registration.installing) await activatePendingWorker(registration.installing);
  if (registration.waiting) await activatePendingWorker(registration.waiting);
  // The host document is outside the scope, so `navigator.serviceWorker.ready`
  // and `controller` say nothing about this registration: its own worker does.
  const activeWorker = registration.active;
  if (!activeWorker) {
    throw new Error('Published Endpoint Service Worker registration has no active worker.');
  }
  await waitForWorkerState(activeWorker, ['activated']);
  return activeWorker;
}

function activatePendingWorker(worker: ServiceWorker): Promise<void> {
  return (async () => {
    await waitForWorkerState(worker, ['installed', 'activated']);
    if (worker.state === 'activated') return;
    worker.postMessage({ type: 'SKIP_WAITING' });
    await waitForWorkerState(worker, ['activated']);
  })();
}

function waitForWorkerState(
  worker: ServiceWorker,
  acceptedStates: readonly ServiceWorkerState[]
): Promise<void> {
  if (acceptedStates.includes(worker.state)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      window.clearTimeout(timeout);
      worker.removeEventListener('statechange', onStateChange);
    };
    const onStateChange = (): void => {
      if (worker.state === 'redundant') {
        finish();
        reject(
          new Error('Published Endpoint Service Worker became redundant before activation.')
        );
        return;
      }
      if (!acceptedStates.includes(worker.state)) return;
      finish();
      resolve();
    };
    const timeout = window.setTimeout(() => {
      finish();
      reject(new Error('Published Endpoint Service Worker activation timed out.'));
    }, 10_000);
    worker.addEventListener('statechange', onStateChange);
    onStateChange();
  });
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
