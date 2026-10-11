---
status: accepted
amends: ADR-0015 (Published Endpoint and HTTP/1 Wire Codec), ADR-0020 (the published HTTP byte path)
---

# Deliver published HTTP as structured requests

A request from a published document to a Node `http.Server` was framed as
HTTP/1 twice and parsed twice. The Service Worker handed the request to the
host page; the Published Endpoint host serialised HTTP/1 bytes, always adding
`connection: close`; the process worker that owned the listener opened a
loopback `net` connection to its own listener, so the bytes travelled through
the Virtual Network authority in the Runtime Host Worker and back; `http.Server`
parsed them; the response bytes were parsed again on the page. The Service
Worker then removed the framing headers that survived. The package held four
HTTP/1 framers: the HTTP/1 Wire Codec, `published-endpoint/http1.ts`, private
helpers in `node-compatibility/http.ts` and the header sanitising in the
Service Worker (issue #676).

## Decision

- **A published request is a Published HTTP Exchange.** The Service Worker
  sends the request to the host page as before. The Published Endpoint host
  selects cookies, adds the headers a Service Worker cannot observe, and calls
  `serveHttp` on the listener's port, the one the process worker opened for it
  (ADR-0020), with `{ method, url, headers, body }`; the body is the request's
  `ReadableStream`, transferred. The process worker hands it to the
  `http.Server` that claimed the listener. The call resolves once the handler
  sends its head, with `{ status, statusText, headers, informational, body }`;
  the body is a transferred `ReadableStream`. Nothing on the way serialises or
  parses HTTP/1, and nothing crosses the Virtual Network authority.
- **`http.Server` serves the exchange as it serves a parsed request.** The
  request becomes an `IncomingMessage` whose body is read from the stream with
  backpressure: a full buffer waits until the handler reads. The handler's
  `ServerResponse` writes into the response stream, whose 64 KiB queue drives
  the write callbacks, so a full queue holds the handler's `write` until the
  page reads. The same dispatch serves both paths: `request`, `checkContinue`,
  and the synchronous-throw 500 response.
- **Each exchange has a socket that carries its lifetime.** `request.socket` is
  a `net.Socket` attached to an in-process connection, so its shape matches a
  Virtual Network socket. It closes when the exchange ends or the client goes
  away; that is how a handler learns of a disconnect (`close` on the request,
  the response and the socket). It carries no bytes: what a handler writes to it
  is not part of the response and is discarded.
- **Cancellation stays a domain operation.** An aborted Fetch notifies
  `cancelHttp` (formerly `cancelHttp1`) while the head is pending; afterwards,
  cancelling the response body propagates through the transferred streams and
  disconnects the exchange.
- **`upgrade` hands over a byte socket.** A published WebSocket opens with a
  structured GET; the server emits `upgrade` with a socket whose bytes belong to
  the program. The program writes its HTTP/1 response head on that socket, and
  the HTTP/1 Wire Codec parses it to decide whether the WebSocket opened, with
  which headers and subprotocol; the bytes after it are WebSocket frames. The
  page stores the head's cookies directly from the opening response.
- **The Fetch boundary projects the response in one place.** The Published
  Endpoint host answers 502 for interim responses (`writeEarlyHints`,
  `writeProcessing`) and for a declared `trailer`; a body that ends with
  trailers errors. It drops the fields that describe a connection rather than
  the message, `connection`, `keep-alive`, `transfer-encoding`, `upgrade`,
  `content-length`, and `content-encoding`, which the browser does not undo for
  a Service Worker response. The Service Worker only rewrites a published
  `Location` and adds cross-origin isolation. Because that responsibility moved,
  the Service Worker protocol token is `mimic-published-endpoint-v2`.
- **No framing headers are invented.** A published request carries no
  `connection: close`, and a bodyless GET or HEAD no `content-length: 0`. It
  still carries `host`, `sec-fetch-dest`, and the body's `content-length` or
  `transfer-encoding: chunked`, which tell a server that a body exists. A
  response carries the handler's headers as set; `100 Continue` is not reported,
  because a structured body already streams.
- **One HTTP/1 framer.** `published-endpoint/http1.ts` and the Service Worker's
  header sanitising are deleted, and `node-compatibility/http.ts` keeps no
  framing of its own: the HTTP/1 Wire Codec is the only parser and serialiser of
  HTTP/1 bytes, and it now also validates the request line. Node Compatibility
  is its only consumer: `http.Server` connections arriving over `node:net`,
  `http.request` and the head written after `upgrade`. Published Endpoint no
  longer depends on it.
- **`http.request` inside the container keeps `node:net`.** A request to a
  listener in the same container still opens a Virtual Network connection and
  speaks HTTP/1, so its `socket`, `upgrade`, `checkContinue` and keep-alive
  behaviour, each covered by `node-compatibility-http.test.ts`, are unchanged.

## Measurements

Chromium (Playwright 1.61.1), Apple M1 Pro, one Playwright worker. The 5 MB
response is a `node:http` server writing 80 chunks of 64 KiB with a
`content-length`, fetched from the host page through the Published Endpoint
with `cache: 'no-store'` and read to the end; one discarded warm-up, then seven
fetches. The Vite page load is the tracked `vanilla-vite-6.4.3` graph after
`npm ci`, `npm run dev`, loading an `index.html` with one stylesheet and four
modules in an iframe until the entry module has run; one cold load, then seven
warm loads (Vite's transform cache and the browser's 304 revalidation). Each
cell is the median over four runs of the per-run median (range of all samples
in parentheses).

| Tree | 5 MB response (ms) | Vite page, cold (ms) | Vite page, warm (ms) |
| --- | --- | --- | --- |
| Before (HTTP/1 bytes, `949972d3`) | 315 (307–319) | 116 (111–129) | 48 (35–111) |
| After (structured exchange) | 46 (28–54) | 88 (83–91) | 30 (23–64) |

## Consequences

- The witness `tests/e2e/mimic-published-http-fidelity.spec.ts`
  keeps proving response and request streaming, cancellation reaching
  `request.socket`, redirects, the 502 fidelity failures and, now, that a
  handler's `content-length` does not reach the Fetch `Response`. The structured
  exchange, its backpressure and the upgrade handover have focused witnesses in
  `node-compatibility-http.test.ts`; Vite HMR and `ws` keep theirs.
- A handler that writes raw bytes to `request.socket` of a published request no
  longer reaches the browser. Such bytes would have corrupted the HTTP/1 stream
  before; no maintained claim depends on them.
- A page that meets a Service Worker of a previous build fails the protocol
  token negotiation, as for any change to their protocol.
