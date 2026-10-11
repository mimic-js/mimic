# Research: frontend toolchain compatibility frontier

> Snapshot note: source findings and dated evidence are retained, but repo-specific
> “current state” statements may be obsolete. Verify them against current code,
> tests, issues, and [`compatibility-status.md`](../compatibility-status.md). See
> [the research status rules](./README.md).

Date: 2026-07-11

## Why this research exists

This note defines which frontend toolchain versions and lifecycle behaviors are valuable compatibility probes for a browser-resident Node runtime. It focuses on architecture boundaries that exercise materially different runtime capabilities, rather than treating every major release as equally informative.

Only primary sources were used: official documentation, upstream release/migration pages, and first-party npm package metadata or source.

## Main conclusion

The compatibility frontier is not a single “bundler works” check. It has three distinct execution classes:

1. **JavaScript-first Node toolchains**, represented by webpack, mainly pressure Node APIs, configuration loading, filesystem watching, HTTP/WebSocket serving, loaders, and plugins.
2. **Native-default toolchains with official WASM/browser variants**, represented by Rollup, esbuild, Rolldown, and Rspack. Their native and WASM paths must be recorded as different outcomes; one is not evidence for the other.
3. **Native-heavy integrated systems**, represented by Parcel and Next.js/Turbopack, where successful production builds are only part of the claim. Their dev loops also exercise watchers, worker/process orchestration, caches, HTTP/HMR, and optional native dependency installation.

Vite straddles these classes. Vite 6–7 use esbuild during development and Rollup for production, while Vite 8 replaced both with Rolldown/Oxc-based tooling. This makes Vite 7→8 the highest-value current architecture boundary.

## Current Mimic frontier

The repository's evidence rubric distinguishes maintained A-grade browser proof from exploratory browser probes. A-grade proof installs an exact published graph and exercises the claimed lifecycle through the public `Mimic` interface in Chromium, rejects relevant fallback paths, and remains green in CI. The current `main` revision is `52e27a4`; its complete CI run passed build/typecheck, unit contracts, and the maintained Playwright compatibility suite on 2026-07-11.

For this investigation, one-shot exploratory Playwright probes used the same public browser path—`boot`, `mount`, `spawn('npm', ['install'])`, and `npm exec`/`node`—against real registry graphs in cross-origin-isolated Chromium. They establish exact current failure boundaries, but they are not A-grade compatibility claims because the probes are not retained as maintained CI fixtures.

