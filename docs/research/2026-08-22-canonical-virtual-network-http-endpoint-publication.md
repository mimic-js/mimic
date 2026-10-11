# Canonical virtual networking, HTTP, and endpoint publication

> Snapshot: 2026-08-22. Current code and maintained tests outrank this note when
> they diverge. Repository conclusions below are explicitly marked as inference.

This resolves Research canonical virtual networking, HTTP, and endpoint
publication (#607).

## Decision

Use three authorities and one shared implementation module:

1. **Virtual Network** remains the sole runtime-local stream-socket authority.
   It owns the virtual socket-address namespace, bound listeners, accepted and
   connected sockets, duplex bytes, backpressure, half-close, refusal, owner
   release, and epoch teardown. It does not own DNS, HTTP, TLS, Fetch,
   WebSockets, cookies, Service Workers, or browser URLs.
2. **Node Compatibility** owns the Node-shaped `net`, `dns`, `http`, `https`,
   and `tls` adapters. Local `net`/HTTP use Virtual Network sockets. Controlled
   external HTTP(S) and WebSocket requests use explicit browser transport
   adapters and report their fidelity limits; they are not presented as raw
   TCP/TLS connections.
3. **Published Endpoint** remains the logical-origin and publication authority.
   It owns stable endpoint identity, URL and route mappings, cookie state,
   HTTP/WebSocket browser routing, stale-route rejection, and route/session
   lifecycle. Its browser host implementation belongs beside this authority,
   not inside Runtime Supervisor Client.
4. **HTTP/1 Codec** remains a small shared protocol module behind both Node HTTP
   and Published Endpoint. It owns incremental HTTP/1 message framing and wire
   validation, not Node objects or browser publication policy.

The shortest target is therefore to **move and merge misplaced implementation,
not combine the three authorities**. Virtual Network and Published Endpoint
have different identities and reasons to change: binding a socket does not make
it browser-reachable, and deleting a browser route must not delete a listener.

## Canonical model and terms

Linux's socket interface separates `socket`, `bind`, `listen`, `accept`, and
`connect`; an accepted socket is distinct from the listening socket
([Linux `socket(7)`](https://www.man7.org/linux/man-pages/man7/socket.7.html),
[Linux `tcp(7)`](https://www.man7.org/linux/man-pages/man7/tcp.7.html)). Node
similarly describes `net` as asynchronous stream-based TCP/IPC servers and
clients, with `Server` producing a new `Socket` for each connection
([Node `net`](https://nodejs.org/api/net.html)). Use that vocabulary:

| Canonical term | Meaning here | Current term/action |
| --- | --- | --- |
| **Virtual Socket Address** | Host/address-family plus port in the runtime namespace | Rename `VirtualAddress`; add family only when IPv6 behavior is implemented |
| **Virtual Listener** | Bound passive socket that accepts connections | Keep `VirtualNetworkListener` responsibility |
| **Virtual Socket** | One endpoint of a connected, full-duplex byte stream | Keep responsibility; do not call it a connection object in types |
| **Virtual Connection** | Relationship between the two connected Virtual Sockets | No new public object; it adds no caller leverage |
| **Duplex Byte Stream** | Ordered bytes, backpressure, half-close, cancellation carried by a Virtual Socket | Behavior, not a fourth authority or exported wrapper |
| **Published Endpoint** | Stable logical browser origin mapped to an explicitly published virtual listener | Keep term and separate authority |
| **Browser Route** | Host-side mapping from a published URL identity to the current endpoint revision | Replace document/manifest/host mapping variants with one owner vocabulary |
| **Outbound HTTP Transport** | Fetch-backed controlled HTTP(S) request/response adapter | Replace the raw-socket-shaped outbound transport |
| **Outbound WebSocket Transport** | Browser `WebSocket`-backed session adapter | Keep distinct from raw sockets and published inbound WebSockets |

Do not add separate `Connection`, `Stream`, `DNS Authority`, or generic
`Browser Adapter` interfaces now. They would have one implementation or repeat
the existing socket interface.

## Current repository evidence

The following are **repository inferences** from current source and maintained
tests, not claims made by external specifications.

- `virtual-network/authority.ts` already supplies one Supervisor-owned listener
  and socket namespace, deterministic port allocation, wildcard/loopback
  matching, byte copying, pause/resume backpressure, half-close, refusal, owner
  release, and disposal. Its service/client repeat the same behavior across
  Worker Transport. The maintained
  [`virtual-network` unit test](https://github.com/mimic-js/mimic/blob/main/tests/unit/virtual-network.test.ts)
  and
  [`virtual-network-v1` browser claim](https://github.com/mimic-js/mimic/blob/main/tests/e2e/mimic-virtual-network.spec.ts)
  protect observable cross-process bytes and lifecycle, not current class/file
  shapes.
- `node-compatibility/network-adapter.ts` correctly owns Node overloads,
  `EventEmitter` ordering, `net.Server`/`net.Socket` projections, and Node error
  translation. `dns.ts` intentionally resolves only loopback and reports
  external record lookup as `ENOTSUP`; `tls.ts` exposes an explicitly limited
  browser-backed client while refusing certificate and server claims.
- `browser-adapters/outbound-network.ts` currently accepts a nominal virtual
  TCP/TLS socket, parses one HTTP/1 request or WebSocket upgrade, then invokes
  Fetch or browser `WebSocket`. That is protocol-aware and cannot carry
  arbitrary socket bytes. The maintained outbound claims protect controlled
  HTTP, HTTPS, and WebSocket behavior and honest rejection, not the fiction
  that Fetch is a TCP/TLS adapter.
- `node-compatibility/http.ts` owns the Node client/server objects and local
  socket protocol, but it also exposes `HttpServerBridge` and browser
  publication/WebSocket handler shapes. Those shapes make Node HTTP know that
  publication exists and should disappear.
- `http-1-wire-codec/codec.ts` is used by Node HTTP and by Published Endpoint's
  HTTP gateway. That is a real two-caller seam. `published-endpoint/http1.ts`
  then repeats response-body framing, chunk, trailer, and EOF logic rather than
  consuming one incremental message codec.
- Published Endpoint has a coherent authority (`authority.ts`, `client.ts`,
  route and cookie policy, host boundary/router), but its concrete Service
  Worker, document-cookie, document-WebSocket, generated-artifact, and host
  lifecycle implementation is misplaced under Runtime Supervisor Client. This
  placement broadens the client for an independently changing browser-host
  reason.
- Maintained claims require: generic plain HTTP publication with honest
  DNS/TLS/HTTPS/HTTP2 limits; public response streaming and explicit fidelity
  failures; revisioned WebSocket routes through Virtual Network; stale URL
  rejection after reboot; and controlled outbound HTTP(S)/WebSocket with no
  arbitrary raw-byte or custom-TLS claim. No maintained claim requires the
  current six route/request structural types, the `HttpServerBridge`, or the
  raw-socket-shaped outbound adapter.

## Prior art and browser constraints

### Sockets, DNS, and outbound transport

Node's `net.Server` has separate listening, connection, error, and close
lifecycle, and its close event waits for existing connections
([Node `net.Server`](https://nodejs.org/api/net.html#class-netserver)). The
Virtual Network interface should preserve those observable ingredients while
leaving Node event timing and errors to the Node adapter.

Node distinguishes `dns.lookup()`, which uses operating-system name-resolution
facilities, from `dns.resolve*()`, which performs DNS queries
([Node `dns`](https://nodejs.org/api/dns.html#implementation-considerations)).
Fetch accepts a URL and runs the browser's fetch algorithm; it does not expose a
DNS-result or TCP socket interface ([WHATWG Fetch](https://fetch.spec.whatwg.org/)).
Therefore outbound name resolution must not invent an IP address. Keep the
current deterministic loopback projection in Node Compatibility; pass an
external hostname to the browser HTTP/WebSocket transport, and keep external
`dns.lookup`/records unsupported until a real resolver or host proxy exists.

The Fetch request/response model filters and combines headers, follows browser
credential/CORS rules, and exposes a body stream rather than raw connection
bytes ([WHATWG Fetch](https://fetch.spec.whatwg.org/#requests)). Browser
`WebSocket` exposes messages and close state, not handshake bytes or a raw
network stream ([WHATWG WebSockets](https://websockets.spec.whatwg.org/)). These
are real, distinct adapters. A raw outbound Virtual Socket adapter should exist
only when a host proxy or browser primitive can actually preserve ordered bytes,
half-close, and connection errors.

### HTTP/1 semantics and codec ownership

HTTP/1.1 message framing depends on request method/status, Transfer-Encoding,
Content-Length, chunk termination, upgrade, and connection close; malformed or
ambiguous framing must be rejected rather than guessed
([RFC 9112 sections 6–7](https://datatracker.ietf.org/doc/html/rfc9112#section-6)).
Node's HTTP interface deliberately streams large and chunked messages instead
of buffering whole messages
([Node `http`](https://nodejs.org/api/http.html)).

Node itself binds `llhttp` behind its HTTP parser implementation and feeds
socket buffers into an incremental parser
([Node parser binding](https://github.com/nodejs/node/blob/main/src/node_http_parser.cc),
[`llhttp`](https://github.com/nodejs/llhttp)). `llhttp` handles fragmented input,
EOF, keep-alive, upgrades, and strict/lenient modes, and warns that leniency can
create request-smuggling exposure. This validates the **seam**, but not a new
dependency here: the repository ships no browser-ready `llhttp`, and adding a
native/WASM toolchain plus callbacks would be larger than the current 247-line
codec before proven compatibility gain.

Keep the codec package-internal and deepen it into one incremental
request/response message parser/serializer. Move the framing loop now duplicated
in `published-endpoint/http1.ts` behind it. Node HTTP retains Node object/event
semantics; Published Endpoint retains conversion between host request/response
values and HTTP/1 messages. Reconsider a pinned `llhttp`-derived browser build
only if focused fuzz/interoperability evidence shows the owned codec cannot
safely meet maintained claims.

Do not claim HTTP/2 or raw TLS. `https` is controlled Fetch-backed HTTP over a
browser-owned TLS connection; `tls.connect` remains limited or unsupported
where certificate, ALPN, session, custom CA, and raw handshake behavior are
observable. The current explicit `ENOTSUP` claims remain truthful.

### Publication, routing, cookies, and WebSockets

A Service Worker can intercept fetches only for clients and URLs within its
registration scope, and `respondWith()` supplies the browser-visible response
([Service Worker specification](https://w3c.github.io/ServiceWorker/#fetch-event-section)).
It is therefore a suitable **browser route adapter**, not a network authority.
Keep one package-owned registration for the singleton runtime epoch, one route
table keyed by opaque epoch/endpoint identity, and one MessagePort to the page
host. Do not create a general router framework.

The smallest publication URL remains the existing same-origin scoped path
`/__mimic__/<opaque-epoch>/<port>/`. A synthetic subdomain would
require DNS/TLS/host configuration the browser runtime does not own. Treat the
URL as an opaque stable descriptor; route revisions prevent a stale URL or
document session reaching a later listener that reused the port.

Cookies are scoped by domain/path/security attributes and selected for requests
according to cookie matching rules
([RFC 6265bis](https://httpwg.org/http-extensions/draft-ietf-httpbis-rfc6265bis.html)).
Because every published URL shares the application origin, native browser
cookies alone cannot model isolated logical origins. Keep one Published
Endpoint cookie jar keyed by endpoint identity and route all host HTTP,
document-cookie, and WebSocket handshake cookie mutations through it. Cookie
state is publication policy, never Virtual Network state.

Service Workers do not host browser WebSocket connections through their fetch
response path. Keep the current minimal document adapter mechanism: inject one
package-owned adapter only into published HTML, resolve the revisioned route,
then relay message/close semantics to the Published Endpoint host. The host
opens a fresh local Virtual Socket to the published listener and performs the
HTTP Upgrade there. Generated program source and duplicated validators should
move with the Published Endpoint browser-host implementation and be generated
from one owner-defined protocol description where build constraints require
standalone source.

Published Endpoint owns all route-bound HTTP requests and WebSocket sessions.
Unpublish, owner release, endpoint replacement, route revision change, browser
host loss, or epoch teardown cancels pending HTTP and closes WebSockets exactly
once. The Runtime Supervisor Client only composes and disposes the host; it does
not export or implement endpoint protocols.

## Merge, keep, reuse, and delete

| Action | Target |
| --- | --- |
| **Keep distinct** | Virtual Network authority, Node Compatibility adapters, Published Endpoint authority |
| **Keep and deepen** | Shared HTTP/1 Codec, with all incremental framing/EOF/chunk/trailer/upgrade validation behind its interface |
| **Merge into Published Endpoint** | Current host boundary/router, cookie jar, document route, Service Worker host, document cookie/WebSocket programs, message-port relay specific to endpoint hosting |
| **Move out of Runtime Supervisor Client** | `published-endpoint-*` implementation and endpoint-specific exports; leave only composition/lifecycle calls |
| **Replace** | `VirtualNetworkOutboundTransport` with explicit Outbound HTTP and Outbound WebSocket transports called by Node adapters; reserve raw outbound sockets for a real byte transport |
| **Delete** | `HttpServerBridge`, its URL field, publication-aware Node HTTP handler types, generic `browser-adapters` wrapper name, duplicated HTTP framing in Published Endpoint, parallel route/request mappings and validators |
| **Reuse platform** | Fetch, ReadableStream/AbortSignal, browser WebSocket, Service Worker fetch routing, MessageChannel/MessagePort at the host seam |
| **Do not add yet** | DNS resolver, router framework, cookie dependency, WebSocket dependency, `llhttp`/WASM dependency, TLS engine, HTTP/2 module |

`PublishedEndpointProtocol = 'http' | 'https'` remains publication metadata, not
a claim that Virtual Network implements either protocol. The endpoint identity
should key on epoch plus virtual listener identity/address; protocol conflict on
one address remains invalid. Browser route protocol versions remain only where
separately built realms genuinely negotiate. In-process structural types and
duplicated manifest/version literals are implementation details, not separate
protocols.

## Target dependency and proof

```text
Node net ───────────────▶ Virtual Network ◀──────── Published Endpoint HTTP/WS gateway
Node local HTTP ────────▶ HTTP/1 Codec ◀────────── Published Endpoint HTTP gateway
Node outbound HTTP/WS ─▶ Browser HTTP/WS transport
Published Endpoint ────▶ browser route + cookie + document/WebSocket host adapters
Runtime Supervisor Client ─▶ compose/dispose Published Endpoint browser host
```

Implementation should preserve or strengthen these checks through the public
seams:

1. Two processes share binding, byte order, backpressure, half-close, refusal,
   owner cleanup, and address reuse through one Virtual Network.
2. Local Node HTTP and Published Endpoint both traverse a Virtual Socket and the
   same strict HTTP/1 codec; neither calls a user's request listener directly.
3. Outbound HTTP(S)/WebSocket claims still pass, while custom TLS and arbitrary
   bytes still fail explicitly; no Fetch adapter satisfies a raw-socket type.
4. Published HTTP keeps incremental bodies, cancellation, duplicate headers
   where representable, informational responses, redirects, and typed failures
   for unrepresentable trailers or malformed/truncated wire data.
5. Cookies remain isolated by endpoint and epoch, including HttpOnly/document
   behavior; stale revisions cannot overwrite current document state.
6. Published WebSockets open, relay, and close once; unpublish and teardown close
   every session; stale routes never reach a rebound port.
7. Architecture checks forbid browser globals in Virtual Network/Node protocol
   code and forbid endpoint protocol implementation in Runtime Supervisor Client.

## Consequences for the map

This resolves the ownership decision without a prototype. Primary-source and
current evidence are sufficient for the same-origin Service Worker mechanism,
the explicit Fetch/WebSocket fidelity boundary, and the shared HTTP codec seam.

It makes two implementation questions precise for later target-architecture
and migration tickets: (1) the exact Node outbound transport interface that
preserves current request lifecycle without raw-socket fiction, and (2) the
expand/migrate/contract order for moving endpoint host artifacts out of Runtime
Supervisor Client while keeping one version-negotiated route protocol. It does
not reveal a genuine new research ticket or unresolved fog patch.
