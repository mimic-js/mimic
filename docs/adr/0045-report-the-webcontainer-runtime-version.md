---
status: accepted
amends: ADR-0039 (which left `process.versions.webcontainer` unset), ADR-0028 (the fallback a NAPI-RS loader runs under that marker), ADR-0016 (what `process.versions` reports)
---

# Report the runtime's version as `process.versions.webcontainer`

WebContainers set `process.versions.webcontainer`, and packages that run in
a browser-hosted Node read it to take the path they keep for one. ADR-0039
left it unset so that NAPI-RS loaders would "keep their own WASI fallback
rather than a WebContainers-specific installer". The demo application pool
of 2026-10-09 ([research](../research/2026-10-09-demo-app-pool.md)) found
the cost: Next.js 14 loads its SWC compiler through `loadBindings`, which
tries the WebAssembly build only for a short list of native triples it has
no binary for, or when `process.versions.webcontainer` is set. On
`linux`/`wasm32` neither holds, the native binding is "not installed", and
`next dev` exits before it starts. Next 13, 15 and 16 fall through to the
WebAssembly build without the marker; Next 14 has no other way to it.

A survey of what reads the marker (next 13–16, `@angular/build` 21,
`nitropack`, `rolldown`, `vite`, `launch-editor`; `rolldown`'s, `oxc`'s and
`@swc/core`'s loaders do not) shows every branch is one written for a Node
that runs in a browser:

- **next 13–16** load `@next/swc-wasm-nodejs` first, from `node_modules` or
  by downloading it into `next/wasm`, instead of a native `@next/swc-*`.
- **`@angular/build`** keeps no persistent build cache (its comment: it does
  not benefit from one there and it costs browser memory), skips the `lmdb`
  cache store the runtime cannot build anyway (ADR-0040), and runs its
  worker pool without the Atomics wait loop, which needs transferable
  objects over `receiveMessageOnPort`; its unit-test builder picks the
  browser-preview provider.
- **`nitropack`** listens on a random port instead of a Unix socket for its
  dev worker; **`rolldown`**'s watcher ends through `process.on('exit')`;
  **`vite`** and **`launch-editor`** default the editor to `code`.

The NAPI-RS loader template that installed a binding with pnpm into `/tmp`
under the marker is not in the surveyed current loaders; and the companions
of ADR-0028 are linked into a package at install time, before its loader
asks, so a loader that still has such a fallback finds the binding first.

## Decision

**`process.versions.webcontainer` is set, to the runtime package's
version.** `process.versions` otherwise reports what it did (`node`, `v8`,
`uv`, `modules`, `zlib`, `napi`), and `process.report` carries it among the
component versions. The identity stays `linux`/`wasm32`/`browser` with the
profiled Node release (ADR-0016, ADR-0039).

## Consequences

- Next.js 14 loads its SWC WebAssembly build and `next dev` serves the
  application; Next 13, 15 and 16 load it first instead of after a native
  attempt (demo pool, Next.js section).
- An Angular workspace builds without its persistent cache unless its
  `angular.json` enables it (`cli.cache.enabled: true`), as on StackBlitz.
  The Angular 21 and 22 compatibility fixtures enable it, so their claims
  keep proving a warm start from the cache a cold one left
  (`tests/e2e/angular-dev-suite.ts`).
- A program with a WebContainers branch takes it. Where that branch assumes
  a facility of WebContainers the runtime does not have, the program fails
  on that branch instead of its Node one; none surveyed does.
