# Research: esbuild wasm for browser-runnable Vite toolchains

> Snapshot note: source findings and dated evidence are retained, but repo-specific
> “current state” statements may be obsolete. Verify them against current code,
> tests, issues, and [`compatibility-status.md`](../compatibility-status.md). See
> [the research status rules](./README.md).

Date: 2026-06-15

## Why this research exists

The roadmap has an explicit research item:

- `Study and implement npm package selection for browser-runnable native toolchains: fetch wasm/browser-compatible builds such as esbuild's wasm package path and skip incompatible platform-native optional packages instead of installing every platform build.`

This document narrows that topic to the current repo goal: make real `vite@6` dependency optimization run inside the browser runtime without the temporary `esbuild` adapter in [`../../src/runtime/module-loader.ts`](../../src/runtime/module-loader.ts).

## Repo-specific context

- The repo currently depends on `vite@^6.0.7` in [`../../package.json`](../../package.json).
- As of 2026-06-15, `vite` latest on npm is `8.0.16`, but that is not the version this repo is proving yet.
- The current runtime intercepts `/esbuild/lib/main.js` and returns a handwritten adapter instead of executing real esbuild code.
- The current package resolver reads `main`, `module`, and string `exports`, but does not currently honor the `browser` field when selecting a package entry.

That means this research must target `Vite 6` behavior, not latest Vite behavior, and must account for the current loader/resolver limitations.

## Source-backed findings

### 1. Vite 6 dev dependency optimization still uses esbuild

Vite 6 documentation says dependency pre-bundling in dev uses esbuild to:

- convert CommonJS and UMD dependencies to ESM
- collapse dependency graphs into fewer modules
- write cache artifacts into `node_modules/.vite`

This is directly relevant because the repo's current Playwright optimized-deps package-flow test is trying to prove Vite's real optimizeDeps behavior, not just source transforms.

Source:

