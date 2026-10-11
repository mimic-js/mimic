import {
  type MessageStream,
  workerTransportBrowserArtifactSource
} from '../worker-transport';
import type { PublishedEndpointDocumentCookieSnapshot } from './cookie-jar';
import {
  PUBLISHED_ENDPOINT_WEBSOCKET_MESSAGE,
  type PublishedEndpointDocumentRouteManifest,
  type PublishedEndpointDocumentRouteRequest,
  type PublishedEndpointWebSocketMessage
} from './types';
import { resolvePublishedEndpointDocumentRoute } from './document-route';
import { installPublishedEndpointDocumentCookieProgram } from './document-cookie-program';
import { installPublishedEndpointDocumentNavigationProgram } from './document-navigation-program';
import { installPublishedEndpointDocumentWebSocketProgram } from './document-websocket-program';

export const PUBLISHED_ENDPOINT_DOCUMENT_RUNTIME_PATH =
  '/__mimic_document_runtime__.js';

const PUBLISHED_ENDPOINT_DOCUMENT_CONFIG = 'mimic-published-endpoint';

type PublishedEndpointDocumentResponse = {
  readonly headers: readonly (readonly [string, string])[];
  readonly body: Uint8Array;
  readonly bodyStream?: ReadableStream<Uint8Array>;
};

export type PublishedEndpointDocumentCookieConfig = {
  readonly route: PublishedEndpointDocumentRouteRequest;
  readonly publicUrl: string;
  readonly logicalUrl: string;
  readonly snapshot: PublishedEndpointDocumentCookieSnapshot;
};

export type PublishedEndpointDocumentConfig = {
  readonly manifest: PublishedEndpointDocumentRouteManifest;
  readonly cookie?: PublishedEndpointDocumentCookieConfig;
};

export function injectPublishedEndpointDocumentAdapter<
  Response extends PublishedEndpointDocumentResponse
>(response: Response, config: PublishedEndpointDocumentConfig): Response {
  const contentType =
    response.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1]?.toLowerCase() ??
    '';
  if (!contentType.includes('text/html')) return response;
  const bootstrap = new TextEncoder().encode(
    `<meta name="${PUBLISHED_ENDPOINT_DOCUMENT_CONFIG}" content="${encodeConfig(config)}">` +
      `<script src="${PUBLISHED_ENDPOINT_DOCUMENT_RUNTIME_PATH}" ` +
      `data-mimic-published-endpoint></script>\n`
  );
  if (response.bodyStream) {
    return {
      ...response,
      bodyStream: response.bodyStream.pipeThrough(documentBootstrapStream(bootstrap))
    };
  }
  const placement = documentBootstrapPlacement(response.body, true);
  if (placement === undefined || placement.present) return response;
  return {
    ...response,
    body: concatBytes(
      response.body.subarray(0, placement.offset),
      bootstrap,
      response.body.subarray(placement.offset)
    )
  };
}

/**
 * Inserts the bootstrap into a streamed document, holding back only the
 * leading bytes that decide where it goes.
 */
function documentBootstrapStream(
  bootstrap: Uint8Array
): TransformStream<Uint8Array, Uint8Array> {
  let prefix: Uint8Array | undefined = new Uint8Array(0);
  const place = (
    controller: TransformStreamDefaultController<Uint8Array>,
    complete: boolean
  ): void => {
    if (!prefix) return;
    const placement = documentBootstrapPlacement(prefix, complete);
    if (!placement) return;
    const chunks = placement.present
      ? [prefix]
      : [prefix.subarray(0, placement.offset), bootstrap, prefix.subarray(placement.offset)];
    prefix = undefined;
    for (const chunk of chunks) {
      if (chunk.byteLength > 0) controller.enqueue(chunk);
    }
  };
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (!prefix) {
        controller.enqueue(chunk);
        return;
      }
      prefix = concatBytes(prefix, chunk);
      place(controller, false);
    },
    flush(controller) {
      place(controller, true);
    }
  });
}

const BOOTSTRAP_MARKER = `<meta name="${PUBLISHED_ENDPOINT_DOCUMENT_CONFIG}"`;
const DOCUMENT_PREAMBLE_TOKENS = ['<!--', '<!doctype', '<html', '<head'];

/**
 * Where the bootstrap goes in a document that starts with `prefix`: after the
 * `<head>` start tag, or else before the first token that is not whitespace,
 * a comment, the doctype or the `<html>` start tag, which is where the HTML
 * parser opens the head by itself. Anything earlier would precede the doctype
 * and leave the document in quirks mode. Returns `undefined` while an
 * incomplete prefix has not decided yet.
 */
function documentBootstrapPlacement(
  prefix: Uint8Array,
  complete: boolean
): { readonly offset: number; readonly present: boolean } | undefined {
  // One character per byte, so offsets in the text are offsets in the bytes.
  const text = new TextDecoder('latin1').decode(prefix);
  const offset = documentBootstrapOffset(text, complete);
  if (offset === undefined) return undefined;
  const following = text.slice(offset).trimStart();
  if (following.startsWith(BOOTSTRAP_MARKER)) return { offset, present: true };
  if (!complete && BOOTSTRAP_MARKER.startsWith(following)) return undefined;
  return { offset, present: false };
}

