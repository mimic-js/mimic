# Research: browser process model for Node-like execution

> Snapshot note: source findings and dated evidence are retained, but repo-specific
> “current state” statements may be obsolete. Verify them against current code,
> tests, issues, and [`compatibility-status.md`](../compatibility-status.md). See
> [the research status rules](./README.md).

Date: 2026-06-18

## Why this research exists

The roadmap has several open items that all collapse onto the same missing layer:

- `Establish a worker-backed runtime boundary for process execution rather than running all Node code in the main page.`
- `Add SharedArrayBuffer-backed primitives where blocking or process coordination needs them.`
- `Replace command-registry execution as the primary path with a process manager that can execute JS bins, shell scripts, and package-manager commands through one process abstraction.`
- `Expand child_process enough for JS child processes and native-toolchain contracts.`
- `Expand worker_threads enough for packages that use workers for parsing or transforms.`

This document answers the internet-research part of that problem for the current repo goal: run browser-resident Node.js code and toolchains in a WebContainers-like runtime without pretending that browser tabs are a real POSIX kernel.

## Repo-specific context

- [`../../src/runtime/Mimic.ts`](../../src/runtime/Mimic.ts) currently executes `spawn()` work by calling `createVirtualProcess()` and then running commands in the same JS realm as the `Mimic` instance.
- [`../../src/runtime/process.ts`](../../src/runtime/process.ts) already exposes `ReadableStream`/`WritableStream` process I/O, but it is still a single in-page runner rather than a scheduler for isolated runtimes.
- [`../../src/runtime/node-runner.ts`](../../src/runtime/node-runner.ts) runs the Node-like loader inline and infers `server-ready` from console text.
- [`../../src/runtime/module-loader.ts`](../../src/runtime/module-loader.ts) still reports `worker_threads.Worker is not supported` and `child_process is not supported`.

So the current question is not "can the browser execute JavaScript?" It already can. The real question is how to map Node process semantics onto browser primitives without breaking the runtime model needed by package managers, Vite, and future framework plugins.

## Source-backed findings

### 1. WebContainers treat process output as stream transport, not buffered command results

The WebContainers process guide says `spawn()` returns a process whose `output` is a `ReadableStream`, and that stream includes stdout/stderr from the spawned process and its descendants. The same guide explicitly calls out that streams can be transferred between contexts such as workers.

That is directly relevant to this repo because [`../../src/runtime/process.ts`](../../src/runtime/process.ts) already models process output as a `ReadableStream`, which is the right API shape. The missing part is the execution boundary behind the stream.

Sources:

