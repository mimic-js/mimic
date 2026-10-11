# Research: deterministic Vite page reloads and optimized dependency generations

> Snapshot note: source findings and dated evidence are retained, but repo-specific
> “current state” statements may be obsolete. Verify them against current code,
> tests, issues, and [`compatibility-status.md`](../compatibility-status.md). See
> [the research status rules](./README.md).

## Scope

This note defines the ownership and recovery model for hard reloads of browser-resident Vite previews. It covers Vite 6.4.3 dependency optimizer generations, `?v=` URLs, VFS commit behavior, Service Worker routing, browser HTTP caching, and `504 Outdated Optimize Dep` responses.

The target is not to suppress Vite's stale-generation signal. The target is to ensure that a preview either loads one coherent optimizer generation or performs one controlled navigation to the current generation without a blank iframe, an unrelated fallback, or an infinite reload loop.

## Primary evidence

- [Vite dependency pre-bundling documentation](https://vite.dev/guide/dep-pre-bundling.html) says optimized dependencies live under `node_modules/.vite`, use version query parameters for browser-cache invalidation, and are served with `max-age=31536000,immutable`.
- [Vite 6.4.3 optimizer source](https://github.com/vitejs/vite/blob/v6.4.3/packages/vite/src/node/optimizer/index.ts) builds into `deps_temp_*`, writes `_metadata.json`, then commits by renaming the old `deps` directory away and the processing directory to `deps`.
- [Vite 6.4.3 optimized-deps plugin](https://github.com/vitejs/vite/blob/v6.4.3/packages/vite/src/node/plugins/optimizedDeps.ts) compares the request's `?v=` browser hash with current metadata before and after processing. A mismatch is intentionally classified as an outdated optimized dependency.
- [Vite 6.4.3 transform middleware](https://github.com/vitejs/vite/blob/v6.4.3/packages/vite/src/node/server/middlewares/transform.ts) maps outdated or closed optimizer requests to HTTP 504 and sends immutable caching headers for dependency URLs.
- [Vite issue #14284](https://github.com/vitejs/vite/issues/14284) demonstrates that optimizer discovery/commit timing can expose a stale URL and blank page, rather than proving that every 504 is a network timeout.
- The [Service Worker specification](https://w3c.github.io/ServiceWorker/) defines fetch interception and client association. Service Worker activation does not make application-level optimizer state atomic.

## Verified Vite behavior

### A browser hash identifies a dependency graph generation

Vite injects `?v=<browserHash>` into optimized dependency URLs. The hash is not cosmetic cache busting: the optimized-deps plugin rejects a URL when its hash does not match the active dependency metadata. A response assembled from a current entry and an older shared chunk is therefore invalid even if both files exist.

Browser verification on 2026-06-22 exposed a Vite 6.4.3 built-output edge: `optimizedDepsPlugin.load()` calls `cleanUrl(id)` before applying `DEP_VERSION_RE`, so an already committed stale `?v=` can reach the current file as `200 OK` even though the active `depsOptimizer.metadata.depInfoList` entry has a different `browserHash`. Mimic therefore validates optimized-dependency requests against that active in-memory Vite metadata at the virtual HTTP boundary. A mismatch preserves the original URL and returns reason-coded `504 Outdated Optimize Dep`; it does not rewrite the hash or serve a VFS fallback.

The same browser matrix also separated two non-optimizer failures. First, Vite HMR dynamic imports can arrive without a usable referrer, so preview routing retains a runtime-scoped Service Worker client association for subresources; an unowned document navigation clears that association before host modules load. Second, the Service Worker transport deadline must exceed the virtual HTTP handler's 30-second response deadline. A 10-second MessagePort timeout incorrectly converted a still-running real Vite transform into an unrelated `504 Gateway Timeout`; the gateway now waits 35 seconds and keeps that failure distinct from `Outdated Optimize Dep`.

### Commit is directory-atomic on a normal filesystem

Vite does not publish optimizer output file by file. It writes the processing directory and metadata first, renames the previous committed directory aside, and renames the complete processing directory into place. Consumers should observe either the previous committed tree or the next committed tree.

Mimic's `VirtualFileSystem.renameSync()` changes the in-memory tree before emitting watcher events, so reads inside one worker already have directory-atomic visibility. The worker-to-main mirror is not equivalent: a directory rename is currently reduced to `rm` plus `mkdir` mutations and does not transfer the renamed subtree. This does not affect a request served wholly by the worker today, but it is an explicit consistency gap for diagnostics, exports, restarts, and any future main-thread reader.

### A 504 can be a generation signal, not transport failure

The same status currently represents at least three distinct conditions:

1. Vite rejected an old browser hash (`Outdated Optimize Dep`).
2. Vite's optimizer failed or was still processing.
3. Mimic's virtual HTTP bridge timed out waiting for a response.

Recovery must use the Vite status message or a runtime diagnostic reason. Retrying every 504 would hide real server failures and can loop forever.

### Browser and Service Worker caches have different ownership

`mimic-sw.js` routes preview requests but does not put responses into Cache Storage. The browser HTTP cache still honors Vite's immutable dependency headers. The Service Worker owns routing to a runtime instance and port; it must not rewrite a stale dependency URL to a different hash because that can combine two dependency generations in one module graph.

Service Worker updates (`skipWaiting()` and `clients.claim()`) change which worker controls a client. They do not invalidate Vite optimizer metadata, the browser HTTP cache, or an iframe's already evaluated module graph. Those lifecycles need separate generation identifiers and diagnostics.

## Ownership contract

| State | Owner | Required invariant |
| --- | --- | --- |
| Staging optimizer files | Vite process worker | Never served as a committed generation |
| Active `_metadata.json` plus `deps` tree | Vite process worker/VFS | Published as one generation |
| Mirrored VFS tree | Process protocol | A directory rename transfers one complete subtree or an explicit snapshot transaction |
| Preview request routing | Service Worker | Preserve path and query exactly; bind request to one instance and port |
| Immutable dependency response cache | Browser HTTP cache | Keyed by the full URL including `?v=` |
| Stale-generation recovery | Preview lifecycle | At most one controlled reload for one observed generation transition |
| Retry/reload diagnostics | Runtime event stream | Distinguish outdated hash, optimizer failure, bridge timeout, and missing file |

## Selected design

1. Preserve Vite's generation semantics. Do not strip `?v=`, rewrite it to the current hash, or serve an arbitrary current file for an old URL.
2. Make VFS directory replacement an explicit process-protocol mutation. The receiver applies the complete replacement synchronously and emits watcher events only after the tree is installed.
3. Carry HTTP status text or a normalized failure reason through the virtual HTTP response and preview diagnostics. `504 Outdated Optimize Dep` must be distinguishable from bridge timeout.
4. On the first outdated-generation response for a preview navigation, wait until the active optimizer metadata and referenced files are committed, then reload the iframe URL once with a recovery nonce owned by the preview lifecycle. A second outdated response for the same active generation is a hard failure with diagnostics.
5. Do not retry JavaScript module requests individually against a different generation. Navigation is the coherence boundary because it rebuilds the browser module graph from fresh HTML/source transforms.
6. Keep Service Worker routing state independent from optimizer state. A controller change may reconnect a runtime port, but it must not claim that optimizer recovery succeeded.

## Rejected shortcuts

- Removing the `v` query hides stale-generation detection and defeats immutable-cache invalidation.
- Rewriting old hashes to current files can mix generations and produce subtler runtime failures.
- Serving optimized files through `vfsPreviewFallback` bypasses Vite's metadata checks and is forbidden proof.
- Blindly retrying all 504 responses conflates optimizer state with a real virtual HTTP timeout.
- Clearing all browser storage on every reload avoids the symptom but destroys Vite's intended cache behavior and does not prove atomic commits.

## Verification sequence

1. Add a Playwright reproduction that records every optimized dependency URL, response status/status text, iframe navigation id, Service Worker version, and optimizer metadata hash across repeated hard reloads.
2. Assert that the fixture initially loads real Vite-optimized output with browser caching enabled.
3. Reload vanilla, TypeScript, React, Vue, Solid, and Svelte previews repeatedly without reinstalling packages.
4. Trigger one optimizer generation change and prove the preview performs no more than one controlled navigation to the new generation.
5. Fail on blank iframe content, stale hash reuse after recovery, 504, page/module error, `vfsPreviewFallback`, or adapter execution.
6. Add a process-protocol test proving a committed `deps_temp_* -> deps` directory replacement arrives in the mirrored VFS as one complete tree including `_metadata.json`.

## Implementation order

1. Browser reproduction and reason-coded diagnostics.
2. Transactional directory-replace protocol and test.
3. Controlled one-shot preview recovery for the outdated-generation reason only.
4. Repeated-reload matrix across all browser fixtures.

This order keeps the first implementation change evidence-driven and prevents a generic retry from becoming permanent architecture.
