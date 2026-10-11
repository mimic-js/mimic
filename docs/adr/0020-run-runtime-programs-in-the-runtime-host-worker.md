---
status: accepted
amends: ADR-0015 (placement of Process Execution and its Runtime Programs)
amended-by: ADR-0033 (the page keeps the facade alone; the Runtime Host document of the endpoints' origin keeps the rest)
---

# Run Runtime Programs in the Runtime Host Worker

Until this decision the page's main thread ran the Shell Program, the core
utilities and the npm, pnpm and Yarn Command Proxies, including tarball fetch,
extraction and hashing. The Runtime Host Worker's program table was mostly
stubs that called back into the page. The page created every process worker,
and a process worker's asynchronous Virtual File System and Virtual Network
requests went through the page to the Runtime Host Worker. Spawning a Node
process took three page-to-worker round trips before `new Worker`. Executable
resolution and the program table existed three times, and shell redirection
twice. A tracked `npm ci` stalled the embedding page for more than a second.

## Decision

- **The page keeps the public facade only.** It holds `Mimic`, the
  asynchronous Virtual File System client, the projection of the processes it
  spawned, and the Published Endpoint host: Service Worker registration, the
  published-document bridge and the Cookie Jar. It runs no Runtime Program.
- **The Runtime Host Worker runs Process Execution with every Runtime
  Program.** It creates the JavaScript and WASI process workers itself, as
  nested dedicated workers, so spawning a process takes no round trip through
  the page. Chromium, the attested platform of ADR-0010 and the Playwright
  project, supports nested module workers; a nested dedicated worker inherits
  cross-origin isolation, so the `SharedArrayBuffer` and `Atomics` channel
  (the VFS mailbox, synchronous child execution, WASI stdin, and since
  [ADR-0025](./0025-use-one-synchronous-channel.md) `receiveMessageOnPort`)
  works unchanged.
- **A process worker's port reaches the authorities in one hop.** The `Worker`
  the Runtime Host holds is the process worker's connection: the Virtual File
  System service and the Virtual Network authority answer on it directly.
- **Published HTTP reaches the owning worker directly.** A process worker opens
  one `MessagePort` per published listener; the Runtime Host hands it to the
  page's Published Endpoint host, which serves Service Worker requests over it.
  The HTTP/1 byte path itself is unchanged. A process exits only after the page
  has unpublished its listeners, and its listener ports close with it.
- **The page drives processes by handle.** It names each spawn with a handle of
  its own, so output that arrives before the spawn call returns has a
  destination. Standard output and error travel in the order the program wrote
  them; output and input both carry backpressure; signals and the exit outcome
  are calls on the same connection.
- **One registry and one resolver.** `runtimeProgramDefinitions` is the one
  table of Runtime Program ids and their commands. The Runtime Host binds an
  implementation to each id, and every spawn resolves through
  `resolveExecutable` against that table. The Shell Program implements
  redirection over its filesystem port, once.
- **Runtime Programs call the Virtual File System like another context.**
  Programs in the Runtime Host Worker use the asynchronous client through
  Worker Transport's `localRemote`: each call is its own task and works on
  copies. A long install therefore leaves room for the synchronous mailbox
  requests of process workers, which the same worker serves.
- **A killed process is released once its program settles.** SIGKILL reaches a
  root process's program, and Process Execution releases the process (exit 137)
  only after the program returns, so teardown is acknowledged after every
  Runtime Program has cleaned up.

## Consequences

- The witness `tests/e2e/mimic-main-thread-responsiveness.spec.ts`
  installs the tracked `vanilla-vite-6.4.3` graph with `npm ci` and allows no
  main-thread task longer than 100 ms. It measured 3 ms; the same install on
  the previous placement stalled the page for 1.4 to 2.5 s.
- Browsers without nested dedicated workers cannot run Mimic. This
  adds no requirement to the attested platform.
- A test that observes or disturbs a process worker installs a hook module in
  the Runtime Host Worker (`tests/e2e/runtime-host-worker-hook.ts`); patching
  the page's `Worker` no longer reaches process workers.
- The Runtime Host Worker's event loop now also runs Command Proxies. Work they
  do between Virtual File System calls delays other processes' synchronous
  requests, not the page.
- `worker_threads` messages between process workers pass through the Runtime
  Host Worker's port relay, which holds the only queue a blocked thread can
  read synchronously ([ADR-0025](./0025-use-one-synchronous-channel.md)).
