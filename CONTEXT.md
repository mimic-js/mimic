# Mimic domain language

This glossary defines the canonical vocabulary of the Mimic runtime: the terms used in code, tests, ADRs and research notes for how Mimic runs Node.js programs, package managers and dev servers inside a browser tab, and for how its compatibility is proved. Each entry names the term to use and the terms to avoid.

## Language

### Runtime architecture

**Headless Runtime Core**:
The Mimic library boundary that executes workloads in a cross-origin-isolated browser context without owning application UI.
_Avoid_: Runtime-owned preview UI, library iframe adapter, degraded non-isolated runtime

**Runtime Deep Module**:
A package-internal responsibility owner reachable by other modules only through its entry point and the dependency graph declared by ADR-0015.
_Avoid_: Small-file module, public plugin, independently published runtime package

**Runtime Host**:
The single owner of the lifetime and composition of one Mimic runtime epoch; browser-placement collaborators remain private beneath it.
_Avoid_: Runtime Supervisor, Runtime Supervisor Client, split lifecycle authority, shared cross-runtime host

**Runtime Host Worker**:
The dedicated worker that runs one epoch's authorities, Process Execution, and every Runtime Program, and creates its process workers; the Runtime Host Document creates it, and the page keeps only the Mimic facade, connected over a MessagePort (ADR-0020, ADR-0033).
_Avoid_: Page-hosted Runtime Program, main-thread program host, relay through the page, page-created Runtime Host Worker

**Runtime Host Document**:
The package's hidden-frame document, loaded by the page from the Preview Origin, that creates the Runtime Host Worker from the page's asset manifest, registers the Service Worker and runs the Published Endpoint host beside it, so that a project's processes and documents hold that origin's authority and not the page's (ADR-0033).
_Avoid_: Bridge document, page-side Published Endpoint host, consumer-written sandbox frame

**Process Worker**:
A dedicated worker the Runtime Host Worker creates to run one JavaScript or WASI Runtime Process, or one Worker Thread of a JavaScript Runtime Process, whose own port reaches the Virtual File System and Virtual Network authorities in one hop.
_Avoid_: Page-created worker, two-hop relay, in-process child or thread

**Runtime Process**:
The Process Execution-owned lifecycle identity for one executing program, including stdio, signals, exit, children, and cleanup.
_Avoid_: Browser Worker, module evaluation, Worker Thread

**Runtime Program**:
A package-internal program implementation admitted through Process Execution's ordinary command-resolution and lifecycle path.
_Avoid_: Parallel command runner, process interceptor, Supervisor program adapter

**Runtime Program Registry**:
The one table of Runtime Program ids and the commands they own, against which every command resolves through the one executable resolver.
_Avoid_: Per-context program table, stub program, second resolver

**Process Execution**:
The deep module that owns command resolution, spawn admission, process trees, worker isolation, capacity, stdio, signals, exit, and cleanup.
_Avoid_: Command-specific process runner, public command registry, broad runtime capability bag

**Synchronous Child Process Execution**:
The package-neutral behavior in which a Runtime Process parks its own Node-shaped caller while an ordinary child runs through Process Execution and returns captured stdio and its terminal result over the caller's Synchronous Channel; any number of a context's processes may be parked at once.
_Avoid_: Busy wait, same-context child evaluation, in-process child, package-specific synchronous runner

**Virtual File System**:
The single authoritative inode and namespace state machine for Mimic: one mutable state that a commit changes in place or, when rejected, leaves unchanged, with watches and Open File Descriptions (ADR-0022).
_Avoid_: Node-owned filesystem authority, per-worker mutable filesystem, client relay, VFS Transaction, copy-on-write layer

**Open File Description**:
The Virtual File System-owned state for one open inode, including its offset and status flags, referenced by opaque process-local descriptor handles.
_Avoid_: Path-backed descriptor record, descriptor number as filesystem identity

**VFS Commit Journal**:
The bounded revision-ordered record used to invalidate VFS client caches after committed mutations, with explicit resynchronization when required history has expired.
_Avoid_: New Change Feed subsystem, mutation broadcast, unbounded history

