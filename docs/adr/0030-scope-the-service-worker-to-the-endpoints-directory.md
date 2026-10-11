---
status: accepted
amends: ADR-0027 (the Service Worker's scope and the `Service-Worker-Allowed` header)
amended-by: ADR-0032 (a configurable preview origin; the same-origin layout stays the default), ADR-0044 (an origin per endpoint, where the worker takes the root and the endpoint URL has no directory prefix)
---

# Scope the Service Worker to the endpoints directory

`Mimic.boot()` registered the Published Endpoint Service Worker for
the scope `/`, took control of every page of the embedding application with
`clients.claim()`, and let every request of those pages through its `fetch`
handler: a request that named no endpoint still waited for `clients.get()`
before the worker fetched it from the network. A consumer with a Service Worker
of its own (a PWA, an offline cache) lost it: a registration for the same scope
replaces the script, and `skipWaiting()` made the replacement immediate. The
reverse held too: an application registering its own worker for `/` later
silently took the endpoints with it. The scope also required the third response
header of ADR-0027, `Service-Worker-Allowed: /`, because bundlers emit the
script in an assets directory and a script may only take a scope above its own
directory when its response allows it.

## Decision

- **The scope is the `__mimic__/` directory beside the script.**
  The page registers `service-worker.js` for `new URL('./__mimic__/',
  scriptUrl)`: `/assets/__mimic__/` after a Vite build,
  `/src/runtime/modules/published-endpoint/__mimic__/` on the
  package's own development server. Every Published Endpoint URL is
  `<scope><epoch>/<route>/<port>/…`, and the worker reads its prefix from
  `self.registration.scope`. The scope is under the script's directory, so no
  `Service-Worker-Allowed` header is needed; ADR-0027's header list is two.
- **The embedding page is outside the scope.** It keeps whatever Service
  Worker controls it, or none; `boot()` waits for the registration's own
  worker to activate instead of `navigator.serviceWorker.ready`, which only
  answers for a page the registration covers. Endpoint documents are
  controlled by the Published Endpoint worker because their navigation URL is
  under its scope, and a request from such a document is routed whatever URL
  it names, so the absolute `/src/main.js` references a development server
  emits keep working.
- **The page requests endpoints through the container.** A request is routed
  by the document that makes it, so the page's own `fetch` no longer reaches an
  endpoint. `container.endpoints.fetch(input, init)` does, with `fetch`
  semantics: it runs in a hidden frame of the scope document, which the worker
  serves itself at the scope URL, opened on the first request and removed with
  the epoch.
- **Retired epochs are bounded.** The worker remembers the last 64 retired
  epoch ids to answer their URLs with 404 rather than racing the pages.
- **The worker serves this origin only, with the page's embedder policy.** A
  preview's request to another origin is not routed into the container; it
  goes to the network, where the embedding page's
  `Cross-Origin-Embedder-Policy` decides. `boot({ embedderPolicy })` names
  that policy (`require-corp` by default, or `credentialless`), the host
  passes it at `host-connect`, and the worker serves endpoint documents with
  the same one, so a preview may load what its page may. The Vite plugin
  takes the same option.

## Considered and not done

- **Keeping the scope `/` and passing non-endpoint requests through without
  `respondWith`.** The worker cannot tell synchronously whether a request
  without an endpoint referrer comes from an endpoint document whose
  association it lost with a restart, and it would still replace the
  application's own worker and start before every navigation of the site.
- **Serving endpoints from a second origin, as WebContainers does.** It would
  need a host the package does not own; the same-origin directory keeps the
  package self-contained. ADR-0032 adds it as the consumer's option, with
  this layout as the default.
- **Reimplementing `fetch` over the host RPC for the page.** Redirect
  handling, interim statuses, trailers and streaming request bodies would be
  written a second time; the browser's own `fetch` from a controlled document
  already has them.
- **Unregistering a worker an older build left at `/`.** The package has no
  published consumers yet; an upgrade path can be added when it does.

## Consequences

- Consumers configure two headers, not three. The Vite plugin, the README and
  the consumer harnesses send two.
- `tests/e2e/mimic-service-worker-routing.spec.ts` registers an
  application Service Worker for `/` before `boot()` and proves that it still
  controls the page while an endpoint document loads and
  `endpoints.fetch()` answers.
- Maintained tests that requested endpoints with the page's `fetch` use
  `endpoints.fetch()` or the served document's own window. A retired epoch's
  URL is requested while a newer epoch can still request it.
- A Service Worker an earlier build registered for `/` stays installed until
  the application unregisters it; it no longer routes endpoints, since the
  endpoint directory is the longer match.