| Published lane | Current status | Lifecycle actually observed | Exact boundary |
| --- | --- | --- | --- |
| Vite `6.4.3` with the six pinned vanilla/TypeScript/React/Vue/Solid/Svelte graphs | **Browser-proven for the maintained dev paths; partial overall** | Install, real Vite bin startup, dev-server readiness, module/asset serving, dependency optimization, rendering, source updates/HMR, preview reload and teardown; framework details vary by fixture | This is the only maintained Vite line. Production build/watch/preview and other Vite 6 patch lines are not claimed. Vue remains partial for state-preserving HMR, and remaining Rollup parsing behavior uses package-specific loader adapters. |
| Vite `7.3.6` | **Unsupported today** | Exploratory install succeeded with the real 11-package graph; `vite build` started | Mimic reports Node `22.0.0`, below Vite's supported `22.12+` floor, and execution then stops at the explicit missing `node:http2` builtin. No dev/HMR/watch path was reached. |
| Vite `8.1.4` | **Unsupported today** | Exploratory install succeeded with the real 13-package Rolldown graph; `vite build` started | Rolldown fails with `Cannot find native binding`. The installer materializes neither a supported platform binding nor an explicit WASI/browser replacement for the logical package. |
| webpack `5.108.4` + webpack-cli `7.2.1` | **Unsupported today** | Exploratory install succeeded with 105 real packages; the real webpack JS bin started | Startup stops in `graceful-fs/polyfills.js` because the generic Node `constants` builtin is absent. This is the first observed blocker, before build output. Current webpack-dev-server `6.0.0` also requires Node `22.15+`, above Mimic's reported version, so serve/HMR is not presently a valid lane. |
| Rollup `4.62.2` | **Exploratory one-shot build succeeds; toolchain compatibility is partial** | The real package installed and `rollup src.js --file bundle.js --format esm` exited 0 | Success crosses package-specific `rollup/dist/native.js` and `parseAst.js` adapters in `module-loader.ts`. Those shallow adapters hide native parsing/hashing behind Rollup-aware branches, so this is not toolchain-agnostic or proof of the ordinary native package, `@rollup/wasm-node`, `@rollup/browser`, plugins, config loading, or watch lifecycle. |
| esbuild `0.25.12` | **Browser-proven for a narrow WASM API claim** | Maintained install plus `transform()` and `context().rebuild()`, VFS output, diagnostics and teardown | Mimic declaratively replaces logical `esbuild` with version-matched `esbuild-wasm`. Direct native entry execution is explicitly rejected; CLI, sync APIs, native child process, serve, watch and SSE live reload are not claimed. |
| esbuild `0.28.1` | **Exploratory WASM transform succeeds; unvalidated** | Real logical package installed; `transform()` ran through the replacement and reported `0.28.1` | This extends the observed API shape beyond the maintained pin but is not in the coverage manifest or CI. It does not upgrade the native or full-lifecycle claim. |
| Parcel `2.16.4` | **Unsupported today** | Exploratory `npm install` returned success but produced a synthetic one-package lockfile, zero bins, and no transitive graph; `npm exec parcel build` could not resolve an executable | The package resolver silently falls back instead of materializing Parcel's dependency graph, so the frontier stops before `@parcel/core`, Rust, watcher, worker, cache, build or serve behavior can be evaluated. The first required fix is honest full graph/bin materialization, not a Parcel adapter. |
| Rspack core/CLI `2.1.3` | **Unsupported today** | Exploratory install materialized core, CLI and the binding facade; the real JS bin started | Rspack rejects Mimic's reported Node `22.0.0` against its `22.12+` floor, then the binding loader reports `Unsupported OS: browser, architecture: x64` and `Cannot find native binding`. Native and `@rspack/binding-wasm32-wasi` lanes must be explicit separate outcomes. |
| Next `15.5.20` and `16.2.10` | **Unproved candidates, not yet classified** | No maintained or exploratory browser execution | The coverage manifest names versions but provides no evidence. Next should not be called unsupported until a real probe localizes its first blocker; its package metadata predicts SWC/Turbopack optional-native pressure, and it also depends on the still-partial Node server/runtime lifecycle. |

The factual answer to "how toolchain-agnostic is Mimic?" is: **not yet at the toolchain-agnostic threshold**. The only broad maintained success family is Vite 6, its esbuild behavior relies on one good declarative Browser Package Replacement Catalog entry, and Rollup success still depends on package-identity branches inside the loader. The webpack failure is encouraging because its first blocker is a small generic stdlib capability, while Vite 8, Rspack, Parcel, and full esbuild/Rollup lifecycles expose larger generic gaps in native/WASM selection, package graph materialization, process/version fidelity, workers, watchers, and lifecycle scripts.

Sources for the maintained evidence: [`compatibility/coverage.ts`](../../compatibility/coverage.ts), [`mimic-toolchain.spec.ts`](../../tests/e2e/mimic-toolchain.spec.ts), and [`module-loader.ts`](../../src/runtime/module-loader.ts).

## Recommended version frontier

Versions below were current in first-party npm metadata on 2026-07-11. A “historical” lane is included only where it represents a meaningful architecture, packaging, or compatibility transition.

| Toolchain | Current or maintained lanes | Representative historical/transition lanes | Why the boundary matters |
| --- | --- | --- | --- |
| Vite | `8.1.4`, `8.0.x`, `7.3.6`, `6.4.3` | `5.4.21`; optionally `2.9.18` for the original Vite 2 architecture | Vite officially supports 8.1 with regular patches, 8.0/7.3 with important and security fixes, and 6.4 with security fixes. Vite 8 changes the engine from esbuild+Rollup to Rolldown/Oxc. |
| webpack family | `webpack@5.108.4` + a compatible pinned `webpack-cli`/`webpack-dev-server` set | `webpack@4.47.0` + `webpack-cli@3.3.12` + `webpack-dev-server@3.11.3` | webpack 4 is the old configuration/CLI ecosystem boundary; current CLI and dev-server Node floors are much newer than webpack core’s floor. |
| Rollup | `4.62.2` native package; matching `@rollup/wasm-node` and `@rollup/browser` alternatives | `3.29.4` as the official v4 migration stop; late v2 (`2.80.0`) only if legacy support matters | Rollup 4 introduced platform-specific native optional dependencies. Rollup 3 and 2 were JavaScript/WASM-package-free from the installer’s perspective. |
| esbuild | `0.28.1` as both `esbuild` and matching `esbuild-wasm` | `0.25.x` through Vite 6; `0.21.x` through Vite 5 | Every normal esbuild lane installs/spawns a platform executable; the WASM package has a different initialization and feature contract. Parent-tool probes capture more value than arbitrary old esbuild versions. |
| Parcel | `parcel@2.16.4`; add a pre-2.15 v2 probe if isolating the Rust distribution transition | `parcel-bundler@1.12.5` | Parcel 2 is a different architecture from Parcel 1; Parcel 2.15 began shipping additional Rust binaries as architecture-specific npm packages. |
| Rspack | `@rspack/core@2.1.3` native and matching WASI fallback | `1.7.12`; `0.7.5` only for an established regression | v2 raises the Node floor and keeps a native Rust binding, while upstream documents `@rspack/binding-wasm32-wasi` for unsupported platforms. |
| Next.js / Turbopack | `next@16.2.10` | latest 15.x transition lane; `12.3.7` only when isolating the original SWC-native boundary | Next 16 makes Turbopack the default for dev and build; Next 15 is the transition line; Next 12 made SWC the default compiler. |

