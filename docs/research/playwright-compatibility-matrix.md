# Research: a cost-effective Playwright compatibility matrix

> Snapshot note: source findings and dated evidence are retained, but repo-specific
> “current state” statements may be obsolete. Verify them against current code,
> tests, issues, and [`compatibility-status.md`](../compatibility-status.md). See
> [the research status rules](./README.md).

Date: 2026-07-11

## Why this research exists

Design a cost-effective Playwright compatibility matrix (#119) asks how Mimic can prove install, execution, and lifecycle compatibility across a growing workload/version matrix without reinstalling the same published package graph for every assertion.

The destination set by Map pragmatic Mimic compatibility (#114) is stricter than a fast browser smoke suite: authoritative evidence uses Chromium, the public `Mimic` API, a real published package graph, and observable install/run/lifecycle behavior. A restored filesystem can make later scenarios cheaper, but it cannot by itself prove installation.

## Current repository baseline

The repository already has most of the raw mechanisms this design needs:

- [`playwright.config.ts`](../../playwright.config.ts) has one Chromium project, CI retries, first-retry traces, failure screenshots/videos, and a Vite host server.
- [`mimic-toolchain.spec.ts`](../../tests/e2e/mimic-toolchain.spec.ts) and [`express-compatibility.spec.ts`](../../tests/e2e/express-compatibility.spec.ts) boot Mimic in Chromium, mount published package manifests, call `spawn('npm', ['install'])`, execute the installed graph, inspect output, and tear the runtime down.
- [`browser-fixture-matrix.spec.ts`](../../tests/e2e/browser-fixture-matrix.spec.ts) already treats each frontend fixture as a named case, but the demo path performs its own setup and the suite does not yet have a graph-level install receipt.
- [`package-cache.ts`](../../src/runtime/package-cache.ts) has memory and OPFS implementations for tarballs and extracted entries. [`lockfile-installer.ts`](../../src/runtime/lockfile-installer.ts) keys package payloads by integrity, shasum, or resolved URL; verifies cached tarballs; records tarball/extracted hit and miss counts; and writes an install-state record.

The main cost bug is therefore not “Playwright has no cache.” It is that tests and proofs are not yet scheduled around the unit that is expensive and reusable: one exact package graph.

## Primary-source findings

### Playwright's isolation boundary is the browser context

Playwright's built-in `browser` fixture is shared by tests in a worker, while each test gets a fresh, isolated `BrowserContext` and page. Test-scoped fixtures are torn down after each test; worker-scoped fixtures live until their worker exits. Playwright explicitly presents worker fixtures as the place to start shared services. [Sources: [Playwright fixture API](https://playwright.dev/docs/api/class-fixtures) and [Playwright fixtures](https://playwright.dev/docs/test-fixtures)]

That makes a **package graph**, not an individual assertion, the correct test/context boundary for Mimic. One graph test should install once and then exercise its dev server, preview, HMR or watch mutation, build/start path where applicable, process exit, server closure, and `teardown()`. Separate graph tests still receive fresh origin storage and Service Worker state. Host-side services may be worker-scoped, but sharing a browser context between unrelated graphs would surrender Playwright's normal isolation.

### Project dependencies are useful for observable setup, but not as a cross-shard graph cache

Playwright recommends project dependencies over opaque global setup because setup appears in reports, can use fixtures, and can retain traces. Filtering and sharding select primary tests and then run their dependencies, so a heavyweight graph-preparation dependency can be repeated by independent shard invocations. [Sources: [Playwright global setup and teardown](https://playwright.dev/docs/test-global-setup-teardown) and [Playwright projects](https://playwright.dev/docs/test-projects)]

Use a setup project for inexpensive suite-wide validation—fixture-manifest schema, host readiness, and cache-artifact validation. In CI, generate expensive installed-graph artifacts in an explicit prerequisite job and pass them to shard jobs as workflow artifacts. GitHub documents artifacts as the mechanism for passing job-produced files to later jobs in the same workflow, while dependency caches are for regenerable data reused across workflow runs. [Sources: [GitHub workflow artifacts](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts) and [GitHub store and share data](https://docs.github.com/en/actions/tutorials/store-and-share-data)]

### Cache package payloads separately from installed graph state

npm's own cache is content-addressable, verifies data on insertion and extraction, and remains only a cache rather than an authoritative persistent store. npm also uses a satisfying `package-lock.json` to select exact versions. [Sources: [npm cache](https://docs.npmjs.com/cli/v8/commands/npm-cache/) and [npm install](https://docs.npmjs.com/cli/install/)]

Mimic should preserve that separation:

1. **Registry/package cache:** immutable registry metadata, tarballs, and extracted package entries. Tarballs are addressed by published integrity (falling back to shasum or exact URL only when unavoidable) and verified before use. This cache saves network and extraction while `npm install` still resolves/materializes a fresh VFS.
2. **Installed-graph snapshot:** a serialized VFS produced after one successful public-API install of one exact fixture graph. It saves repeated materialization and lifecycle work for additional run-only scenarios, but is derived evidence, never install evidence on its own.

Do not check in `node_modules` images or use one mutable “latest” snapshot. A snapshot is useful only when a graph needs destructive or independently retryable scenario branches that cannot efficiently run after one install in one test. Until then, one graph test with sequential lifecycle assertions is simpler and cheaper.

### Installation includes lifecycle behavior, not just files appearing

npm documents that `npm install` runs install lifecycle stages after modules have been placed in `node_modules`; the documented order includes `preinstall`, `install`, `postinstall`, and preparation stages. [Source: [npm scripts lifecycle order](https://docs.npmjs.com/cli/using-npm/scripts/#life-cycle-operation-order)]

Accordingly, a Mimic install receipt must include a lifecycle sentinel for fixtures that declare an approved lifecycle script. Merely mounting a cached `node_modules` tree or observing an executable file is not equivalent to installing the graph.

### Shard at individual graph tests and merge evidence

With `fullyParallel`, Playwright can distribute individual tests rather than only files. Its blob reports retain test results and attachments and can be merged after shard jobs; Playwright's GitHub Actions example uses a job matrix, `--shard`, uploaded blob reports, and a final merge job. [Source: [Playwright sharding](https://playwright.dev/docs/test-sharding)]

The manifest should therefore generate one independently runnable test per exact graph. Avoid serial groups across graphs: Playwright advises isolated tests over serial mode, and workers are discarded after failures to restore a clean environment. [Source: [Playwright parallelism](https://playwright.dev/docs/test-parallel)]

### Host dependency caching and compatibility evidence are different concerns

GitHub cache keys can incorporate lockfile hashes, exact-key misses create a new cache after a successful job, and cache entries are immutable. Restored caches must be treated as untrusted input. [Sources: [GitHub dependency caching reference](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching) and [GitHub dependency caching concepts](https://docs.github.com/en/actions/concepts/workflows-and-actions/dependency-caching)]

Cache the host pnpm store with the normal setup-node mechanism. Cache Mimic's registry/package seed separately under strict keys and verify every payload. Avoid prefix `restore-keys` for installed-graph snapshots because a partial match can restore an artifact built from a different graph or runtime policy.

Playwright also says caching browser binaries is generally not worthwhile because restoring them takes about as long as downloading them and Linux system dependencies are not cacheable. Each Playwright version requires matching browser binaries. [Sources: [Playwright CI](https://playwright.dev/docs/ci#caching-browsers) and [Playwright browsers](https://playwright.dev/docs/browsers)]

Use a pinned Playwright container or install the pinned Chromium and its dependencies; do not mix browser-binary caching into the Mimic package-cache design.

## Recommended architecture

### 1. A versioned fixture manifest is the source of matrix identity

Each entry should declare:

```ts
type CompatibilityFixture = {
  id: string;
  category: string;
  packageManager: { name: 'npm' | 'pnpm' | 'yarn'; version: string };
  manifestPath: string;
  lockfilePath: string;
  expectedPackages: Record<string, string>;
  commands: {
    install: string[];
    run: Array<{ name: string; argv: string[]; expectation: string }>;
  };
  lifecycle: Array<'install' | 'dev' | 'hmr' | 'watch' | 'build' | 'start' | 'teardown'>;
  requiredCapabilities: string[];
  forbiddenFallbacks: string[];
  tier: 'pr' | 'main' | 'nightly';
  estimatedSeconds: number;
};
```

The **graph digest** is computed from the normalized fixture entry, exact lockfile bytes, package-manager name/version, virtual platform identity, Browser Package Replacement Catalog digest, installer/cache schema versions, and runtime build SHA. Mutable dist-tags and semver ranges may be discovery inputs, but never artifact identity.

### 2. Typed Playwright fixtures divide responsibilities by lifetime

`tests/e2e/compatibility/fixtures.ts` should expose:

- `matrixManifest` (worker): validated immutable manifest and selected shard/tier.
- `fixtureAssetServer` (worker): serves lockfiles, content-addressed cache seeds, and same-run snapshots; it records reads but does not synthesize success.
- `registryObserver` (worker): records registry metadata/tarball requests and blocks undeclared hosts. It may proxy pinned upstream bytes but may not substitute local packages.
- `compatibilityPage` (test): Playwright's ordinary fresh context/page configured for cross-origin isolation and centralized console, page-error, worker-error, request-failure, trace, and video evidence.
- `mimic` (test): boots via the public API, registers diagnostics, and always calls `teardown()` during fixture teardown.
- `installedGraph` (test): mounts the source/lockfile, calls the declared package-manager install through `spawn`, captures an install receipt, and only then exposes command helpers.

Only host services and immutable bytes are worker-scoped. Mimic, its context, VFS, servers, and processes stay test-scoped.

### 3. One test installs one graph and exercises its lifecycle

Generate one test for each `(fixture id, exact version graph, package manager)` tuple. Inside that test:

1. boot and mount through public `Mimic` APIs;
2. run the real install command once;
3. verify the receipt and lifecycle sentinel;
4. execute every non-destructive lifecycle scenario in order;
5. perform destructive/restart scenarios last;
6. terminate child processes and servers;
7. call `teardown()` and prove a clean reboot where the fixture's claim includes lifecycle isolation.

Multiple pages may share that graph's context for preview clients, but unrelated graphs never do. This immediately removes “install once per assertion” without introducing snapshot machinery.

### 4. Add same-run snapshots only for branched scenarios

When a graph has enough mutually destructive scenarios to justify it, add a `prepare-graphs` CI job. For every selected graph, a Playwright test performs the public-API install in Chromium, verifies it, serializes the VFS, and uploads:

- `graph-snapshot.tar.zst` (or another deterministic binary-safe format);
- `install-receipt.json`;
- `snapshot-manifest.json` containing the graph digest, file count, byte count, per-file or archive digest, and schema versions;
- the Playwright blob report and trace for the preparation test.

Shard jobs download these same-workflow artifacts, verify digests, restore each snapshot into a fresh Mimic context, and run only the branched lifecycle scenarios. GitHub workflow artifacts are the right transport because these files are outputs of a prerequisite job consumed by later jobs. Cross-run GitHub cache may hold the lower-level verified package seed, but a prior-run installed snapshot must never silently satisfy the current run's install-proof requirement.

### 5. Every compatibility claim carries an evidence receipt

Attach one machine-readable receipt to the graph test containing:

- fixture id, graph digest, runtime SHA, browser/Playwright version, virtual platform, and replacement-catalog digest;
- exact install argv, exit code, output digest, elapsed time, and install-state record;
- registry request log plus tarball/extracted cache hit/miss counts;
- materialized package/version list and lockfile digest;
- lifecycle sentinel results and installed package execution output;
- forbidden-fallback scan results;
- server/process teardown and clean-reboot result;
- snapshot digest when later scenarios used one.

The human report should distinguish `cold-install`, `warm-install`, and `snapshot-restore`; only the first two are installation evidence. A snapshot-only scenario inherits provenance from its same-run install receipt but must not be reported as another install.

## The mandatory real-install witness

At least one small published graph in every PR workflow runs as a **cold-install witness**:

- fresh browser context and a unique empty package-cache namespace;
- no installed snapshot and no preseeded Mimic package cache;
- exact checked-in lockfile and declared registry hosts only;
- positive registry metadata/tarball request evidence and non-zero cache misses;
- `spawn(packageManager, installArgs)` through the public API with exit code zero;
- expected package versions, binary/assets, and install-state visible in the VFS;
- an approved lifecycle sentinel where relevant;
- execution of an installed package with expected output;
- no forbidden adapter/fallback marker;
- process/server shutdown, `teardown()`, and clean subsequent boot.

The PR witness proves the retrieval-to-execution path has not been replaced by snapshots. In `main` and nightly lanes, every newly added or invalidated graph must produce a fresh install receipt before its snapshot can feed branched scenarios. Existing unchanged graphs may use the verified package-content cache, but still call the installer once per graph test unless their run-only scenarios are explicitly marked as snapshot-derived.

Add one complementary **warm-cache witness** for a representative graph: after the cold proof and teardown, boot again in the same graph context/namespace, reinstall into a fresh VFS, assert extracted/tarball hits and no unexpected registry payload fetches, then execute the package again. This proves that caching reduces transfer/extraction without bypassing materialization.

## Invalidation rules

Use exact, fail-closed invalidation:

| Artifact | Key inputs | Invalidate when |
| --- | --- | --- |
| Host pnpm cache | runner OS, pnpm version, root `pnpm-lock.yaml` hash | host toolchain or lockfile changes |
| Registry metadata | registry origin, package, exact version, response digest, metadata schema | exact response/policy changes or configured expiry |
| Tarball | published integrity; otherwise shasum plus exact URL | digest/key changes or verification fails |
| Extracted package | tarball digest, extractor version, filename/permission schema | tarball or extraction semantics change |
| Installed graph snapshot | graph digest, runtime SHA, installer schema, replacement-catalog digest, virtual platform, lifecycle policy, snapshot schema | any input changes |
| Evidence receipt | workflow run, commit SHA, graph digest, browser/Playwright version | never reused as current-run evidence |

Corrupt or unverifiable cache entries are misses, not flaky-test retries. Do not use broad restore prefixes for registry/extracted/snapshot data. A compatibility retry must recreate a fresh test context; traces and both attempt receipts remain visible so a retry cannot conceal a cache-dependent first failure.

## CI topology and cost controls

### Pull requests

- manifest/schema and unit-contract checks;
- one unsharded cold-install witness plus warm-cache witness;
- affected `pr` graph tests, each installing once and running all lifecycle assertions;
- no snapshots until a graph demonstrably needs branched scenarios.

### Main branch

- all blocking representative graphs;
- graph tests sharded with `fullyParallel: true`;
- optional `prepare-graphs` prerequisite for expensive branched fixtures;
- blob reports and evidence receipts merged into one report.

### Nightly/discovery

- full Validated Version Range and Compatibility Quarantine negatives;
- cold installs for graphs whose upstream metadata, lockfile, replacement policy, or runtime inputs changed;
- browser breadth only where the compatibility claim calls for it; Chromium remains the authoritative baseline from the map;
- timing data feeds `estimatedSeconds`, shard count, and tier promotion/demotion.

Shard by individual graph tests, initially letting `fullyParallel` distribute them. If a few large graphs dominate, generate deterministic shard assignments from historical duration using the fixture id as a stable tie-breaker. Shards upload blob reports even on failure, and a final job merges reports and receipts.

## Decision

Adopt **install once per exact graph, then test its lifecycle** as the immediate architecture. Keep Mimic and browser contexts test-scoped; keep only fixture servers, registry observation, and immutable cache artifacts worker-scoped. Reuse integrity-verified package payloads across runs, but introduce installed-graph snapshots only for genuinely branched scenarios and generate them from a successful public-API Chromium install in the same workflow.

This gives the matrix a clear evidence hierarchy:

1. cold install + execute + lifecycle + teardown is the strongest proof;
2. warm install proves the real installer on verified cached payloads;
3. same-run snapshot restore cheaply expands run/lifecycle coverage;
4. unit tests and prebuilt host/browser images support the system but do not establish compatibility.

The design cuts repeated graph work without allowing cache hits or snapshots to turn into false compatibility claims.
