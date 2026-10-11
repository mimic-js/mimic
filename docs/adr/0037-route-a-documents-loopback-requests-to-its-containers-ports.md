---
status: accepted
amends: ADR-0024 (which requests reach a listener), ADR-0032 (the Service Worker's requests to other origins)
---

# Route a document's loopback requests to its container's ports

A published document is served from its endpoint URL, but the code in it was
written for a developer machine, where every server of the project answers on
`localhost`. `nrwl/react-template` serves its shop on port 4200 and its API on
3333, and the shop's data hooks fetch `http://localhost:3333/api`. From the
preview document that URL is another origin, which the Service Worker sent to
the network: it reached the viewer's own machine and failed (#701). The
document's WebSocket program mapped loopback hosts only to the port that
served the document.

## Decision

**A published document's request to `localhost`, `127.0.0.1` or `[::1]` on a
port its container publishes reaches that endpoint; any other loopback port
still goes to the network.**

- **Where.** The Service Worker receives every request of the documents it
  controls, whatever its origin, so it routes `fetch`, `XMLHttpRequest`,
  `EventSource` and subresources such as `<img>` and `<script>` in one place.
  It routes a request only for a client it already knows as an endpoint
  document, under that document's instance, so one epoch never reaches
  another. A navigation is routed by the scope it lands in, not by this
  worker, and stays on the network.
- **Port to route.** A loopback URL names only a port. The worker asks the
  instance's host for the route that serves it when the request is made,
  because a server may publish after the document loaded (Nx starts the API
  after Vite). The host waits for the publications queued before the request
  and answers with the route, or with none when the port is unpublished or
  serves the other protocol; with none, the worker answers with `fetch` of the
  request unchanged. A worker that lost its host connection asks every window,
  as it does for an endpoint request.
- **What the server sees.** The request reaches the listener as any Published
  HTTP Exchange, with `Host: localhost:<port>` and the requesting document's
  logical origin, such as `http://localhost:4200`, as `Origin`, which the
  browser adds only after the worker. A CORS middleware that allows that
  origin answers as on a developer machine.
- **Response.** The response keeps its own headers, including its CORS
  headers, and its loopback `Location`, which the browser resolves against the
  loopback URL. It is served with `Cross-Origin-Resource-Policy: cross-origin`,
  since it is cross-origin to the document that loads it, so an `<img>` or a
  classic `<script>` loads under `require-corp`. The response exists only
  inside a client this worker controls, so the header widens nothing beyond
  ADR-0032 and ADR-0033.
- **Cookies.** The request is cross-origin to the document, so the Cookie Jar
  of the target endpoint takes part only with `credentials: 'include'`, which
  is when a browser sends and stores another origin's cookies. A WebSocket
  handshake always carries them. Each endpoint keeps its own jar: a browser
  shares `localhost` cookies across ports, and whether the jar should too is
  left to #679.
- **WebSocket.** A browser WebSocket does not pass through a Service Worker,
  so the document's WebSocket program sends a loopback socket to another port
  to its host with the port alone; the host resolves it as above and opens the
  socket on that route, or answers `unrouted`, and the program opens a browser
  WebSocket instead.

## Considered and not done

- **Patching `fetch` and `XMLHttpRequest` in the document.** It misses
  subresources and decides from the route manifest captured when the document
  loaded, so a server published later is unreachable.
- **A port table the host pushes to the worker.** It would let the worker leave
  an unpublished port alone without asking, but the browser stops an idle
  worker and its table with it, and the table must follow every publication.
  One call per loopback request is always current.

## Consequences

- A page that deliberately calls a service on the viewer's real `localhost`,
  at a port its container also publishes, reaches the container instead.
- The browser hands the worker the request itself, without a CORS preflight,
  so a server never receives the `OPTIONS` request it would on a developer
  machine. A response the worker builds is of type `basic`, not `cors`, so the
  document reads all of its headers.
- The Service Worker protocol gains `resolveLoopbackRoute`, the host HTTP
  request a `loopback` field with the request's credentials mode, and the
  WebSocket stream an `unrouted` message. The committed `service-worker.js` is
  regenerated.
- `tests/e2e/mimic-published-loopback-routing.spec.ts` publishes
  an application and, after its document loaded, an API on another port; the
  document reads JSON with CORS through `fetch` and `XMLHttpRequest`, posts
  JSON, keeps a cookie only with `credentials: 'include'`, loads an image and
  echoes over a WebSocket, while an unpublished port still reaches the
  network.
