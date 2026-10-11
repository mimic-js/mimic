import type { Remote } from '../worker-transport';
import { publishedEndpointLayout, publishedEndpointUrl } from './endpoint-layout';
import type {
  PublishedEndpoint,
  PublishedEndpointApi,
  PublishedEndpointClient,
  PublishedEndpointEvents,
  PublishedEndpointDocumentRoute,
  PublishedEndpointDocumentRouteManifest,
  PublishedEndpointIdentity,
  PublishedEndpointLifecycleEvent,
  PublishedEndpointPublishRequest
} from './types';

export async function createPublishedEndpointClient(
  api: Remote<PublishedEndpointApi>,
  options: {
    readonly epochId: string;
    /** The URL of a published endpoint, by its layout (ADR-0030, ADR-0044). */
    readonly url?: PublishedEndpointUrl;
    /** How this context requests an endpoint; a context without one cannot. */
    readonly fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  }
): Promise<PublishedEndpointClient> {
  const client = new PublishedEndpointClientImplementation(
    api,
    options.epochId,
    options.url ?? defaultPublishedEndpointUrl(options.epochId),
    options.fetch
  );
  try {
    await api.initialize(options.epochId);
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}

/**
 * The Runtime Host document's view of the endpoints (ADR-0033): the same
 * projection the page keeps, fed by the same lifecycle events, over the
 * document's own connection. The page initializes the authority; this does not.
 */
export function projectPublishedEndpoints(
  api: Remote<PublishedEndpointApi>,
  options: {
    readonly epochId: string;
    readonly url: PublishedEndpointUrl;
  }
): PublishedEndpointClient {
  return new PublishedEndpointClientImplementation(api, options.epochId, options.url);
}

export type PublishedEndpointUrl = (endpoint: PublishedEndpointIdentity) => string;

class PublishedEndpointClientImplementation implements PublishedEndpointClient {
  readonly events: PublishedEndpointEvents = {
    lifecycle: (event) => this.receive(event)
  };
  readonly #api: Remote<PublishedEndpointApi>;
  readonly #epochId: string;
  readonly #url: PublishedEndpointUrl;
  readonly #listeners = new Map<
    PublishedEndpointLifecycleEvent['type'],
    Set<(endpoint: PublishedEndpoint) => void>
  >();
  readonly #published = new Map<string, PublishedEndpoint>();
  readonly #routes = new Map<string, PublishedEndpointDocumentRoute>();
  readonly #fetch: ((input: string | URL, init?: RequestInit) => Promise<Response>) | undefined;
  #closed = false;

  constructor(
    api: Remote<PublishedEndpointApi>,
    epochId: string,
    url: PublishedEndpointUrl,
    fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>
  ) {
    this.#api = api;
    this.#epochId = epochId;
    this.#url = url;
    this.#fetch = fetch;
  }

  async fetch(input: string | URL, init?: RequestInit): Promise<Response> {
    this.assertOpen();
    if (!this.#fetch) {
      throw new Error('Published Endpoints can be requested from the embedding page only.');
    }
    return this.#fetch(input, init);
  }

  get current(): readonly PublishedEndpoint[] {
    return [...this.#published.values()];
  }

  get routeManifest(): PublishedEndpointDocumentRouteManifest {
    return {
      version: 1,
      epochId: this.#epochId,
      routes: [...this.#routes.values()]
    };
  }

  on<Type extends PublishedEndpointLifecycleEvent['type']>(
    type: Type,
    listener: (endpoint: PublishedEndpoint) => void
  ): () => void {
    this.assertOpen();
    const listeners = this.#listeners.get(type) ?? new Set<(endpoint: PublishedEndpoint) => void>();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
    return () => listeners.delete(listener);
  }

  async publish(request: PublishedEndpointPublishRequest): Promise<PublishedEndpoint> {
    this.assertOpen();
    return this.project(await this.#api.publish(request));
  }

  async unpublish(request: PublishedEndpointPublishRequest): Promise<void> {
    this.assertOpen();
    await this.#api.unpublish(request);
  }

  async releaseOwner(ownerId: string): Promise<void> {
    this.assertOpen();
    await this.#api.releaseOwner(ownerId);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const published of [...this.#published.values()]) this.removePublished(published);
    this.#listeners.clear();
  }

  private receive(event: PublishedEndpointLifecycleEvent): void {
    if (this.#closed) return;
    const published = this.project(event.endpoint);
    if (event.type === 'published') {
      if (this.#published.has(published.routeId)) return;
      this.#published.set(published.routeId, published);
      this.#routes.set(published.routeId, published);
      this.emit('published', published);
      return;
    }
    const active = this.#published.get(published.routeId);
    if (!active) return;
    this.removePublished(active);
  }

  private removePublished(published: PublishedEndpoint): void {
    if (!this.#published.delete(published.routeId)) return;
    this.#routes.delete(published.routeId);
    this.emit('unpublished', published);
  }

  private project(endpoint: PublishedEndpointIdentity): PublishedEndpoint {
    return this.#published.get(endpoint.routeId) ?? { ...endpoint, url: this.#url(endpoint) };
  }

  private emit(type: PublishedEndpointLifecycleEvent['type'], endpoint: PublishedEndpoint): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(endpoint);
  }

  private assertOpen(): void {
    if (this.#closed) throw new Error('Published Endpoint client is closed.');
  }
}

/** The directory layout beside a Service Worker at the origin's root, for a context that names none. */
function defaultPublishedEndpointUrl(epochId: string): PublishedEndpointUrl {
  const layout = publishedEndpointLayout({
    previewOrigin: undefined,
    serviceWorkerUrl: `${globalThis.location?.origin ?? 'http://localhost'}/service-worker.js`
  });
  return (endpoint) => publishedEndpointUrl(layout, epochId, endpoint);
}
