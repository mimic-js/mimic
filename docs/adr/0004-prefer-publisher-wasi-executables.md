---
status: accepted
amended_by: ADR-0021 (installation of publisher WASI executables)
---

# Prefer publisher WASI executables for filesystem-owning toolchains

ADR-0021 replaces the installation half of this decision: there are no Catalog
Execution Artifacts, Install Environment Projections or Package Installation
Receipts. `ESBUILD_BINARY_PATH` names a launcher that runs the same-version
`@esbuild/wasi-preview1` of whichever esbuild calls it. The WASI execution
architecture below is unchanged.

When a browser-feasible toolchain publishes an official WASI executable, Mimic will prefer running that artifact through package-neutral Process Execution, WASI Execution, and Virtual File System capabilities so the unchanged upstream JavaScript API and service own their normal filesystem behavior. After an explicit executable request resolves to a file, Process Execution asks a narrow WASI-owned executable inspector to classify the WebAssembly magic, `_start` export, and WASI ABI imports rather than interpreting those details or using package identity itself; libraries and unsupported ABIs fail closed with a structured reason.

The first-class WASI Execution deep module owns supported ABI admission, instance lifecycle, descriptor state, and syscall semantics behind one package-internal entry point with two role-specific interfaces. A generic WASI Runtime Program invokes the command-execution interface with executable bytes and an admitted process context. Node Compatibility invokes a separate adapter factory that projects `node:wasi` while sharing the same hidden host core. Descriptor representations, syscall tables, and WebAssembly import wiring are not exported as cross-module interfaces.

ADR-0015 now controls the target module graph while ADR-0003 retains the
currently enforced migration baseline until the final Runtime Host cutover.
WASI Execution remains the sole WASI owner in both graphs.

A WASI executable child receives the same virtual filesystem namespace, cwd, argv, env, and stdio authority as an ordinary Runtime Process, including a preopen for the virtual root but never the host filesystem; explicit user-created WASI instances retain their caller-supplied preopens. The Browser Package Replacement Catalog selects and attests publisher artifacts but is not a runtime dispatch table. Browser module-API adapters that reinterpret filesystem behavior remain Compatibility Quarantines with explicit deletion conditions. This trades a deeper reusable WASI process and filesystem substrate for behavior that is closer to an ordinary machine and can support independent publisher toolchains.

The cutover begins with a behavior-preserving structural tracer: move the existing
descriptor and syscall host from Node Compatibility into WASI Execution, project
`node:wasi` as a thin adapter, transfer host-semantic tests to the new owner, and
retain Node-shaped identity plus browser-level Oxc/Rspack claims at their existing
interfaces. The old host is deleted in the same change; no dual host or Migration
Bridge is introduced. Raw executable admission and new capability families follow
only after this shared seam is proved.

The next tracer admits and runs one minimal raw Preview1 command end to end as an
ordinary Runtime Process. Executable resolution reads bytes, delegates supported
ABI inspection to WASI Execution after ordinary file, PATH, wrapper, and package-bin
resolution, and never falls back to JavaScript for a recognized but unsupported
WebAssembly artifact. The tracer proves `_start`, cwd, argv, env, stdio, process
identity, exit, signal, and cleanup semantics with a synthetic command before adding
filesystem mutation capabilities. Recognition and execution ship together so no
unobservable admission-only interface becomes permanent.

WASI Preview1 growth then follows three sequential, coherent capability families:

1. readable descriptors and namespace operations, including preopens, rights and
   flag validation, open, read, pread, seek, directory enumeration, file status,
   and readlink;
2. writable filesystem behavior, including create, exclusive, truncate, append,
   file-descriptor writes, directory creation, unlink, and directory removal through
   the authoritative Virtual File System; and
3. polling and unsupported-capability behavior, including clock and descriptor
   readiness, descriptor flags, and honest `NOSYS` results for admitted but unused
   socket operations.

Each family is proved first with synthetic package-neutral conformance fixtures.
They share and extend one descriptor invariant in order rather than landing as
parallel host implementations. An unknown import still fails executable admission;
there is no catch-all import stub. Publisher esbuild is an integration witness only
after these capability families pass.

For esbuild, the publisher lockfile remains the dependency-graph authority. Catalog
does not add `@esbuild/wasi-preview1` to `node_modules` or to an Effective Lockfile
Overlay. Instead, Package Installation stages its integrity-verified executable as
a Catalog Execution Artifact in a runtime-owned VFS path outside the installed
dependency graph. The Package Installation Receipt separately binds the source
lockfile digest, native install state, Catalog identity, exact execution-artifact
identity and integrity, selected executable, and relationship to the logical
`esbuild` package.

Catalog declares an Install Environment Projection from `ESBUILD_BINARY_PATH` to
that staged executable. Package Installation applies the projection only to the
upstream package-manager operation and its lifecycle children, and only when the
caller did not explicitly supply the variable. The unchanged upstream
`esbuild/install.js` validates the WASI executable and persists its supported manual
binary override in the installed package. Subsequent Runtime Processes receive no
hidden esbuild environment injection; `esbuild/lib/main.js` and its ordinary child
process control flow own execution after installation.