Sources: [Vite support policy](https://vite.dev/releases), [Vite package metadata](https://registry.npmjs.org/vite/8.1.4), [webpack package metadata](https://registry.npmjs.org/webpack/5.108.4), [webpack 4 metadata](https://registry.npmjs.org/webpack/4.47.0), [Rollup 4 metadata](https://registry.npmjs.org/rollup/4.62.2), [Rollup migration guide](https://rollupjs.org/migration/), [esbuild metadata](https://registry.npmjs.org/esbuild/0.28.1), [Parcel releases](https://github.com/parcel-bundler/parcel/releases), [Rspack 2 metadata](https://registry.npmjs.org/%40rspack%2Fcore/2.1.3), [Next 16 metadata](https://registry.npmjs.org/next/16.2.10).

## Lifecycle contract to assess for every toolchain

The common minimum is:

- **install**: lockfile resolution, lifecycle scripts, optional dependency selection, executable links, and package-manager reproducibility
- **one-shot build**: configuration loading, module resolution, transforms, emitted files, diagnostics, exit status, and production optimizations
- **watch**: initial build, rebuild after create/change/delete/rename, cache invalidation, and clean termination
- **dev server**: readiness signal, chosen port, static/module serving, SPA fallback where applicable, HTTP errors, and shutdown
- **live update**: HMR when supported and full reload otherwise, including WebSocket or SSE transport
- **production serve/preview**: only where upstream defines it, and without treating a preview server as a production server

The matrix should also record whether the result used the ordinary upstream package, an official WASM/browser alternative, or a repo-specific substitution. Those are different compatibility claims.

## Vite

### Maintained versions and architecture boundary

Vite’s official support policy currently gives regular patches to 8.1, important/security backports to 8.0 and 7.3, and security backports to 6.4; older versions are unsupported. These four lines should therefore be the maintained matrix, with 8.1, 7.3, and 6.4 carrying the most distinct value. [Vite releases](https://vite.dev/releases)

Vite 8 is the major boundary. Upstream says Vite previously used esbuild for development and Rollup for production, while Vite 8 uses Rolldown as a unified Rust-based bundler and Oxc-based tools. Its migration guide also says dependency optimization moved from esbuild to Rolldown. [Vite 8 announcement](https://vite.dev/blog/announcing-vite8), [Vite 8 migration](https://vite.dev/guide/migration.html)

The package metadata makes the install consequence concrete:

- `vite@7.3.6` depends on `rollup` and `esbuild`.
- `vite@6.4.3` depends on `rollup@^4.34.9` and `esbuild@^0.25.0`.
- `vite@8.1.4` depends on `rolldown` and `lightningcss`; esbuild is only an optional peer for selected behavior.
- `rolldown@1.1.5` publishes platform binding optional dependencies plus `@rolldown/binding-wasm32-wasi`; that WASI package exposes a browser entry. Lightning CSS also publishes platform-native optional packages, with its browser/WASM variant distributed separately.

Sources: [Vite 8.1.4 metadata](https://registry.npmjs.org/vite/8.1.4), [Vite 7.3.6 metadata](https://registry.npmjs.org/vite/7.3.6), [Vite 6.4.3 metadata](https://registry.npmjs.org/vite/6.4.3), [Rolldown 1.1.5 metadata](https://registry.npmjs.org/rolldown/1.1.5), [Rolldown WASI binding metadata](https://registry.npmjs.org/%40rolldown%2Fbinding-wasm32-wasi/1.1.5), [Lightning CSS metadata](https://registry.npmjs.org/lightningcss/1.32.0).

### Lifecycle probes

Official Vite scripts are `vite`/`vite dev`/`vite serve` for the dev server, `vite build` for production output, and `vite preview` for local inspection of an already-built output. Upstream explicitly says preview is not a production server. `vite build --watch` is a separate long-running production-build probe. [Vite getting started](https://vite.dev/guide/), [Vite CLI](https://vite.dev/guide/cli), [Vite production build](https://vite.dev/guide/build)

The Vite lanes should verify:

- cold dev start and module serving
- dependency optimization and its cache invalidation
- HMR for JS and CSS plus full reload for HTML/config changes
- production build and `build --watch`
- preview after a build
- config loading for JS/TS and ESM/CJS shapes supported by that Vite line
- normal package path versus any explicit WASM substitution

## webpack

### Version family, not a single package

Webpack compatibility must pin a coherent family: `webpack`, `webpack-cli`, and `webpack-dev-server`. Current metadata reports `webpack@5.108.4`, `webpack-cli@7.2.1`, and `webpack-dev-server@6.0.0`. Their engine floors differ: webpack core still declares Node `>=10.13.0`, CLI 7 declares `>=20.9.0`, and dev-server 6 declares `>=22.15.0`. A green webpack-core import is therefore not evidence that the current user-facing toolchain works. [webpack metadata](https://registry.npmjs.org/webpack/5.108.4), [webpack-cli metadata](https://registry.npmjs.org/webpack-cli/7.2.1), [webpack-dev-server metadata](https://registry.npmjs.org/webpack-dev-server/6.0.0)

Webpack 4 is the useful historical family because its migration introduced `mode` and required the separately installed CLI. [webpack 4 migration](https://webpack.js.org/migrate/4/)

Webpack core itself has no platform optional dependency in its current package metadata. Its default frontier is instead broad Node compatibility: config evaluation, filesystem access, resolution, loaders/plugins, watch invalidation, and emitted assets. Dev-server adds Express-based HTTP serving, WebSockets, proxying, certificates, and file watching. Transitive optional packages such as `fsevents` may be skipped on unsupported platforms; they should not be confused with a required compiler binding.

### Lifecycle probes

The official CLI defines default/`webpack build`, `webpack watch`, and `webpack serve`; serve requires webpack-dev-server. Current CLI 7 also requires webpack 5.101 or newer. [webpack CLI](https://webpack.js.org/api/cli/)

Assess:

- default production and development-mode builds
- CJS and ESM config loading, including async/function configs
- watch create/change/delete/rename and stdin-triggered shutdown
- dev-server readiness, static files, history fallback, proxy, WebSocket transport, HMR and full reload
- representative built-in resolution plus one loader and one plugin, so success is not limited to webpack core

## Rollup

### Native boundary and official alternatives

Rollup 4 introduced native code installed through platform/architecture-specific optional npm dependencies. On unsupported systems, upstream directs users to `@rollup/wasm-node` as a platform-independent drop-in replacement. The same guide recommends `rollup@3.29.4` as a transition stop before v4. [Rollup 4 migration](https://rollupjs.org/migration/)

`@rollup/browser` is a third, distinct path. It uses browser APIs, requires the adjacent `dist/bindings_wasm_bg.wasm` asset, and cannot access the filesystem unless the caller supplies an in-memory `fs` implementation or plugins that resolve and load every module. [Rollup in the browser](https://rollupjs.org/browser/)

Therefore record three separate Rollup 4 outcomes:

- ordinary `rollup` with native optional binding
- `@rollup/wasm-node` as the Node-compatible WASM replacement
- `@rollup/browser` with explicit WASM asset and in-memory filesystem/plugin loading

Passing the browser build must not mark the ordinary `rollup` package aligned.

### Lifecycle probes

Rollup’s CLI uses `rollup --config` (`-c`) and `--watch` (`-w`). Config files are imported by Node unless a config plugin or CommonJS bundling option is used, so configuration loading is part of the runtime claim. It supports one or many configurations and outputs. [Rollup CLI](https://rollupjs.org/command-line-interface/)

Assess one-shot build, multiple outputs, dynamic imports/code splitting, plugin resolution/load/transform hooks, watch invalidation, ESM/CJS/TS config paths, and graceful watcher shutdown.

## esbuild and esbuild-based toolchains

### Native package versus browser package

The ordinary `esbuild` npm package installs a platform-specific native executable. Its JavaScript `build()` API launches that executable as a child process. Current `esbuild@0.28.1` declares a postinstall script and platform-specific `@esbuild/*` optional dependencies. [esbuild getting started](https://esbuild.github.io/getting-started/), [esbuild 0.28.1 metadata](https://registry.npmjs.org/esbuild/0.28.1)

Upstream warns that disabling scripts and optional dependencies produces a broken install, and that copying installed packages across operating systems/architectures is not supported. These are direct tests of installer semantics, not incidental packaging details. [esbuild installation details](https://esbuild.github.io/getting-started/#additional-npm-flags)

`esbuild-wasm` is the official browser route. In a browser it requires `initialize()` with a WASM URL, lacks synchronous APIs, and can run with or without a separate worker. Upstream also says the WASM build can be roughly an order of magnitude slower and excludes features including the local file server. [esbuild browser API](https://esbuild.github.io/api/#running-in-the-browser), [esbuild WASM installation](https://esbuild.github.io/getting-started/#install-the-wasm-version)

### Lifecycle probes

For native `esbuild`, separately prove:

- install/postinstall and correct platform binary selection
- CLI one-shot build
- JavaScript async and sync APIs, including the child-process boundary
- context-based incremental rebuild/watch
- built-in serve and its request-waits-for-current-build behavior
- combined watch+serve live reload (SSE), noting that esbuild does not provide HMR itself

For `esbuild-wasm`, prove initialization, transform/build, worker mode, WASM asset resolution, and clearly record unsupported native-only lifecycle features. Parent-tool lanes should then cover the versions actually embedded by Vite: 0.21-era behavior through Vite 5, 0.25 through Vite 6, and 0.27/0.28 through Vite 7.

## Parcel

### Why Parcel is a high-value stress test

Parcel 2’s normal path combines a multi-worker architecture, persistent caching, a low-level native file watcher, and Rust implementations for JavaScript, CSS, HTML, and SVG work. This makes it a broader compatibility probe than a one-shot bundler. [Parcel overview](https://parceljs.org/), [Parcel development](https://parceljs.org/features/development/)

Current package metadata shows `parcel@2.16.4` depending on `@parcel/core`, which depends on `@parcel/rust`. That package publishes architecture-specific native dependencies and a browser entry, while `@parcel/watcher` has an install script plus platform-specific optional packages. A browser entry in one package does not by itself prove the full Parcel CLI lifecycle can run: the watcher, workers, filesystem/cache, reporters, and server remain part of the system. [Parcel metadata](https://registry.npmjs.org/parcel/2.16.4), [Parcel core metadata](https://registry.npmjs.org/%40parcel%2Fcore/2.16.4), [Parcel Rust metadata](https://registry.npmjs.org/%40parcel%2Frust/2.16.4), [Parcel watcher metadata](https://registry.npmjs.org/%40parcel%2Fwatcher/2.5.6)

Parcel 1 is a separate package (`parcel-bundler`) and a useful legacy architecture probe. Within v2, the 2.15 release is an additional boundary because upstream began distributing more Rust binaries as architecture-specific npm packages. [Parcel 1 migration](https://parceljs.org/getting-started/migration/), [Parcel 2.15 release](https://github.com/parcel-bundler/parcel/releases/tag/v2.15.0)

### Lifecycle probes

The CLI defines `parcel`/`parcel serve`, `parcel watch`, and `parcel build`. Serve rebuilds and hot-reloads; watch rebuilds and runs an HMR server without the normal HTTP dev server; build runs once with production optimizations. Parcel can also auto-install referenced transformers unless disabled. [Parcel CLI](https://parceljs.org/features/cli/)

Assess install, default serve/HMR, watch-only mode, production build, cache persistence/invalidation, workers, auto-install behavior, and clean shutdown.

## Rspack

Rspack is a Rust bundler with a webpack-compatible API. Its current v2 line requires Node 20.19+ or 22.12+, while v1 requires Node 18.12+. Upstream publishes native bindings for a fixed platform set and tells unsupported platforms to install `@rspack/binding-wasm32-wasi`; it also links a WASM/WebContainer example. [Rspack quick start](https://www.rspack.dev/guide/start/quick-start)

The metadata confirms that `@rspack/core@2.1.3` depends on `@rspack/binding`, whose optional dependencies include platform binaries and `@rspack/binding-wasm32-wasi`. The WASI package exposes a browser entry. [Rspack core metadata](https://registry.npmjs.org/%40rspack%2Fcore/2.1.3), [Rspack binding metadata](https://registry.npmjs.org/%40rspack%2Fbinding/2.1.3), [Rspack WASI binding metadata](https://registry.npmjs.org/%40rspack%2Fbinding-wasm32-wasi/2.1.3)

Treat native and WASI fallback as separate lanes. Assess build, watch, webpack-compatible loader/plugin behavior, and `rspack dev`/`serve` HMR. `@rspack/dev-server` is a separate optional peer dependency of the CLI and must be included explicitly in a dev-server fixture. [Rspack dev server](https://www.rspack.dev/guide/features/dev-server)

## Next.js / Turbopack

Next.js is worth a separate high-value lane because it composes a frontend toolchain with server runtime behavior. Next 16 uses Turbopack by default for both `next dev` and `next build`; `--webpack` selects webpack. Next 15 is the transition line, and Next 12 introduced the default SWC compiler. [Next.js Turbopack](https://nextjs.org/docs/app/api-reference/turbopack), [Next.js compiler](https://nextjs.org/docs/architecture/nextjs-compiler)

Current `next@16.2.10` declares platform-specific `@next/swc-*` packages and `sharp` as optional dependencies. Upstream’s SWC troubleshooting explicitly calls out missing optional dependencies and platform-specific lockfiles, so the installer outcome is part of the compatibility claim. [Next 16 metadata](https://registry.npmjs.org/next/16.2.10), [SWC failed to load](https://nextjs.org/docs/messages/failed-loading-swc)

Assess `next dev`, `next build`, and `next start` (which requires a prior build), plus HMR, routing, server rendering, static assets, and both default Turbopack and explicit webpack mode. [Next CLI](https://nextjs.org/docs/app/api-reference/cli/next)

## Native and optional dependency rules for compatibility reporting

The evidence supports these reporting rules:

1. **Do not collapse native and official WASM paths.** `rollup`, `@rollup/wasm-node`, and `@rollup/browser` are distinct claims; so are `esbuild` and `esbuild-wasm`, and native Rspack versus its WASI binding.
2. **Do not treat optional as unimportant.** Native binaries are commonly optional only so npm can select one platform package. Omitting all optional dependencies can break the tool entirely.
3. **Record lifecycle-script execution.** esbuild’s postinstall and native watcher installs are compatibility surfaces. A pre-populated tree can hide an unsupported installer.
4. **Record selection provenance.** Reports should state the logical package requested, artifact actually loaded, version, platform selection rule, and whether any alias/rewrite was applied.
5. **Fail closed on undeclared substitution.** Silently swapping a native package for a WASM sibling overstates compatibility and obscures feature differences.
6. **Test downstream optional features separately.** Sass implementations, Lightning CSS, Terser, image processing, and framework plugins add their own native/optional surfaces; a minimal core fixture should not imply they work.

## Proposed execution order

The most informative order is:

1. Vite 6.4 and 7.3 using their ordinary esbuild+Rollup packages.
2. Vite 8.1 using ordinary Rolldown, then an explicitly recorded WASI path if required.
3. Standalone Rollup 4 native, `wasm-node`, and browser builds.
4. Standalone esbuild native and `esbuild-wasm` with their differing lifecycle expectations.
5. Webpack 5 current family, then webpack 4 historical family.
6. Rspack 2 native and WASI fallback.
7. Parcel 2.16, because it requires a larger watcher/worker/cache surface.
8. Next 16 Turbopack and webpack modes, once the underlying native toolchain and server-runtime capabilities are separately understood.

This order finds foundational runtime gaps before high-level toolchains make them harder to attribute.

## Decision

The frontend compatibility program should maintain architecture-bound version lanes, not a generic latest/previous-major rule. Its core frontier is Vite 6.4/7.3/8.1, webpack 5 plus webpack 4, Rollup 4 plus the 3.29.4 transition, esbuild native plus WASM, Parcel 2 plus Parcel 1, Rspack 2 native plus WASI, and Next 16 plus a 15.x transition lane. Every result must include the full lifecycle exercised and the exact native/WASM package path used.
