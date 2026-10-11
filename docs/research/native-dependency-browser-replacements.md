# Research: browser/wasm replacement discovery for native npm toolchains

> Snapshot note: source findings and dated evidence are retained, but repo-specific
> “current state” statements may be obsolete. Verify them against current code,
> tests, issues, and [`compatibility-status.md`](../compatibility-status.md). See
> [the research status rules](./README.md).

Date: 2026-06-16

## Why this research exists

The roadmap has an explicit open item:

- `Add a native-dependency replacement discovery mechanism for browser installs: when a package needs a native binary, first inspect its optionalDependencies for a browser/wasm-compatible package, and otherwise consult an explicit package-policy/metadata source that maps the native package to its wasm/browser replacement. Research is required before hardcoding package-specific substitutions.`

This document answers that question for the current repo goal: install real npm packages into the browser runtime without materializing host-native binaries that cannot run inside WebContainer-like execution.

It builds on the earlier esbuild-specific research in [`../../docs/research/esbuild-wasm-browser-toolchain.md`](../../docs/research/esbuild-wasm-browser-toolchain.md), but broadens the scope from one package to a reusable discovery policy.

## Repo-specific context

- The current lockfile synthesis already filters platform-incompatible `optionalDependencies`, but it only knows how to skip packages, not replace them. See [`../../src/runtime/lockfile-installer.ts`](../../src/runtime/lockfile-installer.ts).
- Registry metadata currently captures `main`, `module`, `exports`, `imports`, `optionalDependencies`, `os`, and `cpu`, but not any explicit browser-target policy or replacement metadata because npm registry metadata does not provide a standard field for that. See [`../../src/runtime/registry-client.ts`](../../src/runtime/registry-client.ts).
- The roadmap target is not "avoid crashes" but "run real browser-runnable toolchains" inside a browser-only Node-like runtime.

That means the installer needs a deterministic answer for native packages:

1. install a browser-runnable replacement payload
2. preserve the logical package name that upstream code resolves
3. record the substitution so the install remains auditable
4. fail clearly when no safe browser replacement exists

## Source-backed findings

### 1. npm provides platform filtering, not browser-replacement semantics

npm's package metadata and install model give us tools such as:

- `optionalDependencies`
- `os`
- `cpu`
- package aliases like `<alias>@npm:<name>`

Those mechanisms help choose or omit packages for a target platform, but they do not define a standard way for a native package to declare "use this browser/wasm package instead when the runtime is a browser".

This is the core gap. The browser installer cannot infer replacements from standard npm semantics alone.

Sources:

