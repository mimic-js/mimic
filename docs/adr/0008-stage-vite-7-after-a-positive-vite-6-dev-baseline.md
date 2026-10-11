---
status: accepted
---

# Stage Vite 7 after a positive Vite 6 development baseline

Mimic will add exact-graph development support for `vite@7.3.6`
only after the maintained Vite 6 development matrix is fully positive. The Vite
6 prerequisite includes frozen installation, Vite-owned development-server
startup, initial render, and framework-native HMR for React, Vue, Solid, and
Svelte, plus the shared HMR behavior exercised by Vanilla JavaScript and
TypeScript. Accepted-failure Compatibility Claims are removed rather than used
as a baseline.

The Vite 7 matrix repeats those positive development scenarios with exact,
current compatible framework graphs. Production build and production preview
are not part of this delivery's readiness boundary.

Development readiness uses the ordinary upstream CLI command without a required
`--configLoader runner` override. Framework fixtures retain the configuration
format used by their current upstream template and exercise Vite's default
`bundle` loader. One focused configuration claim loads `vite.config.ts` and
proves an observable setting. The matrix does not multiply evidence across all
six supported config extensions or across the `runner` and `native` loaders;
those are independent compatibility surfaces rather than prerequisites for an
ordinary Vite project.

HMR evidence must distinguish a hot update from Vite's full-page reload
fallback. Every HMR scenario keeps the same browser document alive, observes
the updated DOM after a filesystem change, retains a connected HMR transport,
reports no runtime error, and closes cleanly. Vanilla JavaScript and TypeScript
exercise self-accepted module updates. React Fast Refresh and a Vue template
update additionally preserve component state for edits that their upstream
refresh implementations classify as compatible. Solid and Svelte prove their
framework-native component replacement without a document reload; they do not
invent a cross-framework state-preservation guarantee that their selected
upstream refresh implementations do not provide.

Each Vite version also has one shared Vanilla CSS HMR scenario. Updating an
imported stylesheet through the VFS must change an observable computed style
without replacing the browser document or losing application state. Framework
fixtures do not duplicate this package-neutral Vite client behavior.

One shared scenario per Vite version proves recovery inside the same development
session. After a successful render, an invalid source edit must surface through
Vite's normal error event or overlay; a subsequent valid edit must remove the
error, update the page, and leave the same development server, browser document,
and HMR session usable through teardown. This is positive recovery evidence, not
an accepted-failure claim.

Native package handling follows publisher-owned browser-feasible profiles. The
installed dependency remains `esbuild@0.28.2`; Catalog stages
`@esbuild/wasi-preview1@0.28.2` as a same-version Catalog Execution Artifact and
projects `ESBUILD_BINARY_PATH` during the upstream install lifecycle.
`rollup@4.62.4` selects the same-version `@rollup/wasm-node` package because
Rollup publishes no WASI executable profile for that version. Platform-native
Rollup bindings and `fsevents` are not materialized for the browser target.
Their omission is acceptable only when the positive Vite development and HMR
scenarios prove the upstream `fs.watch` fallback through useful behavior,
teardown, and fresh boot; package absence is not standalone evidence.

Node compatibility scope is driven by APIs reached through the positive
development matrix, not by every builtin that appears in Vite's bundled static
imports. In addition to capabilities already present on fresh `main`, Vite 7
development and HMR require generic implementations of `buffer.isUtf8`,
`crypto.timingSafeEqual`, and `crypto.randomFillSync`. HTTPS and HTTP/2 server
configuration, `.env.vault` decryption, inspector/profiling, and editor launching
are separate scenarios and do not expand this delivery merely because their APIs
occur in the Vite distribution.

The readiness matrix covers client-side SPA development. Vite SSR, SSR
middleware mode, server module execution, and meta-frameworks such as Nuxt and
SvelteKit are independent compatibility surfaces and are not part of this
delivery.

Vite `server.proxy`, including HTTP and WebSocket proxying, is also a separate
virtual-networking compatibility surface. It is not required by the selected
framework starter workflows and does not expand this delivery's Node API scope.

Every framework Exact Graph starts with an empty Vite dependency-optimizer
cache and must reach its first render through upstream-generated optimized
dependencies. No fixture pre-generates, patches, or supplies optimizer output.
One shared scenario per Vite version then restarts the development server over
the same project and generated optimizer cache and proves a warm-cache render;
framework fixtures do not duplicate that restart evidence.

One shared scenario per Vite version also introduces a previously undiscovered
bare import after the server is ready. Vite must regenerate the affected
optimizer output and reach the new correct render without restarting the
development server or producing missing optimized chunks. A page reload is
allowed in this scenario when it is Vite's upstream response to dependency
re-optimization; it is not confused with framework HMR evidence.

One shared resource-pipeline fixture per Vite version behaves as an ordinary
minimal SPA: Vite transforms a TypeScript entry, imports JSON, resolves an
imported static asset URL, serves an absolute asset from `public/`, and exposes
a `VITE_*` value loaded from `.env`. The rendered page and browser requests must
prove the resulting values and assets through the running development server.
These are public Vite development features, not test-only module hooks.