- [WebContainers: Running Processes](https://webcontainers.io/guides/running-processes)
- [MDN: ReadableStream](https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream)

### 2. WebContainers still rely on cross-origin isolation and SharedArrayBuffer

WebContainers browser support documentation continues to treat `SharedArrayBuffer` and cross-origin isolation as core runtime requirements. MDN documents that `SharedArrayBuffer` enables shared memory between agents such as the main page and web workers, and that the constructor is gated behind the required security headers.

This matters because a believable process model in the browser needs two different communication modes:

- message passing for commands, events, and coarse-grained IPC
- shared memory for low-latency coordination when Node behavior expects stronger process/thread synchronization

Sources:

- [WebContainers: Browser Support](https://webcontainers.io/guides/browser-support)
- [MDN: SharedArrayBuffer](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer)

### 3. Browser workers are the closest primitive to a process or worker runtime boundary

MDN documents that web workers execute code off the main thread, communicate via `postMessage()`, and may themselves spawn more workers if they are same-origin. Workers cannot directly manipulate the DOM, which is useful here: it enforces the separation we actually want between runtime execution and UI.

This does not make a browser worker equal to a POSIX process, but it does make a dedicated worker the right isolation unit for:

- running package-manager or CLI code off the page thread
- hosting Node-like globals independently per execution context
- allowing nested worker-backed implementations of `worker_threads`

Sources:

- [MDN: Using Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers)

### 4. Node distinguishes `child_process` and `worker_threads`, and the browser runtime should preserve that distinction

Node documents `child_process.spawn()` as subprocess creation with configurable `stdio`, while `child_process.fork()` is a special case that starts a new Node process with an IPC channel. Node separately documents `worker_threads` as useful for CPU-bound JS work and explicitly contrasts them with `child_process`: workers can share memory via `ArrayBuffer` transfer or `SharedArrayBuffer`.

That distinction is important for this repo. A browser runtime should not implement both APIs as the same thin alias:

- `child_process` should model a new process abstraction with its own argv/env/cwd/stdin/stdout/stderr/exit lifecycle
- `worker_threads` should model a same-runtime parallel execution primitive with `MessagePort`/`BroadcastChannel`/shared-memory semantics

If both APIs collapse to the same implementation, packages that rely on IPC or environment isolation will behave incorrectly in subtle ways.

Sources:

- [Node.js: child_process](https://nodejs.org/api/child_process.html)
- [Node.js: worker_threads](https://nodejs.org/api/worker_threads.html)

### 5. `child_process` semantics are mostly about contracts, not native binaries

The Node docs show the important `child_process` contracts:

- async process creation via `spawn()`, `exec()`, `execFile()`, and `fork()`
- `stdio` pipe configuration for stdin/stdout/stderr
- IPC channels via `'ipc'` stdio entries for Node child processes
- signals and cancellation through `killSignal`, `subprocess.kill()`, and `AbortSignal`
- separate PID/process lifecycle from the parent

For a browser runtime, this implies we do not need a literal OS process table first. We need a process contract layer that can provide those behaviors for JS-executable commands and fail clearly for unsupported native executables.

Sources:

- [Node.js: child_process](https://nodejs.org/api/child_process.html)

### 6. Transferable streams plus message ports are enough for the first serious process manager

MDN documents `ReadableStream` as a transferable object, and worker communication already uses structured clone / `postMessage()`. That gives the repo a practical bridge design:

- construct stdio streams at the process boundary
- transfer the readable/writable sides between the scheduler and worker contexts
- use structured-clone messages for lifecycle and control events
- add `SharedArrayBuffer` only where latency or coordination requires it

This is a much better fit than buffering all command output in arrays or parsing console text for lifecycle events.

Sources:

- [MDN: ReadableStream](https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream)
- [MDN: Using Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers)

## What this means for this repo

### Main conclusion

The repo should adopt a two-level execution model:

1. a runtime kernel worker that owns process scheduling, VFS access arbitration, preview server state, and runtime diagnostics
2. per-process execution contexts that can be either:
   - lightweight in-kernel tasks for simple commands
   - dedicated workers for commands that need isolation or parallel CPU work

This is the smallest architecture that can grow into both `child_process` and `worker_threads` support without rewriting the API surface later.

### Why a single worker is not enough by itself

Moving all current code into one worker would improve main-thread responsiveness, but it would not solve the semantic gaps:

- `child_process.fork()` needs parent/child separation with IPC
- `worker_threads.Worker` needs nested worker creation and worker-specific APIs
- output from descendants must still surface through the parent-observed process stream
- termination must distinguish "asked to stop" from "process fully exited"

So the correct first boundary is "runtime off the main thread", but the target boundary is "runtime kernel plus child execution units".

### Inference: recommended process taxonomy

This section is an inference from the sources and the current repo structure.

Use four internal execution classes:

- `KernelProcess`: scheduler-owned record with pid, ppid, cwd, env, stdio handles, signal state, exit promise
- `JsProcess`: executes a JS bin/module entry inside a dedicated execution context and can back `node`, package bins, and `child_process.fork()`
- `ShellProcess`: parses shell syntax and spawns one or more child `KernelProcess` records connected by pipes
- `ThreadWorker`: backs `worker_threads.Worker` and shares selected runtime memory/handles with its parent process

This preserves the externally visible Node distinction while still allowing a shared implementation for stream transport, diagnostics, and VFS access.

## Architecture recommendation

### Phase 1. Move the runtime kernel off the main thread

Create a dedicated kernel worker that owns:

- the process table
- the authoritative environment map
- port allocation and server lifecycle
- VFS mutation and watcher fanout
- preview routing registration

The main thread should become a thin facade for:

- API entrypoints such as `boot()`, `mount()`, `spawn()`, `on()`, `teardown()`
- preview iframe/service-worker coordination
- UI consumption of process output and diagnostics

This directly addresses the roadmap item about worker-backed runtime execution.

### Phase 2. Make `spawn()` return streams backed by worker transport, not in-page callbacks

Keep the current public `ReadableStream`/`WritableStream` shape, but have `spawn()`:

1. ask the kernel worker to create a process record
2. allocate stdin/stdout/stderr transport
3. return a `MimicProcess` immediately
4. resolve lifecycle events from kernel messages rather than direct function callbacks

`server-ready` and `port` should be emitted from virtual server listen state inside the kernel, not by parsing CLI logs.

### Phase 3. Implement `child_process` on top of the process table

Recommended support order:

1. `spawn()` for JS-executable commands and package bins
2. `execFile()` as a buffered convenience wrapper over `spawn()`
3. `exec()` as shell-backed composition over the shell process
4. `fork()` as "spawn a new Node-like JS process with IPC channel"

Important constraint: unsupported native binaries should fail during spawn planning with an explicit browser-runtime error, not after partial execution.

### Phase 4. Implement `worker_threads` as nested dedicated workers

Use actual dedicated workers for `worker_threads.Worker` where possible. Map Node semantics onto browser primitives:

- `parentPort` -> `MessagePort`
- `workerData` -> initial structured-clone payload
- `postMessage()` -> worker message channel
- `BroadcastChannel` -> native browser `BroadcastChannel`
- selected shared-memory use cases -> `SharedArrayBuffer`

Do not initially promise perfect parity for every Node worker option. The first target is enough compatibility for toolchains that use workers for transforms, parsing, or compilation.

### Phase 5. Add SAB only where the browser model actually needs it

Do not make `SharedArrayBuffer` the transport for everything. Use it selectively for:

- blocking-style coordination that cannot be expressed as async messages
- low-latency ring buffers for heavy stdio traffic if streams/messages become a bottleneck
- worker/thread synchronization points that packages expect to be cheap

Message-based control and transferable streams should remain the default path.

## Minimal compatibility target

The minimum useful browser process model for this repo is not full POSIX parity. It is:

- `spawn()` creates independently killable process records
- parent output includes child stdout/stderr where Node users expect it
- `npm run <script>` can spawn child commands and stream continuously
- `child_process.fork()` can start a JS child with IPC
- `worker_threads.Worker` can run parser/transform jobs in parallel
- `server-ready` and `port` come from virtual socket/listen events
- unsupported native executables fail clearly before misleading the caller

That target is enough to unblock real package-manager and Vite ecosystem work.

## Risks and constraints

### 1. Browser workers are not real OS processes

The browser does not give the repo a real process table, file descriptors, signals, or syscalls. Any Node-like process model here is an emulation contract. That is acceptable, but only if the runtime is explicit about unsupported native execution.

### 2. DOM access must stay outside the runtime

Workers cannot directly manipulate the DOM, and that is a feature for this architecture. Preview/UI operations should cross the kernel boundary intentionally instead of leaking page objects into runtime code.

### 3. Shared memory raises deployment requirements

Using `SharedArrayBuffer` keeps the existing requirement for cross-origin isolation. The repo should therefore treat `crossOriginIsolated` as a runtime gate for advanced process features, not just as a warning.

### 4. Descendant output aggregation is part of correctness

WebContainers document that process output includes descendants. The process manager therefore needs explicit parent/child plumbing for stdout/stderr forwarding instead of assuming one command equals one output source.

## Decision

Recommended next implementation sequence:

1. move runtime execution into a kernel worker
2. rebase `spawn()` onto kernel-managed stream transport and lifecycle events
3. implement JS-only `child_process.spawn()`/`fork()` over that process table
4. implement real browser-backed `worker_threads.Worker`
5. add `SharedArrayBuffer` coordination only where messages/streams are insufficient

This sequence matches both the public WebContainers process model and the actual browser primitives that exist today.

## Sources

- [WebContainers: Running Processes](https://webcontainers.io/guides/running-processes)
- [WebContainers: Browser Support](https://webcontainers.io/guides/browser-support)
- [Node.js: child_process](https://nodejs.org/api/child_process.html)
- [Node.js: worker_threads](https://nodejs.org/api/worker_threads.html)
- [MDN: Using Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers)
- [MDN: SharedArrayBuffer](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer)
- [MDN: ReadableStream](https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream)
