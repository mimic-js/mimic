# Research: browser worker transport and internal protocol policy

> Snapshot note: this is a point-in-time investigation of commit
> [`e55011e`](https://github.com/mimic-js/mimic/tree/e55011e3144781dafea8ee500f0cd796b8f8c102)
> and browser/runtime primary sources read on 2026-08-22. Repo-specific current-state
> statements must be rechecked against maintained code and tests.

## Question

What is the smallest reliable transport model among the page, Runtime Supervisor,
Execution Contexts, Service Worker, and package-owned browser adapters, and which
correlation, cancellation, backpressure, validation, separation, and versioning
policy is actually required?

## Decision

Keep **Worker Transport**, but deepen it into one small package-internal interface
over one `MessagePort` per peer relationship. It should own only:

- port creation/adoption/transfer and structured-clone send failures;
- request/response correlation when a domain has concurrent calls;
- explicit cancellation keyed by request identity;
- explicit terminal success/failure, idempotent local cleanup, and Worker
  `error`/`messageerror` conversion;
- a configurable in-flight ceiling as overload protection; and
- validation of the generic envelope before dispatch.

Do not make it own domain names, domain version maps, operation type families,
domain error codes, stream chunking, or semantic validation. Each domain module
owns its messages, handler/client adapter, errors, and payload validation at its
entry-point seam. This gives callers one transport interface while keeping policy
local to the module that can interpret it.

Use browser-native transferable `ReadableStream`/`WritableStream`/`TransformStream`
for byte flow where supported. Their transfer protocol already carries
backpressure. Where a domain must send discrete chunks over messages or use
`SharedArrayBuffer`, that domain owns credit/acknowledgement or the Atomics mailbox
layout; Worker Transport cannot infer byte cost or safe capacity. The existing
64-request rejection is an overload ceiling, not backpressure, and should not be
described as such.

Delete protocol negotiation between realms created from the same installed build:
the main-thread client, Runtime Supervisor, and Execution Context assets are one
release unit and have no alternate compatible implementations to negotiate with.
An incompatible internal change should ship atomically, not grow a compatibility
matrix. Retain exactly one fail-closed build/protocol token only across the
Service Worker seam because browser update lifecycle can leave an older active
worker serving a newer page. That one token replaces the current independent
Worker Transport, Published Endpoint domain, and manifest-version checks at that
seam; there is no supported downgrade path.

## Platform facts

- A `MessagePort` has its own initially empty port message queue; `start()` enables
  dispatch, `close()` disentangles it, and `postMessage()` uses structured
  serialization. Transfer-list members move rather than clone and become unusable
  on the sender; invalid cloning or transfer throws `DataCloneError`. These are
  platform guarantees, so a wrapper should expose them rather than reproduce
  serialization or queueing policy ([WHATWG HTML: channel messaging](https://html.spec.whatwg.org/multipage/web-messaging.html#channel-messaging),
  [WHATWG HTML: structured data](https://html.spec.whatwg.org/multipage/structured-data.html#structuredserializewithtransfer)).
- `MessagePort.close()` does not provide a peer-visible close event. Therefore an
  honest remote failure/normal-completion distinction still requires an explicit
  terminal message before local closure; Worker `error` and `messageerror` remain
  separate failure inputs ([WHATWG HTML: `MessagePort`](https://html.spec.whatwg.org/multipage/web-messaging.html#message-ports),
  [WHATWG HTML: workers](https://html.spec.whatwg.org/multipage/workers.html#dedicated-workers-and-the-worker-interface)).
- The Streams Standard defines backpressure through stream queues, desired size,
  and pipe chains, and defines transferable streams using cross-realm messaging.
  Transporting a stream therefore preserves a standard pressure mechanism without
  a second application-level credit protocol ([WHATWG Streams: backpressure](https://streams.spec.whatwg.org/#pipe-chains),
  [WHATWG Streams: transferable streams](https://streams.spec.whatwg.org/#transferable-streams)).
- `AbortSignal` is a local cancellation observation interface. APIs are encouraged
  to reject unsettled promises with its abort reason; a cross-realm operation must
  still convey cancellation to the peer, which makes an `id`-keyed cancel envelope
  necessary for cancellable RPC ([WHATWG DOM: `AbortSignal`](https://dom.spec.whatwg.org/#abortsignal-api)).
- `SharedArrayBuffer` shares memory only within an allowed agent cluster and is
  gated by cross-origin-isolation rules. It removes copying, not synchronization,
  lifecycle, or capacity policy; those remain properties of the domain mailbox
  layout ([WHATWG HTML: agent clusters](https://html.spec.whatwg.org/multipage/webappapis.html#integration-with-the-javascript-agent-cluster-formalism),
  [WHATWG HTML: structured serialization of shared memory](https://html.spec.whatwg.org/multipage/structured-data.html#structuredserializeinternal)).
- A Service Worker update installs a new worker and may wait while the incumbent
  remains active; controlled clients can therefore temporarily run against an
  older active worker. That is the material independently-lived seam requiring a
  fail-closed compatibility token ([Service Workers: update and lifecycle](https://w3c.github.io/ServiceWorker/#service-worker-lifetime)).

## Mature-runtime comparison

Node's `worker_threads` deliberately matches browser `MessagePort`: it transfers
structured data, memory, and ports, exposes `messageerror`, and does not impose a
general RPC/domain/version framework. Its Web Streams implementation transfers
streams through `MessagePort`, preserving the standard stream abstraction
([Node.js `worker_threads`](https://nodejs.org/api/worker_threads.html#class-messageport),
[Node.js Web Streams](https://nodejs.org/api/webstreams.html#transferring-with-postmessage)).

Deno's worker implementation likewise creates one entangled parent/worker port;
termination marks the worker terminated, disentangles that port, and wakes the
event loop. Its control channel is an implementation lifecycle mechanism rather
than a public domain-version negotiation layer
([Deno `runtime/web_worker.rs`](https://github.com/denoland/deno/blob/main/runtime/web_worker.rs)).

These implementations support a narrow browser-native transport seam. They do
not supply evidence for copying their broader runtime structure or adding a
generic internal protocol registry here.

## Repository findings

### Current transport is two modules sharing one name

[`transport-session.ts`](../../src/runtime/modules/worker-transport/transport-session.ts)
is a 800-plus-line session/RPC framework: it creates a control port plus one port
per domain, requires an exact sorted domain-version map, defines generic
client/server operation families, correlation, cancellation, capacity,
drain/close, and transport errors. By contrast,
[`message-port-adapter.ts`](../../src/runtime/modules/worker-transport/message-port-adapter.ts)
is a thin projection of browser primitives plus a domain-specific `serve()`
helper. The latter is the viable external seam; `serve()` should move to its
request-owning module.

The maintained Worker Transport tests prove useful semantics—out-of-order RPC
correlation, cancellation, terminal failure, cleanup, and a bounded number of
requests—but they also lock in accidental structure: exact domain maps, separate
physical endpoints, two independent protocol-version checks, and a drain
handshake needed only because control and data use different queues
([`worker-transport.test.ts`](../../tests/unit/worker-transport.test.ts)). A single
ordered port removes that cross-port close race and its `domain-drain` messages.

### Domain separation is already type-level and can stay local

The Runtime Supervisor Client assembles five domain names and versions before it
can boot ([`runtime-supervisor-client.ts`](../../src/runtime/modules/runtime-supervisor-client/runtime-supervisor-client.ts));
Execution Context startup repeats the same pattern for four domains
([`node-process-worker.ts`](../../src/runtime/modules/execution-context-bootstrap/node-process-worker.ts)).
Those exact maps add coupling but no compatibility choice: every peer is built by
this package. Dispatch can instead be a single discriminated union whose handlers
are installed by the composing realm, or transferred dedicated ports when a
domain genuinely needs independent ownership/lifetime. Physical isolation should
follow a real lifecycle or transfer requirement, not every TypeScript domain.

The direct process-worker protocol already demonstrates the simpler shape: one
discriminated message union with request identities only for concurrent exchanges
([`process-worker-protocol.ts`](../../src/runtime/modules/execution-context-bootstrap/process-worker-protocol.ts),
[`node-process-adapter-protocol.ts`](../../src/runtime/modules/process-execution/node-process-adapter-protocol.ts)).
Its error serialization belongs to Process Execution; moving that semantic
mapping into Worker Transport would reduce locality.

### Relays and transfer mappings are too semantic

[`message-port-relay.ts`](../../src/runtime/modules/runtime-supervisor-client/message-port-relay.ts)
inspects `{ data: ArrayBuffer }` and one Published Endpoint close discriminator to
decide transfer and lifecycle. That makes a generic relay know one domain's wire
shape. Prefer transferring the already-established `MessagePort` directly to its
final owner. When a browser-host hop is unavoidable, the owning Published Endpoint
adapter should relay its union and enumerate its transferables; the transport
adapter should only execute the caller-supplied transfer list.

The Service Worker handshake currently repeats transport and Published Endpoint
domain versions in generated and checked assets, while document messages also
carry a manifest version
([`published-endpoint-host.ts`](../../src/runtime/modules/runtime-supervisor-client/published-endpoint-host.ts),
[`published-endpoint-service-worker.js`](../../src/runtime/modules/runtime-supervisor-client/published-endpoint-service-worker.js),
[`document-route.ts`](../../src/runtime/modules/published-endpoint/document-route.ts)).
Collapse only the Service Worker compatibility checks to one build/protocol token.
Keep the document route manifest discriminator if it validates persisted/untrusted
route data rather than peer implementation compatibility; it is a domain data
format, not a Worker Transport version.

## Minimal envelope and ownership policy

This is a policy, not a required new universal type. Existing direct unions can
remain direct when they do not need RPC.

| Concern | Smallest owner/policy |
| --- | --- |
| Ordering and queueing | Browser `MessagePort`; one port per peer relationship |
| Transfer | Caller supplies transfer list; Worker Transport calls `postMessage` |
| Correlation | Worker Transport `id` only for concurrent request/response |
| Cancellation | `cancel(id, reason?)`; receiver maps it to a local `AbortController` |
| Request pressure | Fixed in-flight rejection ceiling; call it overload protection |
| Byte-stream pressure | Transferable Streams, or domain-owned credits/mailbox rules |
| Generic validation | Worker Transport validates envelope discriminator and `id` shape |
| Semantic validation/errors | Owning domain module at its entry-point seam |
| Normal close/failure | Explicit terminal envelope, then idempotent port cleanup |
| Same-build versions | None |
| Service Worker compatibility | One exact, fail-closed build/protocol token |

## Deletions and localizations

1. Delete per-domain physical channels, `WorkerTransportDomainVersions`, exact
   domain-map negotiation, and domain version constants used only by same-build
   peers.
2. Collapse `WorkerTransportDomain`, `WorkerTransportOperation`, and generated
   client/server endpoint families into a small correlated-port helper only where
   more than one real caller needs it; otherwise keep the domain's direct union.
3. Delete `domain-drain` after control and data share one ordered port. Preserve
   explicit terminal failure and cleanup.
4. Move `serve()` and message-shape transfer discovery out of Worker Transport to
   Published Endpoint or the relevant owning adapter.
5. Prefer direct port transfer over `BrowserMessagePortRelay`; retain a relay only
   where browser topology proves a hop is unavoidable, and keep its semantic
   mapping inside the owning domain adapter.
6. Replace the Service Worker's transport/domain version pair with one exact
   package build/protocol token. Do not add ranges, downgrade logic, or a registry.
7. Retain manifest/layout versions only for independently persisted or shared
   data formats such as document routes and Atomics mailboxes; localize them to
   those formats.

## Verification implications

The replacement needs one maintained seam-level test covering concurrent
out-of-order responses, abort propagation, capacity rejection, clone failure,
peer/Worker failure, terminal cleanup, and transfer detachment/stream flow. Browser
evidence should additionally prove transferred-stream pressure and fail-closed
page/Service Worker build mismatch. Domain tests should validate their own unions
and errors through their entry-point interfaces, not through a generic transport
type matrix.

No new research ticket is required. The exact migration order belongs in the
map's later target-graph and expand/migrate/contract planning tickets.
