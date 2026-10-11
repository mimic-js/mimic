# Research: repository infrastructure and Nx workspace migration

> Snapshot note: source findings and dated evidence are retained, but repo-specific
> “current state” statements may be obsolete. Verify them against current code,
> tests, issues, and [`compatibility-status.md`](../compatibility-status.md). See
> [the research status rules](./README.md).

Date: 2026-07-04

## Why this research exists

The roadmap explicitly calls for research on repository and product packaging infrastructure:

- `Research repository/product packaging and monorepo tooling, with Nx as the preferred target to evaluate against package publishing, affected tests, caching, graph enforcement, and future packages.`
- `Publish a repository-infrastructure research document and ADR comparing the current layout with an Nx workspace; adopt Nx unless the research identifies a concrete blocker and documents an equivalent alternative.`

This document covers the research half. It does not replace the future ADR or the migration plan.

## Repo-specific context

Current repository state:

- [`../../package.json`](../../package.json) is still a single root package that mixes the demo app, runtime implementation, and smoke entrypoints.
- [`../../src`](../../src) contains both public/demo UI code and runtime internals under one tree.
- [`../../scripts`](../../scripts) contains many `smoke:*` entrypoints that are not yet modeled as first-class workspace tasks.
- [`../../pnpm-workspace.yaml`](../../pnpm-workspace.yaml) does not yet define workspace packages; it only contains an `allowBuilds` override for `esbuild`.
- [`../../docs/roadmap-alignment.md`](../../docs/roadmap-alignment.md) already expects future split points such as `apps/demo`, `packages/mimic`, kernel/process/VFS/network packages, tooling packages, and affected test execution.

So the real decision is not whether the repo might someday have multiple projects. The roadmap already assumes it will. The decision is whether Nx is the right orchestration layer for that future split.

## Source set

Primary sources used here:

