# Security audit of the runtime: what untrusted project code can reach

**Snapshot:** 2026-10-06, `main` at 51cda87
**Question:** Which serious security problems does the current Mimic
runtime have when the project it runs is not trusted, and what does each one
need to be closed?

The audit read every Runtime Deep Module (ADR-0029) with one threat model: the
project in the Virtual File System, the packages it installs and the documents
its servers publish are attacker-controlled; the embedding page, the Runtime
Host Worker and the other projects that run on the same origin are the targets.
Each finding below is written so it can be filed as one GitHub Issue: the
proposed title is the heading, the body is the section. Line numbers are at
the snapshot revision.

[`roadmap-alignment.md`](../roadmap-alignment.md) already records that the
runtime "is not a security sandbox for arbitrary untrusted repositories". The
audit confirms that statement and makes it concrete: nearly every finding is a
consequence of one design, that untrusted code runs in the origin of the
embedding page, and the rest are ordinary input-validation and resource-bound
gaps at the boundary between a process worker and the Runtime Host Worker.

## Summary

| # | Finding | Severity | Owner module | Fix |
| --- | --- | --- | --- | --- |
| 1 | Published Endpoint documents run in the embedding page's origin | High | Published Endpoint | Preview origin option (ADR-0032) |
| 2 | Project code holds the embedding origin's ambient authority | High | Runtime Host, Node Compatibility | Runtime Host in a frame of the preview origin (ADR-0033) |
| 3 | Compile Cache key is supplied by the untrusted side | High | Module Execution Engine | Cryptographic key, verified by the host |
| 4 | Cached registry tarballs are trusted without re-verification | High | Process Execution (package manager) | Store and re-check integrity on every hit |
| 5 | Children and worker threads open Web Workers without bound | High | Process Execution | Count live workers per context and per epoch |
| 6 | One malformed RPC notification tears down the epoch | Medium | Worker Transport | Total `message` handler |
| 7 | Owner identifiers are arguments, not bound to the connection | Medium | Runtime Host, Virtual Network, Virtual File System | Bind pid/context per served connection |
| 8 | Zip archives are inflated whole inside the VFS authority | Medium | Virtual File System | Bound by central-directory sizes |
| 9 | Synchronous Channel lets a worker starve the host loop and force allocation | Medium | Worker Transport | Yield and allocate lazily |
| 10 | Loopback is defined twice, differently | Low | Virtual Network, Node Compatibility | One predicate |
| 11 | `verifyTarball` accepts `sha1` and any matching candidate | Low | Process Execution (package manager) | Strongest algorithm only |
| 12 | Package names from `napi` metadata are not validated | Low | Process Execution (package manager) | npm name grammar |
| 13 | `reviveError` copies arbitrary properties, including the crash brand | Low | Worker Transport | Drop reserved names |
| 14 | A process worker's `runtimeError` notification fails the epoch | Medium | Runtime Host | Fail that process only |

## 1. Published Endpoint documents run in the embedding page's origin

**Severity:** High. **Labels:** `security`, `published-endpoint`.

**Evidence.** The Service Worker serves endpoint documents from
`self.location.origin` under `<assets>/__mimic__/<epoch>/<route>/<port>/`
(`service-worker.js:11,82`), the page-side host forwards every response header
of the project's server except `set-cookie` and connection headers
(`browser-host.ts:556-570`), and the repository playground embeds the endpoint
URL as `<iframe src={endpoint.url}>` without `sandbox`
(`apps/repo-playground/src/Preview.tsx:43`). The playground opens any public
repository named by `?repo=owner/name`.

**Impact.** HTML and JavaScript a project's server returns run with the
embedding application's origin: `window.parent.document`, `localStorage`,
IndexedDB, the origin private file system (where the Compile Cache and the
Package Artifact Cache live) and the application's cookies are all reachable,
and requests to the application's own API carry its credentials. The Published
Endpoint Cookie Jar is an emulation of `document.cookie` for the endpoint, not a
boundary. A link `playground/?repo=attacker/evil` runs the attacker's document
in the visitor's browser on the playground's origin. `sandbox` on the iframe
does not help: a document whose origin is opaque is not controlled by the
Service Worker, so it would not load at all.

