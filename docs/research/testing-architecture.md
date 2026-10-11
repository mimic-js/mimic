# Research: sustainable automated testing architecture for a browser-resident Node runtime

> Snapshot note: source findings and dated evidence are retained, but repo-specific
> “current state” statements may be obsolete. Verify them against current code,
> tests, issues, and [`compatibility-status.md`](../compatibility-status.md). See
> [the research status rules](./README.md).

Date: 2026-06-22

## Why this research exists

The roadmap explicitly calls for research on:

- Vitest for runtime and unit contracts
- Playwright for in-browser runtime behavior
- fixture lifecycle
- CI sharding, retries, and traces
- migration away from ad hoc smoke scripts

This repository is no longer proving a toy demo. It is trying to prove WebContainers-like behavior for a browser-resident Node runtime. That means test architecture is part of the runtime architecture: if the evidence model is weak, roadmap checkmarks become untrustworthy.

## Repo-specific context

Current state in the repository:

- [`../../package.json`](../../package.json) exposes many one-off `smoke:*` scripts and no `vitest` dependency yet.
- The old browser demo smoke path used Playwright directly, but as a custom script rather than under Playwright Test's project/fixture/reporting model; those browser fixture assertions now belong in named Playwright Test suites.
- [`../../docs/roadmap-alignment.md`](../../docs/roadmap-alignment.md) already defines the desired destination:
  - Vitest for runtime contracts
  - Playwright Test for mimic behavior
  - typed shared fixtures
  - CI lanes with affected execution and caching after the Nx migration

So the question is not whether to add tests. The question is how to turn the current smoke collection into a layered proof system that matches the repo's compatibility claims.

## Source-backed findings

### 1. Vitest projects are a good fit for layered runtime contracts

Vitest's `projects` feature is designed for multiple configurations in one test process and is explicitly positioned as useful for monorepos, browser tests, and config splits. That maps well to this repository because the runtime needs different evidence layers:

- pure runtime contracts in Node
- browser-mode contracts for browser APIs that do not need full app navigation
- future package-level splits after Nx workspace migration

Sources:

