# Nodepod module execution and the minimal Mimic seam

> Snapshot note: source findings and dated evidence are retained, but repo-specific
> “current state” statements may become obsolete. Verify them against current code
> and maintained tests before implementation. See
> [the research status rules](./README.md).

Date: 2026-08-23

Mimic revision: [`32b9da267bbe285cbfc6306d715c416361067907`](https://github.com/mimic-js/mimic/tree/32b9da267bbe285cbfc6306d715c416361067907)

Nodepod revision: [`10266efb66e9f1ead1853f6a8519a2606b4a77d0`](https://github.com/R1ck404/Nodepod/tree/10266efb66e9f1ead1853f6a8519a2606b4a77d0), current `main` when inspected

## Question

What does Nodepod's current module loading and execution path expose, what
mechanisms are worth borrowing, and what does that imply for the minimal
Module Execution Engine and Node Compatibility seams being decided in
Define minimal runtime interfaces and protocol policy (#612)?

This note is research only. It does not change either runtime.

## Decision in one paragraph

Borrow Nodepod's **placement**, not its `ScriptEngine` surface: a process owns an
engine in its execution realm, starts it through one entry operation, and owns
conversion of program failures into stderr/exit status. Keep one registry per
engine, insert CJS records before evaluation, evict failed records, and keep
compiled-source caching distinct from evaluated module identity. Do not copy
Nodepod's public engine factories, 3,264-line engine, module-global builtin
table, package-specific resolution fallbacks, install-time source rewriting,
regex fallback transforms, or collapse of Worker crashes into program stderr.
For Mimic, the process-facing engine seam should reduce to one
discriminated `run` operation plus idempotent `teardown`; `require`, `import`,
most resolution, records, caches, compiler stages, and transform types stay
private. Node Compatibility keeps only the already-real narrow role ports
needed to implement `node:module` and `node:vm`, plus the existing builtin
provider consumed by the engine.

## Nodepod's actual execution path

### Canonical SDK-to-process path

The clean SDK path is:

```text
Nodepod.boot()
  -> Nodepod.spawn(command, args, options)
  -> ProcessManager.spawn(...)
  -> one dedicated process Worker
  -> init worker-local VFS/process state
  -> executeNodeBinary(entry, args, context)
  -> new ScriptEngine(...)
  -> ScriptEngine.runFileTLA(entry)
```

`Nodepod.spawn()` constructs a public `NodepodProcess`, asks `ProcessManager`
for a process handle, wires stdout/stderr/exit, waits for Worker readiness, and
sends one `exec` message. The source explicitly says every spawn gets a
dedicated Worker. [Nodepod SDK spawn](https://github.com/R1ck404/Nodepod/blob/10266efb66e9f1ead1853f6a8519a2606b4a77d0/src/sdk/nodepod.ts#L529-L627)

`ProcessManager.spawn()` enforces process-count/depth limits, constructs the
Worker and process handle, prepares the VFS snapshot and optional synchronous
buffers/ports, then sends the `init` message. [Nodepod process creation](https://github.com/R1ck404/Nodepod/blob/10266efb66e9f1ead1853f6a8519a2606b4a77d0/src/threading/process-manager.ts#L123-L273)

The Worker initializes process-local state and a worker-local `MemoryVolume`,
then reports ready. File execution delegates to `executeNodeBinary`; the Worker
does not expose its module loader to the SDK. [Nodepod worker initialization](https://github.com/R1ck404/Nodepod/blob/10266efb66e9f1ead1853f6a8519a2606b4a77d0/src/threading/process-worker-entry.ts#L266-L343),
[Nodepod worker file execution](https://github.com/R1ck404/Nodepod/blob/10266efb66e9f1ead1853f6a8519a2606b4a77d0/src/threading/process-worker-entry.ts#L490-L619)

Inside that Worker, `executeNodeBinary()` resolves the entry, establishes the
process context, creates a fresh `ScriptEngine`, and invokes only
`runFileTLA(resolved)`. Process lifecycle, event-loop drainage, stdout/stderr,
exit code, signals, and final resource cleanup remain outside `ScriptEngine`.
[Nodepod process/engine composition](https://github.com/R1ck404/Nodepod/blob/10266efb66e9f1ead1853f6a8519a2606b4a77d0/src/polyfills/child_process.ts#L1203-L1460),
[Nodepod process cleanup](https://github.com/R1ck404/Nodepod/blob/10266efb66e9f1ead1853f6a8519a2606b4a77d0/src/polyfills/child_process.ts#L1711-L1746)

This is the strongest lesson for Mimic: the real production caller
does not need `import`, `require`, `resolve`, caches, or compiler controls. It
needs “run this entry in this process context.”

### Nodepod still exposes a second, broad engine API

Nodepod's root package also exports `ScriptEngine`, `ResolverFn`, three sandbox
engine implementations/factories, and `createWorkspace()` with direct
`execute`, `runFile`, and REPL access. [Nodepod root exports](https://github.com/R1ck404/Nodepod/blob/10266efb66e9f1ead1853f6a8519a2606b4a77d0/src/index.ts#L12-L30),
[Nodepod workspace API](https://github.com/R1ck404/Nodepod/blob/10266efb66e9f1ead1853f6a8519a2606b4a77d0/src/index.ts#L94-L185)

The newer `Nodepod` SDK itself says the main-thread engine was removed and its
`engine` getter always throws, while the old package-root engine exports remain.
[Nodepod deprecated engine getter](https://github.com/R1ck404/Nodepod/blob/10266efb66e9f1ead1853f6a8519a2606b4a77d0/src/sdk/nodepod.ts#L1149-L1159)

That coexistence is migration history, not an interface model to copy. It is
exactly the kind of duplicate public path Mimic's deep-module rule
is intended to prevent.

## Loader and engine mechanics

### Resolve, load, require, import, and eval

Nodepod has no separate public `resolve/load/import/require` service. Internally,
`buildResolver()` returns a callable `ResolverFn`: calling it performs
`require`, while properties expose `resolve`, `cache`, `extensions`, and
`main`. [Nodepod resolver shape](https://github.com/R1ck404/Nodepod/blob/10266efb66e9f1ead1853f6a8519a2606b4a77d0/src/script-engine.ts#L1004-L1057)

The resolver handles builtins and package/path resolution, while its private
`loadModule()` reads and evaluates a resolved file. Dynamic `import()` is
rewritten to an async loader that calls the same resolver and wraps the result
as a namespace. Generated wrappers are executed through indirect `eval`.
[Nodepod dynamic loader](https://github.com/R1ck404/Nodepod/blob/10266efb66e9f1ead1853f6a8519a2606b4a77d0/src/script-engine.ts#L949-L1001),
[Nodepod module load and evaluation](https://github.com/R1ck404/Nodepod/blob/10266efb66e9f1ead1853f6a8519a2606b4a77d0/src/script-engine.ts#L1695-L1979),
[Nodepod require/resolve projection](https://github.com/R1ck404/Nodepod/blob/10266efb66e9f1ead1853f6a8519a2606b4a77d0/src/script-engine.ts#L1982-L2320)

`ScriptEngine` itself exposes several overlapping entry operations (`execute`,
`executeAsync`, `runFile`, `runFileTLA`, `runFileAsync`) plus cache, volume,
process, and REPL escape hatches. [Nodepod ScriptEngine operations](https://github.com/R1ck404/Nodepod/blob/10266efb66e9f1ead1853f6a8519a2606b4a77d0/src/script-engine.ts#L2870-L3257)

Nodepod's separate `node:vm` polyfill directly uses `eval`/`Function` and does
not delegate to the current engine. Its ESM module classes are stubs. This is
smaller, but it loses the engine's evaluation policy, artifact errors, source
identity, and transforms. [Nodepod `node:vm`](https://github.com/R1ck404/Nodepod/blob/10266efb66e9f1ead1853f6a8519a2606b4a77d0/src/polyfills/vm.ts#L1-L139)

Implication: do not copy the callable `ResolverFn` or multiple entry aliases.
Mimic's existing `ScriptEvaluator` role port is the cleaner seam for
`node:vm`, because it routes VM evaluation through the engine-owned policy.

### Module identity and caching

Nodepod's evaluated-module registry is per `ScriptEngine` and keyed first by
resolved path. It inserts a record before evaluation, so CJS cycles can observe
partial exports, and removes the record when evaluation fails. [Nodepod module registry](https://github.com/R1ck404/Nodepod/blob/10266efb66e9f1ead1853f6a8519a2606b4a77d0/src/script-engine.ts#L1695-L1765),
[Nodepod failed-load eviction](https://github.com/R1ck404/Nodepod/blob/10266efb66e9f1ead1853f6a8519a2606b4a77d0/src/script-engine.ts#L1875-L1979)

It separately caches resolution results, parsed manifests, and transformed
source. Transform cache keys include resolved path plus a digest of source, and
the process path injects a realm-wide bounded transform cache into each fresh
engine. [Nodepod resolution caches](https://github.com/R1ck404/Nodepod/blob/10266efb66e9f1ead1853f6a8519a2606b4a77d0/src/script-engine.ts#L1324-L1367),
[Nodepod transform cache key](https://github.com/R1ck404/Nodepod/blob/10266efb66e9f1ead1853f6a8519a2606b4a77d0/src/script-engine.ts#L1774-L1847),
[Nodepod injected worker transform cache](https://github.com/R1ck404/Nodepod/blob/10266efb66e9f1ead1853f6a8519a2606b4a77d0/src/polyfills/child_process.ts#L1323-L1348)

These distinctions are worth retaining as policy:

- evaluated module identity is context-local and keyed by canonical resolved
  identity;
- records enter the registry before evaluation and leave it on failure;
- compiled artifacts may be shared only by a key containing source and compiler
  identity; and
- evaluated exports and mutable module state are never shared across contexts.

Do not copy Nodepod's additional `name@version:subpath` deduplication across
nested `node_modules`. It deliberately aliases different resolved paths to the
first loaded record, which changes Node's path-based module identity and can
hide dependency-layout differences. [Nodepod package deduplication](https://github.com/R1ck404/Nodepod/blob/10266efb66e9f1ead1853f6a8519a2606b4a77d0/src/script-engine.ts#L1701-L1727)

### CJS, ESM, and TypeScript transforms

Nodepod does not run a native ESM graph. It parses ESM with Acorn, rewrites it
to CJS-like wrapper code, and falls back to regex transformation when parsing
fails. Top-level await is emulated through wrapper and synchronous-promise
machinery. [Nodepod ESM conversion](https://github.com/R1ck404/Nodepod/blob/10266efb66e9f1ead1853f6a8519a2606b4a77d0/src/script-engine.ts#L269-L343),
[Nodepod regex fallback](https://github.com/R1ck404/Nodepod/blob/10266efb66e9f1ead1853f6a8519a2606b4a77d0/src/script-engine.ts#L560-L590),
[Nodepod synchronous promise machinery](https://github.com/R1ck404/Nodepod/blob/10266efb66e9f1ead1853f6a8519a2606b4a77d0/src/script-engine.ts#L595-L945)

TypeScript is stripped by a custom scanner/regular-expression implementation.
Nodepod also has an esbuild-based install-time package transformer which may
rewrite installed package files, while runtime loading still performs its own
transforms. [Nodepod TypeScript stripper](https://github.com/R1ck404/Nodepod/blob/10266efb66e9f1ead1853f6a8519a2606b4a77d0/src/strip-typescript.ts#L1-L17),
[Nodepod package transformer](https://github.com/R1ck404/Nodepod/blob/10266efb66e9f1ead1853f6a8519a2606b4a77d0/src/module-transformer.ts#L1-L9),
[Nodepod package rewriting](https://github.com/R1ck404/Nodepod/blob/10266efb66e9f1ead1853f6a8519a2606b4a77d0/src/module-transformer.ts#L228-L311)

None of these are interface lessons. Mimic should keep one
runtime-owned compiler pipeline hidden behind the engine and should not add
install-time source mutation, parser-failure regex semantics, or a second
transform route because Nodepod has them.

### Node builtin injection

Most Nodepod builtins are eagerly imported into one module-global
`CORE_MODULES` object. The resolver then special-cases context-dependent
`fs`, `process`, `console`, `worker_threads`, `module`, and `wasi`; it constructs
a per-engine `Module` class so one engine does not overwrite another's cache
and resolver. [Nodepod builtin registry](https://github.com/R1ck404/Nodepod/blob/10266efb66e9f1ead1853f6a8519a2606b4a77d0/src/script-engine.ts#L1059-L1244),
[Nodepod context-dependent builtins](https://github.com/R1ck404/Nodepod/blob/10266efb66e9f1ead1853f6a8519a2606b4a77d0/src/script-engine.ts#L1984-L2143)

The useful mechanism is only **context-local builtin identity**: repeated
`require('module')` in one process must observe the same engine-local cache and
resolver. The ownership is not worth copying. Mimic already has the
better split: Node Compatibility owns lazy Node-shaped builtin construction and
implements `BuiltinModuleProvider`; Module Execution Engine consumes it and
keeps the resulting canonical builtin record in the same context-local module
registry.

### Worker/thread lifecycle, teardown, and errors

Top-level Nodepod spawns get dedicated Workers. Nested `worker_threads` requests
are sent to `ProcessManager`, which creates another process Worker and passes
thread identity/data through the protocol. [Nodepod worker-thread protocol](https://github.com/R1ck404/Nodepod/blob/10266efb66e9f1ead1853f6a8519a2606b4a77d0/src/threading/worker-protocol.ts#L280-L299)

The placement is useful: each actual worker thread gets a fresh evaluated
module registry and process-local builtins. The VFS implementation is not:
Nodepod snapshots a mutable VFS into each process Worker and then mirrors
changes, whereas Mimic's accepted architecture has one authoritative
VFS with direct clients.

Nodepod converts ordinary program exceptions into stderr and exit code `1` at
the process boundary. It also converts an infrastructure Worker error into the
same stderr/exit shape. [Nodepod program error conversion](https://github.com/R1ck404/Nodepod/blob/10266efb66e9f1ead1853f6a8519a2606b4a77d0/src/polyfills/child_process.ts#L1453-L1499),
[Nodepod Worker error conversion](https://github.com/R1ck404/Nodepod/blob/10266efb66e9f1ead1853f6a8519a2606b4a77d0/src/sdk/nodepod.ts#L554-L573)

Copy the first rule, not the second. Module compile/evaluation errors should
throw from the engine; Process Execution formats them as program stderr and an
exit code. A failed transport or crashed Worker is not program output and must
remain a Process Execution/Runtime Host failure.

Nodepod teardown is synchronous and idempotent at the SDK layer. It terminates
processes, closes owned ports, clears registries/caches, and suppresses several
cleanup failures. [Nodepod SDK teardown](https://github.com/R1ck404/Nodepod/blob/10266efb66e9f1ead1853f6a8519a2606b4a77d0/src/sdk/nodepod.ts#L991-L1036),
[Nodepod process teardown](https://github.com/R1ck404/Nodepod/blob/10266efb66e9f1ead1853f6a8519a2606b4a77d0/src/threading/process-manager.ts#L361-L413)

For the Module Execution Engine specifically, idempotent synchronous teardown
is sufficient while it only clears in-realm hooks and caches. Worker
termination and asynchronous resource cleanup belong to Process Execution and
Runtime Host, not this interface.

## Exact comparison with the current Mimic seams

At the pinned Mimic revision, the Module Execution Engine entry
point exports 38 names: the root engine, its construction options, resolver
factories/types, module records, CJS internals, artifact evidence and errors,
and parser helpers. [Current Module Execution Engine entry point](https://github.com/mimic-js/mimic/blob/32b9da267bbe285cbfc6306d715c416361067907/src/runtime/modules/module-execution-engine/index.ts#L1-L46)

The root `ModuleExecutionEngine` exposes duplicate cache/extension properties,
two entry methods, direct `import`, `require`, and `resolve`, plus the two real
Node Compatibility role ports. [Current engine interface](https://github.com/mimic-js/mimic/blob/32b9da267bbe285cbfc6306d715c416361067907/src/runtime/modules/module-execution-engine/module-execution-engine.ts#L227-L242)

Production callers are much narrower:

- Node process execution calls only `runEntry()` or `runCommonJsSource()`.
  [Top-level process caller](https://github.com/mimic-js/mimic/blob/32b9da267bbe285cbfc6306d715c416361067907/src/runtime/modules/execution-context-bootstrap/node-runtime-program.ts#L653-L656)
- Worker-thread execution additionally calls `resolve()` before creating the
  child runtime, then again calls one of the two entry methods on that child.
  [Worker-thread caller](https://github.com/mimic-js/mimic/blob/32b9da267bbe285cbfc6306d715c416361067907/src/runtime/modules/execution-context-bootstrap/execution-context-runtime.ts#L390-L407),
  [worker-thread entry execution](https://github.com/mimic-js/mimic/blob/32b9da267bbe285cbfc6306d715c416361067907/src/runtime/modules/execution-context-bootstrap/execution-context-runtime.ts#L736-L760)
- `import()` and `require()` are engine-internal recursion mechanisms in
  production; their direct external callers are tests.
- `commonJsCache` and `commonJsExtensions` duplicate data already exposed
  through `nodeModuleAccess`.
- `ModuleEntryOptions` and the resolver/artifact exports have no production
  caller outside the module.
- `ModuleAccess` is included in `NodeCompatibilityBuiltinAdaptersOptions` but
  is not read by that factory. [Current builtin adapter options](https://github.com/mimic-js/mimic/blob/32b9da267bbe285cbfc6306d715c416361067907/src/runtime/modules/node-compatibility/builtin-adapters.ts#L27-L74)

The current bootstrap proves that `NodeModuleAccess` and `ScriptEvaluator` are
real, but composition-local, roles: it creates forwarding projections only to
break the engine/Node Compatibility construction cycle. It also reveals the
avoidable two-stage builtin-adapter assembly. [Current execution bootstrap](https://github.com/mimic-js/mimic/blob/32b9da267bbe285cbfc6306d715c416361067907/src/runtime/modules/execution-context-bootstrap/execution-context-bootstrap.ts#L34-L116)

Node Compatibility's lazy module cache and builtin provider are already
cleaner than Nodepod's global table. Keep that behavior, while localizing the
adapter result/owner wrappers and recursive proxy error translation during the
broader Node Compatibility simplification. [Current builtin provider](https://github.com/mimic-js/mimic/blob/32b9da267bbe285cbfc6306d715c416361067907/src/runtime/modules/node-compatibility/node-compatibility.ts#L121-L179)

## Recommended target interface

The production-facing interface can be:

```ts
type ModuleEntry =
  | { readonly kind: 'module'; readonly specifier: string }
  | {
      readonly kind: 'commonjs-source';
      readonly source: string;
      readonly filename: string;
    };

type ModuleExecutionEngine = {
  run(entry: ModuleEntry): Promise<unknown>;
  teardown(): void;
};
```

The factory still receives the VFS/module access, process/global/console,
builtin provider, compiler policy, and diagnostics needed to build one engine;
those are construction inputs, not runtime methods.

Keep these narrow cross-module role ports because they correspond to observable
Node APIs:

- `BuiltinModuleProvider`, implemented by Node Compatibility and consumed by
  the engine;
- `NodeModuleAccess`, implemented by the engine for Node Compatibility's
  `node:module`; and
- `ScriptEvaluator`, implemented by the engine for Node Compatibility's
  `node:vm`.

They should be available to the private Process Execution composition, not
re-exported by a public Mimic API. A single implementation does not
justify another interface layer beyond these real caller roles.

Move or localize the rest:

1. Replace `runEntry` and `runCommonJsSource` with `run(ModuleEntry)`.
2. Make direct `import`, `require`, registry records, namespace state, format
   selection, and `resolve` private engine machinery. If worker construction
   still needs pre-resolution, expose one private resolver function to that
   composition rather than keeping `resolve` on the root process-facing handle.
3. Remove `commonJsCache` and `commonJsExtensions` from the root; they already
   live under `NodeModuleAccess`.
4. Move `INLINE_NODE_MODULE_ENTRY`, `InlineNodeModuleEntry`, and preload CLI
   parsing to Process Execution. They describe process invocation and synthetic
   entry projection, not module execution's shared interface.
5. Stop exporting `createModuleResolver`, `resolveVfsModuleSpecifier`, resolver
   implementation types, `ModuleRecord`, `ResolutionMode`, `ModuleRecordState`,
   compiler formats, and artifact plumbing merely for direct unit tests. Test
   resolution and formats through `run`, `node:module`, and maintained behavior.
6. Remove the unused `moduleAccess` field from
   `NodeCompatibilityBuiltinAdaptersOptions`.
7. Absorb Execution Context Bootstrap into the private Process Execution realm
   composition; do not preserve its forwarding objects as an independent
   module seam.

## What Nodepod changes in the decision

Nodepod strengthens the case for a one-operation engine. Its real Worker path
already ignores almost all of its own broad engine API. It does **not** justify
copying its loader structure or replacing Mimic's compiler with
Nodepod's transforms. The concrete adopted policy should therefore be:

> Process Execution privately composes one Module Execution Engine and one Node
> Compatibility instance per execution context. The process caller can run one
> path or inline CommonJS entry and tear the context down. Module resolution,
> loading, `require`, `import`, evaluation, caching, and builtin identity remain
> internal, except for the narrow `node:module` and `node:vm` role ports.
