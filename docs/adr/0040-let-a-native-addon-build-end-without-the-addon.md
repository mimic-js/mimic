---
status: accepted
amends: ADR-0021 (what an install does with a native addon build)
---

# Let a native addon build end without the addon

A package with a native addon builds it in an install script: `node-gyp
rebuild`, `prebuild-install || node-gyp rebuild`, `node-gyp-build`. Here none
of that can work — there is no Python, no C/C++ compiler, and an addon built
for any platform would not load in a browser — and the failed script failed
the whole install: Angular 18 and Gatsby through `lmdb`, the Socket.IO chat
example through `sqlite3`, Snowpack through `utf-8-validate`
([demo pool, 2026-10-09](../research/2026-10-09-demo-app-pool.md)). Many of
these packages can do without the addon: `ws` falls back to JavaScript when
`utf-8-validate` has no binding, and Angular's build disables its persistent
cache when `lmdb` does not load.

## Decision

**The runtime's native build reports that the package stays without its
addon, and succeeds.** `node-gyp` is a core utility Runtime Program
(`process-execution/core-utilities.ts`): `build`, `rebuild`, `configure` and
`install` print one `gyp info` line naming the package and exit 0;
`--version` answers a node-gyp release. `configure` and `rebuild` leave a
`build` directory holding only `config.gypi`, and `clean` and `rebuild`
remove it, as node-gyp does: node-pre-gyp moves that directory around the
build of each N-API version. It runs however an install reaches node-gyp:

- the `node-gyp` command, on `PATH` or through npm's `node-gyp-bin` wrapper;
- `npm_config_node_gyp`, which npm points at its own copy;
- any installed copy's bin, `…/node_modules/node-gyp/bin/node-gyp.js`, which
  `node-gyp-build` and `node-gyp-build-optional-packages` spawn through
  `process.execPath` when they resolve one: executable resolution substitutes
  the Runtime Program for that entry (a *script program*), by path, without
  reading any package's name.

The install then completes, and the package meets the missing addon when a
program loads it: one with a fallback uses it, one without reports its own
"could not locate the bindings file" error at that point.

## Consequences

- An install no longer fails because of a native addon. A program that needs
  the addon fails later, when it loads it, which names the package instead of
  an npm lifecycle error.
- `prebuild-install` and `node-pre-gyp` still try to download a prebuilt
  binary for `linux-wasm32` first; none exists, and their fallback to
  `node-gyp` ends here.
- A replacement with a WASI or WebAssembly build (ADR-0021, ADR-0028) remains
  the way a package actually gets its native functionality; this decision only
  stops the build that cannot happen from failing the install.
