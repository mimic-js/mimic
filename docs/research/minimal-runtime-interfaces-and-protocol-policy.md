# Minimal runtime interfaces and protocol policy

Status: accepted resolution of GitHub issue #612 on 2026-08-23.

## Decision

The runtime will expose only construction, caller-specific lifecycle handles,
and domain values, errors, or protocol unions that cross a real seam. Concrete
classes, stage functions, validators, mappings, worker bootstrap details, and
test projections remain private.

The current 16 top-level runtime module directories contain 42 distinct
directions of direct inter-module dependency. The target has ten deep runtime
owners. This is not a goal to minimize arrows blindly: each surviving arrow
represents real caller knowledge, while relays, duplicate protocols, and
pass-through adapters are removed.

## Current-to-target module map

| Current module | Target |
| --- | --- |
| `runtime-supervisor` | Renamed and deepened as Runtime Host. |
| `runtime-supervisor-client` | Absorbed by Runtime Host; browser-placement details become private. |
| `process-execution` | Kept and deepened as the single process admission and lifecycle owner. |
| `execution-context-bootstrap` | Deleted as a module; worker bootstrap becomes private Process Execution implementation. |
| `shell-program` | Absorbed as a private Runtime Program under Process Execution. |
| `virtual-file-system` | Kept and deepened behind one async filesystem interface per peer. |
| `virtual-network` | Kept as runtime-local byte sockets and listeners. |
| `published-endpoint` | Kept and deepened to own all browser publication behavior. |
| `http-1-wire-codec` | Kept as the shared HTTP/1 byte framing owner. |
| `browser-adapters` | Deleted; outbound Node behavior moves to Node Compatibility and hosting moves to Published Endpoint. |
| `worker-transport` | Kept and narrowed to a generic peer wrapper over one `MessagePort`. |
| `module-execution-engine` | Kept and narrowed to entry execution plus real Node role ports. |
| `node-compatibility` | Kept and deepened behind one context-local lazy builtin table. |
| `wasi-execution` | Kept as the shared generic WASI host used by a Runtime Program and `node:wasi`. |
| `package-installation-program` | Deleted; manager-specific Command Proxies are private Runtime Programs. |
| `toolchain-catalog-artifact-cache` | Deleted; three catalog maps and one integrity-checking artifact acquisition function remain private. |

Shell and npm, pnpm, and Yarn Command Proxies are Runtime Program
implementations, not runtime authorities or public modules.

## Target dependency direction

```text
Mimic
  -> Runtime Host
       -> Virtual File System
       -> Virtual Network
       -> Published Endpoint -> Virtual Network + HTTP/1 Wire Codec
       -> Process Execution -> Worker Transport + private Runtime Programs
            -> Command Proxies -> Catalog + artifact acquisition + VFS transaction
            -> WASI Runtime Program -> WASI Execution -> VFS capability
            -> worker-local Module Execution Engine -> VFS module access
            -> worker-local Node Compatibility -> narrow runtime capabilities

Node Compatibility -> HTTP/1 Wire Codec
Node Compatibility -> WASI Execution's Node adapter
Module Execution Engine -> Node Compatibility's Builtin Module Provider
```

Arrows describe semantic use. Type ownership must point toward the consumer's
role port where that avoids an import cycle. No broad `RuntimeContext` or
capability bag crosses these seams.

## Runtime Host

The Runtime Host owns one runtime epoch and replaces the Supervisor/Client
split. Its caller learns only:

```ts
type RuntimeHost = {
  readonly fs: VirtualFileSystem;
  readonly endpoints: PublishedEndpoints;
  spawn(request: SpawnRequest): Promise<RuntimeProcess>;
  teardown(): Promise<void>;
};
```

The concrete class, worker construction, process and network authorities,
published-endpoint browser host, execution filesystem, program resolution,
custom Worker/MessageChannel injection, and test projections are private.

There is no `failure`, `closed`, or error event in this interface. Events can
be added when a real caller exists. Fatal epoch failure is private fail-stop
state: pending and new operations reject. `teardown()` is asynchronous,
idempotent, always attempts cleanup, and rejects with `RuntimeHostError` after
an epoch crash. Cleanup must complete before a new epoch boots.

## Process Execution

Process Execution has one root handle:

```ts
type ProcessExecution = {
  spawn(request: SpawnRequest): Promise<RuntimeProcess>;
  shutdown(signal: ProcessExecutionSignal): Promise<void>;
};
```

It owns command resolution, the explicit Runtime Program registry, process
trees, worker isolation, capacity, stdio, signals, exit, and cleanup. Process
capabilities and execution context are private implementation, not exported
interfaces. Admission records, realm/bootstrap identifiers, leases, mailboxes,
Worker protocol details, authority/service/client pairs, and process
projections are removed from entry points.