**Fix.** Serve Published Endpoints from a second origin, as WebContainers does
(`*.webcontainer-api.io`). ADR-0030 declined this because "it would need a host
the package does not own"; the resolution is to make the origin a `boot()`
option, `previewOrigin`, that the consumer provides when its deployment serves
the same build from a second hostname, and to keep the same-origin layout as the
default so the package stays self-contained. [ADR-0032](../adr/0032-serve-published-endpoints-from-a-preview-origin.md)
records the design: a bridge document on the preview origin registers the
Service Worker and relays the host connection; endpoint URLs, the
`endpoints.fetch()` frame and the document programs follow the origin; the
page accepts document connections only from that origin. The playground reads
the origin from `VITE_PREVIEW_ORIGIN` and warns that it runs the repository's
code.

**Acceptance.** An e2e claim boots with `previewOrigin` set to the second
origin the test server already answers on (`localhost` against `127.0.0.1`),
publishes a server, loads its document in a frame, proves the document's origin
is the preview origin and that `endpoints.fetch()`, cookies and WebSockets
still work; the same-origin claims keep passing unchanged.

## 2. Project code holds the embedding origin's ambient authority

**Severity:** High (documented limitation). **Labels:** `security`, `runtime-host`.

**Evidence.** Process workers are ordinary same-origin module workers
(`runtime-host/runtime-assets.ts:2-8`). The program's global is
`Object.create(globalThis)` (`node-runtime-program.ts:547`) and modules are
evaluated with indirect `eval` in the real worker scope
(`runtime-artifact-compiler/artifacts.ts:85-90`), so bare identifiers resolve
to the real `fetch`, `XMLHttpRequest`, `WebSocket`, `Worker`, `postMessage`,
`navigator.storage`, `indexedDB` and `caches`. The runtime's own HTTP and TLS
clients send `credentials: 'omit'` (`http.ts:1656`, `tls.ts:351`), which a
direct `fetch` bypasses.

**Impact.** A project can request the embedding application's API with its
cookies, read and write its origin private file system and IndexedDB, create
Web Workers outside Execution Capacity, and send raw `rpc:*` frames to the
Runtime Host Worker (findings 6, 7, 9 are what those frames can do).

**Fix.** Only running the process workers on an origin of their own closes
this, which means running the whole Runtime Host inside a frame of the preview
origin: a larger change than this audit's slice, which ADR-0032 left open and
[ADR-0033](../adr/0033-run-the-runtime-host-in-a-frame-of-the-preview-origin.md)
made. The Runtime Host document, loaded from the preview origin, creates the
Runtime Host Worker and its process workers, so their ambient `fetch`,
storage and workers belong to that origin. The findings below remove what a
process worker can do to the host and to other projects beyond its own
process.

**Acceptance.** `tests/e2e/mimic-preview-origin.spec.ts` proves
that a program's ambient origin, `indexedDB` and `fetch` are the preview
origin's; README and `roadmap-alignment.md` state the trust model that
remains.

## 3. Compile Cache key is supplied by the untrusted side

**Severity:** High. **Labels:** `security`, `module-execution-engine`.

**Evidence.** The process worker computes `hash = contentHash(source)`
(`compile-service.ts:213-224`) and the host's `serve` compiles `request.source`
under `entryKey(kind, request.hash)` without recomputing the hash
(`compile-service.ts:143-151`). Entries persist in the origin private file
system under `mimic-compile-cache/<version>/<key>`
(`compiled-artifact-store.ts:13-18,99-121`), shared by every epoch, tab and
project on the origin, and are read back without any check and evaluated.
`contentHash` is a 64-bit FNV-1a and multiply-rotate mix meant against
accidental collisions (`content-hash.ts`).

**Impact.** Project A sends `{kind, hash: H(react/index.js), source: <code>}`;
project B later asks for `H(react/index.js)` by hash alone, receives A's text
and executes it. Persistent code execution across projects on the origin. A
collision against a target file is also feasible with the current hash, so even
a package that never touches the protocol can poison the cache.

