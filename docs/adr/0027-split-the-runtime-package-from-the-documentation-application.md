---
status: accepted
amends: ADR-0003 (the package gains one build-time entry beside the `Mimic` facade)
---

# Split the runtime package from the documentation application

_Later renamed: `apps/docs` is now `apps/e2e-demo`, the demo application the
Playwright suite drives, and the site with the documentation and the
playground is `apps/site` (formerly `apps/repo-playground`)._

The repository was one package that was both the published runtime and its
demo. The demo's dependencies (`react`, `vite`, `@vitejs/plugin-react`,
`typescript`) were therefore the runtime's `dependencies`, although the
published `dist` imports nothing. The only consumer-side proof served the
tarball through an import map; nothing built it with a bundler, and the
requirements a consumer's server must meet were readable only from the
repository's own Vite configuration.

## Decision

- **Two workspace projects.** `packages/runtime` is the published package
  (`@mimic-js/runtime`) with its sources, claims, fixtures, architecture
  policy and scripts; inside it the layout is unchanged, so `src/runtime`,
  `tests/e2e` and `scripts` mean what they meant before, relative to the
  package. `apps/docs` is the documentation application, which starts as the
  former demo and consumes the package by name, built, like any other
  application. Repository-wide material (`docs/`, `CONTEXT.md`,
  `.github/`) stays at the root.
- **Nx runs the workspace, package scripts stay the interface.** Nx infers
  targets from each project's `package.json` scripts and adds ordering
  (`^build` before `build`, `typecheck`, `dev`) and caching. There are no Nx
  plugins or generated project files: `pnpm run <script>` inside a project
  does what the Nx target does.
- **The published package declares what it imports.** Everything the runtime
  uses is bundled, so it has no `dependencies`. `pnpm package:check` parses
  every packed script and every declaration reachable from a public types
  entry, and fails on an imported package that is not declared and on a
  declared dependency that nothing imports.
- **One build-time entry: `@mimic-js/runtime/vite`.** `Mimic`
  remains the single runtime facade (ADR-0003). The Vite plugin is
  configuration a consumer's bundler loads in Node; it sends the required
  headers from the development and preview servers, excludes the package from
  dependency pre-bundling, and builds workers as modules. `vite` is an
  optional peer dependency. Other subpaths remain forbidden.
- **Literal asset references.** The build names every worker and asset as
  `new URL('./relative', import.meta.url)` with a literal path. Vite's default
  for a relative base wraps the path in a second, computed URL, which webpack
  turns into a failing context lookup. Published scripts are minified,
  including the ones copied as assets.
- **Headers stay the consumer's server's job, and their absence is named.**
  The page needs `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`; the Service Worker script
  needs `Service-Worker-Allowed: /` unless it is served from the site root.
  `boot()` rejects with one error naming the header that is missing.
  _Amended by [ADR-0030](./0030-scope-the-service-worker-to-the-endpoints-directory.md):
  the Service Worker no longer takes the scope `/`, so the third header is
  gone._

## Considered and not done

- **Setting the headers from the Service Worker**, so that an import and
  `boot()` would be the whole setup. A worker can add the isolation headers to
  the page's own navigation response only after a first, non-isolated load and
  a reload, and it can only be registered for `/` in the first place when its
  script is at the site root or already carries `Service-Worker-Allowed`, which
  is the header this would be trying to avoid. A bundler plugin that emits the
  script at the root would remove that one header and can be added later
  without changing the runtime.
- **Claims that drive the documentation application moving into it.** They
  stay in the package's `tests/e2e` so that one matrix discovers every claim;
  Playwright starts the application's development server beside the test host.

## Consequences

- Commands run from the root through Nx (`pnpm run test:build`,
  `test:unit`, `package:check`) or inside `packages/runtime` directly;
  Playwright runs inside `packages/runtime`.
- Baseline lookups that read an older commit (the claim matrix's additivity
  check and the ownership policy ratchet) try the package path first and the
  former root path second. The second candidate is deleted once no baseline
  predates this layout.
- A consumer's bundler now processes the package's workers as worker entries
  instead of copying them, which is what makes nested workers resolve, at the
  cost of the bundler parsing about 4 MB of already minified code per build.
