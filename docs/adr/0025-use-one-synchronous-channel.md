---
status: accepted
amends: ADR-0015 (Worker Transport), ADR-0019 (adds its synchronous counterpart), ADR-0020 (the `worker_threads` channel), ADR-0023 (the mailbox `call` operation)
---

# Use one synchronous channel and delete the in-process child and thread paths

Four `SharedArrayBuffer` and `Atomics` channels let a worker block until
another context answered, each with its own layout, wait/notify state machine,
chunking and encoding: the Virtual File System mailbox (a JSON header followed
by byte segments, about 2,100 lines), the synchronous child mailbox (one buffer
sized `header + 2 × maxBuffer + 16 KiB`), the WASI stdin mailbox, and the
`worker_threads` port transport. The last reserved a 512 MiB arena of 8 MiB
slots per process and encoded messages as JSON in which a byte array became an
array of numbers and a `Buffer` became `{ type: 'Buffer', data: [...] }` through
its `toJSON`; that is the TextDecoder failure ("parameter 1 is not of type
'ArrayBuffer'") that stopped the Angular development suites in Angular's
JavaScript transformer worker. Separately, `child_process` and `worker_threads`
each had an in-process implementation (`node-runtime-program.ts`,
`execution-context-runtime.ts`, about 950 lines) reachable only when a process
worker did not supply its ports, which `node-process-worker.ts` always did.

## Decision

- **One synchronous RPC in Worker Transport.** `worker-transport/synchronous-rpc.ts`
  is the synchronous counterpart of `connectRpc`:
  `connectSynchronousRpc<Api>(channel).remote` drives an interface shared with
  the callee, and every method returns its result directly;
  `serveSynchronousRpc(channel, implementation)` serves it from the callee's
  event loop with `Atomics.waitAsync`, so an implementation may answer with a
  promise. An error the callee throws is rethrown at the call site with its
  name, message, stack and primitive properties, as in ADR-0019.
- **One layout.** A channel (`createSynchronousChannel`) is one
  `SharedArrayBuffer`: five control words (state, chunk length, last-chunk flag,
  message length, terminal reason), a number of status words either side may
  publish without a call, and a payload window of a fixed capacity.
- **One state machine.** `idle → request → (request taken → request …) →
  processing → response → (response taken → response …) → idle`. The caller
  marks `timed out` when the callee does not pick up a chunk within the
  watchdog; the callee then discards that exchange and the channel stays
  usable. Once the callee holds a whole request, the call lasts as long as its
  work (ADR-0023). `terminal` ends the channel as closed or failed. A channel
  whose callee may be busy for a long time and whose loss ends the caller
  anyway (a process worker's own channel, WASI stdin) has no watchdog.
- **One chunking scheme.** A message larger than the payload window is copied
  through it chunk by chunk, each chunk acknowledged, without first joining
  the encoded parts.
- **One binary encoding.** `worker-transport/value-codec.ts` encodes what the
  structured clone algorithm encodes for plain data: primitives, BigInt,
  strings as UTF-8, arrays, plain objects, `Map`, `Set`, `Date`, `RegExp`,
  `Error`, `ArrayBuffer` and typed arrays, with shared references and cycles
  kept. Bytes are raw bytes; a payload of 4 KiB or more is referenced, not
  copied, until the channel writes it. There is no base64, no number array and
  no per-caller codec. Shared memory cannot cross by content and is refused.
- **Every caller uses it.**
  - The **VFS mailbox** serves `SynchronousVirtualFileSystemMailboxApi`
    (reads, Open File Description operations, commits, the commit journal and
    the generic `call` of ADR-0023); its status word is the authority
    revision the client cache compares against. The client names channel
    failures as before (`VFS_MAILBOX_TIMEOUT`, `VFS_PAYLOAD_TOO_LARGE`,
    `VFS_EPOCH_FAILED`, `VFS_MAILBOX_CLOSED`). The mailbox cancellation API,
    the epoch word and the same-build response validators had no production
    caller and are deleted.
  - Each **process worker** gets one more channel from its host, serving
    `NodeProcessSynchronousApi`: `spawnChild` runs a Synchronous Child Process
    Execution and returns its captured stdio and result (the `maxBuffer` bound
    stays where it was enforced, in `executeSynchronousChildProcess`), and
    `receivePortMessage` serves `receiveMessageOnPort`.
  - **WASI stdin** serves `read(maximumBytes)`; the host reads one chunk of
    process input ahead. The status word holds its size, or -1 once input has
    ended and nothing is held, and the host notifies it on every change, so
    `poll_oneoff` reports standard input readable only when a read would not
    block and otherwise waits on the word until input arrives or ends, or the
    earliest clock subscription is due. Reporting an empty standard input as
    readable made a program that polls it spin: esbuild's WASI build kept a
    core busy for as long as it ran.
  - **`worker_threads`**, below.
- **`worker_threads` messages travel by structured clone; only a synchronous
  receive uses the channel.** A Worker Thread is its own process worker, so a
  `MessagePort` end lives in one thread. While both ends of a channel are in
  one thread they stay local. When an end leaves its thread in a message, the
  pair is handed to the Runtime Host's port relay
  (`runtime-host/worker-thread-ports.ts`), which keeps each end's messages in
  order. A thread that listens has them delivered by structured clone, so
  transferred `ArrayBuffer`s, `SharedArrayBuffer`s, `WebAssembly.Module`s and
  shared `WebAssembly.Memory` cross natively. A thread that calls
  `receiveMessageOnPort` — the `synckit` and `piscina` pattern of
  `Atomics.wait` followed by a synchronous receive — takes the next message
  over its process channel, including one already delivered by structured
  clone but not yet taken in, whose copy is then dropped on arrival. Before
  answering, the relay waits for every relay notification any thread had sent
  when the receive began (each thread counts them in a status word), so a
  message posted before the `Atomics.notify` that woke the receiver is never
  missed. A `Worker` and its thread's `parentPort` are such a hosted pair.
  A blocked thread can be handed only shared memory it already holds, so a
  4-byte `SharedArrayBuffer`, which Angular and `piscina` use as signals, is
  still drawn from a per-process pool every thread receives at start, and
  crosses as its index. Thread ids are drawn from the same pool, and a Worker
  Thread starts with one notification to the host, which admits it, so a
  parent that blocks right after `new Worker()` still gets its thread.
- **The 512 MiB arena is removed.** Nothing is reserved per process beyond
  the 4,096 pooled 4-byte signals and one 64 KiB channel per process worker, so
  there is no reservation to measure. The pool does not take signals back. A
  process that has drawn them all gets an ordinary 4-byte `SharedArrayBuffer`
  from then on, which reaches a thread that listens but not one that receives
  synchronously (below).
- **The in-process `child_process` and `worker_threads` paths are deleted.**
  `RuntimeProgramContext.childProcess`, `synchronousProcessAuthority` and
  `workerThreads` are required; a child and a Worker Thread are always
  Runtime Processes of their own workers. The worker-side admission ports they
  used (`admitChild`, `reserveThreadIdentity`, `createThreadExecutionPort`,
  `createChildProcessExecutionPort`) are deleted with them.
- **Synchronous Child Process Execution parks any caller.** Process Execution
  tracked the parked process per Execution Context, so two scripts of one npm
  install that each called `execFileSync` failed with "already synchronously
  parked". It now parks any number of callers of a context, at most eight in
  all; the context counts once against capacity.

## Consequences

- esbuild's synchronous API (`transformSync`, `buildSync`) works: it starts a
  Worker Thread and blocks in `Atomics.wait` at once, and the thread's start
  used to wait on an admission reply the blocked parent never read. Two esbuild
  versions install concurrently without `--foreground-scripts`
  (`tests/e2e/mimic-package-manager-command-proxy.spec.ts`).
- `receiveMessageOnPort` of a message holding something the binary encoding
  cannot carry (a `WebAssembly.Module`, a `SharedArrayBuffer` that is not a
  pooled signal) throws `DataCloneError`; the same message received by a
  listener arrives intact.
- Messages between two threads of a process take one hop each way through the
  Runtime Host Worker. That is where the only queue a blocked thread can read
  synchronously lives.
- Unit tests that ran children and Worker Threads in the test's own context
  are deleted; the real paths are covered by the inline worker-thread,
  synchronous child process, VFS mailbox, esbuild and Angular claims. New unit
  tests cover the channel (`tests/unit/worker-transport-synchronous-rpc.test.ts`),
  the encoding (`worker-transport/value-codec.test.ts`) and the relay
  (`runtime-host/worker-thread-ports.test.ts`).
