# Research: native package managers at the Browser Package Replacement Catalog seam

> Snapshot note: source findings and dated evidence are retained, but repo-specific
> “current state” statements may become obsolete. Verify them against current code,
> maintained tests, and
> [`compatibility-status.md`](../compatibility-status.md). See the
> [research status rules](./README.md).

Date: 2026-07-18

## Question

Can maintained npm, pnpm, and Yarn JavaScript CLIs run through the generic
Mimic runtime while consuming Browser Package Replacement Catalog
decisions during registry/artifact resolution, without corrupting lockfile,
integrity, lifecycle-script, or dependency-layout semantics? Which native or
host assumptions block them, and what evidence decides when the shared
package-installation interface must use a first-party installer?

This note resolves
Evaluate native npm, pnpm, and Yarn against browser package replacement (#230).
It is a planning decision, not a compatibility claim or implementation.

## Decision

Use one deep **Package Installation** module whose interface selects a pinned
package-manager adapter and returns a manager-neutral install receipt. Keep
resolution policy in one internal **Catalog Resolution** module. The adapters
must consume the Catalog result *before linking/materialisation* and must let the
selected manager continue to own its lockfile, integrity verification,
lifecycle scheduling, and layout.

Select the adapters as follows:

- **npm: first-party installer for now.** Mimic's `npm` command is a
  first-party lockfile/materialisation implementation, not the upstream npm CLI.
  There is no maintained browser proof for the upstream CLI, npm exposes no
  supported resolver/fetcher plugin seam equivalent to pnpm or Yarn, and current
  npm 12 requires Node `^22.22.2 || ^24.15.0 || >=26.0.0` while the runtime
  advertises Node `22.13.0`. npm root `overrides` and a synthetic registry are
  useful experiments but do not satisfy the full Catalog contract.
- **pnpm 11: native CLI candidate, conditional on a Catalog resolver/fetcher
  adapter and generic transaction semantics.** The upstream JavaScript CLI
  already executes a representative exact workspace install in Chromium.
  pnpm 11 provides supported custom resolvers and fetchers at the required
  seam. Do not promote this adapter while `WorkerNodeCommand` detects pnpm by
  filename and parses its install arguments to obtain atomic mutation behavior;
  that package-manager identity branch violates the map's generic-runtime rule.
- **Yarn 4: native CLI candidate, conditional on a runtime-supplied Catalog
  plugin.** Exact Yarn 4.17.1 already runs both `node-modules` and PnP/ZipFS
  fixtures in Chromium. Yarn plugins can register resolver and fetcher classes,
  and `reduceDependency` can change descriptors during resolution. Supply the
  pinned plugin through Yarn's documented dynamic plugin mechanism rather than
  editing the user's `.yarnrc.yml`. Prove `node-modules` and PnP independently.

The first-party npm adapter and the native pnpm/Yarn adapters are real adapters
at one seam; the variation is therefore justified. Do not hide the differences
behind post-install rewriting, and do not make the generic runtime branch on a
manager or package name.

## Why registry interception alone is not the seam

All three managers can point at a registry, so a Mimic-owned registry
facade may still be a useful transport and observation mechanism. It is not, by
itself, a semantics-preserving replacement interface:

1. Returning the replacement tarball unchanged preserves its upstream
   integrity, but the archive still contains the replacement package's name,
   entrypoints, dependencies, bins, and lifecycle scripts. Those may not satisfy
   the logical package identity requested by dependants.
2. Repacking or mutating that archive can project the logical identity, but now
   produces different bytes. The effective artifact needs its own digest and
   must not be reported as the untouched publisher artifact.
3. A stock registry packument has no Browser Package Replacement Catalog
   provenance contract. A manager may discard unknown metadata when it writes
   its lockfile.
4. Layout is decided after resolution and fetch. Rewriting `node_modules`, a
   pnpm virtual store, Yarn cache zips, `.pnp.cjs`, or install state after that
   point bypasses the manager's graph and checksum model.

The supported resolver/fetcher seams in pnpm and Yarn solve these problems in
the correct order. A registry facade may carry bytes, but Catalog selection and
provenance remain inputs to the adapter.

## Required internal contract

The exact TypeScript shape is an implementation decision, but every adapter
needs the equivalent of this result from the Catalog Resolution module:

```ts
type EffectivePackageResolution = Readonly<{
  requested: { name: string; range: string; selectedVersion: string };
  artifact: {
    packageName: string;
    version: string;
    url: string;
    publisherIntegrity: string;
    effectiveIntegrity: string;
  };
  logicalIdentity: {
    installName: string;
    manifestProjection: 'unchanged' | 'catalog-projected';
  };
  lifecyclePolicy: 'replacement-manifest' | 'disabled-by-catalog';
  provenance: { catalogId: string; catalogVersion: number; entryDigest: string };
}>;
```

`publisherIntegrity` and `effectiveIntegrity` may be equal when the adapter uses
the unmodified replacement artifact. They must differ when it projects a new
manifest or repacks content. The lockfile or a manager-owned sidecar must bind
the logical request, effective locator, effective integrity, and Catalog entry
digest. The install receipt must retain both identities even if a manager's
lockfile format cannot store all provenance fields.

The Package Installation interface should be smaller than the individual CLI
surfaces. Callers should provide project root, pinned manager/version, virtual
platform, immutable/frozen mode, lifecycle policy, and Catalog revision; the
module returns the exact graph/install receipt or a named failure. Command-line
flags and manager-specific files stay inside each adapter's implementation.

## Manager findings

### npm

#### What is proved locally

The public `spawn('npm', ...)` path constructs [`NpmCommand`](../../src/runtime/npm-client.ts),
which reports `10.0.0-mimic` and invokes the repository's
[`installFromLockfile`](../../src/runtime/lockfile-installer.ts). That installer
resolves Catalog entries, fetches the replacement tarball, validates its
integrity, writes it at the logical package path, projects the logical name into
the extracted manifest, records provenance, and rolls back `node_modules` on
failure. It is useful first-party installer evidence, not evidence that the
upstream npm CLI runs in Mimic.

The maintained npm workspace test proves the first-party npm command's workspace
links, bins, scripts, failure behavior, and reboot. The compatibility scoreboard
correctly describes package installation as Partial; the roadmap identifies the
current npm implementation as custom.

#### Upstream seam and blockers

npm documents root-only `overrides`, including replacing a dependency with an
`npm:` alias to another package. This can express some Catalog choices, but it
is not a complete adapter:

- overrides live in the root project manifest; injecting them mutates user
  policy unless Mimic implements a process-private manifest view;
- npm restricts overrides of direct dependencies unless their specs match;
- the override does not define Mimic's manifest projection,
  lifecycle policy, Catalog revision, dual integrity, or receipt provenance;
- npm has no documented supported custom resolver/fetcher plugin interface that
  can be pinned and injected independently of the project.

Current upstream npm 12.0.1 also cannot honestly run against the advertised
virtual Node profile: its engine starts at Node 22.22.2 while Mimic
advertises 22.13.0. npm bundles a broad Node-oriented implementation including
Arborist, pacote, cacache, `@npmcli/run-script`, `node-gyp`, git/process helpers,
filesystem links, and HTTP/TLS machinery. `node-gyp`, git dependencies, shell
commands, and host executables are named unsupported modes unless the generic
runtime supplies their behavior; their presence does not by itself prevent
registry-only JavaScript installs.

**Conclusion:** retain the first-party npm adapter. Reconsider upstream npm only
after the platform profile satisfies its pinned engine and a prototype proves a
non-mutating pre-link Catalog seam with replayable provenance. A maintained npm
major without such a seam is not preferable merely because its CLI starts.

### pnpm

#### What is proved locally

[`mimic-pnpm-exact-workspace.spec.ts`](../../tests/e2e/mimic-pnpm-exact-workspace.spec.ts)
installs and runs the official `pnpm@11.11.0` JavaScript CLI through the generic
`node` command in Chromium. It proves aliases, peers, platform optionals,
workspace links/bins/realpaths, a content store, cold and offline installs,
integrity failure, lifecycle ordering, atomic failure, teardown, and reboot for
locally generated fixture packages.

That proof has two important limits:

- the manager binary is bootstrapped through the first-party npm installer;
- the package graph uses test registry metadata and generated tarballs and does
  not contain a Catalog replacement.

It also depends on a forbidden transitional shortcut:
[`WorkerNodeCommand`](../../src/runtime/worker-node-command.ts) recognizes pnpm
entry filenames, parses pnpm 11.11.0 options, buffers all filesystem mutations,
and commits them only on exit zero. Native pnpm cannot be the selected adapter
until transactionality comes from the shared process/VFS/package-installation
interface rather than manager identity.

#### Upstream seam and blockers

pnpm 11's `.pnpmfile.mjs` contract is the strongest direct fit:

- a custom resolver converts a wanted dependency into a lockfile resolution;
- that resolution may contain the replacement tarball URL and integrity or a
  custom resolution type;
- a custom fetcher can supply the effective files and manifest to pnpm's
  content-addressable store;
- custom resolvers run before built-in resolvers;
- `afterAllResolved` can validate or extend the serialized lockfile.

Use a runtime-supplied, pinned pnpmfile owned by the pnpm adapter. Its custom
locator/reference must include the Catalog entry digest so a changed Catalog
invalidates a frozen result. Let pnpm calculate the content-addressable store,
virtual store, hardlink/copy choice, peer suffixes, symlinks, bins, and lifecycle
plan from the effective package.

Do not rely only on `readPackage`: pnpm explicitly documents that removing
scripts there does not prevent a dependency build, because build execution
reads the archive's `package.json`. The resolver/fetcher must therefore select
the replacement artifact and effective manifest before pnpm decides
`requiresBuild`; Catalog lifecycle policy is then enforced through the fetched
artifact and pnpm's build controls.

The maintained pnpm 11.14.0 JavaScript package declares Node `>=22.13`, which
matches the current virtual version. Its source bundle includes host-oriented
paths such as `node-gyp`, process inspection, and reflink acceleration. These
must fail clearly or use generic fallbacks when exercised. The existing 11.11.0
browser proof shows they are not startup blockers for the covered registry,
workspace, and lifecycle path.

**Conclusion:** choose an upstream pnpm 11 adapter after a Catalog-plugin proof
and deletion of pnpm-name-based transaction logic. Revalidate the exact current
maintained 11.x release rather than promoting the older 11.11.0 fixture by
inference.

### Yarn

#### What is proved locally

[`mimic-yarn-node-modules-workspace.spec.ts`](../../tests/e2e/mimic-yarn-node-modules-workspace.spec.ts)
runs official `@yarnpkg/cli-dist@4.17.1` with the `node-modules` linker and proves
workspaces, links/realpaths, peers, bins, topological scripts, cache reuse,
immutable repeat, atomic failure, teardown, and reboot.

[`mimic-yarn-pnp-zipfs.spec.ts`](../../tests/e2e/mimic-yarn-pnp-zipfs.spec.ts)
separately proves Yarn 4.17.1 PnP/ZipFS, generated CommonJS and ESM loader hooks,
external PnP data, dependency-edge-aware resolution from immutable cache zips,
undeclared-dependency failure, immutable repeat, failure without loader
mutation, teardown, and reboot.

Those fixtures bootstrap Yarn through the first-party npm installer and use
local `file:`/workspace payloads; they do not prove arbitrary registry graphs or
Catalog replacement. The `node-modules` fixture's platform-optionals observation
also must not be generalized to publisher registry packages.

#### Upstream seam and blockers

Yarn's plugin interface can register resolver and fetcher classes. A resolver
turns descriptors into locators and full package definitions that are stored in
the lockfile; a fetcher supplies the package filesystem and checksum input. The
`reduceDependency` hook can replace a descriptor during resolution. Yarn also
documents `YARN_PLUGINS`, allowing the adapter to load a pinned plugin without
editing `.yarnrc.yml`.

Use a dedicated Catalog protocol/locator whose reference binds the logical
identity, selected replacement, and Catalog entry digest. The resolver returns
the replacement's effective dependency metadata under the logical locator; the
fetcher verifies and supplies the effective payload. Then Yarn's selected linker
owns either `node_modules` or PnP/ZipFS, and its cache checksum covers the bytes
it actually uses.

Yarn's lifecycle policy is materially different from npm's: current Yarn 4
disables dependency postinstalls by default unless scripts are enabled globally
or per package. The adapter must make that explicit in the install request and
receipt. A Catalog replacement cannot silently inherit whichever setting the
test harness happened to use.

The bundled Yarn CLI and its libzip/WASM path already execute in the maintained
fixtures, so native code is not the immediate blocker. Unsupported external git,
shell, host executable, or arbitrary native-addon paths remain named negative
modes. PnP additionally requires the maintained loader and ZipFS semantics; it
is a distinct adapter mode, not evidence for `node-modules` or vice versa.

**Conclusion:** choose an upstream Yarn 4 adapter after a runtime-injected
Catalog plugin passes registry replacement evidence in both linker modes. Keep
Yarn's resolver/fetcher/plugin code inside the package-installation adapter;
generic loader/VFS/process modules must consume only generic outputs.

## Semantic invariants for every adapter

### Lockfile

- The manager writes and subsequently consumes its native lockfile.
- A Catalog change invalidates immutable/frozen reuse through a stable effective
  locator or an adapter-owned policy digest, not through post-processing.
- The logical request and effective replacement remain distinguishable.
- A second immutable install makes no lockfile or install-state mutation.

### Integrity and cache

- Verify the publisher replacement tarball before use.
- Verify the effective bytes after any manifest projection; never label projected
  bytes with the original publisher integrity.
- Cache keys include manager/version, virtual platform, Catalog revision and
  entry digest, logical/effective locator, and effective content digest.
- Tampering, a missing declared WASM/Worker asset, or a stale Catalog selection
  fails closed before link/build.

### Lifecycle scripts

- The original native package's install scripts never run after replacement.
- Replacement scripts run only under explicit Catalog and manager policy.
- Script environment, bin/PATH construction, topological order, exit status,
  signals, descendants, and rollback are owned by generic process/VFS behavior.
- Native compilation, Python, git, shell, or OS executable requests fail with a
  named capability error unless a generic runtime capability supports them.

### Dependency layout

- npm owns its Arborist tree/hoisting, pnpm owns its store/virtual-store/links,
  and Yarn owns its selected linker and PnP loader artifacts.
- Catalog selection occurs before those layout decisions.
- Logical imports, package self-references, bins, peers, aliases, optionals,
  workspaces, symlink/realpath behavior, and assets resolve to the effective
  package without a loader package-name branch.
- Failed installation leaves the previous graph, cache metadata, lockfile, and
  generated loader state coherent.

## Evidence gate for native selection

A native adapter is selected only after an A-grade public-API Chromium receipt
for the exact manager/version and each claimed linker mode proves all of the
following in one deterministic locally served registry graph:

1. The manager CLI itself is installed from an integrity-pinned publisher
   artifact and runs through the generic Execution Context.
2. A logical native package resolves through an approved Catalog entry to an
   exact browser/WASM replacement before materialisation.
3. Registry and tarball observations show both the logical metadata decision and
   the exact replacement payload; forbidden native artifacts are never fetched,
   cached, linked, or executed.
4. The manager's lockfile, cache/install state, materialised manifest or PnP
   package definition, and receipt agree on logical identity, effective
   identity, version, Catalog digest, and effective integrity.
5. Cold install, offline/warm install into a fresh VFS, immutable/frozen repeat,
   teardown, and clean reboot execute the replacement's claimed behavior.
6. A lifecycle-bearing replacement proves the explicit script policy and
   ordering. A native-script sentinel proves the original script cannot run.
7. Required peers, conflicting nested peers, aliases, platform optionals,
   workspaces, bins, and manager-specific realpath/layout semantics survive the
   replacement.
8. Corrupt tarball, stale Catalog digest, missing replacement version/asset,
   peer conflict, script failure, and interrupted install fail atomically and
   retain the previous graph.
9. A forbidden-fallback scan finds no custom command registry, placeholder bin,
   host Node execution, post-install rewrite, manager-name transaction branch,
   or package-name loader/runtime branch.

Run the npm, pnpm, Yarn `node-modules`, and Yarn PnP receipts independently. A
passing adapter may be selected without waiting for the others; it does not
promote another manager or linker by analogy.

## First-party installer decision rule

Use the first-party installer for a manager/mode whenever any of these remains
true after a bounded adapter prototype:

- no supported pre-link resolver/fetcher seam can consume the Catalog without
  mutating user policy files;
- the manager cannot serialize and replay a Catalog-bound effective locator
  under immutable/frozen install;
- its checksum/cache model cannot bind the effective bytes after logical
  manifest projection;
- the original native package's lifecycle can still run, or replacement
  lifecycle policy cannot be made explicit;
- correct layout requires rewriting manager output after link;
- success depends on direct OS-native binaries, raw host networking, unsupported
  Node internals, or package-manager identity branches in generic modules;
- atomic failure, teardown, and reboot cannot be proved through the shared
  process/VFS interface.

This is a semantic rule, not a preference for custom code. Conversely, once a
native adapter satisfies every invariant and evidence item, keeping a parallel
first-party implementation for that same mode would reduce locality and create
two authorities for lockfile/layout behavior; delete it for that mode.

## Surfaced follow-up decisions

These are recommendations for the parent map, not tickets created by this
research session:

1. Prototype a manager-neutral `EffectivePackageResolution` plus receipt schema,
   then exercise it with one exact `esbuild -> esbuild-wasm` graph.
2. Prototype pnpm 11 custom resolver/fetcher injection and prove the Catalog
   digest survives frozen/offline reuse.
3. Prototype a dynamically injected Yarn 4 resolver/fetcher plugin for both
   `node-modules` and PnP; decide how the logical locator and projected manifest
   appear in `yarn.lock`, cache filenames, and `.pnp.data.json`.
4. Decide the generic VFS transaction interface that removes
   `isPnpmInstall`/pnpm option parsing from `WorkerNodeCommand`.
5. Keep upstream npm behind the first-party adapter until a narrow prototype
   either finds a supported non-mutating seam or records that npm overrides plus
   registry transport cannot meet the receipt contract.

## Sources

### Repository evidence

- [`CONTEXT.md`](../../CONTEXT.md)
- [`browser-package-policy.ts`](../../src/runtime/browser-package-policy.ts)
- [`lockfile-installer.ts`](../../src/runtime/lockfile-installer.ts)
- [`npm-client.ts`](../../src/runtime/npm-client.ts)
- [`worker-node-command.ts`](../../src/runtime/worker-node-command.ts)
- [`virtual-platform.ts`](../../src/runtime/virtual-platform.ts)
- [`mimic-npm-workspace.spec.ts`](../../tests/e2e/mimic-npm-workspace.spec.ts)
- [`mimic-pnpm-exact-workspace.spec.ts`](../../tests/e2e/mimic-pnpm-exact-workspace.spec.ts)
- [`mimic-yarn-node-modules-workspace.spec.ts`](../../tests/e2e/mimic-yarn-node-modules-workspace.spec.ts)
- [`mimic-yarn-pnp-zipfs.spec.ts`](../../tests/e2e/mimic-yarn-pnp-zipfs.spec.ts)
- [`compatibility-status.md`](../compatibility-status.md)
- [`roadmap-alignment.md`](../roadmap-alignment.md)

### Upstream primary sources

- [npm package manifest and engine requirements](https://github.com/npm/cli/blob/7b1f6c173d17b3bf30e45426f6df39473c6a1163/package.json)
- [npm `package.json` documentation: overrides, scripts, `gypfile`, OS and CPU](https://docs.npmjs.com/files/package.json/)
- [npm lifecycle-script ordering](https://docs.npmjs.com/cli/using-npm/scripts/)
- [pnpm 11 `.pnpmfile.mjs` hooks, custom resolvers and custom fetchers](https://pnpm.io/pnpmfile)
- [pnpm 11.14.0 JavaScript CLI manifest and engine](https://github.com/pnpm/pnpm/blob/aeaaccba51e5c5ada0c143d257db4ee6ff368903/pnpm11/pnpm/package.json)
- [Yarn plugin tutorial and dynamic `YARN_PLUGINS`](https://yarnpkg.com/advanced/plugin-tutorial)
- [Yarn plugin type: resolver and fetcher registration](https://github.com/yarnpkg/berry/blob/7744e6678de126a2ca2398d4123e3f7e009256b8/packages/yarnpkg-core/sources/Plugin.ts)
- [Yarn fetcher result and checksum contract](https://github.com/yarnpkg/berry/blob/7744e6678de126a2ca2398d4123e3f7e009256b8/packages/yarnpkg-core/sources/Fetcher.ts)
- [Yarn resolver interface and lockfile model](https://yarnpkg.com/api/yarnpkg-core/interface/Resolver)
- [Yarn core hooks, including `reduceDependency`](https://yarnpkg.com/api/yarnpkg-core/interface/Hooks)
- [Yarn install phases, immutable/cache validation, and build step](https://yarnpkg.com/cli/install)
- [Yarn linker modes](https://yarnpkg.com/features/linkers)
- [Yarn lifecycle security policy](https://yarnpkg.com/features/security)
- [Yarn 4.17.1 CLI manifest](https://github.com/yarnpkg/berry/blob/7744e6678de126a2ca2398d4123e3f7e009256b8/packages/yarnpkg-cli/package.json)

The two accepted repository ADRs govern issue-queue ownership and verification
flow. They do not choose a package-manager implementation or weaken the
compatibility evidence gate.
