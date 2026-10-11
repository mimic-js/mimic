---
status: accepted
supersedes: ADR-0012, ADR-0014
amends: ADR-0004 (installation of publisher WASI executables), ADR-0015 (Command Proxy internals)
amended_by: ADR-0028 (WASI bindings installed as companions from `napi` metadata; map entries without a range), ADR-0040 (a native addon build ends without the addon), ADR-0041 (the release `packageManager` asks for runs), ADR-0043 (a project's install scripts run again after its replacements)
---

# Reduce package management to a pinned CLI and a replacement map

ADR-0028 amends the replacement map below: a NAPI-RS package's WASI binding is
installed as a companion derived from its `napi` metadata, with no entry, and
a `package-contents` entry names no range; the same major line as a published
replacement version is the range.

The npm, pnpm and Yarn Command Proxies ran the exact upstream CLIs, but about
4,800 lines surrounded them: a Package Installation Receipt that was written
and immediately re-read; an Effective Lockfile Overlay that rewrote
`package-lock.json`, pre-downloaded every `resolved` tarball (including
optional packages npm would skip) and then wrote the pre-install lockfile back
over npm's own result; a Runtime Artifact Cache that stored every package
twice, once as base64 JSON, without a bound; an allow-list of global options
that existed only to decide whether to open a VFS Transaction; and a Catalog
range approval that aborted an install for a nearby version. Lockfile-less
installs, `--no-package-lock` and zero-dependency projects failed, npm's
lockfile changes were discarded, a manager's exit code became a JavaScript
stack, `npm -s run x` threw, two esbuild versions in one graph were rejected,
and pnpm and Yarn received only part of the replacements (issues #648, #649,
#650, #651, #664 and #425).

## Decision

Package management is: fetch and verify the pinned CLI, run it as an ordinary
Runtime Process, pass its exit code and output through, and apply a small
replacement map.

- **Pinned CLIs.** One table names each manager's exact package, tarball and
  integrity, and copies the package's own `bin` map: `npm` and `npx` run
  `bin/npm-cli.js` and `bin/npx-cli.js`; `pnpm`, `pnpx`, `pn` and `pnx` run
  `bin/pnpm.mjs` and `bin/pnpx.mjs`; `yarn` and `yarnpkg` run `bin/yarn.js`.
  The CLI tarball is verified against its pinned integrity, extracted once per
  epoch and mounted under `/.mimic/toolchains`. The only project
  intent Mimic reads is `packageManager`: asking for another version
  of the same manager fails with one message naming the version provided.
  *(Amended by ADR-0041: that version is installed from the registry and runs.)*
- **The Command Proxy forwards, it does not interpret.** It spawns
  `node <bin script>` with the caller's arguments untouched, stdin, stdout,
  stderr and signals forwarded, and returns the child's exit code. There is no
  mutation/execution classification, no VFS Transaction, no lockfile reading
  and no frozen-lockfile check of its own: `npm ci`, `--frozen-lockfile` and
  `--immutable` are enforced by the managers. A failed or cancelled install
  leaves what the manager wrote, as on any machine. The manager's environment
  is its defaults (npm: no update notifier, audit or fund), then the
  replacement launchers, then the caller's environment, which wins.
- **Managers fetch their own tarballs** through Node Compatibility's
  `https`, which uses the browser's `fetch`. Nothing is pre-downloaded and the
  lockfile on disk after a mutating install is the manager's own output.
  npm sends headers such as `npm-command`, `pacote-version` and `user-agent`
  that are not CORS-safelisted, so the browser first asks the destination's
  permission with a preflight, which the npm registry does not answer. Node
  Compatibility therefore sends a credential-free `GET` or `HEAD` to another
  origin as a CORS-simple request without those headers; a request carrying
  `authorization` keeps every header. The deleted pre-download had hidden this
  gap: npm itself could not reach the registry from a page whose requests are
  not intercepted.
- **Browser Package Replacements** are one map of four entries
  (`browser-package-replacements.ts`):
  - `rollup` `>=4 <5`, `lightningcss` `>=1 <2` and `@parcel/watcher` `>=2.3 <3`
    are package-contents replacements. When an invocation changed the
    manager's install state (`node_modules/.package-lock.json`, `node_modules/.modules.yaml`,
    `.yarn/install-state.gz`), every installed directory of that name within
    range, nested or in `node_modules/.pnpm`, and in symlinked workspace
    packages, receives the files of `@rollup/wasm-node`, `lightningcss-wasm` or
    `@parcel/watcher-wasm` at the same version, or at the published version
    nearest to it should the replacement have skipped that one. Each file name is removed before it is written, so a
    file pnpm hard-linked from its store is not changed, and the package's own
    `node_modules` stays. This is a post-install rewrite, which ADR-0012
    forbade; it is the only mechanism that treats npm, pnpm and Yarn's
    node-modules linker the same without rewriting their lockfiles.
  - Yarn Plug'n'Play keeps packages in archives, which are not rewritten. After
    a PnP install, each in-range source package is named on stderr with the
    instruction to use `nodeLinker: node-modules`; the exit code is unchanged.
  - `esbuild` is an executable replacement. The manager runs
    with `ESBUILD_BINARY_PATH=/.mimic/bin/esbuild`, a launcher
    Runtime Program; esbuild's own `install.js` records that path in the
    installed package. When executed, the launcher takes the version from the
    `--service=<version>` argument esbuild's API passes to its binary, or from
    the esbuild package resolved from its working directory (the install
    script and the CLI), materializes `@esbuild/wasi-preview1` of that version
    under `/.mimic/replacements`, and replaces itself with it.
    Every esbuild version in a graph therefore runs its own binary.
    `@esbuild/wasi-preview1` starts at 0.22.0. An installed esbuild it was never
    published for is swapped after the install, the same way, for the nearest
    esbuild version that it was published for (0.19.12 becomes 0.22.0), and
    that version's own install script then runs in its directory. The program
    that asked for the older version gets the newer one's API and behaviour;
    the alternative is that it does not run at all. During the install the
    launcher answers the old version's `--version` check; an esbuild left
    unswapped, as in a Plug'n'Play archive, is refused when executed.
  - A package-contents source outside its range is installed as the manager
    installed it and reports itself when executed: its own loader names the
    missing native binding.
- **Package Artifact Cache.** The only cache left holds verified tarball bytes
  of the pinned CLIs and of replacement artifacts, keyed by `name@version`, in
  OPFS with a 256 MiB budget; the oldest entries are evicted. Replacement bytes
  are verified against the registry's integrity on every use, by asking the
  registry for the version's metadata (the cache is on the embedding origin,
  which project code can write; 2026-10-06 security audit), CLI bytes against
  the pinned integrity on every use. The retired `mimic-cache-v1`
  directory is removed.