**Virtual Network**:
The sole runtime-local byte-stream socket and listener authority; it does not represent Fetch or browser WebSocket as raw sockets.
_Avoid_: Browser Adapters module, Fetch-backed raw socket, complete TCP/IP emulation

**Listener Protocol Claim**:
A lifecycle-bound declaration that an active Virtual Network listener serves a named application protocol, consumed by Published Endpoint without making Virtual Network protocol-aware.
_Avoid_: Protocol sniffing, publication command, listener-independent claim

**Published Endpoint**:
The deep module that owns browser publication of a claimed Virtual Network listener, including stable URL identity, routing, cookies, document handling, WebSocket hosting, invalidation, and disposal; it delivers each request to the listener's `http.Server` as a Published HTTP Exchange (ADR-0024).
_Avoid_: Runtime preview, runtime-owned iframe, preview server, separate host/router authority, HTTP/1 serialisation of a published request

**Published HTTP Exchange**:
One published request and its response carried as structured values between the Published Endpoint host and the process worker that owns the listener: method, target, headers and a body stream in, status, headers, interim statuses and a body stream out, with backpressure and cancellation.
_Avoid_: Loopback socket, HTTP/1 bytes over a MessagePort, buffered body

**Published WebSocket Session**:
One published WebSocket served by the process worker that owns its listener: the worker is the RFC 6455 client of the server's `upgrade` socket and carries whole messages to the document on a port of their own, each direction acknowledged by count, with each side watching the other's Web Lock (ADR-0038).
_Avoid_: WebSocket frames in the document, socket bytes through the Runtime Host Document, host-tracked socket sessions

**Published Endpoint Cookie Jar**:
The HTTP cookie authority for one Published Endpoint logical origin.
_Avoid_: Application-origin cookie reuse, Service Worker cookie authority, cross-endpoint cookie sharing

**Preview Origin**:
The origin a consumer names in `boot({ previewOrigin })` that serves the Runtime Host Document, the runtime's workers and the Published Endpoints, so that a project's processes and documents run outside the embedding page's origin; the page's own origin when none is named (ADR-0032, ADR-0033). A wildcard such as `https://*.preview.example` is an Endpoint Origin per port, with the Runtime Host Document on the wildcard's fixed label (ADR-0044).
_Avoid_: Sandboxed preview frame, runtime-owned hostname, page-origin process workers

**Endpoint Origin**:
The origin `<protocol>//<epoch>--<port>.<suffix>` that serves one port of a container at its root when the Preview Origin is a wildcard, so that a document sees the path its server sees; its Service Worker is registered for the root by the package's Endpoint Origin Document, loaded by the Runtime Host Document in a hidden frame, which also carries the host connection to that worker (ADR-0044).
_Avoid_: Path-prefixed endpoint, origin per route, rewritten `location`, bridge document on the page

**HTTP/1 Wire Codec**:
The package's one parser and serializer for HTTP/1 byte framing, used by Node Compatibility where HTTP travels as bytes: over `node:net` connections and in the head a program writes on a socket handed over after `upgrade`.
_Avoid_: Per-caller HTTP parser, Fetch policy in the codec, HTTP/1 framing in Published Endpoint or the Service Worker

**Worker Transport**:
The sole package-internal owner of browser messaging: one typed RPC in which the caller drives an interface shared with the callee through a generic proxy, an error the callee throws rejects only that call and is rethrown at the call site, and events travel as notifications (ADR-0019); an interface served in the calling context is driven the same way, one task and copied values per call (ADR-0020); and its synchronous counterpart, the Synchronous Channel (ADR-0025).
_Avoid_: WorkerPeer, per-module service/client/peer layers, result wrapper, transport-level cancellation or capacity, Transport Session, domain/version registry, domain semantics in transport

**Synchronous Channel**:
The one way a worker blocks until another context answers: a `SharedArrayBuffer` with one layout, wait/notify state machine and chunking, through which the caller drives an interface the callee serves from its event loop, values crossing in the one binary encoding; the VFS mailbox, a process worker's channel to its host (synchronous children, `receiveMessageOnPort`) and WASI stdin are its instances (ADR-0025).
_Avoid_: Per-caller mailbox, bespoke codec, base64 or number-array bytes, shared arena

