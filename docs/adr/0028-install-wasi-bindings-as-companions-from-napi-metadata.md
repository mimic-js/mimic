---
status: accepted
amends: ADR-0021 (Browser Package Replacements)
amended_by: ADR-0035 (a shipped WASI loader is repaired from its module), ADR-0045 (`process.versions.webcontainer` is set; the companion is in place before a loader asks)
---

# Install WASI bindings as companions derived from `napi` metadata

A package built with NAPI-RS publishes its WebAssembly build as a separate
package, `<binding scope>-wasm32-wasi`, and its generated loader falls back to
that package whenever the native binding for `process.platform` does not load.
Until 2026 publishers also listed the WASI package in `optionalDependencies`
with `cpu: ["wasm32"]`, so npm, pnpm and Yarn, taking the platform from the
runtime's `process.arch === 'wasm32'` (ADR-0016), installed it by themselves
and the loader found it. That is how Rolldown, Oxc and Rspack ran with no entry
in the replacement map.

Publishers are dropping that listing. `rolldown` lists the binding through
1.2.1 and not from 1.2.2; current Vite 8.3 resolves `rolldown ~1.2.11` and
current `@angular/build` pins 1.2.8. `oxc-parser`, `oxc-transform`,
`oxc-minify`, the `@node-rs/*` and most `@napi-rs/*` packages never listed it.
The binding is still published at every version and the loader still names it;
only the install no longer brings it. Such a project fails here with "Cannot
find native binding" (research note
[2026-10-05](../research/2026-10-05-deriving-wasi-bindings-from-napi-metadata.md)).

## Decision

**The Command Proxies install the WASI binding a NAPI-RS package falls back
to as a companion, derived from the package's own metadata; no map entry
names the package.**

- **Derivation.** After an install changed the manager's state, the Command
  Proxy reads the `package.json` of every installed package. A package whose
  `napi.targets` names a `wasm32-wasi*` target falls back to
  `${napi.packageName ?? name}-wasm32-wasi`, then to the single-threaded
  `-wasm32-wasip1`, at its own exact version. These are the names the
  NAPI-RS loader template tries, in its order. A package that ships the
  binding itself (`<napi.binaryName>.wasi.cjs`, as `nx` does) or from which
  the binding already resolves (an optional dependency the manager installed)
  needs nothing.
- **Materialization.** Each companion `name@version` is installed once per
  project, with its dependencies (`@napi-rs/wasm-runtime`, `@emnapi/*`), under
  `node_modules/.mimic/companions/<name>/<version>/`, by the pinned
  npm run as a child Runtime Process: `npm install --no-save
  --no-package-lock --ignore-scripts <name>@<version>`. npm is used whatever
  manager the project uses, because npm is the manager proven to fetch here.
  The runtime grows no second resolver (ADR-0021). The directory is inside the
  project's `node_modules`, so an export of the installed tree, such as an
  install layer, carries it, and under a dot-prefixed name the managers leave
  alone.
- **Linking.** A relative symlink `<package>/node_modules/<companion>` points
  at the materialized package, so Node's resolution from the package finds it
  first, in every installed copy, nested or in pnpm's store, from one
  materialization. A manager prunes a link it did not make on its next install;
  the Command Proxy, which runs after every state change, links it again
  without installing again.
- **Exact version only.** The binding and the JavaScript glue of a NAPI-RS
  package are generated together; another version is an ABI mismatch, which is
  why the loader has a version check. A companion the registry does not
  publish at the installed version is named on stderr with the manager's
  command, and the package is left to report the missing binding itself when
  executed. The exit code is unchanged.
- **Map entries lose their range.** A `package-contents` entry is a pair of
  names: `rollup → @rollup/wasm-node`, `lightningcss → lightningcss-wasm`,
  `@parcel/watcher → @parcel/watcher-wasm`. The installed version is replaced
  by the same replacement version, or by the published version nearest to it
  in the same major line, and a version of a major line the replacement was
  never published for (Rollup 3) stays as the manager installed it. The map
  also admits a `companion` kind, a pair naming the package a source package's
  loader falls back to when no metadata links them (a candidate is `@swc/core
  → @swc/wasm`); it is applied by the same materialization and linking, and
  has no entry until a browser proof admits one (ADR-0007).
- **The identity stays `browser`/`wasm32`** (ADR-0016; the operating system is
  `linux` since ADR-0039, which changes nothing here). WebContainers report
  `linux`/`wasm32` with `process.versions.webcontainer` set, which makes the
  same loaders run a fallback that installs the binding with `pnpm` into
  `/tmp` at `require` time. The companion gives the loader the package before
  it asks, once per install.

## Consequences

- Rolldown 1.2.12 parses through `@rolldown/binding-wasm32-wasi@1.2.12`
  although its lockfile names no binding, and `@node-rs/crc32` 1.10.8, whose
  metadata names no binding scope, checksums through
  `@node-rs/crc32-wasm32-wasi@1.10.8`
  (`tests/e2e/mimic-napi-companion.spec.ts`). The derivation
  holds for the 32 NAPI-RS packages with a WASI target surveyed in the
  research note, and derives nothing for `@swc/core`, `nx`, `oxlint` and
  `@napi-rs/canvas`, which publish none.
- The companion is installed and loaded independently of what the package
  then does with it. `@node-rs/argon2` 2.2.1 received
  `@node-rs/argon2-wasm32-wasi@2.2.1` the same way and hashed and verified a
  password through it, but its process ended as a crash, "Worker stopped with
  exit code 1": the binding's `process.on('exit')` teardown terminates the
  WASI thread workers its asynchronous work used, and the runtime still
  delivers those workers' `exit` events after the process has ended, which
  the loader treats as a failure. That is a Worker Thread lifecycle gap of the
  runtime, not of the companion, and is not claimed here.
- An install that needs a companion runs one more npm process per companion,
  after the manager, and asks the registry for the companion's packuments and
  tarballs. The Package Artifact Cache does not hold them; npm's own cache in
  the Virtual File System does, for the epoch.
- Every installed `package.json` is read after an install that changed the
  manager's state, where before only the four mapped names were.
- `@parcel/watcher` 2.2.x, below the first `@parcel/watcher-wasm` (2.3.0),
  now receives 2.3.0's contents instead of staying native; it ran nowhere here
  before.
- The Yarn Plug'n'Play statement is unchanged for package-contents entries; a
  companion is not linked into an archive either, and the loader reports it.
