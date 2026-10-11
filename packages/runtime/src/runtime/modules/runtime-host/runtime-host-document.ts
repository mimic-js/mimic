import { connectRpc, type RpcConnection } from '../worker-transport';
import {
  createPublishedEndpointHost,
  projectPublishedEndpoints,
  publishedEndpointLayout,
  publishedEndpointUrl,
  type PublishedEndpointHost
} from '../published-endpoint';
import { connectPublishedListener, type PublishedListenerConnection } from './published-listener';
import { declareRuntimeAssets, type RuntimeAssetManifest } from './runtime-assets';
import {
  RUNTIME_HOST_CONNECT_MESSAGE,
  type RuntimeHostConnectMessage,
  type RuntimeHostDocumentApi,
  type RuntimeHostDocumentWorkerApi
} from './runtime-host-protocol';

export interface RuntimeHostDocument {
  /** The document is unloading: ends the worker and tells it why. */
  dispose(): void;
}

/**
 * The composition of the Runtime Host document (ADR-0033): it creates the
 * Runtime Host worker, hands it the embedding page's port, and runs the
 * Published Endpoint host beside the Service Worker of this origin, with the
 * listener ports the worker publishes. The worker owns the epoch; this
 * document ends with it.
 */
export async function startRuntimeHostDocument(options: {
  readonly assets: RuntimeAssetManifest;
  readonly epochId: string;
  readonly embedderPolicy: 'require-corp' | 'credentialless';
  /** The preview origin as the facade normalized it, which decides the endpoints' layout (ADR-0044). */
  readonly previewOrigin: string | undefined;
  /** The embedding page's origin. */
  readonly hostOrigin: string;
  /** The page's end of the Runtime Host connection, transferred into the worker. */
  readonly page: MessagePort;
}): Promise<RuntimeHostDocument> {
  declareRuntimeAssets(options.assets);
  const worker = new Worker(options.assets['runtime-host-worker.js'], {
    type: 'module',
    name: 'mimic-runtime-host'
  });
  let disposed = false;
  const listeners = new Map<string, PublishedListenerConnection>();
  let endpointHost: PublishedEndpointHost | undefined;
  let connection: RpcConnection<RuntimeHostDocumentWorkerApi> | undefined;
  let rejectStart!: (error: Error) => void;
  const startFailure = new Promise<never>((_resolve, reject) => {
    rejectStart = reject;
  });
  void startFailure.catch(() => undefined);

  type DisposeReason = 'unloaded' | 'terminated' | 'connection-closed' | 'worker-error' | 'start-failed';
  const dispose = (reason: DisposeReason): void => {
    if (disposed) return;
    disposed = true;
    for (const listener of listeners.values()) listener.abort();
    listeners.clear();
    const host = endpointHost;
    endpointHost = undefined;
    void host?.dispose().catch(() => undefined);
    // An unload with the epoch active is the page removing this frame: the
    // worker names that as the epoch's failure before the connection closes.
    if (reason === 'unloaded') connection?.notify.runtimeHost.documentUnloaded();
    connection?.close();
    worker.terminate();
  };

  worker.addEventListener('error', (event) => {
    event.preventDefault();
    const detail =
      event.error instanceof Error ? event.error.message : event.message || 'unknown worker error';
    rejectStart(new Error(`The Runtime Host worker failed terminally: ${detail}`));
    dispose('worker-error');
  });

  const connect: RuntimeHostConnectMessage = {
    type: RUNTIME_HOST_CONNECT_MESSAGE,
    assets: options.assets
  };
  worker.postMessage(connect, [options.page]);

  const local: Partial<RuntimeHostDocumentApi> = {};
  const opened = connectRpc<RuntimeHostDocumentWorkerApi>(worker, local);
  connection = opened;
  const layout = publishedEndpointLayout({
    previewOrigin: options.previewOrigin,
    serviceWorkerUrl: options.assets['service-worker.js']
  });
  const endpoints = projectPublishedEndpoints(opened.remote.endpoints, {
    epochId: options.epochId,
    url: (endpoint) => publishedEndpointUrl(layout, options.epochId, endpoint)
  });
  const host = createPublishedEndpointHost({
    epochId: options.epochId,
    endpoints,
    browserHost: {},
    embedderPolicy: options.embedderPolicy,
    layout,
    serviceWorkerUrl: options.assets['service-worker.js'],
    endpointOriginDocumentUrl: options.assets['published-endpoint-origin.html'],
    hostOrigin: options.hostOrigin,
    onBackgroundFailure: (error) =>
      opened.notify.runtimeHost.adapterFault({
        kind: 'invariant-violation',
        adapter: 'published-endpoint-host',
        error: { name: error.name, message: error.message, stack: error.stack }
      })
  });
  endpointHost = host;
  Object.assign(local, {
    runtimeHost: {
      terminated: () => dispose('terminated'),
      async closing() {
        const closing = endpointHost;
        endpointHost = undefined;
        await closing?.dispose();
      }
    },
    endpoints: endpoints.events,
    listeners: {
      register(ownerId, listenerId, port, protocol, address, endpoint) {
        const listener = connectPublishedListener(address, endpoint);
        listeners.set(listenerId, listener);
        host.forOwner(ownerId).register(port, protocol, listener.server);
      },
      close: (ownerId, port) => host.forOwner(ownerId).close(port),
      abort(listenerIds) {
        for (const listenerId of listenerIds) {
          listeners.get(listenerId)?.abort();
          listeners.delete(listenerId);
        }
      }
    }
  } satisfies RuntimeHostDocumentApi);
  void opened.closed.then(() => dispose('connection-closed'));

  try {
    await Promise.race([host.initialize(), startFailure]);
  } catch (error) {
    dispose('start-failed');
    throw error;
  }
  if (disposed) throw new Error('The Runtime Host document closed while starting.');
  return { dispose: () => dispose('unloaded') };
}
