import { describe, expect, test } from 'vitest';

import {
  injectPublishedEndpointDocumentAdapter,
  type PublishedEndpointDocumentConfig
} from './document-adapter';

const config: PublishedEndpointDocumentConfig = {
  manifest: { version: 1, epochId: 'epoch', routes: [] }
};
const htmlHeaders = [['content-type', 'text/html; charset=utf-8']] as const;
const bootstrapPattern =
  /<meta name="mimic-published-endpoint" content="[^"]+"><script src="\/__mimic_document_runtime__\.js" data-mimic-published-endpoint><\/script>\n/u;

describe('Published Endpoint document bootstrap', () => {
  for (const [name, document, expected] of [
    [
      'after the head start tag',
      '<!doctype html><html lang="en"><head><title>t</title></head><body></body></html>',
      '<!doctype html><html lang="en"><head>@<title>t</title></head><body></body></html>'
    ],
    [
      'after the doctype when the head is implied',
      '<!DOCTYPE html>\n<title>t</title><p>body',
      '<!DOCTYPE html>\n@<title>t</title><p>body'
    ],
    [
      'after the html start tag when the head is implied',
      '<!doctype html>\n<!-- a > comment -->\n<html data-a="1>2">\n<body>text</body>',
      '<!doctype html>\n<!-- a > comment -->\n<html data-a="1>2">\n@<body>text</body>'
    ],
    ['after a byte order mark', '﻿<!doctype html><p>ж', '﻿<!doctype html>@<p>ж'],
    ['at the start of a document without a doctype', '<p>quirks', '@<p>quirks'],
    ['at the end of a document that is only a preamble', '<!doctype html>', '<!doctype html>@'],
    ['not inside a header element', '<!doctype html><header>h</header>', '<!doctype html>@<header>h</header>']
  ] as const) {
    test(`goes ${name}, buffered or streamed in any chunking`, async () => {
      const bytes = new TextEncoder().encode(document);
      const buffered = injectPublishedEndpointDocumentAdapter(
        { headers: htmlHeaders, body: bytes },
        config
      );
      expectBootstrapAt(decode(buffered.body), expected);

      for (const chunkSize of [1, 2, 3, 7, bytes.byteLength]) {
        const streamed = injectPublishedEndpointDocumentAdapter(
          { headers: htmlHeaders, body: new Uint8Array(0), bodyStream: chunked(bytes, chunkSize) },
          config
        );
        expectBootstrapAt(await text(streamed.bodyStream), expected);
      }
    });
  }

  test('releases the body as it arrives once the placement is decided', async () => {
    const source = new TransformStream<Uint8Array, Uint8Array>();
    const writer = source.writable.getWriter();
    const response = injectPublishedEndpointDocumentAdapter(
      { headers: htmlHeaders, body: new Uint8Array(0), bodyStream: source.readable },
      config
    );
    const reader = response.bodyStream!.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    void writer.write(encoder.encode('<!doctype html><p>first'));
    let received = '';
    while (!received.endsWith('<p>first')) {
      received += decoder.decode((await reader.read()).value, { stream: true });
    }
    expectBootstrapAt(received, '<!doctype html>@<p>first');

    void writer.write(encoder.encode('<p>second'));
    expect(decoder.decode((await reader.read()).value)).toBe('<p>second');
    void writer.close();
    expect((await reader.read()).done).toBe(true);
  });

  test('leaves a document that already carries the bootstrap unchanged', async () => {
    const once = injectPublishedEndpointDocumentAdapter(
      { headers: htmlHeaders, body: new TextEncoder().encode('<!doctype html><head></head>') },
      config
    );
    const twice = injectPublishedEndpointDocumentAdapter(once, config);
    expect(twice.body).toEqual(once.body);

    const streamed = injectPublishedEndpointDocumentAdapter(
      { headers: htmlHeaders, body: new Uint8Array(0), bodyStream: chunked(once.body, 5) },
      config
    );
    expect(await text(streamed.bodyStream)).toBe(decode(once.body));
  });

  test('leaves responses that are not HTML unchanged', () => {
    const response = {
      headers: [['content-type', 'application/json']] as const,
      body: new TextEncoder().encode('{"html":"<head>"}')
    };
    expect(injectPublishedEndpointDocumentAdapter(response, config)).toBe(response);
  });
});

function expectBootstrapAt(actual: string, expected: string): void {
  const [before, after] = expected.split('@');
  expect(actual.startsWith(before), actual).toBe(true);
  expect(actual.endsWith(after), actual).toBe(true);
  expect(actual.slice(before.length, actual.length - after.length)).toMatch(
    new RegExp(`^${bootstrapPattern.source}$`, 'u')
  );
}

function chunked(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    }
  });
}

async function text(stream: ReadableStream<Uint8Array> | undefined): Promise<string> {
  return decode(new Uint8Array(await new Response(stream).arrayBuffer()));
}

/** Keeps a byte order mark, which the default decoder drops. */
function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
}