- Nx workspace/tutorial overview:
  - [Crafting Your Nx Workspace](https://nx.dev/docs/getting-started/tutorials/crafting-your-workspace)
- Nx project linking:
  - [TypeScript Project Linking](https://nx.dev/docs/concepts/typescript-project-linking)
- Nx task selection and caching:
  - [Run Only Tasks Affected by a PR](https://nx.dev/docs/features/ci-features/affected)
  - [Cache Task Results](https://nx.dev/docs/features/cache-task-results)
  - [How Caching Works](https://nx.dev/docs/concepts/how-caching-works)
  - [Remote Caching (Nx Replay)](https://nx.dev/docs/features/ci-features/remote-cache)
- Nx architecture boundaries:
  - [Enforce Module Boundaries](https://nx.dev/docs/features/enforce-module-boundaries)
  - [Project Dependency Rules](https://nx.dev/docs/concepts/decisions/project-dependency-rules)
- Nx packaging and release:
  - [Publishable and Buildable Nx Libraries](https://nx.dev/docs/concepts/buildable-and-publishable-libraries)
  - [Release TypeScript/JavaScript Packages to NPM](https://nx.dev/docs/guides/nx-release/release-npm-packages)
  - [Release Groups](https://nx.dev/docs/guides/nx-release/release-groups)
  - [Release Projects Independently](https://nx.dev/docs/guides/nx-release/release-projects-independently)
  - [nx.json Reference](https://nx.dev/docs/reference/nx-json)

## Source-backed findings

### 1. Nx fits this repository because it layers on top of the tools already in use

Nx's own workspace docs describe it as a task orchestrator, caching layer, and intelligence layer that works on top of the existing repo structure and existing tools rather than replacing the package manager, build tools, or test frameworks. The same docs also say Nx works with any repo structure and already builds on package-manager workspaces.

That matters here because this repository already has the toolchain pieces that Nx expects to sit above:

- `pnpm`
- `vite`
- `typescript`
- custom smoke scripts
- Playwright-based browser verification

The repo does not need a rewrite to adopt Nx. It needs task modeling and project boundaries.

Sources:

- [Crafting Your Nx Workspace](https://nx.dev/docs/getting-started/tutorials/crafting-your-workspace)

### 2. Nx's workspace-linking model matches the roadmap's future package direction

Nx documents two supported TypeScript project-linking strategies: package-manager workspaces and TypeScript path aliases. The docs say Nx has added full support for workspaces because they are now more common and because packages then resolve with native Node module resolution.

That is important for this repository because the runtime is explicitly trying to prove Node-compatible behavior. A future internal package graph that relies on real workspace packages is a better fit than a large root package with ad hoc path reach-throughs:

- package boundaries become visible in `package.json`
- external-consumer validation becomes more realistic
- `npm pack` and publish-dry-run checks become natural
- internal package resolution follows the same Node model the runtime is trying to emulate

Sources:

- [TypeScript Project Linking](https://nx.dev/docs/concepts/typescript-project-linking)
- [Crafting Your Nx Workspace](https://nx.dev/docs/getting-started/tutorials/crafting-your-workspace)

### 3. `nx affected` is directly aligned with the roadmap's planned compatibility-test scale

Nx documents that `nx affected -t <task>` uses Git plus the project graph to determine which projects changed and which dependent projects must rerun. This is exactly the missing control plane for the roadmap's future state, where the repo should stop running the full browser/runtime matrix on every change.

In this repository, the main future benefit is not the first migration day. It is what happens later when the codebase has:

- a public package
- kernel/process/VFS/network packages
- Vitest projects
- Playwright compatibility projects
- release/reporting tooling packages

Without a graph-aware task runner, each extra package and test lane increases CI cost linearly. With `affected`, changes to demo UI or docs do not need to force the full compatibility matrix by default.

Sources:

- [Run Only Tasks Affected by a PR](https://nx.dev/docs/features/ci-features/affected)

### 4. Nx caching is useful here only if tasks are modeled around real artifacts and real inputs

Nx caching is computation-based: it hashes task inputs and restores terminal output plus produced artifacts when the computation matches. Nx also documents that cache inputs are configurable and that remote caching shares results across developers and CI.

That is valuable for this repository, but only if the tasks are decomposed correctly. Some current root scripts are good cache candidates:

- package builds
- typecheck
- pure runtime contract tests
- deterministic fixture generation

Some tasks should be treated more carefully:

- browser tests with nondeterministic network timing
- tasks that depend on live registry state unless registry responses are pinned or cached
- tasks whose output includes machine-specific preview ports without normalization

So Nx caching is not an argument for blindly wrapping today's `smoke:*` scripts. It is an argument for redesigning them into stable targets with explicit inputs and outputs.

Sources:

- [Cache Task Results](https://nx.dev/docs/features/cache-task-results)
- [How Caching Works](https://nx.dev/docs/concepts/how-caching-works)
- [Remote Caching (Nx Replay)](https://nx.dev/docs/features/ci-features/remote-cache)

### 5. Nx gives the repo an enforceable dependency graph, not just a folder convention

Nx's boundary docs say project tags and dependency constraints can be enforced automatically, and the dependency-rules guide recommends a small number of clear library types so that dependency direction remains tractable.

That matters because this repository already has a roadmap requirement that demo/public/UI code must not reach into kernel internals and that lower runtime layers must not import preview/demo/framework-specific modules. Folder naming alone will not keep those boundaries intact once packages begin to multiply.

Nx can provide two concrete enforcement layers:

- import-linting for TypeScript/JavaScript boundaries
- project graph visibility so violations are reviewable and testable

The important point is that the repo should not migrate to `apps/*` and `packages/*` first and hope discipline follows later. Boundary rules need to be part of the migration itself.

Sources:

- [Enforce Module Boundaries](https://nx.dev/docs/features/enforce-module-boundaries)
- [Project Dependency Rules](https://nx.dev/docs/concepts/decisions/project-dependency-rules)

### 6. Nx release flows are a good fit for publishing `mimic` without forcing lock-step versioning everywhere

Nx release supports both fixed and independent versioning, and release groups allow different subsets of projects to have different release policies while still handling dependency updates across group boundaries.

That matches this repository's likely release shape better than a one-version-for-everything model:

- `packages/mimic` is the primary candidate for external publishing
- low-level internal packages may stay workspace-internal for a while
- tooling packages may need separate prerelease cadence
- test fixtures and demo app should not necessarily participate in npm release flows

This is especially relevant because the roadmap asks for future package publishing, provenance, prereleases, compatibility report links, and migration notes. Nx release already has the vocabulary for those release group boundaries.

Sources:

- [Release TypeScript/JavaScript Packages to NPM](https://nx.dev/docs/guides/nx-release/release-npm-packages)
- [Release Groups](https://nx.dev/docs/guides/nx-release/release-groups)
- [Release Projects Independently](https://nx.dev/docs/guides/nx-release/release-projects-independently)
- [nx.json Reference](https://nx.dev/docs/reference/nx-json)

### 7. Nx does not remove the need for repo-specific architecture decisions

The sources support adopting Nx, but they do not answer the most important repository-specific questions:

- which runtime layers deserve separate packages now versus later
- which browser tests are cacheable
- how preview/browser artifacts should be normalized for caching
- whether internal runtime packages should be buildable only or publishable
- when a package is mature enough to become part of the public API surface

So the future ADR still needs to define the package graph and migration sequence. Nx is the orchestration substrate, not the architecture itself.

## What this means for this repo

### Main conclusion

Nx is the right target for this repository's workspace migration.

The research did not identify a concrete blocker strong enough to justify choosing an alternative over Nx for the roadmap's stated needs:

- package publishing
- affected execution
- cache orchestration
- dependency graph enforcement
- future package growth

The correct recommendation is therefore:

1. adopt Nx;
2. keep `pnpm` workspaces as the package-linking base;
3. use Nx to model and enforce the runtime package graph;
4. defer the exact package split and release policy details to an ADR plus staged migration plan.

### Why not keep the current single-package layout?

Because the current layout already conflicts with roadmap goals:

- publishable runtime artifacts are coupled to app/demo code
- test evidence is modeled as root scripts rather than reusable project tasks
- future dependency boundaries are implicit
- external-consumer validation cannot be made trustworthy while everything is one package

### Why not choose a lighter tool instead?

Inference from the source set plus repo context:

- plain package-manager workspaces would give linking, but not graph-aware `affected`, task orchestration, or dependency-boundary enforcement
- a lighter task runner could handle caching or pipelines, but the roadmap explicitly asks for Nx and the repository already needs Nx-specific capabilities such as graph-aware affected execution and boundary tags

I did not find a source-backed reason to reject Nx in favor of a simpler alternative.

## Recommended target workspace shape

This section is an inference from the sources plus the roadmap.

### Initial workspace layout

- `apps/demo`
- `packages/mimic`
- `packages/kernel`
- `packages/process`
- `packages/vfs`
- `packages/module-loader`
- `packages/package-manager`
- `packages/virtual-network`
- `packages/shared-protocol`
- `packages/test-fixtures`
- `tools/` or `packages/tooling-*` for compatibility reporting, repo skills, and migration helpers

This is intentionally close to the roadmap, but it should be applied incrementally. Only `apps/demo` and `packages/mimic` look mandatory for the first move. Some lower-level packages may initially remain merged until their contracts are explicit.

### Suggested tag dimensions

- `scope:app`
- `scope:public-api`
- `scope:runtime`
- `scope:tooling`
- `scope:tests`
- `type:entry`
- `type:feature`
- `type:infra`
- `type:contract`

Example intended dependency direction:

- `scope:app` may depend on `scope:public-api`, selected `scope:tests`, and possibly thin fixture metadata, but not runtime internals directly
- `scope:public-api` may depend on runtime packages
- runtime packages may depend inward on lower-level runtime packages only
- tooling and test packages must not become hidden production dependencies

The future ADR should turn that into exact `depConstraints`.

## Recommended phased migration

### Phase 1. Introduce Nx without moving code

- add `nx`, `nx.json`, and task modeling around the existing root package
- wrap current build/typecheck/smoke commands as named Nx targets
- use inferred tasks where they reduce config, but keep explicit targets where cache inputs/outputs need tight control

Goal: get graph-aware task execution and cache control before large file moves.

### Phase 2. Split the demo app from the publishable runtime

- move UI/browser demo into `apps/demo`
- move supported public API plus browser entrypoints into `packages/mimic`
- keep internal runtime code reachable only through explicit package exports

Goal: establish the first hard boundary that the roadmap already requires.

### Phase 3. Extract runtime internals only where contract boundaries are proven

Recommended early candidates:

- shared protocol types
- kernel/process boundary
- VFS
- package-manager/registry/cache logic

Not every file needs to become a package immediately. Nx should help stage the split, not encourage speculative fragmentation.

### Phase 4. Promote tests and compatibility reporting into workspace-native targets

- turn Vitest and Playwright suites into project targets
- make compatibility reporting a first-class tooling project
- use `nx affected` to limit the default CI lanes
- add remote cache only after the tasks are deterministic enough to trust

### Phase 5. Add release groups only when there is something real to release

- publish `packages/mimic` first
- keep internal packages workspace-private unless a genuine consumer need emerges
- use fixed or independent release groups based on actual coupling, not aesthetics

## Concrete roadmap impact

This research most directly informs:

- section 12: testing architecture and future Nx-affected CI lanes
- section 14: dependency direction and architecture conformance
- section 15: installable packages and Nx workspace infrastructure

## Decisions the ADR should lock next

The research narrows the ADR scope to these concrete choices:

1. exact first-step package graph
2. tag taxonomy and dependency constraints
3. which tasks are cacheable on day one
4. whether internal packages are buildable-only or publishable
5. fixed versus independent release strategy for the first public package set
6. migration order that preserves compatibility evidence throughout the split

## Recommended next actions

1. Create the ADR that selects Nx and defines the first package graph.
2. Add Nx in place without moving files yet.
3. Model `build`, `typecheck`, and the most stable smoke/browser suites as Nx targets.
4. Split `apps/demo` and `packages/mimic` before any deeper runtime extraction.
5. Add boundary tags and forbidden-import rules as part of the split, not after it.
