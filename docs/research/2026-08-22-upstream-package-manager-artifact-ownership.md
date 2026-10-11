# Upstream package-manager execution and artifact ownership

Date: 2026-08-22
Repository revision: [`e55011e3144781dafea8ee500f0cd796b8f8c102`](https://github.com/mimic-js/mimic/tree/e55011e3144781dafea8ee500f0cd796b8f8c102)
Question: Research upstream package-manager execution and artifact ownership (#613)

## Decision

npm, pnpm, and Yarn are ordinary JavaScript/Node programs and Mimic
already runs their pinned publisher entrypoints as child Runtime Processes. Keep
that path. Do not introduce another package-manager execution interface, embed
manager semantics in Process Execution, or reimplement resolution, native
lockfiles, dependency layout, cache/install state, lifecycle ordering, or
command parsing.

`Package Installation Program` does not justify a separate Runtime Deep Module.
Its irreducible Mimic behavior is one small **installation
transaction** inside each package-manager adapter: open a VFS transaction,
prepare Catalog-owned inputs, run the upstream program against the transaction,
fail closed on integrity or nonzero/crash/cancellation, and commit or roll back.
This behavior should be merged into the toolchain-program implementation behind
the existing Runtime Program interface. The VFS remains the transaction
authority; Process Execution remains the process-tree authority.

Split the current `Toolchain, Catalog, Artifact Cache` cluster by authority:

- **Toolchain selection and acquisition** owns exact runtime-approved manager
  profiles and provisioning of their integrity-pinned publisher CLI archives.
  It may reuse Corepack's whole mechanism only if Corepack itself can run inside
  Mimic and its download/cache trust policy meets the maintained
  evidence; otherwise the current small pinned catalog is less machinery.
- **Browser Package Replacement Catalog** owns declarative replacement and
  companion policy. It produces manager-adapter input; it does not fetch,
  extract, cache, transact, or parse command lines.
- **Artifact acquisition** owns registry metadata lookup, verified tarball
  acquisition, extraction, and content-addressed persistence for
  Mimic-owned Catalog/toolchain artifacts. Merge the two current
  acquisition pipelines and caches behind the existing OPFS/memory storage
  adapters; do not add a generic cache seam.
- **Package-manager adapters** own only the manager-specific projection of
  Mimic policy: profile discovery, mutating-operation admission,
  manager-native flags/config, Catalog input projection, and extraction of the
  minimum runtime attestation after success. They must not duplicate the
  manager's solver, lockfile parser beyond the Catalog projection need, linker,
  lifecycle scheduler, or cache.

The upstream manager remains authoritative for the dependency graph and all
manager-native artifacts. Mimic remains authoritative only for the
runtime trust decision, Catalog additions/substitutions, VFS atomicity, and the
small attestation needed to bind those runtime-owned facts to a committed VFS
revision.

## Authority table

| Concern | Canonical authority | Mimic mechanic | Consequence |
| --- | --- | --- | --- |
| Program execution | Process Execution + upstream CLI program | Provision an exact verified CLI and launch its published JS entrypoint as an ordinary Runtime Program | Delete any package-manager branch from generic execution; retain no second execution interface. |
| Toolchain selection | Runtime toolchain policy | Resolve explicit project intent to an allowlisted exact publisher artifact | Keep exact profiles, but collapse descriptor/profile/provision-intent mappings into one record per supported profile. |
| Dependency resolution and layout | Selected npm/pnpm/Yarn | Supply Node/VFS/network/process capabilities and manager-native configuration | Never synthesize the graph, hoisting, pnpm links/store, Yarn PnP, peers, bins, workspaces, or native install state. |
| Native lockfile | Selected upstream manager | Enforce caller-selected frozen/update intent and protect the transaction | Do not treat Mimic's receipt or overlay as a second graph authority. |
| Catalog policy | Browser Package Replacement Catalog | Select an approved publisher relationship before manager materialisation | Keep package knowledge only in Catalog records and the corresponding adapter projection. |
| Effective lockfile overlay | Package-manager adapter, transaction-private | Give the upstream manager effective locators without committing a rewritten publisher lockfile | Keep only while a native supported manager hook cannot express the Catalog decision; discard after every outcome. |
| Package artifacts, integrity, cache | Upstream manager for graph artifacts; Mimic acquisition for runtime-owned Catalog/toolchain artifacts | Verify runtime-owned tarballs before use and persist immutable bytes/extracted content by integrity | Stop reacquiring and reattesting ordinary graph artifacts outside the manager. |
| Lifecycle | Selected upstream manager | Set installation-wide allow/deny policy and provide generic child-process/shell capabilities | Delete Mimic lifecycle ordering and manager-specific allowlist emulation. |
| Transaction | VFS | Give the manager a transaction-scoped filesystem and commit only after clean exit and required trust checks | Keep this wrapper; it is the one irreducible installation mechanic. |
| Receipt | Runtime trust attestation | Bind manager profile, Catalog identity/projection, runtime-owned artifact integrity, and committed VFS revision | Reduce to runtime-owned facts; native lockfile and native install state remain referenced inputs, not copied authorities. |

## Upstream evidence

The upstream tools already own the behavior that a Mimic installer
would otherwise duplicate:

- npm describes `npm install` as the operation that installs a package and its
  dependencies, and `npm ci` as a frozen whole-project install that requires an
  existing lockfile, removes an existing `node_modules`, and never writes
  `package.json` or `package-lock.json`
  ([npm install](https://docs.npmjs.com/cli/install/),
  [npm ci](https://docs.npmjs.com/cli/commands/npm-ci/)). npm also defines its
  lifecycle order and aborts when a lifecycle script exits nonzero
  ([npm scripts](https://docs.npmjs.com/misc/scripts/)). Therefore npm, not a
  Mimic coordinator, is the canonical owner of npm resolution,
  layout, lockfile semantics, and lifecycle ordering.
- pnpm's install command owns frozen-lockfile validation, offline-store use,
  integrity failure, and script suppression
  ([pnpm install](https://pnpm.io/cli/install)). Its documented layout hardlinks
  package files from a content-addressable store and creates the symlinked graph
  consumed by Node resolution
  ([pnpm symlinked layout](https://pnpm.io/symlinked-node-modules-structure)).
  Mimic cannot reproduce or post-process that layout without becoming
  a second pnpm authority.
- Yarn explicitly divides install into resolution, fetch, link, and build;
  plugins write linker artifacts, build scripts run in topological order, and
  `--immutable`, `--immutable-cache`, and `--check-cache` enforce lockfile/cache
  integrity ([Yarn install](https://yarnpkg.com/cli/install)). Yarn configuration
  owns the cache, checksum behavior, script policy, install state, and selected
  PnP/node-modules/pnpm linker
  ([Yarn settings](https://yarnpkg.com/configuration/yarnrc/)). These are one
  cohesive manager implementation, not reusable responsibilities for the
  runtime to split apart.
- Corepack is the mature whole mechanism for selecting, downloading, caching,
  and invoking project-pinned Yarn/pnpm versions from `packageManager`, including
  an offline preparation workflow
  ([Node Corepack documentation](https://nodejs.org/download/release/v18.9.0/docs/api/corepack.html)).
  Node 25 no longer distributes Corepack, so reuse would mean provisioning the
  userland Corepack program rather than assuming a Node builtin
  ([Node 25 Corepack notice](https://nodejs.org/download/release/v25.8.0/docs/api/corepack.html)).

## Current repository findings

The current runtime has already crossed the main architectural threshold:
[`createRuntimeToolchainAdapters`](../../src/runtime/modules/package-installation-program/runtime-toolchain-adapters.ts)
materializes npm 11.18.0, pnpm 11.11.0, or Yarn 4.17.1 and launches the selected
entrypoint through `spawnProgram`; non-mutating operations pass straight through
[`runRuntimeToolchainProgram`](../../src/runtime/modules/package-installation-program/runtime-toolchain-program.ts).
The maintained exact-manager claims prove npm, pnpm, Yarn node-modules, and Yarn
PnP behavior through the public runtime seam.

The remaining cluster is about 5,000 lines across two modules. The main
duplications and shallow seams are:

1. `RuntimeToolchainProgramRequest`, `PackageInstallationRequest`,
   `PackageInstallationManagerRequest`, and `PackageInstallationManagerSpawn`
   repeatedly reshape the same command/profile/cwd/env/args before calling the
   same Process Execution seam. **Inference:** merge the transaction branch into
   the toolchain Runtime Program implementation and delete the intermediate
   package-installation request/spawn vocabulary.
2. `ToolchainProfile`, private `CatalogEntry`, `ToolchainProvisionIntent`,
   `ToolchainProgramDescriptor`, and manager-specific expected-evidence paths
   spread one exact profile across mappings. **Inference:** one allowlisted
   profile record can hold names, aliases, exact artifact, entrypoint, linker,
   and adapter policy without a factory or new interface.
3. `createToolchainCatalogArtifactCache` verifies and stores CLI tarballs while
   `createPackageArtifactAcquisition` plus `RuntimeArtifactCache` independently
   coordinate registry/Catalog tarballs, extracted entries, in-flight loads,
   cloning, and integrity. **Inference:** retain one runtime-owned artifact
   acquisition implementation and the two real persistence adapters (memory and
   OPFS); delete the toolchain-only cache class and wrapper store.
4. `effective-lockfile-overlay.ts` and
   `catalog-execution-artifact-staging.ts` contain manager-specific lockfile
   parsing, acquisition, staging, and large provenance projections. This is
   mixed policy and mechanism. **Inference:** Catalog chooses relationships;
   each manager adapter projects them using the narrowest supported upstream
   mechanism; shared acquisition only returns verified immutable artifacts.
5. The version-1 `PackageInstallationReceipt` repeats manifest, native lockfile,
   native install state, effective overlay, source/effective identities,
   relationship details, cache provenance, operation flags, and hashes
   ([receipt contract](../../src/runtime/modules/package-installation-program/contracts.ts)).
   The package manager's lockfile and install state already own the graph, while
   cache source (`network`, `store`, `memory`) is diagnostic rather than commit
   authority. **Inference:** the durable receipt can become a small runtime
   attestation of exact manager profile, Catalog identity/projection,
   Mimic-owned artifacts, transaction base/commit revision, and
   digests of referenced native inputs. Detailed acquisition provenance belongs
   in transient diagnostics unless a maintained claim explicitly needs it.

The receipt cannot simply disappear today: maintained browser claims observe
transaction rollback, frozen lockfile preservation, exact manager identity,
Catalog replacement/execution-artifact provenance, offline replay, and clean
reboot. Those observations remain required, but they do not require the current
nested type graph or cache-source fields. The smallest surviving attestation is
preferable to a second dependency graph.

## Reuse and non-reuse decisions

- **Reuse upstream managers whole** for solving, lockfiles, fetch/link/build,
  native caches/install state, layout, and lifecycle. This is the largest
  deletion opportunity.
- **Consider Corepack whole, not its internals**, for Yarn/pnpm profile
  provisioning only after its userland CLI passes the same browser-runtime,
  exact-integrity, offline, and reboot evidence. Until then, the current static
  three-entry catalog is smaller and more trustworthy. Do not add Corepack as a
  dependency during simplification research.
- **Do not add Arborist, pnpm internals, or Yarn core packages** as helper
  libraries. The pinned CLIs already contain their cohesive implementations;
  importing their internals would widen the interface and couple Mimic
  to unstable implementation seams.
- **Reuse WebCrypto, `fetch`, OPFS, and VFS transactions** for the remaining
  Mimic-owned acquisition and commit mechanics. No new helper
  dependency is justified.

## Resulting target seam

The external seam remains Process Execution's ordinary Runtime Program
interface. Internally, a package-manager adapter needs only enough private code
to answer:

1. which exact upstream program to run;
2. whether this invocation mutates project dependency state;
3. which native immutable/script/cache configuration expresses caller and
   Catalog policy;
4. which Catalog-owned artifacts or overlays must be staged before launch; and
5. which minimal runtime attestation must be written before VFS commit.

Everything else belongs to the upstream program, Artifact Acquisition, or VFS.
One adapter per manager family is a real internal seam because npm, pnpm, and
Yarn expose materially different native configuration and artifacts; a public
generic Package Installation module is not.

## Verification and planning implications

Verified by tracing all production imports of both current modules, their
runtime-supervisor/execution-context composition, focused unit tests, and the
maintained toolchain, acquisition, transaction, npm, pnpm, and Yarn browser
claims. This is architecture research only; no runtime, test, dependency,
glossary, or ADR was changed.

No new research ticket is required. The result makes the existing map fog
specifiable in the target-decomposition ticket: merge Package Installation into
the toolchain Runtime Program implementation, split Catalog policy from the
single runtime-owned Artifact Acquisition authority, keep manager adapters
private, and reduce the receipt to runtime-owned trust facts while preserving
the maintained observations.
