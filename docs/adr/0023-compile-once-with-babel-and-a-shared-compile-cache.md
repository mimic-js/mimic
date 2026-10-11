---
status: accepted
amends: ADR-0015 (Module Execution Engine transformer and provenance), ADR-0018 (where the Async Context rewrite runs)
---

# Compile once, with Babel and a shared Compile Cache

Every process worker compiled every module it loaded. ES modules went through
`Babel.transform` into `System.register` form with a source map; CommonJS went
through a full Babel parse followed by text splices. The result was a live
`Function` in an in-memory cache per JavaScript realm, so it could be neither
shared nor persisted, and every process, child process and worker thread, each
a fresh worker, started empty. Starting `vite` recompiled Vite's graph on every
launch, and every process worker carried Babel. CommonJS and ES modules had two
parameter lists, two import trackers and two Async Context rewrites (a Babel
plugin and the splices), and a hand-written VLQ decoder mapped ES module stack
locations back through the source map. Every module, builtin and synthetic
namespace also produced a provenance record (identity, source kind, FNV
fingerprint, compiler fingerprint) and passed an evaluation policy that no
production caller set or read (issue #674, superseding #641).

## Transformer: Babel stays

The candidates had to emit the `System.register` form, which keeps
`require(esm)` synchronous, and the Async Context rewrite of ADR-0018.

Measured on native Node 22.20 (Apple M1 Pro, 8 cores) over Vite 6.4.3's
dependency graph from `compatibility/fixtures/vanilla-vite-6.4.3`: the 17 files
Node loads until `vite` is ready (1.86 MB), and all 105 JavaScript files of the
installed graph (5.49 MB). Each figure is the median of three consecutive
passes in one process, the first of which includes warm-up; the source files
are read once beforehand.

| Candidate | What it does | Readiness graph | Whole graph | Shipped size |
| --- | --- | --- | --- | --- |
| Babel 7.29.7, previous configuration | ESM to `System.register` with source maps; CJS parse and splices | 2,026 ms | 4,223 ms | 3.14 MB minified, 5.34 MB as bundled |
| Babel 7.29.7, this decision | one instrumentation for both formats; ESM to `System.register`; no source maps | 2,046 ms | 4,270 ms | same |
| `@swc/wasm` 1.16.13 | ESM to `systemjs`, no Async Context rewrite | 140 ms | 376 ms | 18.2 MB WebAssembly |
| `@swc/wasm` 1.16.13 | the same, plus the parse that locates `await` operands | 430 ms | 1,177 ms | 18.2 MB WebAssembly |
| `oxc-parser` 0.152 (wasm32-wasi) | parse to ESTree only | 220 ms | 582 ms | 1.49 MB WebAssembly + runtime |
| `oxc-transform` 0.152 (wasm32-wasi) | TypeScript strip only | 65 ms | 174 ms | 3.26 MB WebAssembly + runtime |
| `oxc-transform` 0.152 `moduleRunnerTransform` | ESM to Vite's module-runner form | 57 ms | 115 ms | same |

The new Babel configuration costs what the old one did: its extra parse for
ES modules is paid for by dropping source maps (the previous configuration
measured 2,054 and 4,425 ms in the session that measured the new one).

- **oxc cannot emit the register form.** Its only module lowering is Vite's
  module-runner form, in which every import is an `await`, so an ES module
  could never be required synchronously. It has no plugin API for the Async
  Context rewrite.
- **swc emits the register form but cannot carry the Async Context rewrite.**
  `@swc/wasm` runs no JavaScript plugins. The rewrite would need either a Rust
  plugin built against the exact `swc_core` plugin ABI of the shipped
  `@swc/wasm`, a second compiled artifact to keep in lockstep, or a second
  parse whose AST crosses the boundary as JSON (the fourth row). swc also has no
  equivalent of Babel's `retainLines`: program-visible stack traces would need
  source-map translation in every process, which is what this decision
  removes. And its WebAssembly is 18.2 MB, against 3.14 MB for Babel.

Neither candidate does both, so Babel stays. What made Babel expensive was
running it in every process on every launch, which the Compile Cache removes:
a cached module is never compiled again, and a process worker no longer
carries a compiler. The `node-process-worker` asset shrank from 6,855,420 to
1,126,895 bytes; Babel now lives only in `runtime-artifact-compiler-worker`
(5,719,990 bytes, unminified like every runtime asset), which the Runtime Host
Worker starts when there is something to compile and stops after 15 s idle.
`@babel/standalone` was already a dependency; there is no new one.

## Decision

- **One translation for both formats.** The translator turns a source into the
  text of one function expression. A single source-to-source instrumentation,
  from the parsed program, makes every top-level expression statement report to
  `__trackAsync`, every `import()` call `__import__`, and every `await` and
  `for await` operand pass through the Async Context; an inserted call is
  separated from the keyword before it. A CommonJS script is then evaluated as
  written, so its functions keep their source text; an ES module is lowered to
  `System.register` and TypeScript erased by Babel with `retainLines`. One
  function writes the wrapper for both formats: one runtime scope, plus `System`
  for an ES module or Node's five wrapper parameters, in a nested function, for
  CommonJS. One `import()` implementation serves both, keeping evaluation alive
  until the import settles without reporting a rejection the program handles.
  The VLQ decoder, source maps and the CommonJS-only splice pass are deleted.
- **Stack traces report source lines.** The prologue shares the source's first
  line and the text is evaluated with indirect `eval` instead of `new Function`,
  which put two lines before the body. `tests/unit/module-execution-engine.test.ts`
  ("reports source line numbers in the stack traces programs see") covers
  CommonJS, ES modules, both TypeScript formats, a shebang and a frame after an
  `await`.
- **The Compile Cache.** Compiled output is text keyed by kind, content hash
  (SHA-256 over the UTF-8 source since the 2026-10-06 security audit; the
  host recomputes it and refuses a request whose key does not match its
  source, since a process worker is untrusted) and compiler version
  (`babel@<version>+translator@<RUNTIME_ARTIFACT_TRANSLATOR_REVISION>+key@sha256`). The
  identity of a file is not part of the key, so every copy of a file shares an
  entry. The Runtime Host Worker owns it for the epoch: a 64 Mi-character
  in-memory LRU over a store in the origin private file system, one file per
  entry in a directory per compiler version (other versions are removed on
  open), bounded at 256 MiB of text, removing the oldest-written entries first.
  Concurrent requests for one key share one compilation. A unit test pins the
  translator's output for a fixture set to its revision, so a change to the
  output cannot reuse persisted text.
- **Process workers read it synchronously through their VFS mailbox.**
  `require` stays synchronous: the mailbox gained one `call` operation that
  carries a request to another Runtime Host service without interpreting it,
  and the compile service is that service. A process worker asks by hash; only
  on a miss does it send the source, and that second request goes straight to
  compilation: the store is consulted once per miss. While the host works on a call the worker
  stays parked; the watchdog only bounds how long the host takes to pick the
  call up. No new `SharedArrayBuffer` channel exists; the mailbox is an
  instance of the one synchronous channel of
  [ADR-0025](./0025-use-one-synchronous-channel.md).
- **A bounded compiler pool.** Up to four compiler workers, never more than half
  of `hardwareConcurrency`. Work a context waits for runs first; work ahead of
  first use occupies at most one worker, so it delays a waiting context by at
  most one file.
- **Compiled ahead of first use after an install.** When a Command Proxy's
  install changed the install state and the Browser Package Replacements were
  applied (ADR-0021), the JavaScript under the project's `node_modules`
  (`.js`, `.mjs`, `.cjs`; not `.min.js`, `.bin`, or files over 4 Mi characters)
  is compiled with the format Node gives it, from the nearest `package.json`
  `type`, by the pool's ahead-of-time worker.
- **The provenance layer is deleted.** `recordArtifact`, fingerprints,
  `onArtifact`, `evaluationPolicy`, the out-of-band evaluation failure record
  and the source kinds had no production caller. What remains is the error a
  program sees when a module cannot be compiled or instantiated:
  `RuntimeArtifactError` with its code and, when the compiler or platform
  reported one, the source location. With no fingerprint left, the only
  hashing is the cache key.
- **`node:module`.** `enableCompileCache()` reports `ALREADY_ENABLED`: compiled
  modules are always cached, across processes and reloads. The cache lives
  outside the program's file system, so `getCompileCacheDir()` stays
  `undefined` and `flushCompileCache()` has nothing to flush.

## Time to Vite readiness

`npm run dev` of the tracked `vanilla-vite-6.4.3` graph, from spawn to Vite's
published endpoint, Chromium, one Playwright worker, three runs per tree. Cold
is the first start right after `npm ci` in a fresh browser context; warm is a
second start in the same epoch; after reload is the first start after reloading
the page, booting a new runtime and installing again in the same context.

| Tree | Cold (ms) | Warm, same epoch (ms) | Warm, after reload (ms) |
| --- | --- | --- | --- |
| Before (`704ecac3`) | 3,037 · 3,089 · 3,078 | 3,083 · 3,121 · 3,238 | 2,992 · 3,105 · 3,230 |
| After | 2,571 · 2,557 · 2,593 | 410 · 449 · 448 | 473 · 437 · 480 |

The cold start begins while ahead-of-time compilation of the install is still
running; once it has finished, a first start takes 485 ms
(`tests/e2e/mimic-compile-cache.spec.ts`). The second install, after
the reload, also fell from about 3.8 s to 2.7 s, because npm's own modules come
from the Compile Cache.

## Consequences

- `tests/e2e/mimic-compile-cache.spec.ts` (claim
  `module-execution-compile-once-v1`) proves the cache from outside: the
  install compiles the installed graph before anything loads it, a second
  process compiles nothing, and after a reload, installing, running `node` and
  starting Vite leave the persisted entries exactly as they were.
- A CommonJS source Babel cannot parse is still left to the platform, with
  `import(` routed to the engine, as before. A TypeScript source Babel cannot
  parse is a compile error.
- Non-erasable TypeScript (enums, namespaces, parameter properties) is now
  rejected in `.mts` and package-typed `.ts` modules too, as Node's type
  stripping does; it was rejected only in CommonJS before.
- The minified `await(0, f)()` form no longer joins `await` and the inserted
  call into one identifier, which broke Yarn 4.17.1 and the Lightning CSS
  publisher graph (`ReferenceError: await__awaitInContext is not defined`).
- Compiled text persists per origin. Two tabs share it; the store tolerates
  their concurrent writes because every operation on it may fail as a cache
  miss. The store reads its index in the background when it opens; once the
  index is complete, a key it does not hold is a miss without a lookup in the
  origin private file system, and a key is indexed when its write starts. A
  tab therefore sees what any tab wrote before its index completed and what it
  writes itself, but not another tab's later writes, which it compiles and
  writes again. Skipping those lookups took the Angular 22.1.0 cold start
  (`npm run start` until the application renders, right after a first
  `npm ci`) from 9.8 s to 9.1 s, and from 10.1 s to 9.5 s when the server
  starts within a second of the install (medians of four interleaved runs,
  Chromium, 8-core M1 Pro).
