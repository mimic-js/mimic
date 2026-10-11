---
status: accepted
amends: ADR-0020 (what the page keeps), ADR-0032 (the open step it names; the bridge document)
amended-by: ADR-0044 (with a wildcard preview origin the document runs on its fixed label, and an endpoint origin document registers each endpoint origin's Service Worker)
---

# Run the Runtime Host in a frame of the preview origin

ADR-0032 moved the documents a project publishes to a preview origin and left
its second finding open: the project's processes still run in dedicated
workers of the embedding page's origin. The security audit of 2026-10-06
([research](../research/2026-10-06-runtime-security-audit.md), finding 2)
shows what that means. A process worker is a same-origin module worker
(`runtime-host/runtime-assets.ts`), a program's global is
`Object.create(globalThis)` and its modules are evaluated with indirect `eval`
in the worker's own scope, so any identifier Node Compatibility does not shadow
resolves to the real `fetch`, `XMLHttpRequest`, `WebSocket`, `Worker`,
`indexedDB`, `caches` and `navigator.storage` of the page's origin. The
runtime's own HTTP and TLS clients send `credentials: 'omit'`; a program's
direct `fetch('/api/me')` does not. A `postinstall` script in a repository the
playground opens can call the application's API with the user's cookies and
read the application's storage. `previewOrigin` protects the page from what a
project publishes, not from what it runs.

Everything between the page and the Runtime Host Worker already travels over
the one typed RPC of ADR-0019: `RuntimeHostWorkerApi` and `RuntimeHostMainApi`
carry paths, strings, `ArrayBuffer`s and notifications, and no
`SharedArrayBuffer` crosses that boundary (`runtime-host-protocol.ts`). The
transport accepts a `MessagePort` as readily as a `Worker` (`rpc.ts`). The
boundary can therefore move to another origin without changing what crosses
it.

## Decision

- **The Runtime Host runs in a document of the origin that serves the
  endpoints.** `boot()` loads `runtime-host.html`, shipped beside
  `service-worker.js`, from `previewOrigin` in a hidden frame, and the
  document creates the Runtime Host Worker, registers the Service Worker,
  holds the Published Endpoint host (Service Worker binding, listener
  registry, Cookie Jar) and the asynchronous clients, exactly what
  `bootRuntimeHost()` composes on the page today. The page keeps the
  `Mimic` facade and nothing else of the runtime. Project code in
  the process workers then holds the ambient authority of the preview origin,
  which hosts nothing, instead of the page's. The Runtime Host remains the one
  owner of the epoch's lifetime and composition; the frame document is a
  browser-placement collaborator beneath it, as the glossary already requires.
- **The frame is the only path.** Without `previewOrigin` the same document is
  loaded from the page's own origin. One composition, one set of tests, and a
  same-origin deployment still needs nothing but itself. The cost is a frame
  and a `MessagePort` where there was a `Worker`; the page spoke to the host
  over `postMessage` before, so no call gains a hop (see the next point).
- **The page's port reaches the Runtime Host Worker directly.** `boot()` opens
  a `MessageChannel`, posts one end to the frame document with its options,
  and the document transfers it into the Runtime Host Worker, which serves
  `RuntimeHostWorkerApi` on it. The document keeps a second connection to the
  worker for the parts of `RuntimeHostMainApi` that need a window: the
  listener registry, which hands listener ports to the Service Worker host,
  and the host connection to the Service Worker. The lifecycle result
  (`terminated`) and the process and endpoint events are served to the page on
  its own port. Teardown is unchanged for the facade: `teardown()` is a call
  on the port, the terminal result arrives on it, and the frame is removed
  after it. A frame that unloads or crashes closes the port, which the facade
  already reports as the connection closing unexpectedly.
- **The frame is cross-origin isolated by delegation.** The Runtime Host
  Worker and its process workers need `SharedArrayBuffer` for the Synchronous
  Channel of ADR-0025, and a cross-origin frame is not cross-origin isolated by
  default even when the page has `Cross-Origin-Opener-Policy` and
  `Cross-Origin-Embedder-Policy` and the frame's document has
  `Cross-Origin-Embedder-Policy`: the `cross-origin-isolated` permissions
  policy allows `self` only. The package sets
  `allow="cross-origin-isolated"` on the frame it creates. Measured in Chromium
  141 on 2026-10-06 with the two origins of one server: without the attribute
  `crossOriginIsolated` is false in the frame and `SharedArrayBuffer` is
  undefined; with it both the frame and a dedicated worker it creates are
  isolated and a `SharedArrayBuffer` transfers between them, for every
  combination of `require-corp` and `credentialless` on the page and on the
  frame. The embedding page still needs both headers, since the top-level
  document decides the browsing context group; `boot()` keeps that check and
  the frame document adds its own, so a preview origin without
  `Cross-Origin-Embedder-Policy` on its documents and worker scripts fails
  with an error that names it. A dedicated worker script is also checked
  against its owner's embedder policy, so the preview origin must send
  `Cross-Origin-Embedder-Policy` on the package's worker scripts, not only on
  its documents; the README's rule of sending the headers on every response
  already covers it, and the error names the script when a deployment does
  not.
- **The frame loads prebuilt assets by URLs the page resolves.** A bundler
  rebuilds a worker graph only behind `new Worker(new URL(…, import.meta.url))`;
  a script a document loads through a `new URL` reference is copied as a file,
  its own imports and workers untouched. The package's asset build therefore
  prebuilds the frame document's script and every worker it starts as
  self-contained files (`generated/runtime-host/`, built by
  `scripts/runtime-host-assets.ts` with one Vite library build per file), as
  it already does for `service-worker.js`, and one page module,
  `page-assets.ts`, references each with `new URL('./…', import.meta.url)`
  so a bundler copies them and may hash them; the Service Worker script, the
  SQLite engine's glue and binary and the Runtime Host document itself are
  named the same way. The page passes the resolved URLs to the frame document
  in one asset manifest, moved to the document's origin; the document checks
  that each lies on its own origin, starts the Runtime Host Worker from the
  manifest, and the worker passes it on to every process worker at start, so
  `runtime-assets.ts` and `node:sqlite` load by name and never by
  `import.meta.url`. Consumers' bundlers then process no worker of the
  package, which removes the reason for the Vite plugin's
  `worker.format: 'es'` and for webpack's worker handling; `optimizeDeps`
  exclusion stays, since pre-bundling still breaks `import.meta.url`
  references.
- **The bridge document is retired.** With the Runtime Host in a document of
  the endpoints' origin, the Service Worker is registered by a same-origin
  document again and `host-connect` is posted to it directly, as ADR-0030 had
  it. `published-endpoint-bridge.html` and the relay of `host-connect` go.
  `hostOrigin` on the Service Worker protocol keeps its meaning, the
  embedding page's origin, which the Runtime Host document names when it
  connects: the worker serves an instance's documents embeddable by that
  origin and the scope document answers `fetch` for it. `endpoints.fetch()`
  keeps its own frame of the scope document and the cross-origin `fetch`
  service of ADR-0032, since the page is cross-origin to the endpoints
  whenever a preview origin is named.
- **Endpoint documents reach their host through the Service Worker.** An
  endpoint document used to post its WebSocket and cookie connections to
  `window.parent`, which was the host page. The host is now a hidden frame
  that is never the document's parent: the embedding page frames the
  endpoint, or a tab opened it. The document posts the connection's port to
  the Service Worker that serves it (`navigator.serviceWorker.controller`),
  and the worker forwards the port to the host of the document's instance
  over its host connection (`documentConnect`). A document opened in its own
  tab, which had no parent to post to, reaches its host the same way.
- **What the preview origin's storage holds changes.** The Compile Cache in
  the origin private file system (ADR-0023) and the Package Artifact Cache move
  with the Runtime Host to the preview origin, where Chromium and Firefox
  partition them by top-level site. A browser that denies storage to a
  cross-site frame must leave both caches in memory for the epoch: the
  Compile Cache already does so when the origin private file system is
  unavailable, and the Package Artifact Cache, which today chooses the origin
  private file system by the presence of `navigator.storage.getDirectory` and
  fails every request when that call rejects, falls back to its memory cache
  on that rejection. Nothing of a project is stored on the page's origin any
  longer.

## Considered and not done

- **Hiding the page's `fetch`, storage and `Worker` from program code.** The
  program global inherits from the worker's real global, and modules are
  evaluated in that realm; a shadowing layer is bypassed by any reference the
  layer forgot, by `Function('return this')()`, or by a prototype walk. Only
  the origin boundary is enforced by the browser.
- **Running the process workers on the preview origin while the Runtime Host
  Worker stays on the page.** A worker cannot be created on another origin
  from a page; it inherits its creator's origin. A frame of the preview origin
  is needed either way, and a Runtime Host split across two origins would
  relay every Virtual File System and Virtual Network call of a process
  through the page, which ADR-0020 removed.
- **Keeping the same-origin composition without a frame as a second path.**
  Two compositions of `bootRuntimeHost()`, two failure models and two sets of
  maintained tests for one facade. The frame on the page's own origin costs
  one hidden element.
- **Relaying the page's calls through the frame document.** The document
  would implement `RuntimeHostWorkerApi` a second time to forward it. The port
  is transferable, so the worker serves the page directly.
- **Letting the consumer's bundler rebuild the frame's script.** Vite and
  webpack copy a `new URL` reference to a script verbatim; neither follows the
  imports or the `new Worker` calls inside a file a document loads. A
  Vite-only `?worker&url` import would tie the package to one bundler and
  still leave nested workers unbundled for a document.
- **Moving the Published Endpoint host into the Runtime Host Worker.** The
  Service Worker host and the Cookie Jar would run in a worker, which has no
  `navigator.serviceWorker.register` and receives no window `message` events
  from endpoint documents. The document keeps them; they are what the frame is
  for.
- **A sandboxed frame.** As ADR-0032 found, `sandbox` without
  `allow-same-origin` gives the document an opaque origin, which no Service
  Worker controls and no storage serves; with it the frame is the preview
  origin anyway.

## Consequences

- **The boundary ships with the package rather than with its documentation.**
  A consumer can isolate the page's origin alone today, by deploying the page
  that calls `boot()` on an origin of its own. That holds only while nothing
  of value is on that origin, and an application's UI almost always holds
  something: the user's session to save a project, a token to open a private
  repository, an API that accepts its cookies. Keeping the UI with the
  container moves the credentials next to the project's code; keeping the UI
  on the application's origin and the container on a headless origin needs
  an RPC for every file write, spawn and endpoint event, which is this
  package's facade written again by each consumer. This ADR makes the
  package's existing port cross that boundary once, so the same facade serves
  both layouts, as WebContainers' does. Until a consumer holds credentials on
  the page that boots a container, deploying that page on a throwaway origin
  is the cheaper measure and the playground may use it; this ADR is the step
  for the first consumer that cannot.
- The runtime becomes a sandbox for a project's processes in the sense of the
  audit: with a preview origin configured, a program reaches the page only
  through what the Runtime Host serves on the port, and its ambient `fetch`,
  storage and workers belong to an origin that hosts nothing. What remains and
  is documented in the README: a project spends the tab's CPU, memory and
  worker budget, bounded only by Process Execution's capacity and the limits
  of audit findings 5 and 9; the preview origin serves any page that embeds its
  document, so it must host nothing else; previews and processes share the
  preview origin, so a project reads what it published, which is its own; and
  a hostile project can still fill the Compile Cache and the Package Artifact
  Cache of the preview origin, which findings 3 and 4 made safe to share.
- `runtime-host.html` and the prebuilt `runtime-host-document.js`,
  `runtime-host-worker.js`, `node-process-worker.js`,
  `wasi-runtime-worker.js` and `runtime-artifact-compiler-worker.js` under
  `dist/assets`, beside the Service Worker, the SQLite engine and the
  document; `published-endpoint-bridge.html` is removed.
  `scripts/build-runtime-assets.mjs` prebuilds the five bundles into the
  ignored `generated/runtime-host/` directory through
  `scripts/runtime-host-assets.ts`, and `scripts/check-package-distribution.ts`
  checks that every file the entry names is shipped. `runtime-host.ts` keeps
  the page-side client of the port and opens the frame through
  `host-document-frame.ts`; `runtime-host-document.ts` is the frame
  composition; `worker-entry.ts` is how a Runtime Host worker meets its two
  peers; `worker-epoch.ts` serves the page's port and the document's
  connection, with the listener registry and `closing()` on the document's
  side (`RuntimeHostDocumentApi`) and lifecycle events to both;
  `runtime-assets.ts` names the assets and `page-assets.ts` resolves them;
  `node:sqlite` takes its engine's URLs from the process start message. The
  Service Worker protocol gains `documentConnect` on the host API, and the
  committed `service-worker.js` is regenerated.
- The page needs `document` to call `boot()`, as it does today for the bridge
  and the `endpoints.fetch()` frame; the embedding page's `Permissions-Policy`
  must not forbid `cross-origin-isolated` for the preview origin, which the
  README states next to the headers.
- The Vite plugin drops `worker.format`; the README's webpack section drops
  the sentence about following `new Worker` references; the headers table
  gains the note that worker scripts of the preview origin carry
  `Cross-Origin-Embedder-Policy`.
- `tests/e2e/mimic-preview-origin.spec.ts` gains the claim that a
  program's ambient origin is the preview origin, that its `indexedDB` is
  that origin's and holds nothing of the page's, that it has no document, and
  that removing the Runtime Host frame fails the container with
  `RuntimeEpochFailedError` and lets the page boot again. The same-origin
  claims are unchanged and prove that the frame on the page's own origin is
  invisible to them. A test that must reach the Runtime Host Worker, which the
  page no longer creates, serves its script through a Playwright route and
  speaks to it over a `BroadcastChannel` of the shared origin
  (`tests/e2e/runtime-host-worker-hook.ts`,
  `tests/e2e/terminal-runtime-host-worker.ts`); a hook acknowledges each
  message, since a channel message is not ordered with the page's calls over
  the worker's port. The Playwright project runs Chromium only; the isolation
  measurement above is to be repeated in Firefox and Safari, since Safari
  supports `require-corp` only and may deny storage to a cross-site frame.
- ADR-0020's "the page keeps the public facade only" is amended to the facade
  alone, ADR-0032's open step is closed, `CONTEXT.md` names the Runtime Host
  Document and no longer the bridge, the audit's finding 2 and residual risk
  are updated, and `roadmap-alignment.md` states the trust model this ADR
  leaves.
- The Package Artifact Cache keeps its entries in memory when
  `navigator.storage.getDirectory()` rejects, as the Compile Cache already
  did; whether a browser denies storage to the cross-site frame at all is part
  of the Firefox and Safari measurement.
