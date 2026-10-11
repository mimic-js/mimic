---
status: accepted
amends: ADR-0021 (what a `packageManager` field naming another version does)
---

# Run the package-manager release a project asks for

ADR-0021 made a project whose `packageManager` field names another version
of the same manager fail with one message naming the pinned version. In the
[demo pool](../research/2026-10-09-demo-app-pool.md) that stopped three
otherwise ordinary projects before their install: two SvelteKit and Next.js
examples asking for pnpm 10, and the Nx examples asking for Yarn 4.15.0. The
version a project pins is the one its lockfile and scripts were written for,
and Corepack, which these fields are written for, installs it.

## Decision

**The Command Proxy runs the release the project asks for, installed from
the npm registry the way Corepack installs it.** The pinned release stays
the default and the only one used when no field asks otherwise.

- The field is read as Corepack reads it, from the nearest `package.json`
  that names it: `<manager>@<exact version>[+<algorithm>.<hex>]`. A field
  naming another manager, or the pinned version, changes nothing. One
  naming a range or a hash algorithm Web Crypto does not offer fails with
  one message.
- The release's package is `npm`, `pnpm`, `yarn` for Yarn 1, and
  `@yarnpkg/cli-dist` for every later Yarn. Its tarball comes through the
  Package Artifact Cache and is verified against the integrity the registry
  states for that version on every use (ADR-0021's rule for replacement
  artifacts), then mounted under `/.mimic/toolchains/<manager>/<version>`.
- A Corepack hash is checked too. It matches either the archive or, as
  Corepack hashes a Yarn release it fetched as one file, that release's bin
  script.
- The command runs the script the release's own `bin` names for it (the
  manager's main script when the release has no such command), with the
  pinned release's environment defaults, and its install is followed by the
  Browser Package Replacements as any other. Yarn 1 records an install in
  `node_modules/.yarn-integrity`.
- A release that cannot be installed (unpublished, unreachable, a hash or
  integrity mismatch) fails the command with one message naming it; the
  pinned release does not run in its place.

## Consequences

- A project pinned to an older release runs that release, which may need
  Node or browser APIs the pinned one does not; its failures are found by
  running it, not by refusing it up front.
- The first command in such a project downloads one more tarball; later
  ones in the same Runtime Host reuse the mounted release.