**Worker Thread Port Relay**:
The ordered queue, implemented by Node Compatibility and run by the Runtime Host, for each `MessagePort` end of a process whose other end is in another thread; a listening thread receives by structured clone, a thread in `receiveMessageOnPort` takes the next message over its Synchronous Channel (ADR-0025).
_Avoid_: Shared-memory port arena, JSON message codec, direct receive from a native port

**Module Execution Engine**:
The context-local owner of Node module resolution, loading, the Module Registry, linking and evaluation; it compiles through the epoch's Compile Cache.
_Avoid_: Project-provided execution engine, second module cache, Vite-specific loader

**Compile Cache**:
The Runtime Host-owned store of compiled module text, keyed by kind, content hash and compiler version, shared by every context of an epoch, persisted in the origin private file system, and filled by a bounded compiler pool on demand and after installs (ADR-0023).
_Avoid_: Per-realm compiled-function cache, compiler in every process worker, artifact provenance record

**Module Registry**:
The context-local authority for canonical module identity, lifecycle, linking, evaluation, and CJS/ESM interop.
_Avoid_: Separate CJS and ESM authorities, shared cross-context module state

**Async Context**:
The realm-wide frame of `AsyncLocalStorage` stores that the Module Execution Engine re-enters whenever a compiled continuation, promise reaction, or scheduled callback resumes (ADR-0018).
_Avoid_: Store restored when `run` returns, per-builtin store propagation, frame inherited by an uninstrumented job

**Node Compatibility**:
The context-local deep module that exposes Node globals and builtins through one lazy builtin table and explicit adapters over runtime capabilities; builtins that touch no runtime capability come from maintained ports wherever one holds the Node 22 claims (ADR-0026).
_Avoid_: Separate stdlib registry, per-builtin semantic cores, Browser Adapters module, recursive error proxy, hand-written copy of a pure builtin a maintained port provides

**WASI Execution**:
The deep module that owns supported WASI ABI admission, instance lifecycle, descriptor state, and syscall semantics for both Runtime Programs and `node:wasi`.
_Avoid_: WASI syscalls in Process Execution, package-specific WASI host

**Shell Program**:
The runtime-owned ordinary Runtime Program that owns shell syntax and redirection and launches every external command through Process Execution.
_Avoid_: Separate shell authority, shell grammar in Process Execution, POSIX parity claim

**Command Proxy**:
A concrete Runtime Program for a package-manager command that runs the pinned upstream CLI as a child Runtime Process with the caller's arguments untouched, passes its output, signals, and exit code through, and applies the Browser Package Replacements after the CLI changed the installed packages (ADR-0021).
_Avoid_: Process middleware, generic package-manager base class, side-effect registration, mutation/execution classification

**Browser Package Replacement**:
An official same-version package that runs in the browser in place of, or beside, a source package whose native code cannot, applied by the Command Proxies after an install: by replacing the installed package's files, by linking a companion package where the source package's own loader resolves it, or through a launcher the source package uses as its binary. The companion of a NAPI-RS package is derived from its `napi` metadata, and a WASI loader it ships is rewritten when it does not call the register functions of the module beside it; everything else comes from one small map of package-name pairs (ADR-0021, ADR-0028, ADR-0035).
_Avoid_: Catalog version, receipt, lockfile overlay, per-version rows, version ranges, runtime package-name dispatch, WebContainers identity

**Publisher WASI Executable**:
An official WASI artifact, selected by a Browser Package Replacement, executed through package-neutral Runtime capabilities.
_Avoid_: Custom WASM port, package-specific executable adapter

**Package Manager Toolchain**:
An exact, integrity-pinned upstream npm, pnpm, or Yarn JavaScript CLI provisioned independently of project dependencies, whose own `bin` map names the commands it serves, executed as a Runtime Process.
_Avoid_: Host PATH, emulated manager, floating registry version

**Package Execution**:
The observable behavior of running project scripts, package binaries, and one-off tools through Command Proxies and Process Execution.
_Avoid_: Package Execution module, lifecycle scheduler

**Package Artifact Cache**:
The size-bounded store of verified tarball bytes of the pinned Package Manager Toolchains and Browser Package Replacement artifacts.
_Avoid_: Extracted-copy cache, project package cache, unbounded cache