**Fix.** Key by SHA-256 of the source (synchronous, through the `@noble/hashes`
port the runtime already uses); recompute the digest on the host whenever
`source` is present and reject a request whose key does not match; bump the
store version so old entries are not consulted. A process worker that writes
the origin private file system directly can still plant an entry under a
correct key: that residue belongs to finding 2.

**Acceptance.** Unit tests: a mismatching key is rejected and nothing is
stored; a matching key compiles and a later lookup hits; the e2e compile-cache
claim keeps passing.

## 4. Cached registry tarballs are trusted without re-verification

**Severity:** High. **Labels:** `security`, `package-manager`.

**Evidence.** `acquireRegistryTarball` returns cached bytes immediately
(`package-artifacts.ts:49-52`); the registry's `dist.integrity` is used at the
first download only and never stored. `acquirePinnedTarball` re-verifies on
every hit (`package-artifacts.ts:25-33`). The Package Artifact Cache is in the
origin private file system (`artifact-cache.ts:14`), which any project's code
can write (finding 2). `registryPublishes` treats a cache hit as proof that a
version is published (`browser-package-replacements.ts:~328`).

**Impact.** A planted `@esbuild/wasi-preview1@<version>.tgz` or
`@rollup/wasm-node@<version>.tgz` is accepted forever by every later install of
a Browser Package Replacement on the origin.

**Fix.** Store the integrity with the entry and run `verifyTarball` on every
hit; a hit without a stored integrity, or with a mismatch, is a miss.

**Acceptance.** Unit tests: a cached tarball with the wrong integrity and one
without a stored integrity are both fetched again.

## 5. Children and worker threads open Web Workers without bound

**Severity:** High. **Labels:** `security`, `process-execution`.

**Evidence.** Execution Capacity (1 to 8) is checked in `spawn` for root
processes (`process-execution.ts:326-328`; `runnableProcessCount` at 298-299
counts root processes only). `admitChild` checks only the pid stride
(`process-execution.ts:383-412`) and `admitThread` has no count
(`process-execution.ts:425-450`). Each child and each thread opens a real Web
Worker (`runtime-processes.ts:372-382`, `runtime-program-host.ts:398`).

**Impact.** `for (;;) child_process.spawn('node', …)` or `new Worker(…)` from
one admitted process exhausts the renderer that also hosts the embedding page.

**Fix.** Count live children and threads per Execution Context and per epoch;
refuse over the bound with the EAGAIN-shaped error `spawn` already uses.

**Acceptance.** Unit tests: admission over the bound fails with EAGAIN and the
count is released on exit.

## 6. One malformed RPC notification tears down the epoch

**Severity:** Medium. **Labels:** `security`, `worker-transport`.

**Evidence.** A notification (`id === 0`) naming an unimplemented path or a
synchronously throwing method rethrows inside the `message` listener
(`rpc.ts:201-207`); so do a non-iterable `path` (`rpc.ts:175`) and an
`rpc:throw` without `error` (`rpc.ts:241`). In the Runtime Host Worker that
becomes a scope `error` event, which `worker-epoch.ts:84-87` turns into
`epoch.fail` and the page tears down the container. A process worker can post
such a frame through the real `postMessage` (finding 2).

**Fix.** Validate frame shape and make notification dispatch total; a bad frame
is dropped and reported, never thrown out of the listener.

**Acceptance.** Unit tests: each malformed frame leaves the connection usable.

## 7. Owner identifiers are arguments, not bound to the connection

**Severity:** Medium. **Labels:** `security`, `runtime-host`, `virtual-network`, `virtual-file-system`.

**Evidence.** The API served to each process worker
(`runtime-program-host.ts:580-626`) passes caller-supplied `ownerId` to
`network.releaseOwner` and `network.listen` (`virtual-network/service.ts:56-88`;
owners are `String(pid)`), lets `fs.closeSynchronousMailbox(contextId)` close
any predictable mailbox id (`virtual-file-system/service.ts:159-195`), and
`threads.start` runs the thread under `request.identity.pid` after checking
only that the pid is some active process (`process-execution.ts:425-451`); on
exit it releases that pid's network state (`runtime-program-host.ts:693-698`).

