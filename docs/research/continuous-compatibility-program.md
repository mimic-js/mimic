# Research: continuous compatibility program for a browser-resident Node runtime

> Snapshot note: source findings and dated evidence are retained, but repo-specific
> “current state” statements may be obsolete. Verify them against current code,
> tests, issues, and [`compatibility-status.md`](../compatibility-status.md). See
> [the research status rules](./README.md).

Date: 2026-07-05

## Why this research exists

The roadmap explicitly asks for research on:

- how to continuously maintain a compatibility program
- how WebContainers and comparable runtimes choose representative stacks
- how to choose version ranges without turning the matrix into random demos

This repo is already beyond "can Vite boot once?" The hard problem now is evidence discipline: deciding which stacks count, which versions count, how often they must be revalidated, and when a regression should expand the matrix instead of being dismissed as an edge case.

## Repo-specific context

- [`../../docs/roadmap-alignment.md`](../../docs/roadmap-alignment.md) already requires a versioned fixture manifest, explicit compatibility tiers, version-policy coverage, and a scheduled discovery workflow.
- [`../../docs/research/testing-architecture.md`](../../docs/research/testing-architecture.md) already argued for Vitest plus Playwright plus compatibility reporting, but it did not answer the selection policy question.
- The existing browser fixtures are still Vite-heavy. That is useful, but it is not yet a maintained compatibility program for a WebContainers-style runtime.

## Source set

Primary sources used here:

