import type { PublishedEndpointIdentity } from './types';

/**
 * Where an epoch's Published Endpoints are served.
 *
 * - `directory`: `<scope><epoch>/<route>/<port>/…` under the Service Worker's
 *   `__mimic__/` directory on one origin (ADR-0030), the page's own
 *   or the preview origin (ADR-0032). A document then sees that prefix in
 *   `location.pathname`.
 * - `origin`: the root of an origin per port, `<protocol>//<epoch>--<port>.<suffix>/…`,
 *   when the preview origin is a wildcard such as `https://*.preview.example`
 *   (ADR-0044). A document sees the path its server sees, as it would on a
 *   developer machine.
 */
export type PublishedEndpointLayout =
  | {
      readonly kind: 'directory';
      /** The Service Worker's scope, which every endpoint URL starts with. */
      readonly scopeUrl: string;
    }
  | {
      readonly kind: 'origin';
      /** The wildcard preview origin, as `https://*.preview.example`. */
      readonly pattern: string;
      /** The Service Worker script's path, the same on every origin of the pattern. */
      readonly serviceWorkerPath: string;
    };

/**
 * The label that stands for the wildcard in the origin of the Runtime Host
 * document: processes, caches and the host's own storage live there, on an
 * origin no endpoint has. An endpoint's label always carries `--`, so none
 * collides with it.
 */
export const RUNTIME_HOST_ORIGIN_LABEL = 'mimic';

const WILDCARD_LABEL = '*';

