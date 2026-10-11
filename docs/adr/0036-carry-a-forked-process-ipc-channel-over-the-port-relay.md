---
status: accepted
amends: ADR-0025 (how `worker_threads` messages travel)
---

# Carry the IPC channel of a forked process over the port relay

`child_process.fork()` was refused, and so was `'ipc'` in the `stdio` of a
spawn. Nx runs every task that has an executor in a forked process: it sends
the task over the channel at once and waits for the child's answer. Its
`@nx/js:node` executor forks the server it serves the same way. Without a
channel a workspace builds nothing but the targets plugins infer.

Node's channel is a pipe on a fourth descriptor carrying newline-delimited
JSON. Here a process's descriptors are its three standard streams, and every
`worker_threads` MessagePort whose ends are in different threads already
travels through the Runtime Host's port relay (ADR-0025), which keeps what was
posted to an end in order until the thread holding it takes it, and closes one
end when the thread holding the other one ends.

## Decision

**A forked process's IPC channel is one MessagePort pair of the parent's port
relay, which the child joins.**

- **Opening.** Before it asks for the child, the parent hosts a pair in its
  relay and names the child's end in the spawn request (`ipc: { port,
  serialization }`). The host starts the child with that end, and the child's
  Runtime Process connects to the parent's relay instead of a new one, as a
  Worker Thread's does. Port ids carry the pid, so one relay serves a tree.
- **Linking.** The child's process worker links its end before the entry
  runs. What the parent sent in the meantime waits in the relay; what arrives
  while the child has no `message` listener waits in the channel for the first
  one, so a listener added after an `await` hears it too.
- **Messages.** `send()` posts `JSON.stringify(message)`, which the other side
  parses, as Node's default `json` serialization; `advanced` posts a
  structured clone. Handles cannot be sent.
- **Events and lifetime.** `message`, `disconnect` and `error` are emitted from
  the process's own `nextTick`, so a listener runs as process code and
  `process.exit()` in it ends the process. A side keeps its process alive while
  it listens to `message` or `disconnect`, as in Node. The channel closes when
  either side calls `disconnect()` or either process ends; the parent's
  `ChildProcess` emits `close` after `disconnect`.
- **`fork(modulePath, args, options)`** runs `options.execPath` or
  `process.execPath` with `options.execArgv` or `process.execArgv`, the
  module and its arguments; `stdio` defaults to the parent's streams, or pipes
  when `silent`, and must name `'ipc'`.

## Consequences

- `@nx/esbuild:esbuild`, `@nx/js:node` and the other executors run their tasks
  in forked processes.
- A forked process and its own Worker Threads share one relay with its parent;
  the relay's synchronous `receive` waits for the notifications of every
  thread connected to it.
- `'disconnect'` and `'exit'` of a child reach the parent in either order, as
  in Node: the channel closes with the child's thread, and its exit travels
  separately.
