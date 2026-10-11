# Canonical process, execution-context, and supervision architecture

Research snapshot: 2026-08-22. This note answers Research canonical process, execution-context, and supervision architecture (#608). Repository-state statements are dated observations; every recommendation marked **Inference** is a conclusion for Mimic rather than a claim made by an external source.

## Decision summary

Mimic needs three responsibilities, not six peer authorities:

1. **Process Execution** is the single deep module for program resolution and admission, process identity/tree, lifecycle state, stdio ownership, signal delivery, exit observation, cleanup, and capacity accounting.
2. **Execution Realm** is a private, disposable Process Execution resource backed by a dedicated browser worker. It hosts one root Runtime Process and its realm-local worker threads; it has no public identity or lifecycle policy of its own.
3. **Runtime Host** is epoch composition and catastrophic-failure handling. Its browser-side half is an adapter forced by browser placement constraints, not a second supervisor.

Shell and WASI remain ordinary **Runtime Program** implementations. Shell owns language semantics and composes child processes through Process Execution. WASI Execution owns Preview1 inspection, instantiation, descriptors, syscalls, and `proc_exit`, but not process admission or supervision.

This keeps the canonical concepts already present—PID/PPID, process tree, spawn/replace, exit status plus signal, stdio streams, capacity, and an isolated worker per root process—while deleting invented public concepts such as `contextId`, `ExecutionAdmission`, `ChildExecutionAdmission`, `ThreadIdentityLease`, and the split “Supervisor Runtime Program” vocabulary from the eventual external seam.

## Primary-source model

### Admission and executable resolution

Unix separates process creation from replacing a process image: `fork()` creates a child, while `execve()` replaces the calling process image and preserves its PID; `execve()` also replaces memory mappings and resets caught signal dispositions while retaining selected process attributes ([Linux `fork(2)`](https://man7.org/linux/man-pages/man2/fork.2.html), [Linux `execve(2)`](https://man7.org/linux/man-pages/man2/execve.2.html)). Node exposes one primitive, `spawn()`, and builds `exec()`, `execFile()`, and `fork()` on it; executable lookup follows `PATH`, and `exec()` is specifically the variant that introduces a shell ([Node child-process documentation](https://github.com/nodejs/node/blob/main/doc/api/child_process.md)). Deno likewise makes `Command` a reusable description whose `spawn()` creates a fresh child ([Deno subprocess documentation](https://docs.deno.com/api/deno/subprocess/)). Bun takes an argv array and resolves its first element to an executable path before spawning ([Bun `spawn` reference](https://bun.sh/reference/bun/spawn)).

**Inference:** retain one generic `spawn(request)` admission path and one identity-preserving `replace(pid, request)` path. Resolution is part of admission policy because it decides what executable is authorized to run; parsing a shell script is not. The resolver should return a classified Runtime Program plus immutable launch data. No runtime-program registry should be exposed to callers: one configured set of programs makes it implementation, not a real adapter seam.

### Process identity and tree

On Linux, a child has a distinct PID and records its parent PID; termination leaves status for the parent to collect with `wait*()`, and `waitpid()` can select a specific child or children in a process group ([Linux `fork(2)`](https://man7.org/linux/man-pages/man2/fork.2.html), [Linux `wait(2)`](https://man7.org/linux/man-pages/man2/waitpid.2.html)). Process groups and sessions are separate identities for job control and group signalling, and group membership survives `execve()` ([Linux `setpgid(2)`](https://man7.org/linux/man-pages/man2/getpgrp.2.html)). Node's `ChildProcess` similarly reports a PID and distinguishes an exit code from termination by signal ([Node child-process documentation](https://github.com/nodejs/node/blob/main/doc/api/child_process.md)).

**Inference:** PID and PPID are canonical. `contextId` is an implementation key and must not appear in Process Execution's interface. A worker thread is not a process child: use `(pid, threadId)` only inside Node Compatibility and realm implementation. Do not add sessions/process groups until shell job-control compatibility requires them; the current shell has pipelines but no maintained job-control claim. When a parent exits, either preserve the current explicit orphan rule (`ppid = 0`) or later add an init-like reaper—do not conflate descendant cleanup with parent identity.

### Execution realms and workers

The HTML Standard defines a dedicated worker as a separate worker global scope with its own event loop. Termination sets its closing flag, discards queued work, aborts the running script, and empties the implicit port queue ([HTML worker processing model](https://html.spec.whatwg.org/multipage/workers.html)). Node describes `worker_threads` as parallel JavaScript execution that can share memory; unlike child processes, workers share the same process and are useful for CPU-intensive JavaScript rather than I/O ([Node worker-threads documentation](https://nodejs.org/api/worker_threads.html)). Deno also implements workers as separate threads using the Web Worker interface ([Deno Web Platform APIs](https://docs.deno.com/runtime/reference/web_platform_apis/)). Bun calls a worker a new JavaScript instance on a separate thread that shares I/O resources ([Bun workers documentation](https://bun.sh/docs/runtime/workers)).

**Inference:** use **Execution Realm** for the isolated global/module-registry/event-loop resource and **Worker Thread** only for the Node-shaped thread abstraction. A browser `Worker` is the realm adapter. One root Runtime Process per realm matches the browser's failure and termination granularity; child Runtime Processes may be projections in that realm when they do not need independent isolation. Realm prewarming is an internal performance tactic, not admission state or part of the interface.

### Supervision, exit, and cleanup

Unix gives parents child-state observation through `wait*()`; it does not make every program a supervisor ([Linux `wait(2)`](https://man7.org/linux/man-pages/man2/waitpid.2.html)). Node distinguishes `'exit'` from `'close'`: `'close'` occurs only after stdio closes and always follows process exit or spawn error ([Node child-process documentation](https://github.com/nodejs/node/blob/main/doc/api/child_process.md)). Deno's child handle exposes `status`, `kill()`, `ref()`, and `unref()`, explicitly separating process termination from whether the parent event loop must remain alive ([Deno subprocess documentation](https://docs.deno.com/api/deno/subprocess/)). Browser worker termination is abrupt and may abort active script execution ([HTML worker processing model](https://html.spec.whatwg.org/multipage/workers.html)).

**Inference:** Process Execution owns the state machine from admitted to running to exited/crashed and owns idempotent cleanup of the process record, realm, stdio endpoints, child/thread records, and process-owned resources. Runtime Host owns only epoch-wide boot, teardown ordering, and escalation of unhandled host/transport failure. A process result should preserve `{ code, signal }` and a distinct crash/failure result; stdio closure is a later observable completion condition, not the exit result itself. “Supervision” should not name ordinary spawn routing.

### Signals and stdio

`kill(2)` sends a signal to a process or process group and does not guarantee that the target has already terminated ([Linux `kill(2)`](https://man7.org/linux/man-pages/man2/kill.2.html)). Node warns that its `subprocess.kill()` sends a signal but the process may install a handler and continue, and that `'close'` is distinct from `'exit'`; its stdio modes are pipe, inherit, ignore, or explicit descriptors/streams ([Node child-process documentation](https://github.com/nodejs/node/blob/main/doc/api/child_process.md)). Bun similarly exposes streams, abort/timeout signalling, and a configurable kill signal ([Bun child-process documentation](https://bun.sh/docs/runtime/child-process)).

**Inference:** `signal(pid, signal)` means delivery attempt, never “process is dead.” Preserve only the currently claimed signal subset (`SIGINT`, `SIGTERM`, `SIGKILL`) and expand when compatibility evidence demands it. Model stdin, stdout, and stderr independently; the public convenience `output` merge is a projection, not a fourth process stream. Backpressure belongs to the stream/transport implementation, while ownership and closure ordering belong to Process Execution.

### Capacity

Browser worker creation consumes threads and JavaScript heaps; Bun documents a reduced-heap worker mode explicitly because worker instances have material memory cost ([Bun workers documentation](https://bun.sh/docs/runtime/workers)). The Web platform reports `navigator.hardwareConcurrency` only as a user-agent estimate of logical processors and may deliberately report a lower number ([HTML navigator hardware concurrency](https://html.spec.whatwg.org/multipage/workers.html#dom-navigator-hardwareconcurrency)). Mature WASM hosts also treat guest resource limits as embedding policy; Wasmtime exposes memory/resource limits because unbounded guest-controlled allocation is a host availability risk ([Wasmtime resource-exhaustion advisory](https://github.com/bytecodealliance/wasmtime/security/advisories/GHSA-852m-cvvp-9p4w)).

**Inference:** capacity is a Runtime Host policy enforced once by Process Execution across realms and runnable root processes. `hardwareConcurrency` may supply a default but is not capacity itself. Keep the explicit capacity knob; remove PID-stride/thread-lease arithmetic from the interface and use ordinary monotonic identities internally. WASI descriptor and allocation limits belong inside WASI Execution and should consume host policy, not be inferred from process slots.

### Runtime composition

The browser requires main-thread-only facilities and dedicated-worker isolation, so transport adapters are unavoidable. That does not create two lifecycle authorities: the HTML model makes the creator own `Worker.terminate()`, while the worker owns its event loop and can report errors ([HTML worker processing model](https://html.spec.whatwg.org/multipage/workers.html)). Node, Deno, and Bun likewise present child process or worker handles to the creator rather than exposing their bootstrap internals ([Node child-process documentation](https://github.com/nodejs/node/blob/main/doc/api/child_process.md), [Deno subprocess documentation](https://docs.deno.com/api/deno/subprocess/), [Bun workers documentation](https://bun.sh/docs/runtime/workers)).

**Inference:** merge the conceptual responsibilities of Runtime Supervisor and Runtime Supervisor Client under **Runtime Host**, but keep browser-worker-side and main-thread-side adapters as separate files where placement requires them. Runtime Host composes VFS, network, endpoints, Process Execution, program implementations, and transports for one epoch. It must not resolve programs, assign PIDs, route child processes, host shell semantics, or implement WASI.

## Current repository observations

- Process Execution already contains the right authority in one place: request/resolved-request types, PID/PPID, context and thread bookkeeping, exit/crash outcomes, signal, shutdown, and capacity ([source](https://github.com/mimic-js/mimic/blob/main/src/runtime/modules/process-execution/process-execution.ts)). **Inference:** deepen this module by hiding realm and thread allocation details rather than splitting it.
- Runtime Supervisor currently composes VFS, Process Execution, Virtual Network, Published Endpoint, toolchain programs, and WASI inspection, and owns epoch cleanup/failure ([source](https://github.com/mimic-js/mimic/blob/main/src/runtime/modules/runtime-supervisor/index.ts)). **Inference:** composition is legitimate; importing program catalogs and WASI inspection directly is policy leakage that should move behind Process Execution configuration.
- Runtime Supervisor Client both manages the supervisor worker/session and constructs browser-side runtime-program adapters ([client source](https://github.com/mimic-js/mimic/blob/main/src/runtime/modules/runtime-supervisor-client/runtime-supervisor-client.ts), [adapter source](https://github.com/mimic-js/mimic/blob/main/src/runtime/modules/runtime-supervisor-client/runtime-program-adapters.ts)). **Inference:** it is a browser-side Runtime Host adapter, not a second supervisor module; its `spawn()` convenience may remain while delegating authority.
- Execution Context Bootstrap wires Node Compatibility to the Module Execution Engine, while `ExecutionContextRuntime` additionally builds builtins, child/thread ports, network, watchers, and teardown ([bootstrap source](https://github.com/mimic-js/mimic/blob/main/src/runtime/modules/execution-context-bootstrap/execution-context-bootstrap.ts), [runtime source](https://github.com/mimic-js/mimic/blob/main/src/runtime/modules/execution-context-bootstrap/execution-context-runtime.ts)). **Inference:** the first is a shallow construction helper and the second is the real Execution Realm implementation; collapse the naming and keep bootstrap private.
- Shell Program owns parsing, expansion, pipelines, redirection, builtins, child spawn, replacement, signal fan-out, and exit semantics ([source](https://github.com/mimic-js/mimic/blob/main/src/runtime/modules/shell-program/shell-program.ts)). **Inference:** this is cohesive and earns a module; keep its small `run()` interface and do not move child orchestration into Runtime Host.
- WASI Execution owns Preview1 rights, descriptors, syscalls, clocks/randomness, instantiation, and `proc_exit` ([host source](https://github.com/mimic-js/mimic/blob/main/src/runtime/modules/wasi-execution/wasi-execution.ts), [command source](https://github.com/mimic-js/mimic/blob/main/src/runtime/modules/wasi-execution/command-execution.ts)). **Inference:** it remains a deep module. Its executable inspector is an internal adapter supplied to Process Execution; the main-thread WASI worker adapter is placement machinery, not a WASI authority.
- Maintained evidence independently covers supervisor lifecycle, process-tree authority, runtime-program resolution, shell behavior, worker diagnostics/threads, synchronous children, and WASI behavior ([tests](https://github.com/mimic-js/mimic/tree/main/tests/e2e)). **Inference:** preserve these observable claims through the selected deeper interfaces; architecture-string tests should be rewritten only after target names and seams are decided.

## Canonical responsibility table

| Responsibility | Canonical owner | Mechanism to keep | Current concept to hide, merge, or reject |
| --- | --- | --- | --- |
| Command resolution and admission | Process Execution | classified Runtime Program; one spawn path | Hide registries and `ExecutionAdmission`; no Supervisor-specific program type |
| Process identity/tree | Process Execution | PID, PPID, root/child relationship, replace preserves PID | Hide `contextId`, PID strides, thread leases |
| Execution isolation | Process Execution implementation | disposable Execution Realm backed by a browser worker | Rename/collapse Execution Context Bootstrap; no peer authority |
| Node worker threads | Execution Realm + Node Compatibility adapter | realm-local thread ID and ref/unref lifecycle | Never represent as process children |
| Shell language | Shell Program | parser, expansion, pipelines, redirection, builtins | Keep; do not promote shell policy into Process Execution |
| WASI ABI | WASI Execution | inspection, host imports, descriptors, instance lifecycle | Keep; admission and PID lifecycle stay in Process Execution |
| Signals/exit/stdio | Process Execution | delivery attempt, `{code, signal}`, crash, three streams, ordered cleanup | Remove merged output from the canonical model |
| Capacity | Process Execution, configured by Runtime Host | explicit root-realm slots with hardware-based default | No public thread-identity lease or context capacity |
| Epoch boot/failure/teardown | Runtime Host | one composition root with two browser-placement adapters | Merge Supervisor and Supervisor Client conceptually |

## Implications for the simplification programme

1. Specify one target **Process Execution** interface around `spawn`, `replace`, `signal`, `shutdown`, and process handles/results. Make executable classification, realms, child/thread accounting, and cleanup internal seams.
2. Specify **Runtime Host** as composition plus epoch failure/teardown, with main-thread and worker adapters hidden behind one interface. This supersedes the idea that Runtime Supervisor Client is an independent deep module.
3. Rename the surviving execution-context implementation to **Execution Realm** and make its bootstrap private. Do not publish realm identity unless a real second adapter appears.
4. Preserve Shell Program and WASI Execution as Runtime Program implementations. Remove their Supervisor-specific registration types; inject them as immutable Process Execution configuration.
5. Preserve process results, independent stdio, signal delivery, tree cleanup, worker crash propagation, synchronous-child parking, and ref/unref behavior because maintained tests exercise them. Treat PID allocation strategy, context IDs, transport domain layout, registry objects, and prewarming as replaceable implementation.
6. Do not introduce process groups, sessions, PTYs, arbitrary Unix signals, a general actor system, or a generic supervisor tree until a maintained compatibility claim requires each mechanism.

## Follow-up now specifiable

This research makes one decision ticket precise: design the target Process Execution and Runtime Host interfaces and dependency graph using the responsibility table above, explicitly deciding whether `RuntimeSupervisorClient.spawn()` remains a convenience projection and how synchronous-child parking consumes capacity. This is within the map's existing fog about target seams; it does not justify a separate implementation ticket yet.

Nodepod was not used as evidence: no clearly authoritative current project/source matching that name was found. The Linux, Node.js, Deno, Bun, WHATWG, and Wasmtime primary sources were sufficient to resolve the architectural question without relying on secondary descriptions.
