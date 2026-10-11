---
status: accepted
amends: ADR-0015 (Node Compatibility owns the pure builtins it used to host in the Runtime Host), ADR-0025 (where the per-process shared memory pool is created)
---

# Take pure Node builtins from maintained ports

Every Node builtin was written in this repository, including the ones that
touch no runtime capability: about 1,800 lines of streams, 850 of
`util.inspect`, 800 of `Buffer`, hand-coded SHA tables, `assert`, `util`,
`events`, `string_decoder`, `querystring`, and about 570 lines of `path`,
`url`, `os`, `v8`, `tty`, `readline` and `perf_hooks` inside
`runtime-host/execution-context-runtime.ts`. Commit d8d092e3 fixed silent wrong
results in four of them; that is the class of defect hand-written copies of
well-specified modules produce (issue #675).

Node Compatibility now owns only what projects runtime capabilities (`fs`,
`net`, `http`, `child_process`, `worker_threads`, `process`, `module`, `vm`,
`wasi`, `sqlite`, Async Context) and takes a pure builtin from a maintained port
wherever the port holds the runtime's claims for Node 22.22.3, the version
`process.version` reports.

## Decision

Every choice was made by swapping the port in and running the Node
Compatibility unit claims, a differential probe against Node 22.20 (the host
Node; same major line as the claimed 22.22.3), and the Compatibility Evidence
Matrix.

| Builtin | Choice | Evidence |
| --- | --- | --- |
| `stream`, `stream/promises` | **`readable-stream@4.7.0`** (nodejs org, Node 18.19.0's streams, Jan 2025) | Run against Node 22's own `stream`, 23 of the 37 local stream claims failed: they described the local implementation (strings left as strings, `Readable()` throwing without `new`, synchronous `close`, `drain` after `end`, `isWritable(readable) === false`). Rewritten to Node 22's behaviour, the port passes all 37; 35 also pass on Node 22 (the other 2 check this runtime's `default` export). The events-and-streams claim's program failed on Node 22 the same way and was corrected. |
| `events` | **`events@3.3.0`** | Over 500 random sequences of `on`/`once`/`prepend*`/`off`/`emit`/`removeAllListeners`/`listeners`, the port matched Node 22 in all 500 and the local emitter in none (no `newListener`/`removeListener` events). Its last release is from 2021, the one adoption of an unreleased port: Node has not changed the emitter core it implements, and it is the emitter `readable-stream` is built and tested against. |
| `string_decoder` | **`string_decoder@1.3.0`** (nodejs org) | Over 400 random split byte sequences per encoding, the local decoder differed from Node 22 in 27 (UTF-8), 219 (UTF-16LE), 400 (base64), 400 (hex) and 275 (latin1); the port in 25 UTF-8 sequences and none otherwise. |
| `util.inspect`, `util.format`, `util.stripVTControlCharacters` | **`node-inspect-extracted@3.0.2`** | Node's `lib/internal/util/inspect.js` with only its `require` calls replaced. 3.0.2 is the release that tracks Node 22.0.0; 3.1+ track Node 24–26 and print symbol keys as Node 22 does not. All local inspect, format and console claims pass. |
| `crypto` digests, HMAC, PBKDF2 | **`@noble/hashes@2.4.0`** (audited; released Aug 2026) | `getHashes()` grows from 5 to 14 digests (adds SHA-224, SHA-512/224, SHA-512/256, SHA3, RIPEMD-160); every digest is compared with Node for every length from 0 to 300 bytes, whole and in three updates. Web Crypto keeps randomness and `subtle`. |
| `path` (POSIX) | **`path-browserify@1.0.1`** | Over 2,314 calls, the local `path` differed from Node 22 in 101 (trailing separators, `relative`, `format` missing) and the port in 1. |
| `url` (legacy API) | **`url@0.11.4`** | Over 87 `parse`/`format` probes, the local implementation (a projection of WHATWG `URL`) differed from Node 22 in 47 and the port in none; it also brings `resolve`, `resolveObject` and `Url`. |
| `buffer` | keep local | `buffer@6.0.3` (last release Nov 2020) is stale against Node 22: no `base64url`, `Buffer.copyBytesFrom`, `isUtf8`, `isAscii`, `transcode`, `Blob`, `File`, `atob`/`btoa`; it fails the data claim's `base64url` round trip. |
| `assert` | keep local | `assert@2.1.0` (Node 10's assert over `util@0.12`) fails three of the four assert claims; Node 22 itself passes two of those three (a deep-equality case, the `throws` matcher message). It would add `util@0.12` and 13 polyfill packages. Its messages now print through the adopted `inspect`. |
| `util` (except the above) | keep local | `util@0.12.5` (2022) lacks most of Node 22's later API (`parseArgs`, `styleText`, `parseEnv`, `MIMEType`, `isDeepStrictEqual`, `aborted`, `getSystemErrorName`, ...) and inspects a `Map` as `{}`. |
| `querystring` | keep local | `querystring-es3@0.2.1` was last released in 2014: it differs from Node 22 in 15 of 31 probes (throws `URIError` on a malformed escape, has no `escape`/`unescape`). The local module now parses into a null-prototype object with `maxKeys`, keeps malformed escapes and writes only primitives, and matches Node 22 in all 31. |
| `path.win32` | keep local | No maintained browser port carries Node's win32 half (`path-browserify` is POSIX only; `path-unified` reads an undeclared `process` at import and throws in a Worker). It translates separators over the adopted POSIX functions. |
| `os`, `v8`, `tty`, `readline`, `perf_hooks` | keep local | `os` reports the runtime's one platform identity (ADR-0016), which `os-browserify@0.3.0` (2017) cannot; no browser port implements V8's serializer; `tty-browserify` (2018) and `readline-browserify` (2012) are unmaintained; `perf_hooks` is the platform's `performance`. |

## How a port is wired

- **Ports are realm-wide.** A builtin is a port's module, not a factory per
  Execution Context. Process stdio, sockets, HTTP messages, file, child
  process and compression streams all extend the realm's stream classes, and
  `node:buffer` is one module per realm. In production every Execution Context
  is its own worker realm (ADR-0020, ADR-0025); contexts that share a realm (the
  unit tests) share the ports.
- **A port's own Node dependencies resolve to the runtime's modules.** The
  ports name `buffer`, `events`, `process/` and (for `url`) `qs` by bare
  specifier. `vite.node-compatibility.ts` aliases each to
  `node-compatibility/port-dependencies/*`, which read the runtime's module
  from one realm-wide slot filled by `port-dependencies/provide.ts`. So a port
  and a program share one `Buffer`, one `EventEmitter` and the context's
  `querystring`, and the port's `nextTick` carries the Async Context frame
  (ADR-0018). The slot, not a direct import, survives a dependency optimizer
  copying an alias target into a port's chunk. The package build, the
  development server and the unit tests apply the same aliases, and the latter
  two pre-bundle the ports up front.
- **Thin Node 22 layers, nothing more:** WHATWG adapters
  (`Readable/Writable/Duplex.fromWeb`/`toWeb`) and the 64 KiB default
  high-water mark on the streams; `EventEmitterAsyncResource`,
  `addAbortListener`, static `getMaxListeners`/`setMaxListeners` and
  `captureRejectionSymbol` on the emitter; TypedArray input on the string
  decoder; the context's working directory, `toNamespacedPath` and
  dot-less `format` extensions on `path`; `qs` mapped to `querystring` for
  `url`; `Buffer.prototype[inspect.custom]`.
- **No consumer dependency.** The ports are `devDependencies`, bundled into
  the published worker assets like the rest of the runtime, and no published
  type reaches them. All are MIT licensed, as are their bundled dependencies
  (`punycode`, `safe-buffer`, `abort-controller`'s browser entry).

## Known gaps

Each is a gap of the adopted port against Node 22, recorded so it is not
mistaken for a runtime claim:

- `Writable#end(callback)` is not called back with the error of a failing
  `_final` (Node 18.19's streams; Node 22 calls it after `close`).
- `StringDecoder` replaces some malformed UTF-8 sequences with fewer U+FFFD
  characters than Node 22's native decoder.
- `events.errorMonitor`, `captureRejections`, `events.on` and
  `getEventListeners` are absent, as they were before.

## Consequences

- Deleted: the local streams, inspect, hash tables, emitter, string decoder,
  the per-context `Buffer` subclass and stream-builtin plumbing, the
  `legacyCallableStream` proxy outside `fs`, and the dead helpers `toBytes`,
  `toTransferableArrayBuffer` and `arrayHeader`.
  `runtime-host/execution-context-runtime.ts` keeps only the Execution Context.
- Runtime code that relied on local stream extensions now uses Node's:
  sockets emit `close(hadError)` themselves (`emitClose: false`), stop their
  transport in `pause()` and keep it stopped while the stream reads ahead on
  its own; an HTTP message emits `aborted` from its `_destroy` and counts only
  a program's reads as consumption, so a request destroyed before its
  response is read holds no activity; a child output stream reports its
  destroy error; zlib reports a corrupt chunk through `callback(error)`.
- Claims that described the local implementation instead of Node were
  corrected against Node 22: the stream unit claims above, the events and
  streams claim (no `drain` for a write that completes while the stream is
  ending), the process tree claim (ends child stdin after `drain`), HTTP
  lifecycle timing (`close` a tick after `destroy`), `isWritable` of a
  `Readable` (`null`) and `pipe` of a non-emitter (`TypeError`).
- The Runtime Host Worker no longer bundles Node Compatibility: the
  per-process shared memory pool it creates for Worker Threads moved to
  Process Execution (`worker-thread-shared-memory.ts`), the one value the host
  took from Node Compatibility, whose ports are not tree-shakeable.
- Bundle size of the published assets (`pnpm build:package`, unminified as
  shipped; gzip -9 in parentheses):

  | Asset | Before | After |
  | --- | --- | --- |
  | `node-process-worker` (one per Runtime Process) | 977,584 B (258,071 B) | 1,249,276 B (316,488 B) |
  | `worker` (Runtime Host Worker) | 581,454 B (165,918 B) | 417,594 B (94,483 B) |
  | all JavaScript assets and `mimic.js` | 7,524,175 B (1,356,206 B) | 7,632,007 B (1,343,189 B) |

  The other assets are unchanged. Every Runtime Process worker grows by 28 %
  (23 % gzipped): by source map, the ports take about 356 kB of it
  (`readable-stream` 164 kB, `node-inspect-extracted` 97 kB, `@noble/hashes`
  39 kB, `url` 16 kB, `events` 12 kB, `path-browserify` 12 kB, `punycode`
  8 kB, `string_decoder` 6 kB), while the runtime's own code in it shrinks
  from 760 kB to 659 kB. The Runtime Host Worker shrinks by 28 % (43 %
  gzipped).

## Rejected alternatives

Adopting a stale port everywhere (`buffer@6`, `util@0.12`, `assert@2`,
`querystring-es3`) would trade known Node 22 behaviour for older behaviour.
Vendoring the ports would re-create the hand-maintained copies this decision
removes. A whole stdlib catalog (`node-stdlib-browser`, `@jspm/core`,
`unenv`) duplicates the builtin table and stubs the capability-backed modules
(research: `docs/research/reusable-node-compatibility-implementations.md`).