- [npm package.json docs](https://docs.npmjs.com/files/package.json/)
- [npm package spec aliases](https://docs.npmjs.com/cli/v8/using-npm/package-spec)
- [npm install config for `os`/`cpu`](https://docs.npmjs.com/cli/v11/commands/npm-install/)

### 2. Real toolchains publish browser/wasm replacements under different patterns

The packages relevant to modern JS toolchains do not follow one shared publishing pattern:

- `esbuild` publishes many platform-native optional packages, while the browser-compatible package is a separate sibling package named `esbuild-wasm`.
- `lightningcss` publishes platform-native optional packages, while the browser-compatible package is a separate sibling package named `lightningcss-wasm`.
- `rollup` publishes platform-native optional packages, while the browser-compatible build is a separate sibling package named `@rollup/browser`.
- `@swc/core` publishes platform-native optional packages, while browser execution uses a different package named `@swc/wasm-web`.

This means there is no reliable naming rule that can be derived from one example and applied globally. Some replacements end with `-wasm`, some with `-wasm-web`, some are scoped siblings, and some are `@scope/browser`.

Sources:

- [npm registry: esbuild latest](https://registry.npmjs.org/esbuild/latest)
- [npm registry: esbuild-wasm latest](https://registry.npmjs.org/esbuild-wasm/latest)
- [npm registry: lightningcss latest](https://registry.npmjs.org/lightningcss/latest)
- [npm registry: lightningcss-wasm latest](https://registry.npmjs.org/lightningcss-wasm/latest)
- [npm registry: rollup latest](https://registry.npmjs.org/rollup/latest)
- [npm registry: @rollup/browser latest](https://registry.npmjs.org/%40rollup%2Fbrowser/latest)
- [npm registry: @swc/core latest](https://registry.npmjs.org/%40swc%2Fcore/latest)
- [npm registry: @swc/wasm-web latest](https://registry.npmjs.org/%40swc%2Fwasm-web/latest)

### 3. Browser-capable replacements often require extra runtime setup

Even when a replacement exists, installation alone is not enough:

- `esbuild-wasm` requires browser initialization and a `wasmURL`.
- `lightningcss-wasm` is intended for Deno or direct browser use and requires wasm initialization.
- `@swc/wasm-web` requires initialization before transform APIs are used.
- `@rollup/browser` is a browser build, and Rollup's own migration docs note that it relies on a wasm artifact that must be provided as well.

So the installer policy must classify replacements by runtime contract, not merely by package name. Some replacements are "drop-in enough for loader resolution", others require explicit worker/wasm bootstrapping and should be marked as such.

Sources:

- [esbuild API: browser usage](https://esbuild.github.io/api/)
- [Lightning CSS docs: browser/wasm usage](https://lightningcss.dev/docs.html)
- [SWC wasm usage](https://swc.rs/docs/usage/wasm)
- [Rollup browser build](https://rollupjs.org/browser/)
- [Rollup 4 migration notes](https://rollupjs.org/migration/)

### 4. Some ecosystems already use wasm fallback as an official degraded mode

Next.js documents that when native SWC bindings are unavailable on some platforms, it falls back to wasm bindings for core compilation and minification, but not for all features such as Turbopack.

That matters for our design because it reinforces two points:

- browser replacements are a real upstream-supported execution mode, not a custom hack
- replacement metadata must capture capability limits, not just package names

Sources:

- [Next.js SWC failed to load](https://nextjs.org/docs/messages/failed-loading-swc)
- [Next.js Turbopack API reference](https://nextjs.org/docs/app/api-reference/turbopack)

## What this means for this repo

### Main conclusion

The browser installer should not try to guess replacements from package names or from `optionalDependencies` alone.

The correct architecture is a two-stage discovery pipeline:

1. inspect package metadata for platform-native shape and any directly advertised browser/wasm alternative
2. if the package does not self-describe a usable browser replacement, consult an explicit repo-managed package policy table

The policy table is not optional. The source-backed examples above show that critical packages already diverge in naming, entrypoints, and runtime initialization.

## Recommended classification model

Each native-toolchain package considered for browser install should be classified into one of four states:

- `native-only`: no supported browser replacement is known; browser install must fail clearly
- `replaceable-dropin`: a replacement exists and can be materialized under the logical package name with entrypoint rewriting
- `replaceable-runtime-init`: a replacement exists but requires explicit wasm/worker initialization
- `unsupported-for-target`: a replacement exists upstream, but its feature set is insufficient for the repo goal

This classification matters because `@swc/wasm-web` and `@rollup/browser` are not equivalent to `esbuild-wasm` operationally. They may be valid future targets, but they should not all be treated as immediate drop-in replacements.

## Inference: what the discovery algorithm should do

This section is an inference from the sources and the current repo architecture.

For each package resolved during browser-target lockfile synthesis or materialization:

1. Detect native-package risk signals.
   A package should enter the native-replacement pipeline if one or more of these are true:
   - it has platform-scoped `optionalDependencies`
   - it has `os` or `cpu` restrictions
   - it has install/postinstall scripts associated with native binary setup
   - the package is present in an explicit browser-policy index

2. Inspect direct metadata for self-described browser/wasm alternatives.
   This should only auto-accept clear evidence, for example:
   - the package itself exposes a browser entry that is already the intended runtime path
   - a documented sibling package is explicitly called out by upstream docs as the browser build

3. Consult a curated policy table when metadata is insufficient.
   This table should map the logical package name used by upstream dependencies to:
   - replacement package name
   - version matching rule
   - whether the replacement should be materialized under the original package name
   - required entrypoint rewrite
   - required wasm asset handling
   - runtime initialization contract
   - feature caveats

4. Record provenance into installed package metadata and generated lockfile data.
   The install should capture at least:
   - requested package name and version range
   - resolved replacement package name and version
   - reason for replacement
   - policy source: inferred vs explicit table
   - feature caveats

5. Fail closed when no browser-safe route exists.
   For WebContainer-like execution this is better than silently materializing unusable native packages.

## Why `optionalDependencies` inspection is only a heuristic

The roadmap text suggests inspecting `optionalDependencies` first. That is useful, but the research shows it cannot be the decisive mechanism:

- `esbuild`, `lightningcss`, `rollup`, and `@swc/core` all use `optionalDependencies` for native platform packages
- none of those packages use `optionalDependencies` to advertise the browser package that our runtime should install instead
- package names for the browser variant are inconsistent enough that suffix guessing would be brittle

So `optionalDependencies` should be treated as a native-package detector, not as a replacement resolver.

## Proposed initial policy table

This is the recommended initial seed set for a repo-local browser policy source.

| Logical package | Browser replacement | Matching rule | Materialize as original name | Runtime notes |
| --- | --- | --- | --- | --- |
| `esbuild` | `esbuild-wasm` | exact version match | yes | requires `initialize()` and `wasmURL` |
| `rollup` | `@rollup/browser` | exact major/minor preferred; start with exact version | usually no for direct imports, maybe yes only if upstream requires `rollup` name | requires wasm artifact handling |
| `lightningcss` | `lightningcss-wasm` | exact version match | maybe | requires wasm initialization; feature validation still needed |
| `@swc/core` | `@swc/wasm-web` | exact version match | maybe | requires init; feature parity must be validated per use case |

Two important constraints follow from this table:

- only `esbuild` is an immediate implementation target for the current Vite path
- the policy layer should be generic from day one so future packages do not require redesign

## Data model recommendation

The repo should add a checked-in policy file, for example `src/runtime/browser-package-policy.ts` or a JSON/TS equivalent, with entries shaped roughly like:

```ts
type BrowserPackagePolicyEntry = {
  logicalName: string;
  detect: {
    optionalDependencyPrefixes?: string[];
    hasInstallScript?: boolean;
    osCpuRestricted?: boolean;
  };
  replacement: {
    packageName: string;
    versionStrategy: 'exact' | 'same-major' | 'custom';
    materializeAsLogicalName: boolean;
    entrypoint?: {
      preferBrowserField?: boolean;
      overrideMain?: string;
      overrideModule?: string;
      overrideExports?: unknown;
    };
    wasmAsset?: {
      path: string;
      required: boolean;
    };
    runtimeInit?: 'none' | 'esbuild-initialize' | 'swc-init' | 'custom';
  };
  caveats?: string[];
};
```

The important design point is not the exact TypeScript shape. It is that replacement policy needs to capture both install-time and runtime-time requirements.

## Recommended implementation order

### Phase 1. Detection and provenance

- Extend registry metadata usage so install planning can inspect `scripts`, `browser`, `os`, and `cpu` alongside `optionalDependencies`.
- Add a browser-package policy table with one implemented entry: `esbuild`.
- Record replacement provenance in lockfile/package metadata.

### Phase 2. Materialization semantics

- Support materializing a replacement tarball under the logical original package path when upstream dependencies still import the native package name.
- Support package metadata rewriting for browser entry selection where needed.

### Phase 3. Runtime contracts

- Add runtime initialization hooks for wasm packages.
- Keep those hooks package-policy-driven rather than hardcoded in the generic module loader.

### Phase 4. Validation

- Add a smoke that proves only the browser-safe package payload was materialized.
- Add a smoke that fails if disallowed platform-native packages appear in the browser install tree.
- Add future opt-in validation cases for `rollup`, `lightningcss`, and `@swc/core` only when those packages become implementation targets.

## Risks and limits

### 1. npm aliases are useful, but not sufficient as the whole solution

npm package aliases show that one package name can point at another package source, but the browser runtime still needs to control materialization paths, lockfile provenance, and runtime initialization. Alias semantics alone do not solve those layers.

### 2. Browser replacements may be partial, not full substitutes

The Next.js SWC docs explicitly show that wasm fallback can cover compilation/minification while still missing features required for other workflows. The policy layer must expose those limits so implementation planning stays honest.

### 3. Some packages may need explicit rejection

If a native package has no documented browser build and no reliable wasm replacement, the correct browser-runtime behavior is to stop with an actionable error. Silent best-effort install would hide incompatibility and make runtime debugging worse.

## Decision

Recommended next implementation target:

- implement a generic browser package policy layer
- seed it with `esbuild -> esbuild-wasm`
- treat `optionalDependencies` as a detector, not a resolver
- store explicit provenance for every replacement

That gives the repo a reusable architecture for the current Vite milestone and for later work around Rollup, Lightning CSS, and SWC-based toolchains.

## Sources

- [npm package.json docs](https://docs.npmjs.com/files/package.json/)
- [npm package spec aliases](https://docs.npmjs.com/cli/v8/using-npm/package-spec)
- [npm install config for `os`/`cpu`](https://docs.npmjs.com/cli/v11/commands/npm-install/)
- [npm registry: esbuild latest](https://registry.npmjs.org/esbuild/latest)
- [npm registry: esbuild-wasm latest](https://registry.npmjs.org/esbuild-wasm/latest)
- [npm registry: lightningcss latest](https://registry.npmjs.org/lightningcss/latest)
- [npm registry: lightningcss-wasm latest](https://registry.npmjs.org/lightningcss-wasm/latest)
- [npm registry: rollup latest](https://registry.npmjs.org/rollup/latest)
- [npm registry: @rollup/browser latest](https://registry.npmjs.org/%40rollup%2Fbrowser/latest)
- [npm registry: @swc/core latest](https://registry.npmjs.org/%40swc%2Fcore/latest)
- [npm registry: @swc/wasm-web latest](https://registry.npmjs.org/%40swc%2Fwasm-web/latest)
- [esbuild API](https://esbuild.github.io/api/)
- [Lightning CSS docs](https://lightningcss.dev/docs.html)
- [SWC wasm usage](https://swc.rs/docs/usage/wasm)
- [Rollup browser build](https://rollupjs.org/browser/)
- [Rollup 4 migration notes](https://rollupjs.org/migration/)
- [Next.js SWC failed to load](https://nextjs.org/docs/messages/failed-loading-swc)
- [Next.js Turbopack API reference](https://nextjs.org/docs/app/api-reference/turbopack)