Compatibility Claims follow: an Exact Graph target names its replacements as
`replacements: { rollup: '@rollup/wasm-node@4.62.3' }`, read back from the
installed `package.json`, instead of a Catalog id, version, digest and
selections recorded in a receipt.

## Reporting `wasm32` to the managers

The hypothesis was that reporting `cpu=wasm32` to the managers would make
napi-rs packages install their own `wasm32-wasi` bindings, removing Catalog
entries. The runtime already reports `process.arch === 'wasm32'` and
`process.platform === 'browser'` (ADR-0016), and npm (`cpu`/`os` default to
the process), pnpm and Yarn (`supportedArchitectures` default to `current`)
take their platform from the process, so no flag is needed.

- **Rolldown: confirmed, entry removed.** `rolldown` 1.0.0-rc.4, 1.1.5 and
  1.2.0 list `@rolldown/binding-wasm32-wasi` (`cpu: ["wasm32"]`, no `os`) as an
  optional dependency. With the companion entry deleted, `npm ci` of the three
  tracked rolldown graphs installs that binding from the registry by itself and
  Rolldown parses through it
  (`tests/e2e/mimic-rolldown-wasi.spec.ts` asserts npm's own
  install-state entry: registry `resolved`, integrity, `cpu: ["wasm32"]`).
  Outside the runtime, the pinned npm 11.18.0, pnpm 11.11.0 and Yarn 4.17.1
  CLIs given `os=browser`/`cpu=wasm32` (`--cpu/--os`, `supportedArchitectures`)
  each install `@rolldown/binding-wasm32-wasi` and no other binding for
  `rolldown@1.1.5`; without them, npm on the host installs
  `@rolldown/binding-darwin-arm64`. `rolldown` 1.2.12 no longer lists the
  wasm32 binding; such a version reports its missing binding itself.
- **rollup, Lightning CSS, esbuild: negative, entries stay.** None publishes a
  `wasm32` optional dependency (`@rollup/rollup-wasm32-wasi` and
  `lightningcss-wasm32-wasi` do not exist; esbuild's optional dependencies are
  native platform packages only, and `@esbuild/wasi-preview1` is not among
  them). Rollup's and Lightning CSS's loaders select a binding by
  platform/architecture name and have no WASI fallback.

## Consequences

- Installs work without a lockfile, with `--no-package-lock` and with no
  dependencies; `npm -s run x`, `pnpm -r build`, `yarn --immutable` and
  `npx tool --flag` reach the CLI as typed
  (`tests/e2e/mimic-package-manager-command-proxy.spec.ts`,
  `package-manager-command-proxies.test.ts`).
- An install is no longer atomic. VFS Transactions have no production caller;
  their removal from the Virtual File System is issue #673
  ([ADR-0022](./0022-remove-vfs-transactions.md)).
- Offline reinstall after a reboot is no longer provided: the managers' own
  caches live in the Virtual File System of one epoch, and the Package
  Artifact Cache holds no project packages.
- pnpm 11.11.0 fetches through its bundled undici, which opens TLS sockets.
  Node Compatibility's `node:tls` carries an HTTP/1.1 client connection over
  browser Fetch: the socket frames each request the program writes with the
  HTTP/1 Wire Codec, sends it as one `fetch`, with the same CORS-simple header
  rule as `https`, and writes the response back as chunked HTTP/1.1 bytes,
  keeping the connection for the next request (`tls.ts`,
  `node-compatibility-tls.test.ts`). TLS to a loopback listener, TLS servers
  and wrapping an existing socket stay unavailable. undici's `fetch` then
  observes the response body with `stream.finished()`, which the
  `readable-stream` port could only do for Node's own web streams; the port's
  `finished()` and `pipeline()` now attach the closed promise they read to the
  platform's streams as those are consumed (`streams.ts`). Yarn 4.17.1's bundle
  compiles and reports its version through the current translator; npm is the
  manager proven end to end, the pnpm and Yarn claims are the proof for theirs.
- pnpm writes `node_modules/.bin` entries as `sh` scripts that call `dirname`,
  `sed` and `uname`; the core utilities provide them, with `basename`.
- Two install scripts that called `execFileSync` at the same time inside one
  install failed with "already synchronously parked", and esbuild's
  synchronous API (`transformSync`, `buildSync`) did not return.
  [ADR-0025](./0025-use-one-synchronous-channel.md) lifted both: Synchronous
  Child Process Execution parks any number of a context's callers, and a
  Worker Thread starts without its parent's event loop.
