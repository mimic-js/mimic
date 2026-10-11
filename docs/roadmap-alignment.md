# Mimic roadmap

This document states where the runtime is going and what counts as proof that
it got there: the target, the evidence bar, the proof paths that are not
accepted, and the capability areas in the order they build on each other. It
is not a changelog or a status page. Current compatibility lives in the
maintained co-located Compatibility Claims and their CI results
([`compatibility-status.md`](./compatibility-status.md)); accepted decisions
live in [`adr/`](./adr/).

## Target

The public API follows the headless contract of
[ADR-0015](./adr/0015-simplify-browsercontainer-runtime-architecture.md):
`boot()`, `mount()`, `spawn()`, process streams and exit, `fs`,
presentation-neutral Published Endpoints, `export()`, and `teardown()`. The
WebContainers API is the external reference for its shape.

The target runtime is:

```text
Mimic public API
  -> isolated browser runtime and process ownership
  -> POSIX-like VFS plus Node-compatible fs behavior
  -> process tree, stdio, env, signals, cwd, and PATH
  -> npm, pnpm and Yarn, each proved separately
  -> Node CJS/ESM loader, package resolution, and coherent stdlib subset
  -> publisher-declared browser/WASM/WASI execution substrate
  -> process-owned TCP/HTTP/WebSocket virtual network
  -> real package bins and package-owned servers/toolchains
  -> Published Endpoint served only by the owning process and presented by application-owned UI
```

The compatibility goal is **Pragmatic Runtime Compatibility**: exact published
JavaScript graphs plus upstream-declared browser/WASM/WASI variants and
explicit declarative replacements. It is not complete OS emulation and does not
claim arbitrary native `.node`, ELF, Mach-O, or PE execution.

## Trust model

With a preview origin configured, the runtime's workers and the published
documents belong to that origin
([ADR-0032](./adr/0032-serve-published-endpoints-from-a-preview-origin.md),
[ADR-0033](./adr/0033-run-the-runtime-host-in-a-frame-of-the-preview-origin.md)),
so package code holds no authority of the embedding page; without one, it runs
in the page's own origin with ambient Web capabilities, as a deployment of
trusted code needs. A preview origin is still not resource containment: a
project spends the tab's CPU, memory and worker budget, bounded only by Process
Execution's capacity. The
[2026-10-06 security audit](./research/2026-10-06-runtime-security-audit.md)
lists the boundary and what remains outside it.

## Evidence bar

Compatibility claims are claim-scoped:

| Grade | Meaning |
| --- | --- |
| A | An exact published graph is installed and executed through the public API in cross-origin-isolated Playwright Chromium. The claimed lifecycle, forbidden-fallback scan, teardown, reboot, and green CI evidence are recorded. |
| B | Chromium public-API evidence proves a runtime behavior but not a complete published graph claim. |
| C | Unit, internal, Node-hosted, mocked, or source-inspection evidence. Useful for diagnosis, not a compatibility claim. |
| D | Declared, stale, unsupported, or unproved. |

Install success alone is not execution compatibility. A graph that stops at a
failure boundary remains a failed compatibility claim, not a pass.

Every positive graph claim must identify:

- exact package graph, lockfile, package-manager version, and virtual platform;
- browser/runtime revision and Browser Package Replacement revision;
- install activity, materialized packages, cache behavior, and replacement
  provenance;
- commands and lifecycle behavior actually exercised;
- forbidden fallback results, process/server cleanup, teardown, and reboot.

## Fallback and quarantine policy

The following cannot be final proof:

- a package- or tool-specific command adapter;
- metadata-only or synthetic package files that hide unresolved graph payloads;
- inline framework rendering or Mimic-owned framework logic;
- CDN rewrites such as `esm.sh`;
- transformed VFS content returned after the process-owned server misses;
- BroadcastChannel-only or synthetic HMR in a real dev-server path;
- host Node behavior presented as browser-runtime evidence;
- package-, tool-, or framework-name branches in generic loader, process,
  filesystem, networking, or runtime modules;
- silent substitution of a native package outside the Browser Package
  Replacements;
- snapshots, checked-in `node_modules`, mutable `latest`, or broad caches used
  instead of a fresh public-interface install witness (the Install Layer of
  an Exact Graph is allowed only as `compatibility-status.md` describes).

A **Compatibility Quarantine** is allowed only when it:

1. names the missing generic capability;
2. has one owner behind a tool-agnostic seam;
3. identifies the exact claim that still depends on it;
4. has a deletion condition and a negative guardrail;
5. is not used to promote a broader compatibility claim.

Package knowledge belongs only in the declarative Browser Package Replacement
map. Runtime modules execute the selected graph through generic mechanisms.
Direct OS-native executable support is outside the browser-runtime scope. When
the replacement map declares a browser/WASM replacement for a logical package
such as `esbuild`, the Command Proxy applies it explicitly
([ADR-0021](./adr/0021-reduce-package-management-to-a-pinned-cli-and-a-replacement-map.md)),
and compatibility reporting never relabels the result as native execution.