`RuntimeProgram` remains because Shell, Node, WASI, and the concrete Command
Proxies have real behavior differences. It is an implementation role consumed
only by Process Execution, not a public Mimic concept.

## Virtual File System

Each asynchronous peer receives one `VirtualFileSystem` interface. A
transaction reuses that same interface:

```ts
type VirtualFileSystemTransaction = {
  readonly fs: VirtualFileSystem;
  commit(): Promise<void>;
  rollback(): Promise<void>;
};
```

`fs.transaction()` opens a snapshot-isolated transaction with read/write-set
conflict detection and atomic commit. Unrelated commits do not conflict. After
commit or rollback, the transaction and scoped filesystem are terminal.
Nested transactions are unsupported.

The bounded synchronous mailbox is a private adapter injected only where
synchronous Node or WASI calls require it. Only its narrow descriptor/port may
cross that capability seam. Authority/service/client pairs, relays, queued and
execution-context clients, transport domain/version constants, a separate
transaction client, archive codecs, path helpers, mailbox layout, and journal
selectors are not entry-point exports. VFS errors and domain file values may
cross the seam.

## Virtual networking and endpoint publication

Virtual Network, Published Endpoint, and HTTP/1 Wire Codec remain separate
deep owners:

- Virtual Network owns runtime-local byte sockets, listeners, and their
  lifecycle.
- Published Endpoint owns publication identity, Service Worker routing,
  browser URLs, cookies, document handling, WebSocket hosting, invalidation,
  and disposal.
- HTTP/1 Wire Codec owns shared parsing and serialization because both Node
  Compatibility and Published Endpoint consume it.

A lifecycle-bound `ListenerProtocolClaim` connects a listener to publication.
Virtual Network stores the claim beside the listener but does not interpret
HTTP. Browser Adapters, `HttpServerBridge`, host boundary/router/handler
layers, URL-template adapters, and duplicate HTTP/WebSocket protocol families
are deleted.

Outbound `node:http` and `node:https` use native Fetch. Node-shaped WebSocket
uses native browser WebSocket. External raw `node:net` and `node:tls` return
`ENOTSUP` until a real external byte transport exists.

## Worker Transport

One peer pair uses one `MessagePort` and one small wrapper:

```ts
type WorkerPeer<Message> = {
  send(message: Message, transfer?: readonly Transferable[]): void;
  request<Response>(
    message: Message,
    options?: {
      readonly signal?: AbortSignal;
      readonly transfer?: readonly Transferable[];
    }
  ): Promise<Response>;
  subscribe(listener: (message: Message) => void): () => void;
  close(): void;
};
```

The caller owns its discriminated message union and semantic validation.
`request` owns correlation, cancellation, one fixed internal in-flight limit,
overload rejection, and pending cleanup. A terminal envelope rejects pending
requests and closes the peer. Domain maps, generated client/server sessions,
per-domain ports, drain handshakes, and same-build versions are deleted. Only
the independently lived Service Worker seam retains one exact compatibility
token.

An `ArrayBuffer` in the transfer list moves ownership and detaches the sender's
buffer. `SharedArrayBuffer` is shared rather than transferred and is not put in
the transfer list. Transferable streams preserve streaming and backpressure;
they do not promise that future chunks are automatically zero-copy.

## Module Execution Engine and Node Compatibility

The Module Execution Engine exposes one execution operation:

```ts
type ModuleEntry =
  | { readonly kind: 'file'; readonly path: string }
  | {
      readonly kind: 'inline-commonjs';
      readonly source: string;
      readonly filename: string;
    };

type ModuleExecutionEngine = {
  run(entry: ModuleEntry): Promise<void>;
  teardown(): void;
};
```

`file.path` is a canonical absolute VFS path. `file` describes the source
location, not its format: the engine determines CommonJS, ESM, JSON, or
WebAssembly from normal Node rules. `inline-commonjs` exists only for sources
without a VFS file, such as `node -e` and Worker eval. Inline ESM is not added
without a real caller.

Resolution, loading, compilation, linking, evaluation, the Module Registry,
and caches are private. Direct `require`, `import`, `resolve`, and cache access
are not caller APIs. The installed Babel/SystemJS cutover replaces bespoke
ESM/TypeScript transformation without adding a second engine or registry.

Three narrow role ports survive because behavior genuinely differs:

- `BuiltinModuleProvider`, implemented by Node Compatibility and consumed by
  the engine;
- `NodeModuleAccess`, implemented by the engine for `node:module`;
- `ScriptEvaluator`, implemented by the engine for `node:vm`.