- [Vite 6 dependency pre-bundling](https://v6.vite.dev/guide/dep-pre-bundling)
- [Vite 6 dep optimization options](https://v6.vite.dev/config/dep-optimization-options)

### 2. Browser-supported esbuild is a different npm package: `esbuild-wasm`

The official esbuild API docs state that browser usage requires `esbuild-wasm`, an `initialize()` call, and a `wasmURL`. The sync APIs are not available in the browser build. The docs also say `worker: false` can be used when the caller already runs inside a worker.

This matters because our runtime target is already worker-oriented. We should not keep emulating `esbuild` with Babel-like transforms if the real supported browser API already exists.

Source:

- [esbuild API: browser usage](https://esbuild.github.io/api/)

### 3. The `esbuild` npm package is host-native and not browser-runnable as installed

The published `esbuild@0.28.1` package:

- has a `postinstall` script: `node install.js`
- declares many platform-specific `optionalDependencies` such as `@esbuild/linux-x64`, `@esbuild/darwin-arm64`, `@esbuild/win32-x64`
- ships an `install.js` that uses Node host APIs such as `fs`, `os`, `path`, `child_process`, `https`, `zlib`, and binary integrity checks

In other words, normal `esbuild` installation assumes a host OS and a downloadable native binary. That is structurally incompatible with a browser-only runtime.

Sources:

- [npm package metadata: esbuild](https://www.npmjs.com/package/esbuild)
- [npm registry package document: esbuild latest](https://registry.npmjs.org/esbuild/latest)

### 4. `esbuild-wasm` ships the artifacts we actually need

The published `esbuild-wasm@0.28.1` tarball contains:

- `esbuild.wasm`
- browser entrypoints: `lib/browser.js`, `lib/browser.min.js`, `esm/browser.js`, `esm/browser.min.js`
- the same top-level package shape (`main`, `bin`, typings) but without platform `optionalDependencies`

This is a much closer fit for a browser package cache and VFS installer than `esbuild`.

Sources:

- [npm package metadata: esbuild-wasm](https://www.npmjs.com/package/esbuild-wasm)
- [npm registry package document: esbuild-wasm latest](https://registry.npmjs.org/esbuild-wasm/latest)

### 5. Cross-origin isolation remains part of the baseline

WebContainers docs still require COOP/COEP and SharedArrayBuffer-backed cross-origin isolation. That matters because running real esbuild wasm in workers is aligned with the same browser capability baseline the roadmap already targets.

This does not prove esbuild itself requires SAB, but it does support the broader architecture decision to keep heavy toolchain work off the main thread.

Sources:

- [WebContainers browser support](https://webcontainers.io/guides/browser-support)
- [WebContainers configuring headers](https://webcontainers.io/guides/configuring-headers)

## What this means for this repo

### Main conclusion

For the browser runtime, we should stop treating `esbuild` as a normal npm package install. The correct target is:

1. resolve the dependency edge that asks for `esbuild`
2. materialize a browser-runnable replacement payload based on `esbuild-wasm`
3. make module resolution for `require('esbuild')` or `import 'esbuild'` land on the browser entry
4. load `esbuild.wasm` from VFS or package cache and call `initialize()`
5. keep Vite's optimizeDeps flow invoking real esbuild APIs

The package-selection step and the loader step are both required. Doing only one is insufficient.

### Native dependency replacement discovery

For esbuild, the wasm/browser package is not listed in `esbuild`'s `optionalDependencies`; those entries are platform-native packages such as `@esbuild/linux-x64` and `@esbuild/darwin-arm64`. That means a browser-target install cannot rely only on platform filtering. The installer needs a discovery/policy layer:

- first inspect a native package's `optionalDependencies` for an explicitly browser-runnable wasm package when a package publishes one that way
- if no wasm/browser optional dependency exists, consult an explicit metadata source that maps the native package to its browser replacement, for example `esbuild` -> `esbuild-wasm`
- record that replacement in generated lockfile/package metadata so the install remains auditable
- fail explicitly when a native package has no known browser-runnable replacement, instead of downloading every platform-native build and hoping one can execute in the browser

This policy should be generic enough for other native toolchain dependencies, not only esbuild.

### Why package installation alone is not enough

Vite asks for `esbuild`, not `esbuild-wasm`. If we merely install `esbuild-wasm` under its own package name, Vite will still fail resolution.

Also, the current resolver does not honor the `browser` field, so even if a browser-capable payload is present under `node_modules/esbuild`, the loader may still choose `main` instead of the browser entry.

### Inference: the most practical architecture

This section is an inference from the sources plus the current repo structure.

The lowest-friction design appears to be:

- keep `esbuild` as the logical package name in the dependency graph so Vite resolution stays unchanged
- for browser-targeted installs, fetch the `esbuild-wasm` tarball instead of the host-native `esbuild` tarball
- materialize that payload at `node_modules/esbuild`
- rewrite or synthesize `node_modules/esbuild/package.json` so browser execution selects `lib/browser.js`
- store `esbuild.wasm` in the package payload and expose it via a stable VFS URL for `initialize({ wasmURL })`

This avoids needing package-manager-wide alias semantics just for one package, and it fits the repo's current tarball materialization approach.

## Recommended implementation sequence

### Phase 1. Installer/package selection

- Add a browser-target package policy layer in the npm installer.
- Match exact package name `esbuild`.
- When the runtime target is browser execution, fetch `esbuild-wasm` at the matching version instead of `esbuild`.
- Do not materialize `@esbuild/*` platform optional packages in that mode.
- Record provenance in generated lockfile/package metadata so the substitution is explicit and debuggable.

### Phase 2. Loader/resolution

- Add browser-aware package entry resolution.
- Prefer `browser` when the runtime target is browser and the package is being loaded for execution inside that runtime.
- Keep existing `main`/`module`/`exports` behavior for non-browser packages until a fuller condition resolver is implemented.
- Remove the hardcoded `/esbuild/lib/main.js` adapter once real resolution works.

### Phase 3. Runtime execution

- Create a real esbuild runtime wrapper that calls `initialize()` once per runtime boot.
- Host it inside a worker-backed execution path.
- Provide a `wasmURL` that points to the materialized `esbuild.wasm` asset.
- Decide whether esbuild owns its own worker or whether we run it with `worker: false` inside an already-dedicated worker. The official docs allow both.

### Phase 4. Verification

- Add a smoke that asserts `node_modules/esbuild/esbuild.wasm` exists in the installed dependency tree.
- Add a smoke that asserts no `@esbuild/*` native packages were materialized for browser-target installs.
- Add a smoke that proves Vite optimizeDeps emits real `/node_modules/.vite/deps/*` output using real esbuild wasm execution.
- Remove the current fallback condition that returns the handwritten adapter from the module loader.

## Risks and edge cases

### 1. API compatibility is close, but initialization changes are real

The browser API requires `initialize()` and does not expose sync APIs. If Vite or an esbuild consumer in our runtime assumes synchronous entrypoints, that will surface as a real incompatibility to solve, not something a package substitution alone fixes.

### 2. Resolver work is broader than esbuild

The missing `browser` field support will affect other browser-runnable packages too. Even if we solve esbuild with a one-off package rewrite, the broader roadmap item about package fields remains.

### 3. Vite version drift can change the target

This research is intentionally pinned to the repo's current `vite@^6.0.7` track. If the repo upgrades to Vite 8+, the optimizeDeps engine and surrounding assumptions should be re-verified before reusing this document unchanged.

## Decision

Recommended next implementation task:

- replace browser-target installation of `esbuild` with a version-matched `esbuild-wasm` payload
- then add browser-aware package entry resolution so the real browser entry executes

That sequence attacks the real blocker. Replacing the adapter before package selection and resolver support would only move the failure point.

## Sources

- [esbuild API](https://esbuild.github.io/api/)
- [esbuild npm package](https://www.npmjs.com/package/esbuild)
- [esbuild-wasm npm package](https://www.npmjs.com/package/esbuild-wasm)
- [npm registry: esbuild latest](https://registry.npmjs.org/esbuild/latest)
- [npm registry: esbuild-wasm latest](https://registry.npmjs.org/esbuild-wasm/latest)
- [Vite 6 dependency pre-bundling](https://v6.vite.dev/guide/dep-pre-bundling)
- [Vite 6 dep optimization options](https://v6.vite.dev/config/dep-optimization-options)
- [WebContainers browser support](https://webcontainers.io/guides/browser-support)
- [WebContainers configuring headers](https://webcontainers.io/guides/configuring-headers)
