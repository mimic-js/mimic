---
status: accepted
amends: ADR-0030 (where an endpoint's URL starts), ADR-0032 (what `previewOrigin` may name), ADR-0033 (which origin the Runtime Host document runs on)
---

# Serve each Published Endpoint from an origin of its own

A Published Endpoint is served under
`<scope>/__mimic__/<instance>/<route>/<port>/` (ADR-0030), on the
page's origin or the preview origin (ADR-0032). The document a project's
server returns sees that prefix in `location.pathname`, and so does every
client-side router: Angular's reports `NG04002: Cannot match any routes`,
Ember's an `UnrecognizedURLError`, vue-router under Nuxt 2 its own 404, and
React Router 7, Remix 2, SolidStart 1 and TanStack Router render a mismatch
on hydration and then their 404 page. Thirteen of the demo pool's starters
build and serve, then render nothing
(#706,
[demo pool, 2026-10-09](../research/2026-10-09-demo-app-pool.md)). Rewriting
what the page sees was tried and reverted
([stack parity round, 2026-10-08](../research/2026-10-08-stack-parity-round.md)):
`location` cannot be replaced, the document programs resolve their endpoint
from it, and a reload the browser starts itself cannot be redirected. A server
on a developer machine is the root of `http://localhost:<port>/`; WebContainers
gives every port an origin of its own for the same reason.

## Decision

- **A wildcard preview origin serves each endpoint from the root of an origin
  of its own.** `boot({ previewOrigin: 'https://*.preview.example' })` names
  an http(s) origin whose first hostname label is `*`. An endpoint of port
  `<port>` in epoch `<epoch>` is then `https://<epoch>--<port>.preview.example/`,
  so `location.pathname` is the path the server sees, and a root-relative URL
  needs no rewriting. The label carries the epoch so two containers on one
  deployment never share an origin, and the port only, not the route: a
  server that restarts on its port keeps its address, as it does on a
  developer machine, and the route is the one serving the port at the time
  of a request, as for a loopback request (ADR-0037). A single origin
  (ADR-0032) and the page's own origin (ADR-0030) keep the directory layout
  unchanged, so a deployment without wildcard DNS and certificates needs
  nothing new. The two layouts are one `PublishedEndpointLayout`
  (`published-endpoint/endpoint-layout.ts`), which the page and the Runtime
  Host document derive from the normalized `previewOrigin` and the Service
  Worker script's path, and which decides every endpoint URL, the scope
  document `endpoints.fetch()` frames, and how the Service Worker is bound.
- **The Runtime Host document runs on the wildcard's fixed label.** With a
  wildcard, the page loads `runtime-host.html` from
  `https://mimic.preview.example` (`RUNTIME_HOST_ORIGIN_LABEL`):
  the processes, the Compile Cache and the Package Artifact Cache live on an
  origin no endpoint has, so a published document cannot read what a process
  stored and a process cannot read what a document stored, and the caches
  stay warm across epochs, which a label per epoch would not allow. An
  endpoint's label always contains `--`, so the fixed label collides with
  none.
- **The Service Worker of an endpoint's origin is registered for the root by
  the endpoint origin document.** A document can register a worker on its own
  origin only, so the package ships `published-endpoint-origin.html` beside
  `service-worker.js`. When a port publishes, the Runtime Host document loads
  it in a hidden frame from that port's origin, with its own origin as the
  `host` query parameter and the worker script's path, which a bundler may
  have hashed, as `worker`; the document checks that the script lies in its
  own directory, registers it for `/`, activates it, answers `origin-ready`,
  forwards the host's `host-connect` message with its `MessagePort` to the
  worker, and relays the worker's `host-lost` (ADR-0038) back to its parent.
  The host binds one such frame per port, keeps it while the epoch lives, and
  disconnects them all at teardown, which retires the instance in each
  worker. A scope of `/` from a script under `/assets/` needs the
  `Service-Worker-Allowed: /` response header on the script; the Vite plugin
  sends it for a wildcard `previewOrigin`, and the origin document's error
  names it when a deployment does not.
- **On an origin of its own the Service Worker routes by origin, not by
  path.** Registered for the root, the worker reads `<instance>--<port>` from
  its hostname's first label and sends every same-origin request to that
  endpoint with the route left blank, which the host resolves to the route
  serving the port now. Two things on the origin are the package's rather
  than the endpoint's: a navigation to a document under the worker's own
  directory, which is the origin document loading from the network, and the
  `__mimic__/` directory beside the script, where the worker
  serves the scope document that `endpoints.fetch()` frames (ADR-0030,
  ADR-0032). A subresource under that directory is the endpoint's, so a Vite
  build served from `/assets/` keeps its files. A `Location` to the same
  loopback port becomes a path at the root; one to another loopback port of
  the instance becomes the root of that port's sibling origin. Requests to
  other origins, loopback addresses included, are handled as before
  (ADR-0037), and `hostOrigin`, the embedder policy and the host-liveness
  wait (ADR-0042) keep their meaning.

## Considered and not done

- **Rewriting `location`, `history` and `document.baseURI` in the document.**
  `location` is not configurable; `new URL(location.href)`, `<base>` and
  frameworks that read `window.location` directly would still see the prefix,
  and a reload the browser starts cannot be redirected. The research note
  records the attempt.
- **Rewriting `<base href>` to the prefix.** It would carry Angular's
  `PathLocationStrategy`, which strips the base from the path, and nothing
  else of the thirteen: React Router, Remix, SolidStart, TanStack Router and
  Nuxt take a base from their own configuration, not from the document.
- **One endpoint at the root of a single preview origin.** Which of the
  instance's ports, and of the deployment's instances, a navigation to `/`
  belongs to cannot be told from the request: a frame's reload has no
  endpoint referrer, Chromium reports no `replacesClientId`, and two previews
  of two ports cannot both be `/`.
- **A hostname label per route rather than per port.** Every server restart
  would change the preview's origin, its storage and the open documents, and
  the playground's frame would stay on the old document; a developer machine
  keeps `localhost:4200` across restarts.
- **The Runtime Host document on the apex of the wildcard.** A wildcard
  certificate does not cover the apex, and the apex often hosts something.
  The fixed label is covered by the same certificate and hosts nothing else.
- **Registering the endpoint origin's Service Worker from the embedding
  page.** A page cannot register a worker on another origin; the frame is
  needed either way, and the Runtime Host document, which holds the Published
  Endpoint host, is its owner.

## Consequences

- `BootOptions.previewOrigin` accepts a wildcard; `normalizePreviewOrigin`
  validates it and `runtimeHostOrigin` names the document's origin. The
  Service Worker program tells the layouts apart by its scope; the committed
  `service-worker.js` is regenerated. `published-endpoint-origin.html` is a
  runtime asset (`runtime-assets.ts`, `page-assets.ts`) shipped under
  `dist/assets`; the Runtime Host document receives `previewOrigin` in its
  boot message. The host reaches a Service Worker through one
  `PublishedEndpointServiceWorkerLink`: the worker of its own origin, or the
  origin document's frame.
- The Vite plugin adds `Service-Worker-Allowed: /` for a wildcard
  `previewOrigin`; the README's preview-origin section documents the
  wildcard, the header and that every hostname of the wildcard must serve the
  package's assets. In development `http://*.localhost:<port>` is such a
  wildcard on one Vite server: Chromium and Firefox resolve every
  `*.localhost` to the loopback address, treat it as a secure context, and
  Vite allows the hosts by default.
- `tests/e2e/mimic-endpoint-origin.spec.ts` boots against
  `http://*.localhost:4179` and proves an endpoint's origin and root path,
  that a client-side router renders its index route, pushes a nested path and
  renders it again after a reload the document starts itself, that a
  subresource under the package's directory is the application's, and that
  `endpoints.fetch()`, redirects to the same and to another loopback port,
  the Cookie Jar and loopback requests work there. The directory layout's
  claims are unchanged.
- The repository playground defaults to `http://*.localhost:5173` in
  development (`.env.development`), with `strictPort` so the origin names the
  port the server has, and keeps the page's origin for a production build
  unless `VITE_PREVIEW_ORIGIN` names a deployment's wildcard. The demo pool's
  rerun under the wildcard is the evidence #706 asks for and is left to it.
- What the preview origin's trust model loses and keeps: a project owns its
  endpoint's origin as it would own `localhost:<port>`, so it may register a
  Service Worker there or navigate within it; it still reaches the page only
  through what the container serves, and now its processes and its documents
  are on different origins too. A page of the application whose path lies
  under the directory the package's files are served from, such as
  `/assets/page.html` after a Vite build of the embedding application, is the
  one path an endpoint's origin does not answer with the server's document.