export function normalizePreviewOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new TypeError(`previewOrigin must be an origin string, not ${typeof value}.`);
  }
  if (value.includes(WILDCARD_LABEL)) {
    // An origin per endpoint: the wildcard is the whole first label, and the
    // rest is an origin once a label stands in for it.
    const match = /^(https?:)\/\/\*\.([^/*]+)$/u.exec(value);
    const substituted = match && `${match[1]}//${RUNTIME_HOST_ORIGIN_LABEL}.${match[2]}`;
    let origin: string | undefined;
    try {
      origin = substituted ? new URL(substituted).origin : undefined;
    } catch {
      origin = undefined;
    }
    if (!match || origin !== substituted) {
      throw new TypeError(
        `A wildcard previewOrigin must be an http(s) origin whose first hostname label is "*", such as "https://*.preview.example", not ${JSON.stringify(value)}.`
      );
    }
    return `${match[1]}//${WILDCARD_LABEL}.${match[2]}`;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(
      `previewOrigin must be an origin such as "https://preview.example" or a wildcard such as "https://*.preview.example", not ${JSON.stringify(value)}.`
    );
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== value) {
    throw new TypeError(
      `previewOrigin must be an http(s) origin without a path, such as "https://preview.example", not ${JSON.stringify(value)}.`
    );
  }
  return url.origin === globalThis.location?.origin ? undefined : url.origin;
}

/** Whether a normalized preview origin names an origin per endpoint. */
export function isWildcardPreviewOrigin(previewOrigin: string | undefined): previewOrigin is string {
  return typeof previewOrigin === 'string' && previewOrigin.includes(`//${WILDCARD_LABEL}.`);
}

/** The origin of a wildcard preview origin with `label` in place of the wildcard. */
export function previewOriginFor(pattern: string, label: string): string {
  return pattern.replace(`//${WILDCARD_LABEL}.`, `//${label}.`);
}

/**
 * The origin that serves the Runtime Host document and the runtime's workers
 * (ADR-0033): the preview origin, or its fixed label for a wildcard; the
 * page's own origin (`undefined`) when none is named.
 */
export function runtimeHostOrigin(previewOrigin: string | undefined): string | undefined {
  if (previewOrigin === undefined) return undefined;
  return isWildcardPreviewOrigin(previewOrigin)
    ? previewOriginFor(previewOrigin, RUNTIME_HOST_ORIGIN_LABEL)
    : previewOrigin;
}

/** The same path on `origin`: a preview origin serves the same build. */
export function onOrigin(url: string, origin: string | undefined): string {
  if (!origin) return url;
  const parsed = new URL(url);
  return `${origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/**
 * The Service Worker's scope in the directory layout: the
 * `__mimic__/` directory beside its script, which every Published
 * Endpoint URL starts with. A script may take a scope under its own directory
 * without a `Service-Worker-Allowed` header, and the embedding page, outside
 * the scope, keeps the Service Worker it had, if any.
 */
export function publishedEndpointScopeUrlBeside(serviceWorkerUrl: string): string {
  return new URL('./__mimic__/', serviceWorkerUrl).href;
}

export function publishedEndpointLayout(options: {
  readonly previewOrigin: string | undefined;
  /** The Service Worker script on the Runtime Host document's origin. */
  readonly serviceWorkerUrl: string;
}): PublishedEndpointLayout {
  if (isWildcardPreviewOrigin(options.previewOrigin)) {
    return {
      kind: 'origin',
      pattern: options.previewOrigin,
      serviceWorkerPath: new URL(options.serviceWorkerUrl).pathname
    };
  }
  return { kind: 'directory', scopeUrl: publishedEndpointScopeUrlBeside(options.serviceWorkerUrl) };
}

/** The hostname label of one endpoint's origin: `<epoch>--<port>`. */
export function publishedEndpointOriginLabel(epochId: string, port: number): string {
  return `${epochId}--${port}`;
}

/** The origin that serves one port of the epoch in the origin layout. */
export function publishedEndpointOrigin(
  layout: Extract<PublishedEndpointLayout, { kind: 'origin' }>,
  epochId: string,
  port: number
): string {
  return previewOriginFor(layout.pattern, publishedEndpointOriginLabel(epochId, port));
}

export function publishedEndpointUrl(
  layout: PublishedEndpointLayout,
  epochId: string,
  endpoint: Pick<PublishedEndpointIdentity, 'routeId' | 'address'>
): string {
  if (layout.kind === 'origin') {
    return `${publishedEndpointOrigin(layout, epochId, endpoint.address.port)}/`;
  }
  return new URL(
    `${epochId}/${encodeURIComponent(endpoint.routeId)}/${endpoint.address.port}/`,
    layout.scopeUrl
  ).href;
}

/**
 * The port whose origin a URL names in the origin layout, or `undefined` for
 * a URL on any other origin, another epoch's included.
 */
export function publishedEndpointPortOf(
  layout: Extract<PublishedEndpointLayout, { kind: 'origin' }>,
  epochId: string,
  url: URL
): number | undefined {
  const label = url.hostname.split('.', 1)[0] ?? '';
  const prefix = `${epochId}--`;
  if (!label.startsWith(prefix)) return undefined;
  const port = Number(label.slice(prefix.length));
  if (!Number.isInteger(port) || port < 0) return undefined;
  return url.origin === publishedEndpointOrigin(layout, epochId, port) ? port : undefined;
}

/**
 * The document the embedding page frames to request `url` with `fetch`
 * semantics (ADR-0030): the Service Worker serves it itself, at its scope in
 * the directory layout and at the `__mimic__/` directory beside
 * its script on each endpoint's origin. `undefined` when `url` is no Published
 * Endpoint URL of the epoch.
 */
export function publishedEndpointScopeDocumentUrl(
  layout: PublishedEndpointLayout,
  epochId: string,
  url: string
): string | undefined {
  if (layout.kind === 'directory') {
    return url.startsWith(layout.scopeUrl) ? layout.scopeUrl : undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (publishedEndpointPortOf(layout, epochId, parsed) === undefined) return undefined;
  return `${parsed.origin}${publishedEndpointScopeUrlBeside(`${parsed.origin}${layout.serviceWorkerPath}`).slice(parsed.origin.length)}`;
}

/**
 * The endpoint origin document (`published-endpoint-origin.html`) on one
 * port's origin, with the origin it answers and the Service Worker script it
 * registers as query parameters (ADR-0044).
 */
export function publishedEndpointOriginDocumentUrl(
  layout: Extract<PublishedEndpointLayout, { kind: 'origin' }>,
  options: {
    readonly epochId: string;
    readonly port: number;
    /** The document, as the Runtime Host document's origin serves it: the same path there. */
    readonly documentUrl: string;
    /** The origin that opens the document and is answered by it. */
    readonly hostOrigin: string;
  }
): string {
  const url = new URL(onOrigin(options.documentUrl, publishedEndpointOrigin(layout, options.epochId, options.port)));
  url.searchParams.set('host', options.hostOrigin);
  url.searchParams.set('worker', layout.serviceWorkerPath);
  return url.href;
}