- [WebContainers runtime test cases for AI agents](https://webcontainers.io/guides/ai-agents)
- [WebContainers introduction](https://webcontainers.io/guides/introduction)
- [WebContainers browser support](https://webcontainers.io/guides/browser-support)
- [WebContainers API versioning and support](https://webcontainers.io/guides/api-support)
- [StackBlitz available environments](https://developer.stackblitz.com/guides/user-guide/available-environments)
- [Sandpack homepage](https://sandpack.codesandbox.io/)
- [Sandpack FAQ](https://sandpack.codesandbox.io/docs/resources/faq)
- [Sandpack client docs](https://sandpack.codesandbox.io/docs/advanced-usage/client)
- [Node.js releases](https://nodejs.org/en/about/previous-releases)
- [npm workspaces](https://docs.npmjs.com/cli/v8/using-npm/workspaces/)
- [pnpm installation and compatibility](https://pnpm.io/installation)
- [Yarn Corepack](https://yarnpkg.com/corepack)

## Source-backed findings

### 1. WebContainers already publish the right selection principle: choose stacks from observed real usage, not from internal taste

The strongest external signal is the WebContainers AI-agent test-case guide. It says the baseline cases are meant to cover common patterns, libraries, tools, commands, and environments used in the Node ecosystem, and that those choices are driven by usage from millions of StackBlitz users plus npm trends.

That matters because it gives this repo a defensible answer to "why these fixtures?" The answer should not be "because the maintainer likes this framework" or "because this one once broke." The answer should be:

- common real-world usage
- broad runtime-capability coverage
- known regression pressure

This repo should copy that selection principle directly.

### 2. The compatibility program must be capability-led, not framework-led

WebContainers' public baseline is not just a list of popular frameworks. Their test-case categories include:

- Node.js runtime behavior
- package managers
- CLI
- Vite
- Next.js
- shadcn-ui
- React Router
- Nuxt
- LibSQL
- Drizzle ORM

That is the right shape. It mixes popularity with capability classes:

- process and shell behavior
- package installation and workspace behavior
- client bundlers and HMR
- full-stack SSR/dev-server conventions
- CLI-driven code generators
- data and ORM tooling

For this repository, that means the fixture matrix should not start from "React/Vue/Svelte/etc." alone. It should start from capability buckets, with frameworks chosen as representative pressure for each bucket.

### 3. WebContainers' browser baseline means browser compatibility itself is a maintained matrix dimension

The WebContainers browser-support guide makes two constraints explicit:

- SharedArrayBuffer and cross-origin isolation are baseline requirements
- support differs by browser family, with Chromium the strongest path and Safari/Firefox historically more constrained

For this repo, browser support is not a generic QA concern. It changes which runtime architecture claims are even valid. Any compatibility program therefore needs browser lanes at least as metadata, even if daily CI only runs Chromium first.

Inference from the docs: the manifest for each fixture should record both runtime-stack requirements and browser requirements, because some future failures will be "stack works on Chromium but not on Safari/Firefox policy path" rather than "stack unsupported everywhere."

### 4. Comparable runtimes expose why a representative matrix must include unsupported and constrained categories

Sandpack and Nodebox are useful here precisely because they state concrete support boundaries:

- Sandpack markets built-in support for Next.js, Remix, Vite, Astro, and more.
- Sandpack's FAQ says Nodebox aims at the latest Node version but, at the documented moment, targeted Node.js 18 and noted missing experimental features.
- The FAQ also lists major limits: native modules only when wasm alternatives exist, no native sockets, and weak support for large monorepos.
- The Sandpack client docs separate runtime-JS, Nodebox, and static-server execution modes.

This is important because a serious compatibility program is not only a brag sheet of green checks. It must also track:

- intentionally unsupported stacks
- stacks blocked by browser/native limitations
- stacks requiring a different execution mode

If this repo only records successes, it will relearn the same impossible native-dependency and socket problems repeatedly.

### 5. Version coverage should follow upstream support windows, not "latest only"

The primary upstreams in this repo's target space already publish useful version policies:

- Node.js release docs show that, as of July 5, 2026, Node.js 24 is LTS, Node.js 22 is also LTS, and Node.js 26 is Current; production guidance is to use Active LTS or Maintenance LTS.
- pnpm publishes an explicit Node compatibility table; notably pnpm 11 requires newer Node lines than pnpm 10.
- Yarn recommends Corepack so package-manager version is pinned per project rather than floating globally.
- npm's workspaces docs make symlinked local packages a first-class workflow, so workspace behavior cannot be treated as optional edge coverage.

This points to a concrete version policy for the repo:

- one `current-preferred` lane for the newest browser-runnable stack version
- one `supported-previous` lane for the previous major still widely used upstream
- one `pinned-regression` lane when a real bug was found and must never silently return
- explicit `unsupported` ranges with a source-backed reason

Latest-only testing is not enough. It misses long-tail support obligations and breaks reproducibility whenever upstream releases move.

### 6. Package-manager coverage must be first-class because package-manager choice changes runtime requirements

WebContainers explicitly call out npm, pnpm, and Yarn as major package managers. StackBlitz's environment docs also say WebContainers natively support npm, pnpm, and Yarn v1. Yarn's own docs push Corepack-based pinning, while pnpm publishes Node-version compatibility separately from npm.

That means "framework X boots" is not complete evidence. The install path itself changes:

- lockfile format
- workspace linking
- lifecycle script behavior
- symlink expectations
- package-manager binary resolution

For this repo, package managers should be a top-level compatibility tier, not hidden under whichever framework happens to use them.

### 7. The right matrix is incremental and scheduled, not all-on-every-PR

The sources do not prescribe this repo's CI design directly, but together they imply a structure:

- WebContainers baseline chooses broad representative cases.
- Sandpack/Nodebox document explicit limits instead of pretending universal support.
- Node and package-manager upstreams move independently.

So the only sustainable model is:

- a small blocking core set on every PR
- a medium representative set on merge or protected branches
- a broad discovery set on a schedule

Anything else either becomes too expensive to run, or too shallow to trust.

## What this means for this repo

### Main conclusion

This repository should formalize a compatibility program around four selection rules:

1. choose fixtures from real ecosystem usage plus roadmap capability coverage
2. organize them by capability tier, not by framework fandom
3. version them against upstream support windows
4. record unsupported and blocked cases as first-class outcomes

The result should be a versioned manifest plus generated reports, not a loose collection of smoke scripts.

## Recommended compatibility model

### 1. Capability tiers

The roadmap's section 13 is directionally correct. I would tighten it into these program tiers:

1. `core-runtime`
   Covers plain Node behavior: CJS/ESM, fs, streams, child JS processes, workers, env, argv, signals, CLI.
2. `http-and-server`
   Covers `node:http`, Express, Fastify, Koa, NestJS, server-ready, request routing, upgrade/WebSocket boundaries.
3. `bundlers-and-dev-servers`
   Covers Vite first, then webpack-dev-server, Rollup watch, esbuild tools, Rspack only after native/browser prerequisites are documented.
4. `meta-frameworks`
   Covers Next.js, Nuxt, Astro, SvelteKit, React Router framework mode, Angular CLI/Vite.
5. `package-managers-and-monorepos`
   Covers npm, npx, pnpm, Yarn, workspaces, local links, peer/optional deps, lifecycle scripts.
6. `cli-and-codegen`
   Covers shadcn, framework generators, scaffolders, commands that mutate the project tree.
7. `data-and-tooling`
   Covers LibSQL, Drizzle, test runners, and other AI-agent baseline tools.

This keeps Vite as a major tier without allowing it to define the whole support story.

### 2. Fixture statuses

Each fixture should have one of these statuses:

- `aligned`: runs install and runtime inside `Mimic` with no forbidden fallback
- `shimmed`: works only with a declared transitional adapter
- `experimental`: runs, but lacks confidence or browser breadth
- `blocked`: known missing runtime capability
- `unsupported`: intentionally out of scope for now

This status model matches the roadmap's planned report categories and forces honesty about evidence quality.

### 3. Version policy

Each maintained stack should record:

- `latest_supported`
- `previous_supported_major`
- `pinned_regression_versions`
- `unsupported_ranges`
- `upstream_support_basis`

Examples for current policy design:

- Node lanes should follow active upstream support windows, which on July 5, 2026 means preferring Node 24 LTS and 22 LTS as support anchors, while tracking Node 26 Current as forward pressure.
- pnpm lanes should reflect its published Node compatibility table rather than assuming pnpm 10 and 11 are interchangeable.
- Yarn lanes should prefer Corepack-pinned versions so a fixture remains reproducible over time.

### 4. Manifest shape

The future manifest should minimally capture:

- stack id and category
- package manager and version pin
- package versions
- install, dev, start, and test commands
- expected ports and readiness signals
- required runtime capabilities
- forbidden fallbacks
- browser requirements
- support status
- upstream source links
- last validated date
- owner or maintainer

That is enough to drive both execution and reporting.

## Recommended initial representative stacks

These are the highest-value additions after the current Vite-heavy baseline, in order:

1. Plain Node CLI plus child-process fixture
   Why: proves process, stdio, env, and shell semantics without frontend noise.
2. Express or Fastify HTTP fixture
   Why: proves generic server ownership through the virtual network, not only Vite middleware.
3. npm workspaces or local-link monorepo fixture
   Why: forces symlink, workspace, and package-manager behavior that frontend demos do not cover.
4. Next.js or React Router framework-mode fixture
   Why: introduces SSR/full-stack conventions and more demanding dev-server behavior.
5. shadcn CLI fixture
   Why: directly pressures CLI, codegen, file mutation, package installs, and framework conventions.
6. LibSQL plus Drizzle fixture
   Why: matches the WebContainers AI-agent baseline and exposes database/tooling edges early.

Inference: this ordering is better than adding more Vite framework variants first, because the repo already has substantial Vite evidence and weaker non-Vite coverage.

## Maintenance workflow

### On every PR

Run only:

- core runtime contracts
- one plain Node mimic stack
- one generic HTTP/server stack
- one representative Vite stack
- manifest/report generation validation

### On protected-branch merge

Run:

- all maintained core and representative stacks
- all package-manager lanes
- at least one meta-framework lane

### On schedule

Run:

- broader version matrix
- pinned regression fixtures
- discovery candidates for new majors or newly browser-runnable stacks

### Discovery rules

When a new stack should enter the matrix:

- it appears in WebContainers' published baseline categories
- it is a major framework/tool explicitly supported by comparable runtimes
- it introduces a new runtime capability class
- it caused a real regression or exposed a missing capability

When a stack should not enter yet:

- it is just another cosmetic variant of an already-covered capability
- it requires native/browser behavior the repo has not researched yet
- it only runs through host Node or an adapter and would create false confidence

## Concrete roadmap impact

This research should drive these roadmap changes and future implementation tasks:

- the section 13 fixture manifest should encode capability tiers, status, browser requirements, and upstream version policy
- the future compatibility report should include unsupported and blocked stacks, not only passing ones
- the `webcontainers-runtime` skill should inspect stale versions and uncovered capability tiers before choosing implementation work
- package-manager and workspace fixtures should be treated as first-class parity evidence, not auxiliary tests

## Bottom line

The right compatibility program for this repo is not "test popular frameworks." It is:

- capability-tiered
- version-policy-driven
- explicit about unsupported boundaries
- browser-aware
- grounded in real ecosystem usage and upstream support windows

That is the smallest program that can make future "WebContainers-aligned" claims defensible instead of aspirational.