**Runtime Platform Profile**:
The immutable Node version, operating system, architecture, runtime identity and runtime version (`process.versions.webcontainer`, ADR-0045) shared across one Mimic epoch and its evidence.
_Avoid_: Per-package platform, process-only version constant

**Runtime Module Graph**:
The documented set of Runtime Deep Modules, their entry points and their allowed dependency edges, kept in ADR-0029 and upheld in code review rather than by repository tooling.
_Avoid_: Architecture Gate, dependency-cruiser rule set, machine-readable registry, undocumented edge

**Migration Bridge**:
A temporary package-agnostic adapter between consecutive implementation steps, with one owner, a no-new-callers guard, and a named deletion condition.
_Avoid_: Compatibility shim, permanent adapter, cleanup-later fallback

**Compatibility Quarantine**:
A temporary seam that isolates incomplete generic runtime behavior until the permanent capability replaces it, with a named deletion condition and no package identity branch.
_Avoid_: Package-specific adapter, framework shim, permanent fallback

### Compatibility evidence

**Pragmatic Runtime Compatibility**:
Compatibility with valuable Node.js workloads through browser-feasible JavaScript and declared browser, WASM, or WASI paths rather than full operating-system emulation.
_Avoid_: Pure-JavaScript-only compatibility, complete OS emulation

**Compatibility Evidence Matrix**:
The executable collection of co-located Playwright Compatibility Claims that defines Mimic's maintained compatibility.
_Avoid_: Compatibility report subsystem, declarative claim registry

**Compatibility Claim**:
One maintained positive assertion with a stable identity, human-readable statement, and target of either an Exact Graph or Runtime Capability.
_Avoid_: Fixture status, accepted-failure claim, duplicated manifest

**Runtime Capability**:
A Compatibility Claim target naming observable package-agnostic runtime behavior.
_Avoid_: Passing demo, package-specific behavior, exact dependency graph

**Exact Graph**:
An immutable Compatibility Claim target binding exact packages, manager, tracked lockfile, platform, Browser Package Replacements, and execution identities.
_Avoid_: Mutable fixture, floating stack, latest-version claim

**Tracked Compatibility Lockfile**:
The reviewed package-manager lockfile that is the sole dependency-graph authority for a registry-backed Exact Graph.
_Avoid_: Test-generated lockfile, mutable fixture lockfile, graph digest manifest

**Validated Major Line**:
A deliberately supported major version and profile represented by additive immutable Exact Graphs.
_Avoid_: Validated range, rolling active graph, fixture refresh

**Compatibility Step**:
A stable package-agnostic phase identity used by maintained compatibility tests and reporting adapters.
_Avoid_: Free-form test label, version-specific step identity

**Playwright Tarball Cache**:
The ignored host-side read-through cache for integrity-addressed publisher tarballs used by fresh browser compatibility installs.
_Avoid_: Package Artifact Cache, installed dependency snapshot, offline corpus

**Install Layer**:
The ignored host-side copy of the `node_modules` a frozen install produced, keyed by the manifest, the Tracked Compatibility Lockfile and the install command, which a compatibility test mounts instead of repeating that install; the nightly run uses none and performs every install.
_Avoid_: Playwright Tarball Cache, Package Artifact Cache, checked-in node_modules, lockfile-less snapshot

**Vite-Owned Development Workflow**:
A workflow in which the installed upstream Vite package owns configuration, transforms, module-graph behavior, filesystem updates, and HMR while Mimic supplies package-neutral capabilities.
_Avoid_: Vite emulation, Vite runtime adapter, synthetic HMR

**Angular CLI-Owned Development Workflow**:
A workflow in which the installed Angular CLI and build system own compilation, serving, and Angular HMR while Mimic supplies package-neutral capabilities.
_Avoid_: Angular emulation, Angular runtime adapter

**Optimized Dependency Generation**:
The atomic Vite-owned set of prebundled dependency entries and referenced sibling artifacts for one optimizer generation.
_Avoid_: Isolated optimized entry, dependency cache blob

**Vite-Owned HMR Session**:
An HMR session established by Vite's upstream browser client and driven by payloads from the upstream Vite server.
_Avoid_: Synthetic HMR, observer-proven HMR, manually injected payload