Vite 6 and Vite 7 use shared behavioral scenario contracts rather than copied,
independently evolving suites. Version-specific Exact Graphs and lockfiles remain
separate, while small framework drivers provide source files, user interaction,
edits, and framework-native assertions. Core scenarios are registered for both
versions from one list. The harness has no accepted-failure branch: a registered
scenario either completes its positive lifecycle or fails.

Each implementation change runs its focused tests. The final integration
runs the repository's complete local regression gate after synchronization with
fresh `origin/main` and integration of all Vite 6 and Vite 7 work:

1. `pnpm install --frozen-lockfile`;
2. `pnpm run test:build`;
3. `pnpm run package:check`;
4. `pnpm run architecture:check`;
5. `pnpm run test:unit`;
6. `CI=1 pnpm run test:e2e -- --global-timeout=36000000 --fail-on-flaky-tests`;
7. real-demo browser acceptance for one Vite 6 and one Vite 7 development
   fixture, each including a visible HMR update through the runtime-owned
   endpoint and iframe path.

The focused browser-fixture script is already contained in the full Playwright
project and is not repeated. This delivery does not add a CI requirement.

The static `compatibility:check` policy is removed rather than extended for
Vite 7. Its script, package command, workflow invocation, dedicated policy
tests, and documentation references are deleted together. Matrix completeness
belongs to the shared Vite scenario-suite contract and useful behavior belongs
to the full Playwright run; a second static evidence authority is not retained.

Delivery work is split into separate React, Vue, Solid, and Svelte framework
lanes. Each lane owns its Exact Graph, initial render, framework-native HMR,
targeted verification, and removal or replacement of any obsolete
accepted-failure claim for that graph. Shared optimizer, watcher, transport, or
runtime defects belong to prerequisite capability issues rather than
framework-specific workarounds. The lanes integrate through one cumulative
final regression gate.

Common behavior is split into three focused core lanes for each Vite version:

1. default `bundle` config loading and the resource pipeline;
2. Vanilla JavaScript, TypeScript, and CSS HMR plus error recovery; and
3. dependency-optimizer warm-cache restart and late bare-import discovery.

The positive Vite 6 Vanilla tracer establishes the shared suite before those
Vite 6 core lanes expand it. Vite 7 core lanes reuse the same behavioral
contracts after the Vite 7 Node API and Catalog prerequisites are complete.
Each framework lane retains responsibility for its own cold optimizer start
from an empty cache, while the common optimizer lane owns only the package-
neutral warm-cache and late-discovery scenarios. Each core lane runs its focused
tests independently; the dependency graph does not hide all common behavior in
one oversized issue.

Framework lanes are also version-specific. Four Vite 6 lanes establish the
complete positive baseline before any of the four corresponding Vite 7 lanes
can complete. Vite 7 lanes additionally depend on the shared Vite 7 Node API
and Catalog prerequisites; they do not combine Vite 6 repair and Vite 7 adoption
inside one child issue.

Vite 6 repair retains the already claimed Exact Graphs rather than upgrading
framework packages to evade a regression: React `18.3.1` with
`@vitejs/plugin-react@4.7.0`; Vue `3.5.0` with
`@vitejs/plugin-vue@5.2.4`; Solid `1.9.0` with
`vite-plugin-solid@2.11.0` and `babel-preset-solid@1.9.0`; and Svelte `5.37.3`
with `@sveltejs/vite-plugin-svelte@5.1.1`, all on `vite@6.4.3`. Their commands
move from the explicit runner override to Vite's default config loader without
changing those dependency versions.

Vite 7 uses exact current compatible framework stacks: React and React DOM
`19.2.8` with `@vitejs/plugin-react@5.2.0`; Vue `3.5.41` with
`@vitejs/plugin-vue@6.0.8`; Solid `1.9.14` with
`vite-plugin-solid@2.11.14`; and Svelte `5.56.8` with
`@sveltejs/vite-plugin-svelte@6.2.4`, all on `vite@7.3.6`. The reviewed frozen
lockfiles, not compatible ranges, fix their transitive graphs; the Solid graph
therefore records the selected `babel-preset-solid` transitively rather than
adding a non-template direct dependency.

The delivery follows five blocking stages:

1. remove the static compatibility checker, accepted-failure vocabulary, and
   maintained negative compatibility claims while retaining Exact Graph test
   infrastructure;
2. introduce the shared Vite development suite through a positive Vite 6
   Vanilla tracer using the default config loader;
3. complete every Vite 6 core and framework lane, forming the prerequisite
   positive baseline;
4. after that baseline, add the generic Vite 7 Node APIs, Catalog artifact
   versions, and reviewed Exact Graphs; and
5. complete the Vite 7 core and framework lanes, real-demo evidence, and the
   cumulative local finalization gate.

An observed cross-cutting failure creates a blocking runtime repair child with
its own focused positive evidence. A framework-specific workaround is not an
admissible substitute for that repair.
