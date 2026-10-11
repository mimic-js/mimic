# Browser module loading and execution reuse

Snapshot: 2026-08-22. This answers Research browser module loading and execution reuse (#604). External facts are sourced; statements about Mimic are repository inferences from the linked code and maintained Compatibility Claims.

## Decision

Do **not** replace the Module Execution Engine or Module Registry with Nodepod, native browser modules, SystemJS, ES Module Shims, Deno, or Bun. None is a browser-embeddable implementation of the maintained Node loader contract. Retain one context-local Module Registry and the engine-owned resolution/loading authority.

Substantially reduce only the Runtime Artifact Compiler's parsing and rewriting implementation: replace its hand-written ESM/TypeScript rewriting with one pinned, browser-capable parser/transformer that emits executable code and source maps. Reuse the browser's JavaScript and WebAssembly evaluators as execution mechanisms, as today. Keep evaluation admission, runtime bindings, artifact provenance, error normalization, and the `node:vm` script evaluator local because those are Mimic policy or integration authority, not compiler behavior.

The minimal target has two seams, both already real:

1. The Module Execution Engine interface used by Execution Context Bootstrap: run an entry/eval source and expose the Node Compatibility projections. Resolution, the Module Registry, CJS/ESM interop, lifecycle, and failure eviction remain behind it.
2. One private compile operation inside the engine: `(source, identity, format) -> executable definition + source map`. It replaces the current format-specific rewrite cluster; it is not a public compiler interface and needs no adapter family.

Do not add a loader framework, browser import-map authority, second module cache, generic plugin system, or standalone Runtime Artifact Compiler module.

## Required behavior and current ownership

The maintained claims require more than parsing:

| Concern | Current evidence | Authority that must survive |
| --- | --- | --- |
| Canonical identity, symlink realpaths, package `exports`/`imports`, builtin aliases, data URLs | [`mimic-module-identities.spec.ts`](../../tests/e2e/mimic-module-identities.spec.ts) | Resolver + Module Registry |
| CJS partial exports in cycles, mutable `require.cache`, failure eviction | [`mimic-module-registry.spec.ts`](../../tests/e2e/mimic-module-registry.spec.ts) and [`mimic-commonjs-semantics.spec.ts`](../../tests/e2e/mimic-commonjs-semantics.spec.ts) | Module Registry |
| ESM cycles, live bindings, top-level await, CJS namespace interop | [`mimic-esm-semantics.spec.ts`](../../tests/e2e/mimic-esm-semantics.spec.ts) | Module Registry + compiled definitions |
| `.ts`/`.mts`/`.cts`, JSON, WASM, compile/evaluation location and compiler fingerprint | [`mimic-runtime-formats.spec.ts`](../../tests/e2e/mimic-runtime-formats.spec.ts) | Format admission + compiler + provenance mapping |
| `node:module` and `node:vm` projections | [`module-execution-engine.ts`](../../src/runtime/modules/module-execution-engine/module-execution-engine.ts), [`builtin-adapters.ts`](../../src/runtime/modules/node-compatibility/builtin-adapters.ts), and [`vm.ts`](../../src/runtime/modules/node-compatibility/vm.ts) | Engine-owned projections; Node Compatibility only adapts their shape |

Repository inference: [`module-execution-engine.ts`](../../src/runtime/modules/module-execution-engine/module-execution-engine.ts) is already the single identity/lifecycle authority (`records`) and projects its CJS subset as `require.cache`; it also evicts failed records. That matches Node's observable model: CommonJS caches by resolved filename, exposes partially completed exports to break cycles, and permits explicit reload by deleting `require.cache`; `node:` requests bypass cache substitution ([Node CommonJS documentation](https://nodejs.org/api/modules.html#caching), [`require.cache`](https://nodejs.org/api/modules.html#requirecache), [builtins](https://nodejs.org/api/modules.html#built-in-modules)). Node's ESM loader has a separate URL-keyed cache and no `require.cache` projection ([Node ESM URLs](https://nodejs.org/api/esm.html#urls), [ESM/CommonJS differences](https://nodejs.org/api/esm.html#differences-between-es-modules-and-commonjs)). The repo intentionally presents one registry authority with a mutable CJS projection; replacing it with two independent caches would lose locality and invite identity drift.

Repository inference: the compiler is shallower and more replaceable. [`runtime-artifact-compiler/esm.ts`](../../src/runtime/modules/module-execution-engine/runtime-artifact-compiler/esm.ts) combines Babel parsing checks with a large bespoke source rewrite and manual live-binding publication. [`artifacts.ts`](../../src/runtime/modules/module-execution-engine/runtime-artifact-compiler/artifacts.ts) wraps CJS and strips TypeScript. [`commonjs.ts`](../../src/runtime/modules/module-execution-engine/runtime-artifact-compiler/commonjs.ts) and `esm.ts` own every JavaScript `eval`/`Function` sink; [`wasm.ts`](../../src/runtime/modules/module-execution-engine/runtime-artifact-compiler/wasm.ts) owns `WebAssembly.instantiate`. Current Babel transforms explicitly disable source maps in one stripping path and runtime errors are adjusted with line offsets, so the maintained provenance claim is location mapping, not yet a complete source-map pipeline.

## Candidate assessment

### 1. Pinned parser/transformer inside the existing engine — reuse, ranked first

This is the only candidate that can delete substantial implementation without importing another authority. The project already ships `@babel/standalone`; its browser build parses and transforms TypeScript and modules. Reusing the installed dependency is the minimum next move. The replacement must emit a definition compatible with the existing registry callbacks and an actual source map; the registry still schedules/link/evaluates records.

This recommendation is deliberately implementation-neutral beyond the already-installed dependency. A future implementation ticket should compare a Babel `System.register`-style output with the smallest direct callback transform against the maintained tests. Adding Acorn, SWC/Oxc WASM, or esbuild-wasm before that comparison would create new dependency and worker/bootstrap cost without evidence that Babel cannot satisfy the seam.

Source maps remain compiler output, while provenance remains local. The source-map format is standardized as mappings from generated code back to original sources ([ECMA-426 source map specification](https://tc39.es/ecma426/)). A transformer cannot decide Mimic's artifact identity, trust/evaluation policy, VFS provenance, compiler fingerprint, or domain error shape.

### 2. Native browser ESM / import maps — reuse only as an evaluator, not the loader

Browsers provide URL-based ESM loading, live bindings, cycles, dynamic import, and top-level await through the ECMAScript module machinery. Import maps map specifier text to URLs and are document-scoped ([HTML import maps](https://html.spec.whatwg.org/multipage/webappapis.html#import-maps)); dynamic `import()` is the programmatic entry to the same host loader ([HTML host load imported module](https://html.spec.whatwg.org/multipage/webappapis.html#hostloadimportedmodule)).

They do not expose Node package resolution, synchronous `require`, mutable `require.cache`, VFS reads, CJS wrappers, Node builtin identity, or a public module-record/linking interface. Blob/data URL projection would also create a second URL identity space and complicate source provenance. Therefore native ESM can execute generated ESM where useful, but cannot own this module's interface. Import maps are unnecessary because the existing resolver must remain authoritative.

Browser CSP blocks string compilation by default when `script-src`/`default-src` applies; `eval` and `Function` require an explicit eval allowance ([CSP Level 3 string-compilation check](https://w3c.github.io/webappsec-csp/#can-compile-strings)). Moving generated source to blob-backed imports trades that requirement for CSP source/worker allowances and asynchronous URL loading; it does not remove dynamic code policy or restore Node semantics. Keep a single engine-owned evaluation admission point regardless of sink.

### 3. ES Module Shims — retain as prior art only

ES Module Shims is active, browser-targeted, hookable, and can use native ESM semantics, loader hooks, TypeScript stripping, JSON/WASM modules, and import maps ([project README](https://github.com/guybedford/es-module-shims)). It is the strongest browser loader candidate.

It still does not implement Node CJS, `require.cache`, Node package resolution, builtin identity, synchronous `require(esm)`, or the repo's registry contract. Its own README notes a circular-parent live-binding exception in shim processing, which conflicts with the maintained ESM semantics claim. Adopting it would leave the CJS loader, interop registry, provenance, and `node:vm` local while adding a second loader/cache. That is a shallow adapter and a net ownership increase. Do not add it.

### 4. SystemJS — mechanism reference, do not adopt

SystemJS loads compiled `System.register` modules and supports live bindings, cycles, dynamic import, top-level await, import maps, and CSP-compatible script loading ([SystemJS README](https://github.com/systemjs/systemjs)). It explicitly does not integrate its registry with the native browser ESM registry because the module systems cannot share dependencies ([same README, native modules section](https://github.com/systemjs/systemjs#native-modules)). It also does not supply Node resolution/CJS semantics.

Its `System.register` execution protocol is useful prior art for replacing bespoke export instrumentation, but the loader itself would become a second registry and require all sources to be compiled to its format. Reuse the idea through the pinned transformer if it produces a smaller verified implementation; do not add SystemJS plus an adapter.

### 5. Nodepod — reject

Nodepod is browser-targeted but does not own the required behavior at sufficient fidelity. At inspected commit [`c4e08eb`](https://github.com/illuma-ai/nodepod/tree/c4e08eb59b057f3b450456c60783c1afbfab3a20), its [`script-engine.ts`](https://github.com/illuma-ai/nodepod/blob/c4e08eb59b057f3b450456c60783c1afbfab3a20/src/script-engine.ts) is itself a large custom loader/executor with Acorn plus regex fallbacks and hand-written TypeScript/JSX/module transforms. Its [`module.ts`](https://github.com/illuma-ai/nodepod/blob/c4e08eb59b057f3b450456c60783c1afbfab3a20/src/polyfills/module.ts) exposes placeholder resolution/cache methods, and [`vm.ts`](https://github.com/illuma-ai/nodepod/blob/c4e08eb59b057f3b450456c60783c1afbfab3a20/src/polyfills/vm.ts) implements scripts with `eval`/`Function` while its ESM module classes are stubs. The package also brings Acorn, compression, RPC, validation, registry, VFS, shell, and builtin implementations that duplicate existing authorities ([package manifest](https://github.com/illuma-ai/nodepod/blob/c4e08eb59b057f3b450456c60783c1afbfab3a20/package.json)).

Repository inference: substituting Nodepod would be a rewrite around a less compatible parallel runtime, not reuse of a mature deep module. Its recent activity does not offset the semantic and ownership mismatch.

### 6. Deno and Bun — mechanism references, not browser dependencies

Deno and Bun demonstrate that resolution, transformation, registry/cache, and evaluation must cooperate inside a runtime. Deno uses standard ESM as its primary module system and directly executes TypeScript through its runtime pipeline ([Deno modules](https://docs.deno.com/runtime/fundamentals/modules/), [Deno TypeScript](https://docs.deno.com/runtime/fundamentals/typescript/)). Bun implements CJS and ESM in its native runtime, stores CJS exports for cycles, synthesizes ESM namespaces for CJS, and transpiles TypeScript before execution ([Bun module resolution](https://bun.sh/docs/runtime/module-resolution), [Bun runtime](https://bun.sh/docs/runtime)). Node likewise exposes `vm.SourceTextModule`/`SyntheticModule` only through V8's module-record machinery, with explicit linking/instantiation and cycle rules ([Node VM modules](https://nodejs.org/api/vm.html#class-vmmodule)).

None of these implementations is an embeddable browser JavaScript library: Deno and Bun own native runtime/engine integrations, while Node's VM module facilities are V8 bindings absent from Web Workers. Porting them would import an entire runtime rather than reuse one responsibility. Use their terminology and tests as prior art only.

## Ranked retain/delete/reuse programme

1. **Retain:** one context-local Module Registry, resolver, format admission, CJS wrapper contract, builtin provider seam, customization-hook semantics, CJS/ESM interop, failure eviction, and teardown. These are the deep behavior behind the engine interface.
2. **Reuse/reduce:** keep the already-installed Babel browser build first; replace hand-written ESM/TypeScript parsing and rewriting with one transformer result carrying generated code and a source map. If Babel cannot satisfy live bindings/cycles/TLA through the existing registry, prove that with a focused prototype before considering another parser.
3. **Retain locally:** evaluation policy, all dynamic evaluation sinks, runtime binding injection, artifact evidence/fingerprint, error normalization, and the narrow `node:vm` script evaluator. A compiler library does not own them.
4. **Delete after replacement proves parity:** bespoke ESM regex/AST rewrite helpers, manual TypeScript stripping paths, line-count-only provenance adjustment, and duplicated per-format compilation plumbing. Do not delete the registry callbacks those definitions target.
5. **Do not add:** Nodepod, SystemJS, ES Module Shims, import-map state, a second cache, or Deno/Bun/Node runtime ports.

## Minimal target shape

```text
Execution Context Bootstrap
  -> Module Execution Engine interface
       -> resolver + one Module Registry authority
       -> private compile(source, identity, format)
            -> executable definition + source map
       -> engine-owned evaluation/provenance sinks
  <- Node Compatibility adapters (`node:module`, `node:vm`, builtins)
```

This keeps the external seam where behavior actually varies (Execution Context composition supplies VFS and builtin adapters) and keeps the parser/transformer as an internal implementation dependency. A public Runtime Artifact Compiler interface would be hypothetical: there is one owner and one intended adapter.

## Prototype threshold

Only one question remains genuinely empirical: can the installed Babel build emit an execution definition that passes the maintained ESM cycle/live-binding/TLA and CJS interop claims while preserving mapped error locations, with materially less code than the current rewrite cluster? A focused prototype should transform a three-module graph (cycle + mutable export + TLA), run it through the existing registry callbacks, and compare the maintained claim outputs and bundle delta.

No prototype is needed for native import maps, ES Module Shims, SystemJS, Nodepod, Deno, or Bun: their documented interfaces and source already show that Node resolution/CJS/registry authority would remain local or be duplicated.

## Decision-so-far gist

Retain the engine's single local resolution/registry authority and evaluation/provenance sinks; replace only bespoke ESM/TypeScript rewriting with one pinned internal transformer, testing installed Babel first, and add no loader framework or second cache.
