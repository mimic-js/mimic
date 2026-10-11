# Working on Mimic

Mimic runs Node.js programs, package managers and dev servers inside a browser
tab. This file is the short orientation for AI coding agents; humans can read
it too.

## Layout

- `packages/runtime`: the published `@mimic-js/mimic` package (runtime source
  in `src/runtime`, tests in `tests/unit` and `tests/e2e`, build and check
  scripts in `scripts/`). Its `README.md` is the consumer guide.
- `apps/`: consumers of the built package. `apps/site` is the site: the
  landing page, the documentation (Markdown under `src/docs/`) and the
  playground (`/playground`), which opens a GitHub repository or a demo
  application in an editor with a terminal. `apps/e2e-demo` is the demo
  application the Playwright suite drives.
- The root is a pnpm workspace run by Nx; its scripts delegate to the projects.

## Where things are decided

- `CONTEXT.md`: the domain glossary. Use its terms in code, tests and docs,
  and avoid the terms each entry lists under _Avoid_.
- `docs/adr/`: accepted architecture decisions. Read the relevant ADR before
  changing a boundary it covers; supersede it with a new ADR rather than
  silently reintroducing a rejected approach.
- `docs/README.md`: the documentation map, including which ADRs cover which
  area. Use it to pick the smallest set of documents to read; do not read all
  of `docs/`.
- `docs/compatibility-status.md`: the rules a Compatibility Claim follows.
  Compatibility is proved only by positive co-located Playwright claims.

## Verifying a change

From the repository root:

- `pnpm run test:build`: build and typecheck every project.
- `pnpm run test:unit`: Vitest unit tests of the runtime.
- `pnpm run test:e2e`: Playwright browser tests of the runtime, including the
  Compatibility Claims.
- `pnpm run package:check`: build the package and check what it publishes.

Run a single Playwright spec or Vitest file from `packages/runtime`, for
example `pnpm exec playwright test tests/e2e/mimic-filesystem.spec.ts`.

## Ground rules

- Runtime modules stay package-agnostic: package knowledge belongs only in the
  declarative Browser Package Replacement map, never in a branch on a package,
  tool or framework name.
- A failing workload is not fixed by weakening its claim, adding a
  package-specific adapter, or falling back to synthetic behavior; see the
  fallback policy in `docs/roadmap-alignment.md`.
- Keep links repository-relative and never commit workstation paths.
