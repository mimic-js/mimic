# Reusable Node compatibility implementations

Research snapshot: 2026-08-22. This answers Research reusable Node compatibility implementations (#605) for the map Simplify the Mimic runtime architecture (#602).

## Decision

Mimic should reuse maintained, browser-tested implementations only for complete, capability-independent Node semantic islands. The strongest candidates are `buffer` for the complete Buffer responsibility and `readable-stream` (including its `events`, `buffer`, and `string_decoder` dependency family) for the complete EventEmitter/Node-stream responsibility. Adoption is conditional on passing the existing maintained claims through the current public seam and on producing a net deletion after bundling/integration.

Everything that projects Mimic authority into Node shape must remain Mimic-owned: filesystem, network, HTTP server/client, TLS, DNS, process/child process, worker threads, module execution, VM evaluation, WASI projection, SQLite, async-context propagation, runtime globals, and domain-error translation. These are adapters at real seams, not generic polyfills.

Do not adopt Deno, Bun, Nodepod, `unenv`, or a whole Node-stdlib catalog as a runtime layer. Reuse their mechanisms and tests selectively. A second builtin registry or compatibility composition would be a shallow module layered over Mimic's existing authorities.

All recommendations below are repository-specific **inferences** from the cited primary sources, current code, callers, and maintained tests; the external-source facts are separated from those inferences.

## Current seam and evidence

Node Compatibility currently contains 11,949 lines across 32 implementation files. Its external interface is comparatively small: install and restore context-local globals, provide builtins through the engine-owned `BuiltinModuleProvider`, and adapt module-resolution/domain failures into Node-shaped errors. Execution Context Bootstrap is its sole production composer; the engine knows only its own builtin-provider interface. That is a deep and correctly placed external seam even though much implementation behind it is duplicated or over-factored.

The maintained claims constrain observable behavior, not the current files or factories:

- [`node-compatibility-context-bootstrap-v1`](../../tests/e2e/mimic-node-compatibility.spec.ts) protects context-local globals, bare/`node:` builtin identity, CJS/ESM identity, module metadata, error codes, and teardown isolation.
- [`node-compatibility-events-streams-v1`](../../tests/e2e/mimic-events-streams.spec.ts) protects EventEmitter and Node stream behavior.
- [`node-crypto-compression-data-utilities-v1`](../../tests/e2e/mimic-crypto-compression-data-utilities.spec.ts) protects Buffer, crypto, compression, string decoding, and data utilities.
- Filesystem, network, process tree, worker-thread, WASI, HTTP-fidelity, framework, package-manager, and exact-graph claims exercise the capability-backed adapters transitively; the generated matrix currently places these across all twelve compatibility shards.
- [`module-execution-node-22-identities-v1`](../../tests/e2e/mimic-module-identities.spec.ts), module registry, CJS, and ESM claims protect canonical module identity and loading behavior.

Consequently, replacing an implementation is safe only when those claims still pass without a fallback path. A library's own tests are evidence for the imported implementation, not a substitute for Mimic's claims.

## Primary-source findings

### Purpose-built browser packages

[`buffer`](https://github.com/feross/buffer) is explicitly a browser implementation of Node's Buffer API, based on `Uint8Array`, with browser tests and Node core-derived tests. Its package has two small runtime dependencies and a complete Buffer surface. Its repository was not archived and had activity in 2025 at this snapshot. This is a coherent responsibility, unlike importing individual encoding helpers.

[`readable-stream`](https://github.com/nodejs/readable-stream) describes itself as a userland copy of Node's stream library. Its package declares a browser entry, browser and bundler test commands, and depends on `events`, `buffer`, `process`, and `string_decoder`. The repository was not archived and had activity in 2025 at this snapshot. [`events`](https://github.com/browserify/events) describes itself as Node's EventEmitter “for all engines” and runs browser tests; its repository was not archived and had activity in late 2024. Taken together, this is one semantic subsystem, not five unrelated helper dependencies.

[`node-stdlib-browser`](https://github.com/niksy/node-stdlib-browser) demonstrates the mature catalog pattern: it maps builtins such as `stream` to `stream-browserify`/`readable-stream` and selects packages for other pure-JS builtins. That catalog is evidence that these islands can be reused in browsers, but its mapping/composition responsibility duplicates Mimic's engine-owned provider and context-owned adapters. The catalog itself should not be imported.

### Standards-based Web APIs

The browser supplies URL, URLSearchParams, text encoders/decoders, timers, Web Crypto, Web Streams, CompressionStream/DecompressionStream, Web Workers, MessageChannel, BroadcastChannel, WebAssembly, and fetch/WebSocket primitives. Node itself exposes Web Streams globally and supplies Node/Web stream conversion methods ([Node Web Streams documentation](https://nodejs.org/api/webstreams.html)). This supports using browser primitives inside adapters, but Web Streams are not Node streams: event ordering, backpressure, object mode, high-water marks, destroy semantics, `pipeline`, and legacy construction remain Node semantics. A direct alias is not a compatible replacement.

### Deno and Bun

Deno keeps Node compatibility in an [`ext/node`](https://github.com/denoland/deno/tree/main/ext/node) subsystem and actively changes it alongside native runtime operations; recent releases include Node HTTP, stream, Buffer, VM, TLS, SQLite, process, and resolver fixes ([Deno releases](https://github.com/denoland/deno/releases)). Its source demonstrates the useful mechanism: Node-shaped JavaScript modules call narrow runtime-native operations, while shared semantic code stays in the Node layer. The implementation is coupled to Deno core ops, permissions, resolver, resources, and event loop, so importing the subsystem would import a foreign architecture.

Bun's [`src/js/node`](https://github.com/oven-sh/bun/tree/main/src/js/node) and native runtime sources similarly show that compatibility adapters remain local to the runtime's filesystem, sockets, process model, JavaScript engine, and native bindings. Bun is actively maintained, but those implementations are not browser packages and cannot be reused without recreating Bun's host.

### `unenv` and Nodepod

[`unenv`](https://github.com/unjs/unenv) is active, MIT-licensed, and explicitly targets browsers and edge runtimes. It offers an alias/injection catalog plus Node modules. Its own sources show why wholesale adoption is wrong here: several capability-backed exports are `notImplemented`, while others assume globals or its own internal classes. For example, its HTTP server/client functions and child-process functions are stubs, and its stream surface still contains unimplemented operations. Mimic already has maintained behavior for those responsibilities. `unenv` is useful as a source of small pure-JS algorithms and compatibility tests, not as the runtime's builtin provider.

[`illuma-ai/nodepod`](https://github.com/illuma-ai/nodepod) is a browser-native runtime with VFS, execution engine, and builtin polyfills. At this snapshot it was created in March 2026, had only a handful of stars, used a Commons-Clause license, and documented multiple builtins as shims/stubs. It is neither mature nor a clean dependency seam. Its architecture independently owns exactly the VFS, module execution, process, and networking responsibilities Mimic already owns.

## Per-responsibility recommendation

| Responsibility | Recommendation | Why / deletion target |
| --- | --- | --- |
| Buffer and binary encoding | **Reuse whole responsibility:** evaluate `buffer`, then delete `BrowserBuffer`, local codecs, Buffer class generation, and Buffer-specific compatibility helpers that the package covers. | Mature browser-specific implementation; current local class is 353 lines and is coupled into streams, zlib, child process, querystring, and the compiler. Keep only conversion at capability seams if measurements prove necessary. |
| EventEmitter + Node streams + string decoder | **Reuse whole subsystem:** evaluate `readable-stream` and its maintained dependency family; do not independently choose helper packages. Delete `MinimalEventEmitter`, the 926-line stream implementation, legacy-construction property copying/binding, local pipeline/finished machinery, and local string decoder when claims pass. | This is the largest capability-independent semantic island. The dependency family is already designed and tested as one Node stream implementation. Browser-native streams remain an internal mechanism, not the exported Node surface. |
| Assert, querystring, path, URL, timers, constants, util/types, diagnostics channel | **Prefer platform/stdlib or retain tiny local code; no new dependency per builtin.** Reuse algorithms from Node/Deno/unenv only when implementation work reaches a proven compatibility gap. | Most current files are tens to low hundreds of lines. Separate packages would add more composition and update surface than code removed. URL/timers/text codecs already project native globals. Delete redundant `createXBuiltin` factories and default-export assembly where a stable object literal or direct native value suffices. |
| Crypto | **Keep Mimic adapter over Web Crypto; reuse focused algorithms already present only where Web Crypto lacks synchronous Node behavior.** Do not import `crypto-browserify` or all of unenv crypto. | Trust/security and sync APIs require explicit behavior. Broad crypto polyfills bring many algorithm dependencies and still cannot manufacture Node's native engine. Existing claims cover exact behavior. Consider unenv/Node algorithms only as source-level prior art, with licensing and tests checked per mechanism. |
| Compression | **Keep a thin Node facade over native CompressionStream/DecompressionStream plus already-installed `fflate`/`brotli`; delete duplicated stream behavior if the shared stream subsystem lands.** | The codec mechanism already comes from platform/dependencies. A second zlib package would duplicate it. |
| Filesystem and filesystem streams/watchers/descriptors | **Keep Mimic-owned Node adapter over VFS; reuse Node/Deno algorithms and tests, not their host bindings.** | VFS revisions, synchronous mailbox behavior, watchers, transaction visibility, descriptor state, and Node error projection are Mimic authorities. Replace local filesystem-stream base behavior with the selected shared stream subsystem, but keep VFS calls local. |
| Net, DNS, TLS, HTTP/HTTPS/HTTP2 | **Keep Mimic-owned adapters over Virtual Network and HTTP/1 Wire Codec.** Reuse standards parsers/algorithms only behind those interfaces. | Browser fetch/WebSocket cannot implement Node listen/connect/socket identity or server lifecycle. `unenv` stubs the decisive operations. Deno/Bun implementations depend on native sockets and runtime resources. Delete only duplicated event/stream machinery after common semantics are imported. |
| Process and child process | **Keep Mimic-owned adapter over Process Execution and Shell Program.** | PID tree, stdio, signals, synchronous execution, environment, cwd, and teardown are runtime authority. Deno/Bun translate to their own process hosts; Nodepod owns a competing process model. |
| Worker threads | **Keep Mimic-owned adapter over Process Execution/worker transport and browser Worker primitives.** Reuse Web MessagePort/BroadcastChannel mechanisms where semantics agree. | Context-local `threadId`, workerData, parentPort, transfer ownership, ref/unref, synchronous receive, teardown, and nested workers are maintained claims and runtime lifecycle. A browser polyfill cannot supply these without the host adapter. |
| Module, VM, builtin resolution, globals | **Keep the engine-owned provider seam and context bootstrap; collapse registration layers.** | Module identity, CJS/ESM registry, customization hooks, evaluation, and globals are local to each Execution Context. External catalogs duplicate the provider. Delete `NODE_COMPATIBILITY_BUILTIN_FACTORIES`, `createNodeCompatibilityBuiltinAdapters`, `createDomainNodeBuiltinAdapters`, and per-builtin `{ owner, load }` boilerplate in favor of one context-local canonical builtin table whose entries are direct values or lazy closures plus owner metadata only where translation needs it. |
| WASI | **Keep only a thin `node:wasi` projection over WASI Execution.** | ABI admission and syscalls belong to WASI Execution under ADR-0003. No Node polyfill package can replace the runtime host. Delete any duplicated constructor/default-export assembly that adds no semantics. |
| SQLite | **Keep adapter over the selected browser/WASM SQLite engine and VFS.** | Database engine, persistence, synchronous behavior, and VFS coupling are host responsibilities; generic catalogs commonly stub or choose a different engine. |
| Async hooks / AsyncLocalStorage | **Keep context-owned integration; use Deno/Node algorithms and tests as prior art.** | Correct propagation depends on Mimic's scheduler, promises, process, and worker lifecycle. A standalone shim cannot observe all runtime scheduling points. |
| Error translation | **Keep one explicit Node-error adapter at each capability edge; delete the recursive proxy translator.** | `createDomainOperationTranslator` recursively proxies complete module/class/object graphs, wraps callbacks/promises, caches proxy identities, and special-cases branded values. This is broad hidden behavior and fragile class identity machinery. Domain adapters should translate structured failures at their direct operations/callbacks, with a small shared `toNodeError(owner, failure)` function in Node Compatibility. Do not add a new interface for one implementation. |

## Target shape

The external seam should remain approximately:

```ts
installNodeCompatibility({ global, builtins, errors }): {
  builtinModuleProvider: BuiltinModuleProvider;
  moduleResolutionErrorAdapter: ModuleResolutionErrorAdapter;
  teardown(): void;
}
```

This is illustrative, not a prescribed signature. The important decisions are:

1. Execution Context Bootstrap constructs one canonical builtin table. Bare and `node:` normalization and context-local caching happen once in the provider.
2. Pure semantic islands are direct imported module values or context-local constructors, not wrapped in an adapter/factory/registry chain.
3. Capability-backed entries are direct Mimic-owned Node adapters over VFS, Virtual Network, Process Execution, Module Execution Engine, HTTP codec, and WASI Execution.
4. Error translation occurs at explicit adapter operations. The provider translates only provider/resolution failures.
5. Default/named export identity is assembled once by the builtin implementation or a single tiny helper; repeated `Object.assign(builtin, { default: builtin })`, anonymous constructor factories, and wrapper mappings are deleted.

The deletion test supports the provider seam: removing it would spread normalization, identity, caching, and errors into every engine caller. It does not support the current factory layers: removing them leaves a table of the same values with less interface to learn.

## Adoption gate

No dependency should be added merely because this research names it. An implementation issue should accept `buffer` or `readable-stream` only if one tracer replacement proves all of the following:

1. the existing focused unit tests and the relevant maintained end-to-end claim pass unchanged;
2. bare/`node:` and CJS/ESM identities remain canonical per Execution Context and isolated across contexts;
3. the browser package build works in the package worker without Node host globals or dynamic host imports;
4. production bundle size and startup cost are measured, and the dependency removes more owned implementation than integration code adds;
5. no wrapper preserves the old implementation as fallback;
6. license and transitive dependency review is acceptable; and
7. the imported version is pinned by the normal lockfile and exercised in CI.

If either candidate fails this gate, retain the local implementation and borrow only a proven mechanism. That is not a reason to add a parallel compatibility path.

## Decisions-so-far gist

Reuse `buffer` and the `readable-stream` family only as whole, claim-gated semantic islands; keep Mimic-owned Node adapters over runtime capabilities, collapse builtin registration to one context table, and replace recursive proxy translation with explicit edge translation.

## New implications

- **New implementation ticket, after target seams are chosen:** tracer-evaluate `buffer` against the data-utilities and context-identity claims, measuring net deletion and bundle cost.
- **New implementation ticket, after the Buffer result:** tracer-evaluate `readable-stream` as one EventEmitter/streams/string-decoder subsystem against its focused claim and framework/package claims.
- **New design ticket:** specify the single canonical context builtin table and the exact deletion list for the two current factory/adapter registries.
- **New design ticket:** enumerate capability operations that currently rely on recursive proxy error translation and place explicit translation at each owning adapter edge before deleting the proxy.
- No prototype is justified for Deno, Bun, Nodepod, unenv, or a whole stdlib catalog; primary-source evidence already rules out wholesale adoption.