Publisher esbuild cutover is blocked by package-neutral Synchronous Child Process
Execution because the unchanged `esbuild/install.js` validates its selected binary
with `execFileSync`. Node Compatibility must project a coherent `spawnSync` and
`execFileSync` family over ordinary Process Execution admission, child identity,
captured stdio, signals, timeout, exit, and cleanup. Only the calling Execution
Context worker blocks; the Runtime Supervisor and child remain asynchronous, and
Execution Capacity must prevent a blocked parent from starving the child it awaits.
Skipping the lifecycle, fabricating the version check, or branching on esbuild is
not an admissible proof path.

Before a synchronous wait, the parent transfers its runnable Execution Capacity
lease to the admitted child and becomes a parked context. A nested synchronous child
transfers the same lease further down the wait chain; completion returns the lease
before waking each parent. Parked contexts do not consume runnable capacity but are
subject to a separate runtime-owned hard limit, with `EAGAIN` returned before a call
parks when that limit is exhausted. The parked-context limit is eight, matching the
maximum runnable capacity and bounding assigned Execution Context workers at
sixteen; it is runtime-owned and has no public tuning. A ninth park returns a
Node-shaped `EAGAIN` through the requested synchronous interface. This permits a capacity-one runtime to execute
the `install.js` to WASI-child path without introducing same-context evaluation or
an unbounded Worker pool.

The first Synchronous Child Process Execution slice implements one shared
`spawnSync` core and the Node Compatibility `execFileSync` projection. It supports
cwd, env, input, pipe/inherit/ignore stdio, encoding, timeout, kill signal, and
bounded output, preserving Node's distinct return and throw shapes for the two
interfaces. Generic JavaScript and WASI children prove success, non-zero exit,
timeout, output overflow, signal, teardown, capacity-one admission, and nested lease
transfer. `execSync` and shell execution remain explicit `ENOTSUP` until an
independent publisher workload demands the shell-string capability family.

Catalog adoption lands in two tickets. The first introduces Catalog v4 Execution
Artifact schema, exact publisher artifact acquisition, integrity verification, safe
staging before package-manager launch, caller-first Install Environment Projection,
receipt attestation, rollback, and cache reuse. A synthetic lifecycle fixture proves
that infrastructure without package-specific runtime behavior while preserving the
source lockfile byte for byte and adding no `node_modules` dependency node.

The second ticket atomically cuts exact `esbuild@0.25.12` over to the official
`@esbuild/wasi-preview1@0.25.12` Execution Artifact. It runs the unchanged upstream
installation lifecycle and ordinary CLI, JavaScript API, stdio service, and VFS
writes, then deletes the `esbuild-wasm` replacement, `wasm-module-api` and
`vfs-context` adapters, the `esbuild/lib/main.js` prohibition, and obsolete negative
claims. This ticket is blocked by the WASI capability sequence, Synchronous Child
Process Execution, and Catalog Execution Artifact infrastructure; no dual esbuild
path remains after it closes.

Cutover acceptance is one positive browser-level black-box claim through the public
Mimic interface. A tracked exact `esbuild@0.25.12` project installs with
the frozen manager operation, imports ordinary esbuild, performs a `write: true`
splitting build with a user plugin, observes entry files and sibling chunks through
the public VFS, edits an input, rebuilds through a context, disposes, tears down, and
repeats on a fresh boot. The focused claim passes twice sequentially with one worker
and no retries. It does not inspect adapter names, diagnostics, internal calls, or
the absence of legacy behavior; removal of the Compatibility Quarantine is part of
the cutover implementation and architecture review rather than the behavioral test.

Delivery follows this blocking graph:

1. Extract WASI Execution, then admit a minimal raw WASI Runtime Process.
2. From that tracer, readable descriptors block writable filesystem behavior, which
   blocks polling and unsupported-capability semantics.
3. Synchronous Child Process Execution also starts after the minimal raw process and
   may proceed in parallel with the filesystem capability sequence.
4. Catalog Execution Artifact infrastructure proceeds independently of the WASI
   capability sequence.
5. Publisher esbuild cutover is blocked by completed filesystem/polling semantics,
   Synchronous Child Process Execution, and Catalog Execution Artifact infrastructure.
6. Publisher esbuild cutover blocks canonical Vanilla Vite evidence and the existing
   Svelte and Vue optimizer acceptance slices. Vanilla evidence then blocks every
   framework update or HMR lane; Vue and Svelte HMR additionally require their own
   optimizer acceptance slice.
7. The independent stale-watch investigation proceeds in parallel and retains its
   existing downstream blocker. Final Vite integration waits for all positive lanes,
   the investigation outcome, and every repair issue opened for a failed maintained
   Compatibility Claim.

No additional hard dependency is inferred merely from shared code ownership or a
suspected cause.
