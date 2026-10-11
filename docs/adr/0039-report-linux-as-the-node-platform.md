---
status: accepted
supersedes: ADR-0016 (the operating system a program reads)
amends: ADR-0028 (the identity the companion bindings rely on)
amended_by: ADR-0045 (`process.versions.webcontainer` is set)
---

# Report `linux` as the Node platform

ADR-0016 had `process.platform` and `os.platform()` report `browser`, the
operating system of the Runtime Platform Profile, and accepted that "a package
that accepts only a fixed list of platforms rejects it". The demo application
pool of 2026-10-09 ([research](../research/2026-10-09-demo-app-pool.md)) shows
how many do: `cachedir` throws for an operating system it does not know (the
Nx 21 recipes stop in their install), puppeteer's install script and Stencil's
bundled Rollup refuse the pair outright, and every NAPI-RS loader records
`Unsupported OS: browser` before it falls back. None of them has a branch a
browser could take; each only needs a platform Node itself reports.

## Decision

**The Runtime Platform Profile's operating system is `linux`.**
`process.platform`, `os.platform()`, `os.type()`'s family, `uname -s`
(`Linux`) and `uname -o` (`GNU/Linux`) report it. The architecture stays
`wasm32`, the runtime stays `browser`, and the Node version stays the one the
profile names.

- **Binding selection is unchanged.** A NAPI-RS loader on `linux` finds no
  native package for `wasm32` and falls back to the WASI binding, as it did on
  `browser`; npm, pnpm and Yarn still read `cpu` from `process.arch`, so a
  native optional package (`cpu: ["x64"]`) is still left out and a WASI one
  (`cpu: ["wasm32"]`) still installed. The companions of ADR-0028 apply as
  before.
- **A glibc Linux.** `process.report.getReport().header.glibcVersionRuntime`
  names a glibc release, which libc detection (NAPI-RS loaders, `detect-libc`)
  reads instead of running `ldd`, which the runtime does not have.
- **Compatibility Claims attest `linux`/`wasm32`.** The `virtualPlatform` of
  every Exact Graph names the new operating system; the graphs, lockfiles and
  replacements are unchanged, because the managers never selected anything by
  operating system for a `wasm32` process.

## Consequences

- A program that switches on the platform takes its Linux path: `cachedir`
  answers `~/.cache`, Node-only tools stop rejecting the runtime.
- A program may now try Linux facilities the runtime does not have — `/proc`,
  `ldd`, `xdg-open` — and finds them missing as on a minimal container, which
  it already handles more often than an unknown platform.
- Linux paths that run a basic system command find it: `getconf LONG_BIT`
  answers `32` for `wasm32` (the `arch` package, which clipboardy and Cypress's
  installer call, throws without it), alongside `uname`.
- WebContainers report the same `linux`/`wasm32` pair. The runtime still sets
  no `process.versions.webcontainer`, so loaders keep their own WASI fallback
  rather than a WebContainers-specific installer.
