# Documentation map

Use the smallest document set that answers the question at hand. The documents
here have different authority and freshness, and reading all of `docs/` is both
expensive and misleading.

## Repository layout

The repository is a pnpm workspace run by Nx
([ADR-0027](./adr/0027-split-the-runtime-package-from-the-documentation-application.md)):

- `packages/runtime`: the published `@mimic-js/runtime` package. Paths in ADRs
  and research notes that start with `src/runtime`, `tests/`, `scripts/`,
  `architecture/` or `compatibility/` are relative to it, and Playwright and
  Vitest commands run from it. Its
  [`README.md`](../packages/runtime/README.md) is the consumer guide: boot
  options, bundler integration and the headers a page needs.
- `apps/site`: the site, a consumer of the built package. `/` is the landing
  page; `/docs/installation`, `/docs/api` and `/docs/faq` render the
  Markdown of `src/docs/`;
  `/playground?repo=owner/name` (optional `&ref=`) opens a
  public GitHub repository in an editor with a terminal over one `Mimic`, and
  `/playground?example=<id>` one of the demo-pool applications listed in
  `src/playground/examples.ts`, with the terminal in its directory and its
  commands typed. `pnpm run dev` starts it; [`deploying.md`](./deploying.md)
  covers its Vercel deployment.
- `apps/e2e-demo`: the demo application the Playwright suite starts beside
  the test host as the package's browser witness, also a consumer of the
  built package. `pnpm run dev:e2e-demo` starts it.
- the root: [`CONTEXT.md`](../CONTEXT.md), [`AGENTS.md`](../AGENTS.md),
  `.github/` (CI), and scripts that delegate to the projects.

## Verifying a change

From the repository root:

| Command | What it runs |
| --- | --- |
| `pnpm run test:build` | build and typecheck of every project |
| `pnpm run test:unit` | the runtime's Vitest unit tests (`packages/runtime/tests/unit/`) |
| `pnpm run test:e2e` | the runtime's Playwright browser tests (`packages/runtime/tests/e2e/`), which include every Compatibility Claim |
| `pnpm run package:check` | builds the package and checks what it would publish |

To run one spec or a subset, run Playwright or Vitest from `packages/runtime`,
for example `pnpm exec playwright test tests/e2e/mimic-filesystem.spec.ts`.

## Authority order

When two sources disagree, use this order:

1. current code and maintained test output;
2. accepted ADRs in [`adr/`](./adr/);
3. [`roadmap-alignment.md`](./roadmap-alignment.md) for direction and the
   evidence rules;
4. dated research notes, for design context only.

If a lower source contradicts a higher one, fix the lower source; do not keep
both as an undocumented compatibility branch.

## What to read

