---
status: accepted
amends: ADR-0020 (how the Runtime Host Worker creates process workers)
---

# Keep one process worker ahead of demand

Since ADR-0020 the Runtime Host Worker creates a JavaScript process worker
when a program starts: `new Worker` at spawn, then the fetch and compile of its
script, then the process. Process Execution already keeps an Execution Context
admitted ahead of the next spawn, but that is bookkeeping; the `Worker` itself
started from nothing each time, also for every `worker_threads` thread.

## Decision

- **The Runtime Program host holds one spare JavaScript process worker.** It
  creates the first when the host is created and the next one as soon as a
  spawn takes the spare, so a worker fetches and compiles its script while the
  process before it runs. The spare is a `Worker` only: it has no connection
  and has received nothing, and the messages a spawn sends before its script
  has evaluated are queued by the browser as they are today.
- **A spare that fails to load is dropped.** Its `error` event terminates it;
  the spawn that would have taken it starts a worker of its own.
- **The spare ends with the host.** `dispose()` terminates it beside the
  processes. WASI workers are not kept ahead: a WASI process is rare next to
  JavaScript ones and its worker is a tenth of the size.

## Consequences

- `scripts/measure-cold-spawn.mjs` extended to a second and a third
  `spawn('node', ['-e', '0'])` in the same container, nine runs, medians: the
  first spawn is unchanged at about 710 ms with an empty HTTP cache, since the
  spare starts loading at the same moment; the second and third fall from
  173 ms and 177 ms to 90 ms and 109 ms.
- One idle dedicated worker, about the size of a loaded process worker, exists
  while a container is booted and nothing runs.