- [Vitest test projects](https://vitest.dev/guide/projects)
- [Vitest configuration](https://vitest.dev/config/)

### 2. Vitest browser mode is useful, but it should not replace Playwright for CI-proof browser behavior

Vitest browser mode runs tests in a real browser and supports providers. However, the Vitest docs explicitly say CI should use a real provider such as Playwright or WebdriverIO, and recommend that over the default preview provider because preview simulates events instead of using Chrome DevTools Protocol.

That matters for this repo because many critical claims are about true browser/runtime behavior:

- Service Worker routing
- iframe preview rendering
- cross-origin isolation
- HMR update delivery
- repeated reload correctness

Those should not depend on a simulated browser path.

Sources:

- [Vitest browser mode](https://vitest.dev/guide/browser/)
- [Vitest homepage](https://vitest.dev/)

### 3. Playwright Test already has the primitives this repo needs for mimic verification

Playwright Test provides:

- isolated fixtures for test environments
- project dependencies for setup phases
- retries
- traces
- sharding across CI machines

Those are not incidental conveniences. They directly match the repository's current pain points:

- boot/install/dev-server setup is expensive and should be modeled as reusable fixtures
- failing mimic tests need retained traces, not just terminal output
- compatibility matrices across fixtures and frameworks need project-level organization
- browser tests will become too slow unless they shard cleanly

Sources:

- [Playwright fixtures](https://playwright.dev/docs/test-fixtures)
- [Playwright projects and dependencies](https://playwright.dev/docs/test-projects)
- [Playwright retries](https://playwright.dev/docs/test-retries)
- [Playwright trace viewer](https://playwright.dev/docs/trace-viewer-intro)
- [Playwright sharding](https://playwright.dev/docs/test-sharding)

### 4. Playwright traces should be treated as a required artifact for flaky browser-runtime failures

Playwright documents a practical default: traces `on-first-retry`, with retries enabled on CI. The trace viewer captures DOM snapshots, network activity, console/errors, and action history.

For this runtime, traces are especially valuable because browser failures often involve interactions across:

- main page
- preview iframe
- Service Worker routing
- injected preview scripts
- runtime-owned HMR/network behavior

A plain thrown error rarely captures enough of that boundary.

Sources:

- [Playwright trace viewer](https://playwright.dev/docs/trace-viewer-intro)
- [Playwright `use.trace` modes](https://playwright.dev/docs/test-use-options)
- [Playwright timeouts](https://playwright.dev/docs/test-timeouts)

### 5. WebContainers' own AI-agent baseline argues for a maintained compatibility matrix, not a handful of demos

The WebContainers "Runtime Test Cases For AI Agents" page says the test cases are meant to validate runtimes against common patterns, libraries, tools, commands, and environments used in the Node ecosystem.

That is directly aligned with this repo's roadmap language about representative client, server, bundler, framework, and plain Node stacks. The implication is clear: the test plan should be organized around maintained compatibility tiers, not around whichever smoke script happened to be written first.

Source:

- [WebContainers runtime test cases for AI agents](https://webcontainers.io/guides/ai-agents)

### 6. Nx affected execution and caching are the right CI scaling target after workspace migration

Nx documents two relevant behaviors:

- `nx affected -t <task>` computes the minimal set of affected projects from Git history and the project graph
- task caching hashes sources, relevant config, dependency versions, runtime values, and CLI flags, then replays outputs when the computation matches

That matches the roadmap's desire to eventually split the runtime into packages and avoid rerunning the full compatibility matrix on every PR. It also means the testing architecture should be designed now so that future Vitest and Playwright tasks can become first-class Nx targets without being rewritten again.

Sources:

- [Nx affected](https://nx.dev/docs/features/ci-features/affected)
- [Nx caching](https://nx.dev/docs/concepts/how-caching-works)

## What this means for this repo

### Main conclusion

The repository should adopt a three-layer testing architecture:

1. `Vitest` for fast runtime contracts and small integration boundaries
2. `Playwright Test` for authoritative mimic behavior
3. compatibility-matrix reporting built from named fixtures/projects instead of ad hoc smoke scripts

The current `smoke:*` scripts are still useful as migration scaffolding, but they should stop being the long-term source of truth.

### Recommended test layers

#### Layer A. Vitest runtime contracts

Use Vitest for boundaries that do not require a fully navigated browser page:

- VFS semantics
- resolver and package export conditions
- module-loader behavior
- package-manager resolution logic
- shell parser and process-manager contracts
- preview-routing units that can be tested without a real iframe

Recommended structure:

- `tests/runtime/*.test.ts` for pure contracts
- `tests/integration/*.test.ts` for multi-module runtime boundaries
- `vitest.config.ts` with `projects` for `runtime`, `integration`, and later package-level splits

Inference: some browser-adjacent code may also fit Vitest browser mode, but only if the assertion is local to a browser API and does not need the full preview/runtime lifecycle.

#### Layer B. Playwright mimic suites

Use Playwright Test for claims that define WebContainers alignment:

- `boot()`, `mount()`, `spawn()`, `server-ready`
- preview iframe rendering
- Service Worker preview routing
- HMR behavior
- repeated reload correctness
- fixture switching without leaked runtimes
- teardown correctness
- preview error forwarding
- cross-origin isolation

Recommended structure:

- `playwright/fixtures.ts` for runtime boot, mounted project, preview helpers, and diagnostics capture
- `tests/browser/*.spec.ts` for core browser-runtime behavior
- `tests/compat/*.spec.ts` for framework/package-manager matrices
- Playwright projects for `setup`, `core`, `frameworks`, and later `extended-compat`

#### Layer C. Compatibility tiers

Instead of one large undifferentiated suite, maintain explicit tiers:

- `core`: API/lifecycle, VFS, install, dev server, preview routing, no forbidden fallback
- `frameworks`: vanilla, React, Vue, Solid, Svelte, TypeScript
- `ecosystem`: future React Router, shadcn, Next/Vite-adjacent server cases, ORM/database cases
- `broad-matrix`: scheduled or nightly representative stacks

That tiering is an inference from the repo roadmap plus the WebContainers baseline.

## Recommended fixture architecture

### Shared typed fixture builders

The current repo should stop encoding project graphs and assertions inside one-off scripts. Instead, create reusable typed builders that both Vitest and Playwright can consume:

- `fixtures/projects/vanilla.ts`
- `fixtures/projects/react.ts`
- `fixtures/projects/vue.ts`
- `fixtures/projects/solid.ts`
- `fixtures/projects/svelte.ts`
- `fixtures/helpers/install.ts`
- `fixtures/helpers/preview-diagnostics.ts`

Each builder should describe:

- mounted source tree
- package manifest
- optional lockfile shape
- expected rendered selector/text
- expected HMR mutation
- forbidden fallback markers

That lets one fixture definition feed:

- a Vitest integration test for installer/loader behavior
- a Playwright browser test for runtime/preview behavior
- a future compatibility report

### Browser diagnostics fixture

The Playwright layer should centralize:

- console capture
- page errors
- iframe errors
- network failures
- preview diagnostic payloads
- terminal output snapshots
- trace retention hooks

Without that, each new browser test will keep re-implementing failure plumbing and the suite will stay hard to debug.

## Migration plan away from ad hoc smoke scripts

### Phase 1. Introduce runners without deleting smoke scripts

- add `vitest` and a root `vitest.config.ts`
- add `@playwright/test` config instead of custom `tsx` entrypoints
- port one fast smoke from each category first:
  - installer/resolver to Vitest
  - browser demo render to Playwright

Success condition: both runners exist and are green without changing roadmap claims yet.

### Phase 2. Extract shared fixtures

- move mounted project definitions out of `scripts/smoke-*.ts`
- create typed fixture builders reusable by both test runners
- keep wrapper scripts only if CI or docs still point at old names

Success condition: new tests no longer hand-roll package trees in each file.

### Phase 3. Port browser smokes into Playwright projects

Port these high-value flows first:

- browser demo vanilla
- React/Vue/Solid/Svelte fixture render
- JS/CSS/framework HMR
- reload regression
- fixture switching regression
- preview error forwarding

Success condition: the critical browser claims in the roadmap are backed by Playwright Test suites with traces and retries.

### Phase 4. Port Node-hosted smokes into Vitest contracts

Port focused smokes such as:

- dependency resolver
- lockfile installer
- package cache
- registry metadata cache
- shell-lite
- HTTP preview server units where a real browser is unnecessary

Success condition: most fast feedback comes from Vitest, not `tsx` scripts.

### Phase 5. Remove compatibility-wrapper smoke commands

Keep only thin compatibility commands during migration, then delete them once CI points at test runners directly.

Success condition: `package.json` no longer treats ad hoc `smoke:*` scripts as the primary test surface.

## CI recommendation

### Pull request lanes

- `build`: typecheck and production build
- `vitest-core`: fast runtime and integration contracts
- `playwright-core`: authoritative core mimic behavior

### Extended lanes

- `playwright-frameworks`: framework fixtures
- `playwright-reload-regressions`: repeated reload and fixture-switching stress cases
- `compat-broad`: scheduled broader matrix against representative stacks

### Failure-policy recommendation

- default Playwright traces: `on-first-retry`
- CI retries: enable for browser suites, keep low and intentional
- shard browser suites in CI once the suite length justifies it
- keep deterministic fixture teardown mandatory, even on failure

These recommendations are based on Playwright's documented retry/trace/shard model and the repo's browser-runtime failure modes.

## Concrete implementation recommendation

The next implementation sequence should be:

1. add `vitest` and `@playwright/test` as first-class runners
2. create shared typed fixture builders
3. port the browser demo fixture assertions into a Playwright Test project with traces/retries
4. port one installer/resolver smoke into Vitest
5. keep legacy wrapper commands only as temporary aliases
6. after the Nx migration, expose `test:vitest`, `test:playwright-core`, and `test:playwright-frameworks` as cacheable affected targets

## Decision summary

The sustainable target is not "more smoke scripts." It is:

- `Vitest` for fast correctness contracts
- `Playwright Test` for browser-runtime truth
- shared typed fixtures for both
- explicit compatibility tiers
- Nx-affected CI execution after workspace migration

That is the smallest test architecture that matches the technical ambition of this repository and the evidence standard implied by WebContainers-style compatibility claims.
