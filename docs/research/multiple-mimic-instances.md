# Research: concurrent Mimic instances

> Snapshot note: this is a point-in-time investigation of commit
> [`7538f79`](https://github.com/mimic-js/mimic/tree/7538f79d81b51e1da39045d91d8115e7d9b89026)
> and the public WebContainer documentation read on 2026-07-19. Repo-specific
> current-state statements must be rechecked against maintained code and tests.
>
> Subsequent architecture decision: the current Headless Runtime Core effort
> retains the official temporal-singleton contract. Concurrent instances are
> feasible but deferred to a separate future effort.

## Question

Does the official StackBlitz WebContainer API permit multiple concurrent
instances, is its singleton a browser constraint, and can this repository's
target architecture support more than one `Mimic`?

## Conclusion

The official StackBlitz API is a **temporal singleton**: only one WebContainer
may be live at a time, and another may be booted after `teardown()`. That is the
current product/API contract, not evidence of a Web Platform prohibition.
StackBlitz's published browser prerequisites require `SharedArrayBuffer` and
cross-origin isolation but do not identify a single-runtime constraint.

This repository could support multiple concurrent `Mimic` instances,
but the current architecture deliberately does not. `boot()` rejects the second
instance, and the current preview router has shared keys and cleanup paths that
are not fully epoch-scoped. None of the identified blockers is a Web Platform
prohibition; they are deferred rather than included in the current destination.

Treat concurrent instances as a deliberate extension beyond strict StackBlitz
API parity. Do not claim the behavior until a two-instance browser test proves
independent filesystems, processes, equal port numbers, published endpoints,
cache use, and teardown.

## Official contract and platform boundary

- The current [`WebContainer.boot()` reference](https://webcontainers.io/api#%E2%96%B8-boot)
  says only one instance may be booted concurrently and calls boot expensive.
  The [`teardown()` reference](https://webcontainers.io/api#%E2%96%B8-teardown)
  explicitly permits a later boot, so the authoritative reference describes
  serial reuse rather than a once-per-page lifetime prohibition. The
  [quickstart](https://webcontainers.io/guides/quickstart#_1-create-a-webcontainer-instance)
  uses the simpler “call only once” guidance.
- StackBlitz lists
  [`SharedArrayBuffer` and cross-origin isolation](https://webcontainers.io/guides/browser-support#web-platform-requirements)
  as the important platform requirements. Its
  [troubleshooting guide](https://webcontainers.io/guides/troubleshooting#out-of-memory-error)
  describes several projects or embeds running concurrently until browser
  memory is exhausted. Resource cost is therefore real, but the published
  material does not establish a browser-enforced count of one.
- The [WHATWG Workers specification](https://html.spec.whatwg.org/multipage/workers.html#workers)
  creates a new global environment for each `Worker` and includes an example
  farming work to ten workers. It warns that workers have startup and per-instance
  memory costs; it does not impose a singleton. The
  [Service Worker specification](https://w3c.github.io/ServiceWorker/#service-worker-registration-concept)
  defines registrations and clients independently and permits many registrations
  at an origin when scopes differ. A single registration can also route many
  application-level epochs; it does not have to be duplicated per runtime.

No examined StackBlitz primary source publishes the internal reason for its
singleton. The strongest supportable statement is therefore: **the singleton is
an API/product/implementation constraint; it is not a stated Web Platform
constraint**.

## Current repository: enablers

- Most mutable runtime state is already instance-owned. Each constructor creates
  its own VFS, command registry, server manager, active-process set, PID counter,
  and random instance ID
  ([`Mimic.ts`](../../src/runtime/Mimic.ts#L38-L73)).
- Published URLs already include the instance ID
  ([`server-manager.ts`](../../src/runtime/server-manager.ts#L458-L462)). The
  service worker stores runtime ports by instance ID and removes matching client,
  route, and recovery state on disconnect
  ([`mimic-sw.js`](../../public/mimic-sw.js#L23-L48)).
- Node programs already get a fresh dedicated worker, and the owning command
  tracks and terminates its own workers
  ([`worker-node-command.ts`](../../src/runtime/worker-node-command.ts#L18-L31),
  [`worker-node-command.ts`](../../src/runtime/worker-node-command.ts#L199-L213)).
  Multiple supervisors and execution workers are therefore compatible with the
  browser execution model.
- The default package cache is intentionally shared in the page realm, while the
  VFS is not
  ([`package-cache.ts`](../../src/runtime/package-cache.ts#L180-L188)). Sharing
  immutable, integrity-addressed artifacts can remain an optimization across
  epochs without sharing mutable runtime authority.

## Current repository: blockers and required proof

1. **Remove the explicit singleton, not merely its error.** Static
   `activeRuntime` and `isBooting` reject concurrent boots, and `teardown()`
   clears that global slot
   ([`Mimic.ts`](../../src/runtime/Mimic.ts#L29-L32),
   [`Mimic.ts`](../../src/runtime/Mimic.ts#L76-L103),
   [`Mimic.ts`](../../src/runtime/Mimic.ts#L198-L205)).
   The maintained unit contract currently asserts this rejection
   ([`runtime-command-contracts.test.ts`](../../tests/unit/runtime-command-contracts.test.ts#L1643-L1651)).
2. **Make the browser host epoch-safe.** `runtimePorts`, direct preview URLs, and
   disconnect cleanup are already namespaced, but `routedUrls` is keyed only by
   browser URL and an unclaimed navigation clears the whole map
   ([`mimic-sw.js`](../../public/mimic-sw.js#L65-L77),
   [`mimic-sw.js`](../../public/mimic-sw.js#L107-L120),
   [`mimic-sw.js`](../../public/mimic-sw.js#L185-L195)).
   Two previews requesting the same root-relative URL can overwrite each other's
   remembered target. Route identity and cleanup must include epoch/client
   ownership throughout.
3. **Filter every page-side event by epoch.** Preview requests and WebSocket opens
   check `instanceId`, but the diagnostic branch does not before forwarding a
   window message
   ([`service-worker-client.ts`](../../src/runtime/service-worker-client.ts#L83-L110)).
4. **Acquire shared browser infrastructure idempotently.** Concurrent boots can
   share one package-owned service-worker host, but registration/update/controller
   setup needs one in-flight acquisition and per-instance connection cleanup.
   Teardown of one epoch must never replace, clear, or terminate another epoch's
   host state.
5. **Coordinate shared artifact writes across supervisors.** Today's OPFS cache
   serializes same-path writes only inside one `OpfsPackageCache` object
   ([`package-cache.ts`](../../src/runtime/package-cache.ts#L40-L58)). If each
   Supervisor owns a separate adapter, immutable cache publication needs
   cross-context atomic/idempotent semantics or a single cache host. Mutable VFS,
   process, network, and endpoint state must remain per epoch.
6. **Budget resources across instances.** A per-runtime execution-capacity formula
   applied independently by every instance can oversubscribe the same browser.
   The browser adapter needs an origin/page-level admission budget or a proven
   conservative policy without becoming shared runtime authority.
7. **Add browser evidence.** Boot two instances concurrently; use the same cwd,
   PID values, and virtual port in both; prove VFS and process isolation; fetch
   both published URLs; perform concurrent immutable-cache access; tear one down;
   and prove the other continues serving and spawning. Also test two simultaneous
   boot failures so partial service-worker connections and workers cannot leak.

## Decision guidance

If a future effort accepts multiple concurrent instances, use these boundaries:

- one Runtime Supervisor and one mutable authority set per runtime epoch;
- one package-owned browser host may multiplex epochs but owns no runtime-domain
  state;
- shared storage contains immutable artifacts only;
- every transport, route, handle, and cleanup operation carries epoch identity;
- resource admission is bounded across instances;
- the public guarantee begins only when the two-instance browser evidence passes.

This preserves the accepted deep-module boundaries while avoiding an unnecessary
StackBlitz implementation limitation.
