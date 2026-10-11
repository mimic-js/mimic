---
status: accepted
amends: ADR-0030 (where the Service Worker is registered and which origin serves endpoints)
amended-by: ADR-0033 (the Runtime Host runs on the preview origin too; the bridge document is retired), ADR-0044 (a wildcard preview origin serves each endpoint from an origin of its own)
---

# Serve Published Endpoints from a preview origin

ADR-0030 serves Published Endpoints from the embedding page's own origin,
under the `__mimic__/` directory beside the Service Worker script,
and declined a second origin because "it would need a host the package does
not own". The security audit of 2026-10-06
([research](../research/2026-10-06-runtime-security-audit.md), finding 1)
shows what that costs: the documents a project's server returns are
application code, and on the page's origin they read the page's DOM through
`window.parent`, its `localStorage`, IndexedDB and origin private file system,
its cookies, and call the application's API with the application's
credentials. The repository playground, which opens any public repository,
embeds such a document in a frame. `sandbox` on that frame is no answer: a
document with an opaque origin is not controlled by the Service Worker and
does not load.

## Decision

- **`boot({ previewOrigin })` names the origin that serves the endpoints.** It
  is an `http:` or `https:` origin, such as `https://preview.example`, and is
  normalized by the facade; the page's own origin means the same-origin
  layout of ADR-0030, which stays the default so a deployment needs nothing
  but itself. The consumer serves the same build from that origin: the
  package's assets at the same path, with `Cross-Origin-Embedder-Policy` and
  `Cross-Origin-Resource-Policy: cross-origin`. The Vite plugin's
  `previewOrigin` option sends the third header in development, where
  `http://localhost:<port>` beside `http://127.0.0.1:<port>` is a second
  origin of the same server.
- **A bridge document registers the Service Worker on the preview origin.** A
  page cannot register a worker on another origin, so the package ships
  `published-endpoint-bridge.html` beside `service-worker.js`. `boot()` loads
  it from the preview origin in a hidden frame with the page's origin as its
  `host` query parameter and the worker script's path, which a bundler may
  have hashed, as `worker`; the bridge checks that the script lies in its own
  directory, registers it for the scope beside itself, activates it, answers
  `bridge-ready`, and forwards the page's `host-connect` message, with its
  `MessagePort`, to the worker, after checking that the message comes from
  that origin. The worker then speaks to the page directly over the port. A
  document under the endpoint directory is never accepted as a host, since it
  is application code; the `hostOrigin` a host names decides only how that
  host's own instance is served.
- **Endpoint URLs, documents and the page's requests follow the origin.** The
  epoch's base URL is the scope on the preview origin. The worker serves an
  instance's documents with `Cross-Origin-Resource-Policy: cross-origin` when
  its host origin differs from its own, so the page may frame them. The
  document programs post their connections to the host origin the injected
  configuration names, and the page accepts a window message as a connection
  only from the origin that serves the endpoints. `endpoints.fetch()` keeps
  its hidden frame of the scope document; when that frame is cross-origin the
  scope document serves `fetch` over a `MessagePort` on the one typed RPC
  (ADR-0019): request head and body in, response head and body out, bodies as
  transferred streams where the browser transfers them and as bytes where it
  does not, and an abort notification.
- **The preview origin serves whoever embeds its bridge.** The bridge answers
  the origin that names itself in its query parameter, so a dedicated preview
  origin may be used by any page that can load it. Nothing else should be
  hosted on that origin.

## Considered and not done

- **`sandbox` on the preview frame.** Without `allow-same-origin` the frame's
  document has an opaque origin, which no Service Worker controls, so the
  endpoint does not load; with it the frame is the page's origin again.
- **Running the process workers on the preview origin too.** Project code in
  the workers keeps the page origin's ambient authority (audit finding 2).
  Moving them means running the Runtime Host Worker inside a frame of the
  preview origin and relaying the facade over `postMessage`; this ADR leaves
  that open as the step that would make the runtime a sandbox.
- **Re-implementing `fetch` over the host RPC for the page.** Rejected by
  ADR-0030 and still so: the scope document's own `fetch` already has
  redirects, caching and streaming, so the cross-origin path forwards one call
  to it rather than rebuilding it.
- **A fixed preview hostname pattern, as WebContainers has.** The package has
  no hostnames of its own; the consumer's deployment names the origin.

## Consequences

- `BootOptions.previewOrigin`, `RuntimeHostOptions.previewOrigin`, the Vite
  plugin's `previewOrigin`, and a `published-endpoint-bridge.html` asset.
- The Service Worker protocol carries `hostOrigin` on `host-connect`, keeps a
  host origin per instance, and the scope document carries the Worker
  Transport as text to serve `fetch`. The committed `service-worker.js` is
  regenerated.
- `tests/e2e/mimic-preview-origin.spec.ts` boots against
  `http://localhost:4179` from `http://127.0.0.1:4179` and proves the
  endpoint URL's origin, that neither the page nor the preview reads the
  other's document, and that `endpoints.fetch()`, the Cookie Jar and
  in-document requests work. The same-origin claims are unchanged.
- The repository playground reads `VITE_PREVIEW_ORIGIN`, passes it to `boot()`
  and the plugin, and says in its header that the repository's code runs in
  the tab.