**Impact.** One project process can close another's listeners, sockets and
synchronous Virtual File System channel. Denial of service between processes
of one container; no data exposure.

**Fix.** Close over the process's own pid and context on the host side and
ignore or reject ids the caller supplies.

**Acceptance.** Unit tests: a served API cannot release another owner's
listeners nor close another context's mailbox.

## 8. Zip archives are inflated whole inside the VFS authority

**Severity:** Medium. **Labels:** `security`, `virtual-file-system`.

**Evidence.** Any lookup of a path through `x.zip/…` calls fflate's
`unzipSync` over the whole archive with no bound on uncompressed size or entry
count, in the Runtime Host Worker that owns the Virtual File System
(`virtual-file-system.ts:1078-1116`); the result is cached per archive.

**Impact.** A small archive that inflates to gigabytes, followed by
`fs.statSync('bomb.zip/x')`, exhausts the Runtime Host Worker and ends every
process, not only the offending one.

**Fix.** Read the central directory first and refuse archives over a total
uncompressed size or entry count; bound the archive cache by inflated bytes.

**Acceptance.** Unit test: an archive whose central directory exceeds the bound
is refused without inflating.

## 9. Synchronous Channel lets a worker starve the host loop and force allocation

**Severity:** Medium. **Labels:** `security`, `worker-transport`.

**Evidence.** `serve()` handles the `request`, `responseTaken` and `timedOut`
states with `continue` and awaits only in the default branch
(`synchronous-rpc.ts:378-400`), and allocates `MESSAGE_LENGTH` bytes, up to
256 MB, before any payload arrives (`synchronous-rpc.ts:350-363`). A process
worker holds the raw `SharedArrayBuffer` (finding 2).

**Impact.** A worker spinning the state word keeps the single-threaded Runtime
Host Worker from yielding, so every other process and the page's `fs` calls
stall; two channels per process can demand about 512 MB of host heap.

**Fix.** Yield a macrotask after a bounded number of consecutive non-waiting
iterations; allocate the receive buffer as chunks arrive.

**Acceptance.** Unit tests: a competing task runs while a channel spins; no
allocation before the first chunk.

## 10. Loopback is defined twice, differently

**Severity:** Low. **Labels:** `virtual-network`, `node-compatibility`.

**Evidence.** `virtual-network/authority.ts:348-351` treats `127.0.0.1`,
`localhost` and `::1` as loopback; `tls.ts:511-514` treats `127.*`, `0.0.0.0`,
`::1` and `localhost`. `http.request('http://127.0.0.2:8443/')` therefore gets
`EXTERNAL_TRANSPORT_UNSUPPORTED` and is sent by the browser's `fetch`, without
credentials and under CORS and private-network rules.

**Fix.** One predicate covering 127/8, `0.0.0.0`, `::1`, `localhost` and
`*.localhost`, used by both.

## 11. `verifyTarball` accepts `sha1` and any matching candidate

**Severity:** Low. **Labels:** `package-manager`.

**Evidence.** `npm-tarball.ts:283-297`: `strongest` is `candidates[0]`, and a
`sha1-… sha512-…` integrity passes on the sha1 match alone.

**Fix.** Prefer sha512, then sha384, then sha256; refuse sha1-only integrity.

## 12. Package names from `napi` metadata are not validated

**Severity:** Low. **Labels:** `package-manager`.

**Evidence.** `napiCompanions` takes `napi.packageName ?? found.name` from any
installed `package.json` (`browser-package-replacements.ts:~205-212`); the name
reaches registry URLs with only the first `/` encoded
(`package-artifacts.ts:231,244-246`), `npm install <name>@<version>`, and VFS
paths under `node_modules/.mimic/companions/<name>/<version>`. The
registry host is a constant, so the download cannot leave the registry.

**Fix.** Validate against npm's package-name grammar where the name is read;
encode every `/`.

## 13. `reviveError` copies arbitrary properties, including the crash brand

