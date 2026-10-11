const NODE_RESPONSE = Symbol('node-response');
const nodeResponses = new WeakMap<typeof Response, typeof Response>();
const encoder = new TextEncoder();

/**
 * Node's `Response` over the platform's: a body that is an async iterable (an
 * async generator, a Node `Readable`) streams its chunks, as undici streams
 * them, where the platform would take it for a string and answer
 * `[object Object]`. Astro's development server renders a page to a Response
 * over an async iterable once it tells the runtime is Node by
 * `String(process)`. Every other body reaches the platform's constructor as
 * it was given. The class shares the platform's prototype, so a Response that
 * `fetch` or `Response.json` returns is an instance of it, as in Node.
 */
export function nodeResponse(base: typeof Response): typeof Response {
  if ((base as unknown as Record<symbol, unknown>)[NODE_RESPONSE]) return base;
  let response = nodeResponses.get(base);
  if (!response) {
    const NodeResponse = function Response(body?: unknown, init?: ResponseInit): globalThis.Response {
      if (!new.target) throw new TypeError("Class constructor Response cannot be invoked without 'new'");
      return Reflect.construct(base, [nodeResponseBody(body), init], new.target) as globalThis.Response;
    };
    Object.defineProperties(NodeResponse, {
      length: { configurable: true, value: base.length },
      prototype: { value: base.prototype, writable: false },
      [NODE_RESPONSE]: { value: true }
    });
    // `Response.json`, `Response.error` and `Response.redirect`.
    Object.setPrototypeOf(NodeResponse, base);
    response = NodeResponse as unknown as typeof Response;
    nodeResponses.set(base, response);
  }
  return response;
}

/** Gives a process worker's global Node's `Response`; free identifiers and the process's `globalThis` both reach it. */
export function installNodeResponse(target: { Response?: typeof Response } = globalThis): void {
  if (typeof target.Response !== 'function') return;
  Object.defineProperty(target, 'Response', {
    configurable: true,
    enumerable: false,
    writable: true,
    value: nodeResponse(target.Response)
  });
}

/** In undici's order: what the platform takes as a body is left to it; an async iterable becomes a stream. */
function nodeResponseBody(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return body;
  if (
    body instanceof URLSearchParams ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof Blob ||
    (typeof FormData === 'function' && body instanceof FormData) ||
    body instanceof ReadableStream
  ) {
    return body;
  }
  const iterate = (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator];
  if (typeof iterate !== 'function') return body;
  return streamOf((iterate as () => AsyncIterator<unknown>).call(body));
}

function streamOf(iterator: AsyncIterator<unknown>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // An empty chunk is skipped; a pull that enqueued nothing would not be called again.
      while (true) {
        const { done, value } = await iterator.next();
        if (done) {
          controller.close();
          return;
        }
        const chunk = typeof value === 'string' ? encoder.encode(value) : new Uint8Array(value as ArrayLike<number>);
        if (chunk.byteLength > 0) {
          controller.enqueue(chunk);
          return;
        }
      }
    },
    async cancel(reason) {
      await iterator.return?.(reason);
    }
  });
}