## Capability areas, in dependency order

### 0. Evidence system

- Each maintained assertion is a co-located Playwright Compatibility Claim run
  through the canonical compatibility-test fixture.
- Every registry-backed Exact Graph has a reviewed Tracked Compatibility
  Lockfile, mounted into a fresh Mimic and installed by the selected manager in
  frozen or immutable mode; a test never creates or rewrites the lockfile.
- Exact Graph evidence is additive
  ([ADR-0013](./adr/0013-keep-exact-graph-evidence-additive.md)): another
  version or profile adds a graph and a claim instead of replacing one.
- Every claim is a required, parallel-sharded pull-request gate; a scheduled
  run repeats the matrix to detect external drift.

### 1. Coherent Node execution substrate

- One Node/platform identity across loader behavior, engine checks, installer
  filtering, diagnostics, and replacement selection
  ([ADR-0010](./adr/0010-use-one-attested-runtime-platform-profile.md),
  [ADR-0016](./adr/0016-report-the-profile-identity-from-process.md)).
- Package-neutral globals, `Buffer`, process/os identity, cwd, env, argv, PATH,
  stdio, exits, executable lookup, CJS/ESM/package conditions, and explicit
  unsupported errors.

### 2. Process tree, VFS, and package-manager composition

- JavaScript children with independent pid/parent, cwd/env/argv, stdio with
  backpressure, signals, exit/close, descendant cleanup, and reboot behavior;
  `child_process` and `worker_threads` kept observably distinct.
- A VFS with byte-correct descriptor/stream/callback/sync operations, metadata,
  stable errors, symlinks, realpath, atomic rename, recursive watches, and
  export.
- npm graph resolution, peers, optionals, aliases, platform filtering, bins,
  lifecycle scripts, workspaces, integrity, and offline cache, run by the
  pinned upstream CLI.

### 3. Publisher browser/WASM/WASI substrate

- Installed WASM and Worker assets served byte-correctly from the VFS.
- Cross-origin-isolated Workers and shared memory, VFS/Buffer/WASI preopens,
  error ownership, concurrency, and teardown behind a package-neutral interface.
- Replacement versions derived from the exact selected source-package version;
  exact replacement provenance preserved end to end.
- Unmodified artifacts from at least two publishers and more than one host-glue
  family before the substrate is called generic.

### 4. Generic virtual networking

- Process-owned bind/listen/address/close, with readiness derived from virtual
  listen state.
- Stream-backed HTTP requests and responses, headers, status, bodies,
  trailers, aborts, backpressure, sockets, upgrades, and WebSocket framing.
- Browser requests routed only to the active owning process; a server miss
  stays a miss and never falls through to VFS content.
- A plain HTTP server, Express, Fastify, `ws`, and a non-Vite dev server proved
  through the same transport.

### 5. Package-manager breadth

- npm first; pnpm store/link/realpath/workspace behavior proved separately;
  Yarn `node-modules` proved separately from Yarn PnP/ZipFS.
- Every fixture pins its package-manager version; behavior is never inferred
  from ambient Corepack or from another manager.

### 6. Validated Major Lines and Exact Graphs

- Lanes follow supported upstream major lines and meaningful architecture
  transitions, each captured as an immutable Exact Graph.
- Native-request negative guards stay separate from official WASM, browser,
  and replaced execution profiles.
- Each lane records the install, build, watch, dev readiness, live update,
  serving, shutdown, and reboot behavior that applies to it.

### 7. Architecture and distribution

- Runtime Deep Modules keep the dependency direction documented in
  [ADR-0029](./adr/0029-move-runtime-behaviour-to-its-owner-and-keep-the-module-graph-in-documents.md).
- Architecture and package-boundary decisions are recorded as ADRs before a
  workspace or package migration.
- The published package works for a clean external consumer: install, boot,
  mount, run, serve, and teardown without repository-internal code.

## Completion definition

The roadmap is complete when maintained browser evidence shows all of the
following without forbidden fallbacks:

- representative plain Node CLI, process-tree, filesystem, and server workloads;
- npm plus separately scoped pnpm and Yarn modes;
- at least two independent publisher browser/WASM/WASI paths;
- process-owned HTTP and WebSocket behavior with streaming and teardown;
- Vite plus at least one non-Vite toolchain and one non-Vite server framework;
- co-located Playwright claims that fail on an earlier error, forbidden fallback,
  unexpected success, missing tracked lockfile, or lockfile mutation;
- repeated preview reload and runtime switching without stale routes, blank
  previews, or leaked workers;
- the published package exercised by a clean external consumer;
- explicit unsupported outcomes for everything outside the validated range.

## External baseline

The public target is derived from the WebContainers API and guides. Verify
upstream behavior when implementing a change because these pages evolve:

- https://webcontainers.io/api
- https://webcontainers.io/guides/quickstart
- https://webcontainers.io/guides/running-processes
- https://webcontainers.io/guides/introduction
- https://webcontainers.io/guides/browser-support