**Severity:** Low. **Labels:** `worker-transport`.

**Evidence.** `rpc.ts:92-98` applies `serialized.properties` to the revived
error, so a process worker's `fail(error)` can set
`mimicWorkerFailure: true` (`process-worker-protocol.ts:87-97`) and
have an exit reported as a worker crash, or override `code`.

**Fix.** Do not copy `name`, `message`, `stack` or the crash brand; brand
crashes on the host side.

## 14. A process worker's `runtimeError` notification fails the epoch

**Severity:** Medium. **Labels:** `security`, `runtime-host`.

**Evidence.** The API served to a process worker routes `runtimeError` to
`context.emitter.emitError` (`runtime-program-host.ts:635-636`), which is the
host's `onBackgroundFailure` (`runtime-program-host.ts:240`), which
`worker-epoch.ts:319` turns into `failAdapter('runtime-program', …)`: an
epoch failure. The Node program itself reports through it when an `exit`
listener throws (`node-runtime-program.ts:360-370`), which is application
code, and a worker can post the frame directly (finding 2). Found while
fixing finding 7.

**Impact.** `process.on('exit', () => { throw new Error('x') })` in any
project, or one forged notification, tears down the container and every other
process.

**Fix.** Treat `runtimeError` as that process's failure, as `fail` is; the
emitter stays for faults the host itself observes.

**Acceptance.** A program whose `exit` listener throws ends with an error
while the container and its other processes keep running.

## Checked and not a problem

- Pinned Package Manager Toolchains: constant registry URLs, hardcoded sha512,
  verified before use and on every cache hit (`package-manager-clis.ts:22-65`,
  `package-artifacts.ts:25-33`).
- Tar and zip extraction: absolute paths, `..`, symlink and hardlink entries
  rejected; sizes and offsets checked against the buffer; checksums validated
  (`tar-archive.ts:109-116,176-189,266-293`, `zip-archive.ts:590-690`).
- WASI Execution: every guest pointer and length passes `inBounds` before
  memory access; preopen confinement with `realpath`; u64 values range-checked
  as BigInt; fds 0 to 2 cannot be closed (`wasi-execution.ts`).
- Worker Transport dispatch: `__proto__`, `constructor` and other
  `Object.prototype` names are refused (`rpc.ts:178`, `synchronous-rpc.ts:503`);
  the value codec defines keys on fresh objects and reconstructs a fixed type
  set only; decode is bounded by payload length.
- `node:vm` offers `runInThisContext` only and throws `ERR_NOT_SUPPORTED` for
  contexts (`vm.ts:19-25`): no fake isolation.
- `node:crypto`: WebCrypto randomness, `@noble/hashes` digests, constant-time
  `timingSafeEqual`; unsupported primitives throw rather than return wrong
  results.
- `node:dns` and `node:http2` are `ENOTSUP` stubs; loopback through the Node
  APIs never reaches the real network; `tls.connect` reports TLS only over
  `https:` fetch, where the browser performs it.
- Published Endpoint `Set-Cookie` goes to the Cookie Jar, never to the browser's
  jar (`cookie-jar.ts:81-89`, `browser-host.ts:122-130`).
- A `Service-Worker-Allowed` header from a project's server does not let its
  document register a Service Worker on the host origin: the browser fetches a
  Service Worker script without going through the controlling Service Worker,
  so the script would have to exist on the real server.

## Residual risk after this slice

With findings 1 to 14 closed, a project with a preview origin configured
reaches the embedding page only through what the Runtime Host serves on its
port: its process workers and its published documents hold the preview
origin's ambient authority, which hosts nothing. It can no longer poison what
other projects execute through the Compile Cache protocol or install through
the Package Artifact Cache protocol, or take down the Runtime Host Worker or
other processes through the transport. What remains, documented in the README:
the tab's CPU, memory and worker budget; the preview origin serves any page
that embeds its Runtime Host document; and projects on the same preview
origin share that origin's storage with each other and with their previews.
Without a preview origin the page's own origin is the runtime's, as a
self-contained deployment of trusted code needs.