| Situation | Reading |
| --- | --- |
| Domain vocabulary | [`../CONTEXT.md`](../CONTEXT.md) |
| Headless runtime architecture | [`../CONTEXT.md`](../CONTEXT.md), [ADR-0015](./adr/0015-simplify-browsercontainer-runtime-architecture.md) and [ADR-0029](./adr/0029-move-runtime-behaviour-to-its-owner-and-keep-the-module-graph-in-documents.md) for ownership and the documented module graph, with [ADR-0019](./adr/0019-express-cross-context-calls-as-one-typed-rpc.md) for messaging between contexts, [ADR-0020](./adr/0020-run-runtime-programs-in-the-runtime-host-worker.md) for which context runs what, [ADR-0031](./adr/0031-keep-one-process-worker-ahead-of-demand.md) for the spare process worker, and [ADR-0022](./adr/0022-remove-vfs-transactions.md) for the Virtual File System's one mutable state; [ADR-0023](./adr/0023-compile-once-with-babel-and-a-shared-compile-cache.md) for module compilation and the Compile Cache, with [ADR-0034](./adr/0034-bundle-the-compiler-from-babels-packages.md) for where the compiler worker takes Babel from; [ADR-0024](./adr/0024-deliver-published-http-as-structured-requests.md) for how published HTTP reaches a listener and where HTTP/1 framing remains; [ADR-0025](./adr/0025-use-one-synchronous-channel.md) for the one synchronous channel (VFS mailbox, synchronous children, WASI stdin, `receiveMessageOnPort`) and how `worker_threads` messages travel, [ADR-0036](./adr/0036-carry-a-forked-process-ipc-channel-over-the-port-relay.md) for the IPC channel of a forked process, [ADR-0037](./adr/0037-route-a-documents-loopback-requests-to-its-containers-ports.md) for a published document's requests to other loopback ports of its container, [ADR-0038](./adr/0038-serve-a-published-websocket-from-its-process-worker.md) for how a published WebSocket travels between its document and the process worker that serves it; [ADR-0003](./adr/0003-enforce-headless-runtime-module-boundaries.md) is superseded history |
| Workspace layout, package dependencies, bundler integration, consumer headers | [ADR-0027](./adr/0027-split-the-runtime-package-from-the-documentation-application.md), [ADR-0030](./adr/0030-scope-the-service-worker-to-the-endpoints-directory.md) for the Service Worker's scope and `endpoints.fetch()`, [ADR-0032](./adr/0032-serve-published-endpoints-from-a-preview-origin.md) for the preview origin, [ADR-0033](./adr/0033-run-the-runtime-host-in-a-frame-of-the-preview-origin.md) for the Runtime Host document on that origin and what that changes for assets and headers, [ADR-0044](./adr/0044-serve-each-published-endpoint-from-an-origin-of-its-own.md) for a wildcard preview origin that serves each endpoint from the root of an origin of its own, and [`../packages/runtime/README.md`](../packages/runtime/README.md) |
| The identity a program reads (`process.platform`, `process.arch`, the Node version, `process.versions.webcontainer`) | [ADR-0016](./adr/0016-report-the-profile-identity-from-process.md), [ADR-0039](./adr/0039-report-linux-as-the-node-platform.md) for `linux`, [ADR-0045](./adr/0045-report-the-webcontainer-runtime-version.md) for the WebContainer marker and the branches it selects |
| Node builtins (which are maintained ports, which are runtime-owned, how a port is wired) | [`../CONTEXT.md`](../CONTEXT.md) and [ADR-0026](./adr/0026-take-pure-node-builtins-from-maintained-ports.md) |
| Package management (Command Proxies, pinned CLIs, Browser Package Replacements, WASI companions of NAPI-RS packages) | [`../CONTEXT.md`](../CONTEXT.md), [ADR-0021](./adr/0021-reduce-package-management-to-a-pinned-cli-and-a-replacement-map.md) and [ADR-0028](./adr/0028-install-wasi-bindings-as-companions-from-napi-metadata.md), [ADR-0035](./adr/0035-repair-shipped-napi-wasi-loaders-from-their-module.md) for a shipped WASI loader generated by another build than its module |
| Security of the runtime against an untrusted project | [`research/2026-10-06-runtime-security-audit.md`](./research/2026-10-06-runtime-security-audit.md) for the findings and their status, [ADR-0032](./adr/0032-serve-published-endpoints-from-a-preview-origin.md) for the preview origin, [ADR-0033](./adr/0033-run-the-runtime-host-in-a-frame-of-the-preview-origin.md) for the Runtime Host document on that origin |
| Whether a stack works, and how to add a claim | [`compatibility-status.md`](./compatibility-status.md) for the evidence contract, then the co-located claim in `packages/runtime/tests/e2e/` and its latest CI result |
| Releasing a version of `@mimic-js/runtime` | [`releasing.md`](./releasing.md): `nx release`, conventional commits, the Release workflow and the secrets it needs |
| Deploying the site (Vercel, headers, the preview origin's domains) | [`deploying.md`](./deploying.md) |
| Historical design rationale | The relevant file under [`research/`](./research/), after reading its [snapshot rules](./research/README.md) |

## Document classes

- [`adr/`](./adr/): the accepted-decision log, numbered in order. An ADR is
  superseded explicitly by a later one, never edited into a different
  decision. Numbers are never reused; 0001, 0002, 0005 and 0006 recorded the
  retired development process and were removed.
- [`compatibility-status.md`](./compatibility-status.md): the compatibility
  evidence contract; never a live status table.
- [`roadmap-alignment.md`](./roadmap-alignment.md): the runtime target, the
  evidence bar and the capability areas in dependency order; never a
  completed-work log.
- [`releasing.md`](./releasing.md): how versions, changelogs and npm
  publishes are produced.
- [`deploying.md`](./deploying.md): how the site is deployed.
- [`research/`](./research/): dated snapshots. Source-backed findings can remain
  useful, but repository-specific "current state" statements age immediately.

## Maintenance rules

- Prefer links to code and tests over repeating completion history.
- Name transitional fallbacks and quarantines with an owner, a deletion
  condition, and their proof limitation.
- Remove obsolete instructions instead of keeping "old mode" branches.
- Use repository-relative links; never commit workstation or worktree paths.
