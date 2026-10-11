import { connectRpc, transfer } from '../worker-transport';
import { publishedEndpointScopeDocumentUrl, type PublishedEndpointLayout } from './endpoint-layout';

export interface PublishedEndpointFetch {
  /** Requests a Published Endpoint URL from the embedding page. */
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
  dispose(): void;
}

const SCOPE_DOCUMENT_TIMEOUT_MS = 10_000;

/**
 * What the scope document of a preview origin serves to the embedding page:
 * one `fetch` per request, its response head and body returned as values, and
 * an abort notification (ADR-0032). The same shape is implemented by
 * `SCOPE_DOCUMENT_PROGRAM` in `service-worker-program.js`.
 */
export type PublishedEndpointScopeDocumentApi = {
  fetch(request: PublishedEndpointScopeFetchRequest): Promise<PublishedEndpointScopeFetchResponse>;
  abort(requestId: string): void;
};

export type PublishedEndpointScopeFetchRequest = {
  readonly requestId: string;
  readonly url: string;
  readonly method: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body?: ArrayBuffer | ReadableStream<Uint8Array>;
  readonly redirect: RequestRedirect;
  readonly cache: RequestCache;
};

export type PublishedEndpointScopeFetchResponse = {
  readonly status: number;
  readonly statusText: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly url: string;
  readonly redirected: boolean;
  readonly body: ArrayBuffer | ReadableStream<Uint8Array> | null;
};

type ScopeDocumentConnection = ReturnType<typeof connectRpc<PublishedEndpointScopeDocumentApi>>;

/**
 * The Service Worker routes a request by the document that makes it, and the
 * embedding page is outside its scope. The page's requests therefore go
 * through a hidden frame of the scope document, which the Service Worker
 * serves itself; a frame opens on the first request to its scope and closes
 * with the epoch. In the directory layout there is one scope; in the origin
 * layout each endpoint's origin has its own (ADR-0044). On the page's own
 * origin the frame's `fetch` is called directly; on a preview origin the frame
 * is cross-origin, so the scope document serves `fetch` over a MessagePort instead.
 */
export function createPublishedEndpointFetch(
  options: { readonly layout: PublishedEndpointLayout; readonly epochId: string }
): PublishedEndpointFetch {
  const frames = new Map<string, ScopeDocumentFrame>();
  let disposed = false;

  const frameFor = (scopeUrl: string): ScopeDocumentFrame => {
    let frame = frames.get(scopeUrl);
    if (!frame) {
      frame = openScopeDocumentFrame(scopeUrl);
      frames.set(scopeUrl, frame);
    }
    return frame;
  };

  return {
    async fetch(input, init) {
      if (disposed) throw new Error('Published Endpoint client is closed.');
      const url = new URL(input, defaultBase(options.layout)).href;
      const scopeUrl = publishedEndpointScopeDocumentUrl(options.layout, options.epochId, url);
      if (scopeUrl === undefined) {
        throw new TypeError(`${url} is not a Published Endpoint URL.`);
      }
      return frameFor(scopeUrl).fetch(url, init);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const frame of frames.values()) frame.dispose();
      frames.clear();
    }
  };
}

/** What a relative URL resolves against: the one scope, or nothing of its own. */
function defaultBase(layout: PublishedEndpointLayout): string | undefined {
  return layout.kind === 'directory' ? layout.scopeUrl : undefined;
}

type ScopeDocumentFrame = {
  fetch(url: string, init: RequestInit | undefined): Promise<Response>;
  dispose(): void;
};

function openScopeDocumentFrame(scopeUrl: string): ScopeDocumentFrame {
  const scopeOrigin = new URL(scopeUrl).origin;
  const crossOrigin = scopeOrigin !== window.location.origin;
  let frame: Promise<Window> | undefined;
  let element: HTMLIFrameElement | undefined;
  let remote: Promise<ScopeDocumentConnection> | undefined;

  const open = (): Promise<Window> => {
    frame ??= new Promise<Window>((resolve, reject) => {
      const iframe = document.createElement('iframe');
      element = iframe;
      iframe.hidden = true;
      iframe.setAttribute('aria-hidden', 'true');
      iframe.title = 'Mimic endpoints';
      const timeout = window.setTimeout(() => {
        iframe.remove();
        reject(new Error('The Published Endpoint scope document did not load.'));
      }, SCOPE_DOCUMENT_TIMEOUT_MS);
      iframe.addEventListener(
        'load',
        () => {
          window.clearTimeout(timeout);
          const content = iframe.contentWindow;
          if (content) resolve(content);
          else reject(new Error('The Published Endpoint scope document has no window.'));
        },
        { once: true }
      );
      iframe.src = scopeUrl;
      (document.body ?? document.documentElement).append(iframe);
    });
    return frame;
  };

  const connect = (): Promise<ScopeDocumentConnection> => {
    remote ??= open().then((content) => {
      const channel = new MessageChannel();
      content.postMessage(
        { type: 'published-endpoint:fetch-connect' },
        scopeOrigin,
        [channel.port2]
      );
      return connectRpc<PublishedEndpointScopeDocumentApi>(channel.port1);
    });
    return remote;
  };

  return {
    async fetch(url, init) {
      if (!crossOrigin) {
        const content = await open();
        return content.fetch(url, init);
      }
      return fetchThroughScopeDocument(await connect(), url, init);
    },
    dispose() {
      frame = undefined;
      void remote?.then((connection) => connection.close()).catch(() => undefined);
      remote = undefined;
      element?.remove();
      element = undefined;
    }
  };
}

async function fetchThroughScopeDocument(
  connection: ScopeDocumentConnection,
  url: string,
  init: RequestInit | undefined
): Promise<Response> {
  // `Request` normalises the init the way `fetch` would: method casing,
  // header validation and a body stream of bytes whatever the caller passed.
  const request = new Request(url, init);
  const requestId = crypto.randomUUID();
  const signal = init?.signal ?? undefined;
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError');
  const body = request.body ? await bodyValue(request) : undefined;
  const message: PublishedEndpointScopeFetchRequest = {
    requestId,
    url: request.url,
    method: request.method,
    headers: [...request.headers.entries()],
    body,
    redirect: request.redirect,
    cache: request.cache
  };
  if (body instanceof ReadableStream) transfer(message, [body]);
  const abort = (): void => connection.notify.abort(requestId);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await connection.remote.fetch(message);
    if (signal?.aborted) {
      if (response.body instanceof ReadableStream) void response.body.cancel().catch(() => undefined);
      throw signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError');
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers.map(([name, value]): [string, string] => [name, value])
    });
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

/** A request body as a transferable stream, or as bytes where streams do not transfer. */
async function bodyValue(request: Request): Promise<ArrayBuffer | ReadableStream<Uint8Array>> {
  if (request.body && streamsTransfer()) return request.body;
  return request.arrayBuffer();
}

let streamsTransferable: boolean | undefined;
function streamsTransfer(): boolean {
  if (streamsTransferable !== undefined) return streamsTransferable;
  try {
    const stream = new ReadableStream();
    structuredClone(stream, { transfer: [stream] });
    streamsTransferable = true;
  } catch {
    streamsTransferable = false;
  }
  return streamsTransferable;
}
