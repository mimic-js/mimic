# Research: native-dependency strategies by ecosystem leverage

> Snapshot note: source findings and dated evidence are retained, but repo-specific
> “current state” statements may be obsolete. Verify them against current code,
> tests, issues, and [`compatibility-status.md`](../compatibility-status.md). See
> [the research status rules](./README.md).

Date: 2026-07-11

## Question

Which native dependencies dominate representative Node.js and frontend-toolchain workloads; which have official browser/WASM entrypoints or behaviorally compatible replacements suitable for the declarative Browser Package Replacement Catalog; which can be unlocked by small generic Node/OS emulation; and which may justify a generic browser-executable binary substrate?

This is a planning note for Map native-dependency strategies by ecosystem leverage (#118). It does not claim compatibility and does not propose package-specific runtime branches.

## Decision constraints

The terms and boundaries come from [`CONTEXT.md`](../../CONTEXT.md):

- **Pragmatic Runtime Compatibility** is the target, not complete OS emulation.
- Package knowledge may exist only as declarative **Browser Package Replacement Catalog** data. The installer, loader, process model, and WASM host must remain package-, tool-, and framework-agnostic.
- A **Validated Version Range** requires real published package graphs to pass the claim-relevant lifecycle through the public `Mimic` API in Chromium under Playwright. Registry metadata, upstream browser support, source inspection, and unit tests are candidate-selection evidence, not compatibility proof.
- A **Compatibility Quarantine** cannot become a package-identity dispatch mechanism.
- The preference order is official browser/WASM entrypoint, declarative browser/WASM replacement, small generic Node/OS emulation, then a generic browser-executable binary substrate.

## Method and limits

The inventory samples current high-value frontend tools (Vite, Rollup, esbuild, Next/SWC, Rolldown, Rspack, Parcel, Tailwind Oxide, Lightning CSS, Sass, Biome, and Oxlint) plus common Node native workload classes (image processing, SQLite, password hashing, canvas, and filesystem watching). Package topology comes from the packages' canonical npm registry documents and behavior from upstream documentation or source repositories.

“Dominates” below means one of two observable things: a native family is on the direct critical path of several representative tools, or it recurs as a common Node workload class. It does **not** mean npm downloads are unique users or that this sample proves total ecosystem share. Current npm download counters are useful only as a directional sanity check because installs, mirrors, CI, and dependency fan-out inflate them ([npm downloads API](https://github.com/npm/registry/blob/main/docs/download-counts.md)).

## Executive finding

The opportunity is concentrated, not evenly distributed:

1. Frontend tools are dominated by a small set of compiler/bundler bindings: esbuild, Rollup, Rolldown/Oxc, Lightning CSS, SWC/Next SWC, Rspack, Parcel Rust, Tailwind Oxide, Biome, and Oxlint. Many already publish an official browser or `wasm32-wasi` artifact.
2. Two reusable Node-API-over-WASM families now recur across independent publishers: NAPI-RS/emnapi (`@rolldown/browser`, Rspack WASI, Tailwind Oxide WASI, and sharp's WASM artifacts) and `napi-wasm` (Lightning CSS and Parcel Watcher). That convergence justifies a focused generic substrate prototype.
3. Small generic capabilities—WASM asset loading, `browser`/conditional-export selection, Workers, cross-origin-isolated shared memory, `Buffer`, a virtual `fs`, and filesystem watch semantics—unlock multiple official paths. These are higher leverage and lower risk than emulating arbitrary binaries.
4. Generic execution of existing `.node`, ELF, Mach-O, or PE artifacts is a different and much larger problem. Node defines `.node` files as dynamically linked native libraries; Node-API ABI stability does not make host machine code browser-executable ([Node addon loading](https://nodejs.org/api/addons.html#loading-addons-using-require), [Node-API](https://nodejs.org/api/n-api.html)). No representative evidence justifies building a general OS/CPU emulator before the publisher-supplied WASM route is exhausted.

## Representative native-dependency inventory

### Tier A — recurring frontend critical paths with official browser/WASM routes

| Native family | Representative reach | Official browser/WASM route | Catalog suitability and semantic boundary |
| --- | --- | --- | --- |
| **esbuild** | esbuild itself and toolchains that call its JS API; the npm package selects one of many platform binaries via optional dependencies ([`esbuild` registry metadata](https://registry.npmjs.org/esbuild/latest)). | `esbuild-wasm` is the upstream browser package. It runs WASM in a Worker and requires `initialize({ wasmURL })`; synchronous APIs are absent ([esbuild browser API](https://esbuild.github.io/api/#running-in-the-browser)). | **Ready catalog candidate**, already browser-proven in this repo for a pinned transform/context claim. Catalog data must encode exact-version coupling, WASM asset location, initialization, and the unavailable sync surface. Do not generalize the current proof beyond its tested API/lifecycle. |
| **Rollup 4** | Rollup 4 selects OS/CPU native packages and is a direct bundler workload ([`rollup` registry metadata](https://registry.npmjs.org/rollup/latest)). | `@rollup/browser` uses browser APIs, ships a WASM binding, and accepts an in-memory implementation of a subset of Node `fs`; `@rollup/wasm-node` is the platform-independent Node-oriented build ([Rollup browser build](https://rollupjs.org/browser/), [Rollup migration guide](https://rollupjs.org/migration/)). | **Ready candidate with two declared profiles**: browser build for browser-style execution and `wasm-node` where Node API fidelity is required. The browser build needs a WASM asset and VFS injection; plugin compatibility is claim-scoped. |
| **Rolldown/Oxc** | Current Vite uses Rolldown and Lightning CSS directly, while Rolldown selects native bindings including a WASI option ([`vite` metadata](https://registry.npmjs.org/vite/latest), [`rolldown` metadata](https://registry.npmjs.org/rolldown/latest)). | `@rolldown/browser` has browser conditional exports and depends on `@napi-rs/wasm-runtime` plus emnapi; Rolldown also publishes `@rolldown/binding-wasm32-wasi` ([browser metadata](https://registry.npmjs.org/%40rolldown%2Fbrowser/latest), [WASI binding metadata](https://registry.npmjs.org/%40rolldown%2Fbinding-wasm32-wasi/latest)). | **High-priority candidate** because it is on the current Vite critical path and exercises the generic NAPI-RS/emnapi substrate. Prefer the official browser package; do not teach the runtime Rolldown's name. |
| **Lightning CSS** | Current Vite depends directly on Lightning CSS; Parcel and CSS pipelines also expose it as a first-class transformer ([`vite` metadata](https://registry.npmjs.org/vite/latest), [`lightningcss` metadata](https://registry.npmjs.org/lightningcss/latest)). | `lightningcss-wasm` is the official Deno/browser package, requires asynchronous initialization, and accepts/returns typed arrays ([Lightning CSS browser docs](https://lightningcss.dev/docs.html#from-deno-or-in-browser), [`lightningcss-wasm` metadata](https://registry.npmjs.org/lightningcss-wasm/latest)). | **Ready candidate for transform/minify claims**. Validate API surface per version rather than assuming the native package is a transparent alias. Its dependency on `napi-wasm` also tests a second reusable Node-API/WASM host family. |
| **SWC / Next SWC** | `@swc/core` and Next publish broad matrices of platform-specific optional bindings; Next also optionally installs sharp ([`@swc/core` metadata](https://registry.npmjs.org/%40swc%2Fcore/latest), [`next` metadata](https://registry.npmjs.org/next/latest)). | `@swc/wasm-web` is the upstream browser module; it must be initialized and then supports synchronous transformation in-browser ([SWC WASM docs](https://swc.rs/docs/usage/wasm)). Next documents its own WASM fallback as incomplete for some features, including Turbopack ([Next SWC load failure](https://nextjs.org/docs/messages/failed-loading-swc), [Next Turbopack](https://nextjs.org/docs/app/api-reference/turbopack)). | **Catalog candidate for explicit SWC transform/minify claims, not a blanket Next replacement**. Next's package-specific orchestration must remain upstream code or catalog metadata; missing feature parity is a semantic limit, not a reason for a runtime name check. |
| **Rspack** | `@rspack/core` depends on `@rspack/binding`, which publishes many native optional packages and a WASI binding ([core metadata](https://registry.npmjs.org/%40rspack%2Fcore/latest), [binding metadata](https://registry.npmjs.org/%40rspack%2Fbinding/latest)). | `@rspack/binding-wasm32-wasi` exposes a browser entry and depends on the same NAPI-RS/emnapi runtime family as Rolldown ([WASI binding metadata](https://registry.npmjs.org/%40rspack%2Fbinding-wasm32-wasi/latest)). | **Excellent substrate-prototype workload**. The artifact is publisher-supplied and selected declaratively; full Rspack compatibility still depends on generic Node/process/fs/worker capabilities and must be browser-proven. |
| **Tailwind Oxide** | Tailwind's current Oxide package selects a platform binding and includes `@tailwindcss/oxide-wasm32-wasi` in its optional dependency matrix ([Oxide metadata](https://registry.npmjs.org/%40tailwindcss%2Foxide/latest)). | The WASI package declares a browser entry and depends on emnapi and `@napi-rs/wasm-runtime` ([Oxide WASI metadata](https://registry.npmjs.org/%40tailwindcss%2Foxide-wasm32-wasi/latest)). | **Excellent substrate-prototype workload** and evidence that the generic path reaches beyond bundlers. A catalog entry may force/select the WASI platform package, but runtime execution remains generic. |

### Tier B — official WASM exists, but selection or semantic limits need proof

| Native family | Representative reach | Browser/WASM fact | Decision |
| --- | --- | --- | --- |
| **Parcel Rust** | `@parcel/core` directly depends on `@parcel/rust`, and Parcel also uses native source-map and watcher components ([`@parcel/core` metadata](https://registry.npmjs.org/%40parcel%2Fcore/latest), [`@parcel/rust` metadata](https://registry.npmjs.org/%40parcel%2Frust/latest)). | The main Rust package currently lists host-native platform packages, while `@parcel/watcher-wasm` separately publishes a WASM implementation using `napi-wasm` ([Rust metadata](https://registry.npmjs.org/%40parcel%2Frust/latest), [watcher-WASM metadata](https://registry.npmjs.org/%40parcel%2Fwatcher-wasm/latest)). | **Catalog the watcher replacement only after behavioral proof; keep Parcel overall partial/unknown.** The Rust core remains a separate blocker. This is a good test of whether generic `fs`/watch semantics remove a native edge without runtime package knowledge. |
| **Biome and Oxlint** | Both distribute native CLI matrices ([Biome metadata](https://registry.npmjs.org/%40biomejs%2Fbiome/latest), [Oxlint metadata](https://registry.npmjs.org/oxlint/latest)). | Biome publishes official `@biomejs/wasm-web` and `@biomejs/wasm-nodejs` workspace APIs ([Biome WASM-web metadata](https://registry.npmjs.org/%40biomejs%2Fwasm-web/latest), [Biome WASM-node metadata](https://registry.npmjs.org/%40biomejs%2Fwasm-nodejs/latest)). Oxc publishes WASM packages for components such as its parser, but current Oxlint metadata does not advertise a browser/WASI CLI sibling ([Oxc parser WASM metadata](https://registry.npmjs.org/%40oxc-parser%2Fwasm/latest), [Oxlint metadata](https://registry.npmjs.org/oxlint/latest)). | **Biome workspace APIs are candidates; CLI substitution is not assumed. Oxlint stays unsupported pending an official equivalent.** A library API that can format/lint text is not automatically behaviorally compatible with a CLI process contract. |
| **sharp** | Next lists sharp as an optional dependency; sharp is the representative high-value native image pipeline ([Next metadata](https://registry.npmjs.org/next/latest), [sharp metadata](https://registry.npmjs.org/sharp/latest)). | sharp publishes `@img/sharp-wasm32` and, currently, `@img/sharp-webcontainers-wasm32`; however sharp's official installation guide explicitly says browser use is unsupported, along with single-threaded execution, native text rendering, and tile output ([sharp metadata](https://registry.npmjs.org/sharp/latest), [WebContainers WASM package metadata](https://registry.npmjs.org/%40img%2Fsharp-webcontainers-wasm32/latest), [sharp WASM limits](https://sharp.pixelplumbing.com/install/#webassembly)). | **Prototype candidate for the generic substrate, not yet a Browser Package Replacement Catalog compatibility claim.** The WebContainers-targeted artifact is strong opportunity evidence, but upstream's browser prohibition and missing features require an exact environment/API/lifecycle proof before catalog admission. |
| **Sass watcher path** | Current `sass` is JavaScript but optionally installs native `@parcel/watcher`; `sass-embedded` distributes platform executables and communicates with a child process ([Sass metadata](https://registry.npmjs.org/sass/latest), [Sass Embedded metadata](https://registry.npmjs.org/sass-embedded/latest)). | `@parcel/watcher-wasm` exists, while regular Sass can run without making the embedded compiler binary the only route ([watcher-WASM metadata](https://registry.npmjs.org/%40parcel%2Fwatcher-wasm/latest), [Sass metadata](https://registry.npmjs.org/sass/latest)). | **Prefer regular Sass plus generic watch behavior.** Replacing Sass Embedded must preserve its process/protocol semantics and offers less leverage than enabling the standard JS package path. |

### Tier C — Node workload classes without drop-in browser replacements

| Workload class | Native packages | First-party browser/WASM evidence | Why it is not yet a catalog alias |
| --- | --- | --- | --- |
| **SQLite** | `better-sqlite3` and `sqlite3` load compiled addons through binding/prebuild packages ([better-sqlite3 metadata](https://registry.npmjs.org/better-sqlite3/latest), [sqlite3 metadata](https://registry.npmjs.org/sqlite3/latest)). | SQLite publishes an official browser-focused WASM distribution with C-like, object-oriented, Worker, Promise-Worker, and OPFS-backed interfaces ([SQLite WASM APIs](https://sqlite.org/wasm/doc/trunk/api-index.md), [SQLite WASM persistence](https://sqlite.org/wasm/doc/trunk/persistence.md)). | The APIs, sync/async behavior, worker model, and persistence contract differ from Node add-ons. Official SQLite WASM proves capability, not behavioral interchangeability. A separately maintained API-compatible package could become catalog data; runtime code must not adapt `better-sqlite3` by name. |
| **Password hashing** | `bcrypt` is a Node-API addon loaded through `node-gyp-build` ([bcrypt metadata](https://registry.npmjs.org/bcrypt/latest), [bcrypt source](https://github.com/kelektiv/node.bcrypt.js)). | The native package's upstream metadata and repository do not declare a browser/WASM route. | A declarative replacement is possible only after proving API, encoded-hash, error, async/sync, and performance behavior across a Validated Version Range. Crypto performance and side-channel behavior raise semantic risk; generic runtime code must not translate bcrypt calls. |
| **Canvas** | `canvas` is a Node-API package backed by native graphics libraries ([canvas metadata](https://registry.npmjs.org/canvas/latest), [node-canvas repository](https://github.com/Automattic/node-canvas)). | Browsers standardize `HTMLCanvasElement` and `OffscreenCanvas`, but those platform APIs are not the `canvas` npm package's Node API or native dependency stack ([HTML Living Standard: canvas](https://html.spec.whatwg.org/multipage/canvas.html)). | Browser Canvas is a platform capability, not a drop-in package replacement. A compatible browser package may be cataloged if independently proven; direct runtime adaptation would violate the package-agnostic boundary. |

## What small generic emulation unlocks

The highest-leverage “emulation” layer is narrow and capability-oriented:

| Generic capability | Workloads unlocked or advanced | Risk boundary |
| --- | --- | --- |
| **Conditional exports and `browser` field selection, `cpu: wasm32` install planning, and exact WASM/worker asset URL preservation** | Official browser packages and platform packages for Rolldown, Rspack, Tailwind Oxide, NAPI-RS packages, Prettier-like self-described browser entries, and other publisher-provided WASM artifacts ([NAPI-RS packaging/install contract](https://napi.rs/docs/concepts/webassembly), [npm package metadata semantics](https://docs.npmjs.com/cli/v11/configuring-npm/package-json)). | Low semantic risk if selection is standards/metadata-driven. Catalog entries may declare a replacement and version rule, but resolver behavior stays generic. |
| **Virtual `fs` subset plus coherent watch notifications** | Rollup browser explicitly accepts a subset of Node `fs`; Parcel Watcher WASM, Sass, and toolchain watch modes can build on a generic VFS/watch seam ([Rollup browser FS](https://rollupjs.org/browser/), [Node `fs.watch`](https://nodejs.org/api/fs.html#fswatchfilename-options-listener)). | Medium semantic risk: event coalescing, rename/change differences, recursive watching, path identity, and teardown must be claim-tested. It is still generic OS behavior, not package adaptation. |
| **Workers, SharedArrayBuffer/Atomics, cross-origin isolation, top-level await, `import.meta.url`, and deterministic WASM asset serving** | NAPI-RS WASI browser modules and multithreaded publisher builds; the NAPI-RS support matrix explicitly requires a cross-origin-isolated browser, shared memory, ESM workers, top-level await, and correct asset serving ([NAPI-RS browser support matrix](https://napi.rs/docs/concepts/webassembly)). | Medium implementation/lifecycle cost but low package-specificity. Proof must cover worker startup, concurrent calls, errors, process exit, teardown, memory growth, and asset failures—not only one transform. |
| **`Buffer` and a VFS-backed WASI filesystem/preopens** | NAPI-RS can generate browser glue that injects `Buffer` and an in-memory filesystem; these capabilities recur across data/image/compiler addons ([NAPI-RS browser configuration](https://napi.rs/docs/concepts/webassembly)). | Medium semantic risk. The VFS is not the host filesystem, and WASI preopen/security semantics must be explicit. |
| **Omission of optional platform accelerators when an upstream JS/generic path remains** | `fsevents` in Rollup/Vite and optional native watchers should not block non-macOS/browser installation merely because a faster platform path is unavailable ([Rollup metadata](https://registry.npmjs.org/rollup/latest), [Vite metadata](https://registry.npmjs.org/vite/latest)). | Low if upstream declares the dependency optional and acceptance tests prove the fallback lifecycle. Omission is not a license to suppress required native failures. |

These capabilities should be exposed as generic runtime mechanisms. A Catalog entry can say “select this browser package, preserve these assets, require these conditions, reject this unsupported API profile”; it should not name a runtime hook such as `runTailwindOxide` or branch in module loading on `sharp`.

## Does a generic browser-executable binary substrate deserve a prototype?

**Yes—but narrowly: prototype publisher-supplied Node-API/WASI artifacts, not arbitrary host-native binaries.**

The strongest evidence is convergence across independent, current packages:

- `@rolldown/browser` and `@rolldown/binding-wasm32-wasi` use NAPI-RS/emnapi ([Rolldown browser metadata](https://registry.npmjs.org/%40rolldown%2Fbrowser/latest)).
- `@rspack/binding-wasm32-wasi` uses the same runtime family and declares a browser entry ([Rspack WASI metadata](https://registry.npmjs.org/%40rspack%2Fbinding-wasm32-wasi/latest)).
- `@tailwindcss/oxide-wasm32-wasi` uses the same runtime family and declares a browser entry ([Oxide WASI metadata](https://registry.npmjs.org/%40tailwindcss%2Foxide-wasm32-wasi/latest)).
- NAPI-RS officially generates browser loaders, workers, package fallbacks, and optional generic `Buffer`/memfs integration, and documents a browser-tested publisher workflow ([NAPI-RS WebAssembly/WASI](https://napi.rs/docs/concepts/webassembly)).
- Lightning CSS and Parcel Watcher independently publish browser/WASM bindings on `napi-wasm`, showing that Node-API-shaped WASM is broader than one toolchain ([Lightning CSS WASM metadata](https://registry.npmjs.org/lightningcss-wasm/latest), [Parcel Watcher WASM metadata](https://registry.npmjs.org/%40parcel%2Fwatcher-wasm/latest)).

The prototype question should therefore be:

> Can Mimic install and execute unmodified, publisher-supplied browser/WASI packages from at least two independent Node-API/WASM families through generic package resolution, VFS, Worker, shared-memory, and asset-loading mechanisms, with no package identity checks?

Suggested proof workloads are `@rolldown/browser` or Rolldown's WASI binding, `@tailwindcss/oxide-wasm32-wasi`, `@rspack/binding-wasm32-wasi`, and one `napi-wasm` package such as `@parcel/watcher-wasm` or `lightningcss-wasm`. Requiring at least two publishers and two host-glue families prevents an esbuild-style package adapter from masquerading as a substrate.

The prototype should explicitly **not** attempt to load existing `.node` files or Linux executables. Node documents `.node` as dynamically linked native libraries, often linked to Node/V8/libuv or external C/C++ libraries ([Node addon loading](https://nodejs.org/api/addons.html#loading-addons-using-require)). NAPI-RS also warns that a dependency may compile natively yet fail for WASI because it assumes unavailable POSIX APIs ([NAPI-RS C/C++ dependency guidance](https://napi.rs/docs/concepts/webassembly#build-cc-dependencies)). A CPU emulator plus dynamic linker, libc, syscalls, threads, files, signals, sockets, and process semantics would be complete-OS work with much higher maintenance and lower browser performance; this inventory does not show enough marginal coverage to justify it.

## Strategy ranking

Scores are relative planning judgments from **1 (worst/lowest)** to **5 (best/highest)**. “Neutrality” means absence of package-specific runtime code. Coverage is inferred from the representative inventory; risk and cost are architectural judgments, not upstream claims.

| Rank | Strategy | Ecosystem coverage | Semantic safety | Performance | Low maintenance cost | Runtime neutrality | Recommendation |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| **1** | Honor official browser/WASM entrypoints and generic package metadata | 4 | 5 | 3 | 5 | 5 | **Do first.** It is upstream-owned, auditable, and lowest risk. Build generic export/browser/asset/Worker support and prove each package profile. |
| **2** | Declarative Browser Package Replacement Catalog for official siblings | 5 | 4 | 3 | 4 | 5 | **Do first alongside rank 1.** Seed/extend with esbuild, Rollup, Rolldown, Lightning CSS, and scoped SWC claims; encode version, assets, initialization, and exclusions declaratively. |
| **3** | Small generic Node/OS emulation: VFS, watch, Buffer, Workers/shared memory, WASM lifecycle | 5 | 4 | 4 | 3 | 5 | **Invest incrementally.** These are prerequisites shared by catalog entries and pure-JS Node workloads. Each addition needs lifecycle evidence and a narrow semantic contract. |
| **4** | Generic publisher-supplied Node-API/WASI substrate (NAPI-RS/emnapi plus `napi-wasm` compatibility) | 4 | 3 | 3 | 2 | 5 | **Prototype next.** Current Rolldown, Rspack, Tailwind, Lightning CSS, and Parcel artifacts show broad leverage. Exit only on multi-publisher, no-name-check browser proof. |
| **5** | Declarative API-compatible third-party replacements for SQLite/bcrypt/canvas classes | 3 | 2 | 2–4 | 2 | 5 | **Evaluate case by case after generic paths.** Admit only replacements that own compatibility in package code and pass exact behavioral/lifecycle tests; do not write runtime adapters. |
| **6** | Generic execution of arbitrary `.node`/ELF/native machine code | 5 theoretical | 1 | 1 | 1 | 4 | **Defer/reject for this map.** The theoretical coverage is broad, but it implies CPU/OS/dynamic-linker emulation and violates the pragmatic cost frontier without evidence that publisher WASM paths are insufficient. |

## Proposed Browser Package Replacement Catalog classifications

Catalog records should declare facts, not imperative package hooks. A minimal planning shape is:

```ts
type BrowserReplacementProfile = {
  requestedPackage: string;
  validatedRequestedRange: string;
  replacementPackage: string;
  replacementVersionRule: 'exact' | 'catalog-pinned';
  selection: 'browser-export' | 'wasm32-platform' | 'logical-alias';
  assets: Array<'wasm' | 'worker'>;
  requirements: Array<
    | 'cross-origin-isolation'
    | 'shared-memory'
    | 'virtual-fs'
    | 'buffer'
    | 'top-level-await'
  >;
  supportedClaims: string[];
  excludedClaims: string[];
  provenance: string[];
};
```

The exact implementation type is not decided here. The important constraints are that the record contains a Validated Version Range and claim boundary, generic requirements are capabilities rather than package-named callbacks, and unsupported APIs are explicit.

Recommended states for the current inventory:

| State | Candidates |
| --- | --- |
| **Catalog now / extend existing proof** | `esbuild → esbuild-wasm`; begin evidence work for Rollup browser/WASM, Rolldown browser/WASI, Lightning CSS WASM. |
| **Catalog after scoped behavior proof** | `@swc/core → @swc/wasm-web` for transform/minify only; Parcel Watcher → watcher WASM; Biome native CLI → WASM workspace API only if the requested contract is library-level; Rspack/Tailwind WASI selection. |
| **Substrate prototype, not compatibility claim** | sharp WebContainers/WASM artifact; multi-threaded NAPI-RS packages; cross-family `napi-wasm` packages. |
| **Not behaviorally interchangeable today** | `better-sqlite3`/`sqlite3 → SQLite WASM`, `canvas → browser Canvas`, `bcrypt → unspecified pure-JS package`, full Next SWC/Turbopack → generic SWC WASM. |
| **Unsupported/deferred** | Oxlint CLI without an official equivalent, Parcel Rust core without a publisher browser/WASI path, arbitrary `.node` and native executable payloads. |

## Compatibility proof requirements

Every promoted catalog profile or substrate capability must be proven against the claim, not merely shown to instantiate:

1. Install an exact real published graph through `spawn('npm', ['install'])` using only public `Mimic` APIs in cross-origin-isolated Chromium under Playwright.
2. Assert the selected replacement/platform package, WASM, and Worker assets came from the installed graph; reject native host payload execution, CDN substitution, adapter execution, and package-name dispatch.
3. Exercise the behavior that downstream workloads use: transform/build/watch/rebuild, filesystem access, concurrency, error propagation, process exit, kill/teardown, preview/network lifecycle where applicable, and persistence semantics where claimed.
4. Prove declared exclusions fail clearly. Examples include esbuild sync APIs, unsupported sharp browser/text/tile paths, incomplete SWC/Next features, and SQLite API differences.
5. Record exact package versions, browser/runtime revision, lifecycle scenarios, and last-green CI revision as the Validated Version Range evidence. Unit and lower-level tests support diagnosis but cannot promote the claim.
6. For the generic substrate, require at least two independent publishers and both NAPI-RS/emnapi and `napi-wasm`-style packages to execute without package-specific runtime code. A single catalog entry is evidence for that entry, not for the substrate.

## Recommended decision and next map frontier

Adopt this ordered program:

1. Expand the Browser Package Replacement Catalog around official browser/WASM packages, with generic asset/init/capability declarations and exact claim boundaries.
2. Invest in the small generic capabilities shared by those packages: metadata-driven selection, WASM/Worker asset preservation, cross-origin-isolated Workers/shared memory, VFS/`Buffer`, and watch semantics.
3. Create one focused prototype ticket for a **publisher-supplied Node-API/WASI browser substrate**, with multi-publisher and cross-host-glue exit criteria and an explicit prohibition on package identity checks.
4. Keep API-different SQLite, bcrypt, canvas, and image alternatives out of the catalog until a package owns the compatibility layer and Mimic proves it behaviorally.
5. Keep arbitrary `.node`/ELF execution out of scope until measured workload failures show substantial coverage remains after official browser/WASM, declarative replacements, generic emulation, and publisher-supplied WASI are exhausted.

This ordering maximizes Pragmatic Runtime Compatibility without turning Mimic into a collection of framework shims or prematurely committing to complete OS emulation.

## Primary sources

### Package topology

- [npm package metadata semantics](https://docs.npmjs.com/cli/v11/configuring-npm/package-json)
- [Vite registry metadata](https://registry.npmjs.org/vite/latest)
- [esbuild registry metadata](https://registry.npmjs.org/esbuild/latest)
- [Rollup registry metadata](https://registry.npmjs.org/rollup/latest)
- [Rolldown registry metadata](https://registry.npmjs.org/rolldown/latest)
- [Lightning CSS registry metadata](https://registry.npmjs.org/lightningcss/latest)
- [SWC registry metadata](https://registry.npmjs.org/%40swc%2Fcore/latest)
- [Next registry metadata](https://registry.npmjs.org/next/latest)
- [Rspack registry metadata](https://registry.npmjs.org/%40rspack%2Fbinding/latest)
- [Parcel core registry metadata](https://registry.npmjs.org/%40parcel%2Fcore/latest)
- [Tailwind Oxide registry metadata](https://registry.npmjs.org/%40tailwindcss%2Foxide/latest)
- [sharp registry metadata](https://registry.npmjs.org/sharp/latest)

### Browser/WASM behavior

- [esbuild browser API](https://esbuild.github.io/api/#running-in-the-browser)
- [Rollup browser build](https://rollupjs.org/browser/)
- [Lightning CSS browser/WASM usage](https://lightningcss.dev/docs.html#from-deno-or-in-browser)
- [SWC WASM usage](https://swc.rs/docs/usage/wasm)
- [NAPI-RS WebAssembly and WASI](https://napi.rs/docs/concepts/webassembly)
- [sharp WASM installation and limits](https://sharp.pixelplumbing.com/install/#webassembly)
- [SQLite WASM API index](https://sqlite.org/wasm/doc/trunk/api-index.md)
- [SQLite WASM persistence](https://sqlite.org/wasm/doc/trunk/persistence.md)
- [Node addon loading](https://nodejs.org/api/addons.html#loading-addons-using-require)
- [Node-API](https://nodejs.org/api/n-api.html)
