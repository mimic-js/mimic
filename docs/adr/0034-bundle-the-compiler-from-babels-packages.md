---
status: accepted
amends: ADR-0023 (the shipped size of the compiler worker; where Babel comes from)
---

# Bundle the compiler from Babel's packages

ADR-0023 keeps Babel as the Runtime Artifact compiler and moves it into
`runtime-artifact-compiler-worker`, the one asset the compiler pool starts.
That asset took Babel from `@babel/standalone`, a build Babel publishes for
browsers that carries every preset and plugin Babel maintains: `preset-env`
with its compatibility data, the `core-js` polyfill providers, the Unicode
property tables of `regexpu-core`, React, Flow and the stage proposals. The
translator uses none of it. It parses with `@babel/parser`, erases TypeScript
with `preset-typescript`, lowers ES modules with
`transform-modules-systemjs` and `transform-export-namespace-from`, and
carries its own two plugins (`translator.ts`). Minified, the asset was
3,134,658 bytes (687 KB compressed), the largest file of the package by a
factor of two over the SQLite binary, and 97 % of it was Babel.

## Decision

The compiler worker imports Babel from Babel's own packages: `@babel/core`,
`@babel/parser`, `@babel/preset-typescript`,
`@babel/plugin-transform-modules-systemjs` and
`@babel/plugin-transform-export-namespace-from`, pinned to one version.
`runtime-artifact-compiler-babel.ts` in Runtime Host presents them as the
`BabelStandalone` slice the translator takes: `transform`, which resolves the
preset and plugin names the translator passes to the bundled modules and
rejects any other name, `packages.parser`, and `version`. The translator, the
Compile Cache and the compiler pool do not change. The Compile Cache key
names the `@babel/core` version where it named the `@babel/standalone`
version; both are the same release, so entries persisted before this decision
stay valid, and the translator's pinned output test
(`tests/unit/runtime-artifact-compile-service.test.ts`) shows the compiled
text is unchanged.

Babel's packages are written for Node. The browser build of `@babel/core`
(its `browser` field, which the bundler honours) drops configuration files
and source-map files but still joins file names with `path`, and its module
transforms call `assert`. The compiler asset's build resolves `path` to
`path-browserify`, already a dependency of the Node Compatibility ports, and
`assert` to a one-function module. Babel also reads `process.env`,
`process.cwd()` and `process.versions` as it loads, which `@babel/standalone`
provided itself; `runtime-artifact-compiler-babel-globals.ts` provides the
same members in the compiler worker and is imported before any Babel package.
In Node, where the unit tests run the translator, none of this applies: the
builtins and `process` are the platform's.

The asset is now 1,443,208 bytes (357 KB compressed), 54 % less. What
remains is the compiler itself: `@babel/parser` is close to half of it,
`@babel/types`, `traverse`, `generator`, `core` and the helper templates most
of the rest. Going lower means another compiler, which ADR-0023 measured and
rejected: swc cannot carry the Async Context rewrite and ships 18 MB of
WebAssembly; oxc cannot emit `System.register`.

## Consequences

- `@babel/standalone` leaves the dependencies. A new Babel preset or plugin the
  translator needs is a new pinned dependency and a new entry in the shim's
  table; a name the table lacks fails the compile with a message naming it.
- Babel's packages publish no types. `src/vite-env.d.ts` declares the members
  the shim uses, as it declared `@babel/standalone` before.
- `tests/unit/module-execution-architecture.test.ts` keeps Babel out of the
  Execution Context: `esm-execution` names neither a Babel package nor the
  shim.
- Upgrading Babel means upgrading the five packages together; the Compile
  Cache's version key changes with `@babel/core`.
