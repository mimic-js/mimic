import { describe, expect, test } from 'vitest';

import { installNodeResponse, nodeResponse } from '../response-body';

/** The platform's Response, recording each body its constructor is given. */
function platformResponse(): { readonly Platform: typeof Response; readonly bodies: unknown[] } {
  const bodies: unknown[] = [];
  class Platform extends Response {
    constructor(body?: BodyInit | null, init?: ResponseInit) {
      bodies.push(body);
      super(body, init);
    }
  }
  return { Platform, bodies };
}

describe('Node Compatibility Response', () => {
  test('streams an async iterable body as undici does, where the platform would stringify it', async () => {
    // Astro's development server renders a page to a Response over an async iterable.
    const { Platform, bodies } = platformResponse();
    const NodeResponse = nodeResponse(Platform);
    async function* page() {
      yield '<h1>';
      yield new Uint8Array();
      yield new TextEncoder().encode('Latest posts');
      yield Uint8Array.from([60, 47, 104, 49, 62]);
    }

    const response = new NodeResponse(page() as unknown as BodyInit, { status: 201, headers: { 'content-type': 'text/html' } });

    expect(bodies[0]).toBeInstanceOf(ReadableStream);
    expect(response.status).toBe(201);
    expect(response.headers.get('content-type')).toBe('text/html');
    expect(await response.text()).toBe('<h1>Latest posts</h1>');
  });

  test('leaves every body the platform takes as it was given', async () => {
    const { Platform, bodies } = platformResponse();
    const NodeResponse = nodeResponse(Platform);
    const stream = new ReadableStream<Uint8Array>();
    const bytes = new Uint8Array([1]);
    for (const body of ['text', bytes, bytes.buffer, new Blob(['b']), new URLSearchParams('a=1'), stream, null, undefined]) {
      new NodeResponse(body as BodyInit);
    }

    expect(bodies).toEqual(['text', bytes, bytes.buffer, expect.any(Blob), expect.any(URLSearchParams), stream, null, undefined]);
    expect(bodies[5]).toBe(stream);
  });

  test('cancelling the body returns the iterator', async () => {
    let returned = false;
    async function* endless() {
      try {
        while (true) yield 'chunk';
      } finally {
        returned = true;
      }
    }
    const response = new (nodeResponse(Response))(endless() as unknown as BodyInit);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();

    expect(returned).toBe(true);
  });

  test('is one class with the platform prototype, so a fetched Response is an instance, as in Node', async () => {
    const NodeResponse = nodeResponse(Response);

    expect(nodeResponse(Response)).toBe(NodeResponse);
    expect(nodeResponse(NodeResponse)).toBe(NodeResponse);
    expect(new Response('platform')).toBeInstanceOf(NodeResponse);
    expect(new NodeResponse('node')).toBeInstanceOf(Response);
    expect(NodeResponse.json({ ok: true })).toBeInstanceOf(NodeResponse);
    expect(await NodeResponse.json({ ok: true }).json()).toEqual({ ok: true });
    class Subclass extends NodeResponse {}
    expect(new Subclass('sub')).toBeInstanceOf(Subclass);
    expect(() => (NodeResponse as unknown as (body: string) => Response)('call')).toThrow(TypeError);
  });

  test('installs on a global once, keeping the name non-enumerable as the platform defines it', () => {
    const target = { Response } as { Response?: typeof Response };
    installNodeResponse(target);
    const installed = target.Response;
    installNodeResponse(target);

    expect(installed).toBe(nodeResponse(Response));
    expect(target.Response).toBe(installed);
    expect(Object.getOwnPropertyDescriptor(target, 'Response')?.enumerable).toBe(false);
  });
});
