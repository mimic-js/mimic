# Research: upstream npm execution and pre-materialisation browser replacement

> Snapshot note: source findings and dated evidence are retained, but repo-specific
> “current state” statements may become obsolete. Verify them against current code,
> maintained tests, and
> [`compatibility-status.md`](../compatibility-status.md). See the
> [research status rules](./README.md).

**Date:** 2026-07-18  
**Repository revision:** [`7538f79d81b51e1da39045d91d8115e7d9b89026`](https://github.com/mimic-js/mimic/tree/7538f79d81b51e1da39045d91d8115e7d9b89026)  
**Question:** Can Mimic provision and execute the upstream npm CLI,
then apply Browser Package Replacement Catalog decisions before npm materialises
packages, without editing the user's project or rewriting `node_modules` after
installation?

## Answer

**Probably yes for executing a pinned npm 11 CLI, but transparent replacement is
not a simple npm plugin.** The current Mimic virtual platform reports
Node `22.13.0` in [`virtual-platform.ts`](../../src/runtime/virtual-platform.ts).
Upstream `npm@11.18.0` declares Node `^20.17.0 || >=22.9.0`, so that exact profile
passes npm's engine floor. Current `npm@12.0.1` instead requires
`^22.22.2 || ^24.15.0 || >=26.0.0`, so it does not match the advertised runtime
profile. Engine compatibility is necessary, not proof that the browser runtime
implements every Node, process, filesystem, networking, and child-process behavior
the CLI exercises. Sources: [`npm@11.18.0` package metadata](https://github.com/npm/cli/blob/v11.18.0/package.json),
[`npm@12.0.1` package metadata](https://github.com/npm/cli/blob/v12.0.1/package.json).

The supported integration is to run `bin/npm-cli.js` as a process. Requiring the
`npm` package is not an integration seam: its exported `index.js` throws when it
is not the main module because the programmatic API was removed in npm 8, and
npm's own `Npm` class states that npm has no programmatic API. Sources:
[`npm@11.18.0` entry point](https://github.com/npm/cli/blob/v11.18.0/index.js),
[`Npm` implementation](https://github.com/npm/cli/blob/v11.18.0/lib/npm.js).

For replacement, npm 11 has no documented resolver/fetcher plugin registration
seam comparable to the pnpm and Yarn mechanisms already investigated. Its install
command directly constructs Arborist and calls `reify`; Arborist directly calls
the bundled Pacote API to resolve manifests and extract the chosen artifact.
Pacote exposes fetcher classes for callers of Pacote, but its own dispatcher uses
a fixed switch over npm spec types and does not expose custom fetcher registration.
Sources: [`npm install`](https://github.com/npm/cli/blob/v11.18.0/lib/commands/install.js),
[`Arborist` public API](https://github.com/npm/cli/blob/v11.18.0/workspaces/arborist/README.md),
[`buildIdealTree`](https://github.com/npm/cli/blob/v11.18.0/workspaces/arborist/lib/arborist/build-ideal-tree.js),
[`reify`](https://github.com/npm/cli/blob/v11.18.0/workspaces/arborist/lib/arborist/reify.js),
[`Pacote` API](https://github.com/npm/pacote/blob/v21.5.1/README.md),
[`Pacote` fetcher dispatch](https://github.com/npm/pacote/blob/v21.5.1/lib/fetcher.js).

The strongest supported experiment is therefore a **Catalog-aware registry
facade**. npm can receive registry configuration through process environment or
CLI configuration, so the adapter need not write `.npmrc` or `package.json`.
Pacote fetches the logical package's packument from the configured registry,
chooses a manifest, then obtains the artifact URL and expected integrity from
`dist.tarball` and `dist.integrity`. A facade can make the Catalog decision at
that point and return a projected logical manifest plus a projected artifact and
its effective integrity before Arborist builds and materialises the tree. Sources:
[`npm` configuration sources](https://docs.npmjs.com/cli/v11/using-npm/config/),
[`registry` configuration](https://docs.npmjs.com/cli/v11/using-npm/config/#registry),
[`RegistryFetcher`](https://github.com/npm/pacote/blob/v21.5.1/lib/registry.js).

This is viable enough to prototype, but it is **not yet sufficient to promote
upstream npm**. The decisive blocker is ordinary pre-existing lock state. npm
uses exact locked versions when the lock still satisfies `package.json`, and
`npm ci` is frozen. `package-lock.json` records the artifact URL in `resolved`
and the SRI of the unpacked artifact in `integrity`. Pacote rejects a new
packument or tarball when its integrity conflicts with an integrity already
provided by the lockfile. Redirecting a locked URL to different bytes therefore
does not perform a replacement; it produces `EINTEGRITY`. Sources:
[`npm install` lockfile behavior](https://docs.npmjs.com/cli/v11/commands/npm-install/),
[`npm ci` frozen behavior](https://docs.npmjs.com/cli/v11/commands/npm-ci/),
[`package-lock.json` fields](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json/),
[`Pacote` integrity comparison](https://github.com/npm/pacote/blob/v21.5.1/lib/registry.js).

## What “Catalog-aware registry facade” must mean

It cannot be a tarball redirect alone. For a logical request such as
`esbuild@0.25.12 -> esbuild-wasm@0.25.12`, the facade must make all of these
inputs agree before npm resolves and extracts the package:

1. The packument slot and selected version must satisfy the logical request.
2. The manifest npm uses to build dependency, peer, bin, platform, and lifecycle
   state must describe the effective artifact.
3. The tarball's installed `package.json` and files must agree with that projected
   manifest. If projection changes the tarball, the projected bytes need a new
   effective integrity.
4. Catalog lifecycle policy must be reflected before Arborist schedules builds;
   a global `--ignore-scripts` can disable all scripts, but it is not a selective
   replacement hook. npm 11.18 also resolves its own `allowScripts` policy before
   `reify`, so the adapter must test the exact interaction rather than bypass it.
5. The facade must preserve scoped/private-registry routing and auth. Replacing
   the configured registry without delegating those policies would regress normal
   npm behavior.

This preserves npm's ownership of solving, peer placement, workspaces, bin links,
layout, lockfile serialization, and lifecycle order. It also keeps replacement
ahead of materialisation, unlike a forbidden post-install `node_modules` rewrite.

## Why the other apparent seams are insufficient

### Root `overrides`

npm officially supports root `overrides`, including replacing a package with an
`npm:` alias, Git repository, or local file. However, overrides are read only from
the root `package.json`; direct dependencies cannot be overridden to a different
spec and cause `EOVERRIDE`. Using them transparently therefore requires a
transaction-private manifest overlay, and the resulting policy is still npm
project policy rather than a typed Catalog/provenance contract. Source:
[`package.json` overrides](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#overrides).

Overrides remain useful as a small control experiment: they can show whether the
chosen replacement's dependency graph, bins, and lifecycle work under native
Arborist. They should not be mistaken for the final injection seam.

### Calling Arborist or Pacote directly

Arborist and Pacote have supported programmatic APIs, but replacing the npm CLI's
bundled instances requires bypassing the CLI, patching its dependency graph, or
monkey-patching private module state. That turns the adapter into an npm fork tied
to one exact release. It also stops answering the user's question—whether the
real npm CLI can remain authoritative for its behavior.

### Registry-host rewriting alone

The `replace-registry-host` option can rewrite lockfile hosts to the configured
registry, but it changes only routing. It does not change the lockfile's expected
integrity, logical/effective identity, or Catalog provenance. Source:
[`replace-registry-host`](https://docs.npmjs.com/cli/v11/using-npm/config/#replace-registry-host).

## Lockfile and provenance consequences

A fresh installation through the Catalog facade can produce a native npm lockfile
whose `resolved` and `integrity` point at the effective projected artifact. That
lockfile can be replayed only while the same facade and Catalog contract remain
available, or while the effective bytes are already available through a compatible
offline cache.

A normal repository lockfile created against the publisher's original artifact is
different. Supporting its frozen installation with a replacement requires an
explicit design decision, not a redirect:

- create and commit a Catalog-aware lockfile through the facade;
- give npm a transaction-private **effective lockfile overlay**, while preserving
  and separately attesting the user's original lockfile;
- or declare that profile unsupported when a replacement is required.

The second option weakens the statement that upstream npm alone owns frozen lock
semantics, so it must be called out explicitly if selected.

npm's documented package descriptor stores a single `resolved` and `integrity`
plus normalized package fields; Arborist serializes a defined set of metadata.
There is no documented field for dual publisher/effective identity or a Catalog
entry digest. The Package Installation Receipt must therefore obtain provenance
from typed facade observations, not stdout and not an invented lockfile extension.
Sources: [`package-lock.json` format](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json/),
[`Arborist` lockfile serializer](https://github.com/npm/cli/blob/v11.18.0/workspaces/arborist/lib/shrinkwrap.js).

Registry signatures and attestations also cannot be copied onto projected bytes.
Pacote verifies signatures against package identity plus integrity and verifies an
attestation subject against the package PURL and tarball digest. If Mimic
repackages a replacement under a logical identity, it must verify and record the
publisher replacement artifact separately, then calculate and record the effective
projected integrity; it cannot claim the publisher signature authenticates the new
projection. Source: [`RegistryFetcher` verification](https://github.com/npm/pacote/blob/v21.5.1/lib/registry.js).

## Runtime and transaction consequences

Passing npm's engine floor only proves that the selected JavaScript supports the
advertised Node version. `npm@11.18.0` bundles Arborist, Pacote, cacache,
`@npmcli/run-script`, `node-gyp`, process spawning, link creation, registry HTTP,
TLS/crypto, and signal behavior. A browser proof must exercise the relevant generic
runtime capabilities; startup or `npm --version` alone is not install evidence.
The exact bundled dependency set is recorded in
[`npm@11.18.0` package metadata](https://github.com/npm/cli/blob/v11.18.0/package.json).

Arborist has its own staged reification and some rollback behavior, but its source
notes a point after which an install “can't be safely recovered.” That is not the
same as Mimic's project-wide VFS Transaction. The upstream npm process
must run entirely inside the shared transaction so manifest, lockfile,
`node_modules`, hidden lockfile, lifecycle changes, and receipt either commit
together or remain invisible. Source:
[`Arborist reify transaction steps`](https://github.com/npm/cli/blob/v11.18.0/workspaces/arborist/lib/arborist/reify.js).

## Recommended prototype gate

Do not resolve the architecture ticket by assuming either “upstream npm works” or
“npm needs a permanent built-in installer.” Create one bounded prototype for the
exact `npm@11.18.0 + Node 22.13.0` profile:

1. Provision the official integrity-pinned npm artifact outside project
   dependencies and run `bin/npm-cli.js --version` in an Execution Context.
2. Run a fresh ordinary registry install through the Catalog facade and prove a
   replacement is selected before any original native artifact is fetched.
3. Prove the projected manifest, dependencies, bins, lifecycle policy, layout,
   effective integrity, and typed receipt provenance agree.
4. Run the same graph from the facade/cache with network disabled.
5. Feed npm an ordinary publisher lockfile and capture the expected integrity
   boundary. Then prove the chosen explicit lock strategy—Catalog-aware lockfile
   or effective overlay—with `npm ci`.
6. Inject failure and cancellation during fetch, extraction, lifecycle, and commit;
   prove the outer VFS Transaction leaves no project-owned partial state.
7. Include a workspace and peer dependency so success cannot be attributed to a
   trivial flat graph.

Promotion requires all seven. If the facade cannot preserve frozen-lock integrity
and provenance without making Mimic a second hidden solver/lockfile
authority, retain the Built-in npm Quarantine. If it can, upstream npm becomes the
preferred npm adapter and the quarantine has a concrete deletion proof.

## Decision impact

The current planning direction should be refined, not reversed:

- keep upstream npm as the target;
- use an exact npm 11 profile for the first proof, not current npm 12;
- treat the CLI process, not `require('npm')`, as the supported toolchain seam;
- prototype a Catalog-aware registry facade as the only presently supported
  non-mutating, pre-materialisation injection route;
- keep lockfile transformation/overlay as an explicit unresolved decision;
- do not close **Choose the package-installation architecture** until that
  prototype determines whether native npm can pass the Catalog and frozen-lock
  gates.