Node Compatibility builds one context-local lazy builtin table. Individual
builtin factories, generated owner/result wrappers, adapter registration,
recursive error proxies, and duplicated cache/extension tables are private or
deleted. Its entry point exposes construction, the narrow caller handle, and
only Node domain values or errors that cross a real seam.

## WASI Execution

WASI is an ABI, not a program. A WASI `.wasm` file is an executable, and the
Process Execution `RuntimeProgram` is the adapter that recognizes and runs
that class of executable.

WASI Execution exposes two construction paths:

- `createWasiRuntimeProgram(...)` returns the ordinary Runtime Program used by
  Process Execution and owns WASI executable inspection;
- `createWasiNodeAdapter(...)` supplies the same WASI host to Node
  Compatibility's private `node:wasi` builtin implementation.

The WASI id, compiler/inspection functions, syscall tables, descriptors,
writers, process types, Worker protocol, stdin mailbox, and VFS plumbing are
private. The special Supervisor `binaryExecutable: { programId, inspect }`
configuration is removed; executable inspection is optional behavior on a
registered Runtime Program.

## Shell, Command Proxies, Catalog, and artifacts

Shell parsing, expansion, redirection, and execution remain, but the separate
Shell module and its exported child/spawner/service interfaces are removed.
Process Execution owns it as a private Runtime Program with closures for child
spawn and filesystem redirection.

npm, pnpm, and Yarn each remain a small concrete Command Proxy over the real
upstream CLI. Each proxy classifies its own command, opens a VFS transaction
for mutations, prepares Catalog artifacts, runs the upstream CLI as a child,
and commits or rolls back. There is no common package-manager base class,
generic installation pipeline, or broad capability bag.

The Catalog is three plain maps: package replacements, companion artifacts,
and executable replacements. Artifact acquisition is one private
integrity-checking function over memory/OPFS storage. Stage/profile/request
mappings, a separate toolchain cache, aliases, and extended receipts are
deleted. Receipts retain only runtime-owned trust facts.

## Error and lifecycle policy

- Application and ordinary program errors write truthful stderr and resolve
  with the actual numeric exit code.
- A process Worker/runtime crash closes streams and rejects `process.exit`
  with `MimicProcessCrashError`; it is not fabricated as program
  stderr or exit code 1.
- A fatal epoch failure causes Runtime Host operations and teardown to reject
  with `RuntimeHostError` after required cleanup.
- Terminal/UI adapters may render structured errors. Core process streams do
  not stringify infrastructure failures.
- No global `failure` property or error event is added now. An event can be
  introduced later with a real consumer and defined delivery semantics.

## Validation, versions, and immutability

Validation happens once at a trust boundary: the public Mimic API,
Worker or Service Worker ingress, network input, archives, registry/package
metadata, and WebAssembly. Ordinary typed in-process calls are not revalidated.
Worker Transport validates only envelope, correlation, and terminal state;
the domain owner validates its message union.

Same-build peer protocol and domain versions are removed. Only the
independently cached Service Worker has an exact compatibility token.

Fresh internal DTOs are copied at ingress and typed `readonly`; defensive
`Object.freeze` chains are removed. Freezing remains only where it is
observable Node API behavior, such as constants objects, or enforces a real
runtime invariant.

## Type, mapping, and construction policy

- A named exported type must be a domain concept that crosses the module entry
  point. Single-use request/options shapes stay inline beside the method.
- Duplicate Client/Service/Transport DTOs and identity mappings are deleted.
  Mapping survives only when meaning or representation changes.
- A factory is exported only as deep-module construction. Private classes are
  used only for identity, state, or lifecycle; otherwise use a function or
  plain object.
- No interface exists solely to describe one concrete implementation.
- Generated client/server classes, assignment wrappers, and long names that
  encode the old module chain are deleted.

## Concurrency and performance

- Methods on a live handle may run concurrently. Ordering is promised only
  within the relevant stream, request, or owned state machine.
- Native Web Streams provide backpressure; modules do not add parallel
  unbounded queues.
- Transfer lists are explicit where ownership can move.
- Worker Transport has a fixed private in-flight bound and rejects overload.
- Long-running transport requests use `AbortSignal`; processes use `kill`.
- VFS transactions provide their existing atomic conflict-aware commit.
- Cache policy, batching, and queue sizes remain private until measurement
  proves a public control is necessary.

## Verification and implementation handoff

Public behavior remains protected through Mimic and the maintained
Compatibility Claim matrix. Add one focused test at an owning module entry
point only for an invariant that can escape that matrix. Do not preserve or
manufacture tests for deleted implementation-shaped interfaces.

Implementation tickets must cut over by target owner, prevent new callers of
legacy seams, and delete temporary bridges in an explicitly dependent slice.
The Nodepod comparison supporting the Module Execution decision is recorded in
`docs/research/2026-08-23-nodepod-module-execution-interface.md`.