function documentBootstrapOffset(text: string, complete: boolean): number | undefined {
  // A UTF-8 byte order mark, as its three bytes decode in a single-byte encoding.
  const byteOrderMark = '\u00ef\u00bb\u00bf';
  if (!complete && text.length < byteOrderMark.length && byteOrderMark.startsWith(text)) {
    return undefined;
  }
  let offset = text.startsWith(byteOrderMark) ? byteOrderMark.length : 0;
  const undecided = (): number | undefined => (complete ? offset : undefined);
  for (;;) {
    while (offset < text.length && '\t\n\f\r '.includes(text[offset])) offset += 1;
    if (offset === text.length) return undecided();
    if (text.startsWith('<!--', offset)) {
      const end = text.indexOf('-->', offset + 4);
      if (end === -1) return undecided();
      offset = end + 3;
      continue;
    }
    const tag = /^<(!doctype|html|head)(?=[\t\n\f\r />])/iu.exec(text.slice(offset, offset + 10));
    if (tag) {
      const end = tagEnd(text, offset);
      if (end === -1) return undecided();
      offset = end;
      if (tag[1].toLowerCase() === 'head') return offset;
      continue;
    }
    const start = text.slice(offset, offset + 9).toLowerCase();
    if (!complete && DOCUMENT_PREAMBLE_TOKENS.some((token) => token.startsWith(start))) {
      return undefined;
    }
    return offset;
  }
}

/** The offset after the `>` that closes the tag starting at `from`, or -1. */
function tagEnd(text: string, from: number): number {
  let quote: string | undefined;
  for (let index = from; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index + 1;
    }
  }
  return -1;
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

export function isPublishedEndpointDocumentRuntimeRequest(request: {
  readonly path: string;
  readonly destination?: string;
}): boolean {
  return (
    request.path.split(/[?#]/u, 1)[0] === PUBLISHED_ENDPOINT_DOCUMENT_RUNTIME_PATH &&
    (request.destination === undefined || request.destination === 'script')
  );
}

export function openPublishedEndpointDocumentCookie<
  Request extends PublishedEndpointDocumentRouteRequest & { readonly path: string }
>(
  manifest: PublishedEndpointDocumentRouteManifest,
  request: Request,
  client: MessageStream,
  open: (request: Request, client: MessageStream) => void
): void {
  if (!resolvePublishedEndpointDocumentRoute(manifest, request)) {
    client.send({
      type: 'mimic:document-cookie-close',
      reason: 'Published Endpoint route is stale or unavailable.'
    });
    client.close();
    return;
  }
  open(request, client);
}

export function openPublishedEndpointDocumentWebSocket<
  Request extends PublishedEndpointDocumentRouteRequest
>(
  manifest: PublishedEndpointDocumentRouteManifest,
  request: Request,
  peer: MessageStream,
  open: (request: Request, peer: MessageStream) => void
): void {
  if (!resolvePublishedEndpointDocumentRoute(manifest, request)) {
    peer.send({
      type: PUBLISHED_ENDPOINT_WEBSOCKET_MESSAGE.close,
      code: 1008,
      reason: 'Published Endpoint WebSocket route is stale or unavailable.'
    } satisfies PublishedEndpointWebSocketMessage);
    peer.close();
    return;
  }
  open(request, peer);
}

export function publishedEndpointDocumentRuntimeResponse(): {
  readonly status: 200;
  readonly headers: [string, string][];
  readonly body: Uint8Array;
} {
  return {
    status: 200,
    headers: [
      ['content-type', 'text/javascript; charset=utf-8'],
      ['cache-control', 'no-store'],
      ['cross-origin-resource-policy', 'same-origin']
    ],
    body: new TextEncoder().encode(publishedEndpointDocumentRuntimeArtifactSource())
  };
}

export function publishedEndpointDocumentRuntimeArtifactSource(): string {
  return `(() => {
    const element = document.querySelector('meta[name="${PUBLISHED_ENDPOINT_DOCUMENT_CONFIG}"]');
    if (!element) throw new Error('Missing Published Endpoint document configuration.');
    const bytes = Uint8Array.from(atob(element.content), (character) => character.charCodeAt(0));
    const config = JSON.parse(new TextDecoder().decode(bytes));
    ${documentStreamArtifactSource()}
    (${installPublishedEndpointDocumentNavigationProgram.toString()})();
    (${installPublishedEndpointDocumentWebSocketProgram.toString()})({
      manifest: config.manifest,
      openStream: openHostStream
    });
    if (config.cookie) {
      (${installPublishedEndpointDocumentCookieProgram.toString()})({
        config: config.cookie,
        openStream: openHostStream
      });
    }
  })();`;
}

export function publishedEndpointDocumentWebSocketArtifactSource(options: {
  readonly manifest: PublishedEndpointDocumentRouteManifest;
}): string {
  return `${documentStreamArtifactSource()}\n(${installPublishedEndpointDocumentWebSocketProgram.toString()})({ ...${JSON.stringify(options)}, openStream: openHostStream });`;
}

/**
 * Defines `openHostStream`, which opens a message stream to the document's
 * host. The host is the Runtime Host document of this origin, which is not
 * this document's parent (the embedding page frames the endpoint, or a tab
 * opened it), so the port goes to the Service Worker that serves this
 * document, and the worker forwards it over its host connection (ADR-0033).
 */
function documentStreamArtifactSource(): string {
  return `${workerTransportBrowserArtifactSource()}
    const openHostStream = () => {
      const controller = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (!controller) {
        return Promise.reject(new Error('The Published Endpoint document is not controlled by its Service Worker.'));
      }
      const channel = new MessageChannel();
      controller.postMessage({ type: 'published-endpoint:document-connect' }, [channel.port2]);
      return Promise.resolve(openMessageStream(channel.port1));
    };`;
}

function encodeConfig(config: PublishedEndpointDocumentConfig): string {
  const bytes = new TextEncoder().encode(JSON.stringify(config));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
