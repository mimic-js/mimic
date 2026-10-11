---
status: accepted
---

# Carry the Async Context through compiled continuations

`AsyncLocalStorage` keeps its store with the asynchronous continuation it was entered in. Node does this with promise hooks inside V8; a browser exposes none. Mimic therefore carries one realm-wide frame of stores explicitly, in the Module Execution Engine's Async Context, and re-enters it at every point where a continuation resumes:

- **`await` and `for await`** are rewritten by the Runtime Artifact Compiler, for CommonJS and ES modules alike, to pass their operand through the Async Context. Outside a frame the operand is returned untouched and the `await` is the platform's own. Inside a frame the operand is forwarded into a private promise that re-enters the frame immediately before the continuation and leaves it immediately after.
- **`Promise.prototype.then`** (and with it `catch` and `finally`) binds its reactions to the frame that registered them. The replacement is installed the first time a frame is entered, so a program that never uses `AsyncLocalStorage` runs on the unmodified intrinsic.
- **Scheduling entry points** of the Node event loop (`setTimeout`, `setInterval`, `setImmediate`, `process.nextTick`, `queueMicrotask`) capture the frame when a callback is scheduled and deliver the callback inside it. `AsyncResource` and `EventEmitterAsyncResource` do the same for the frame they were created in.

`EventEmitter` listeners are not bound at registration. As in Node, they run in the frame of the `emit` call.

A frame is only ever current between a re-entry and its matching leave, so a job that none of these mechanisms instruments starts with no frame. The store such a job reads is `undefined`, never the store of an unrelated `run`. This is the property the design is chosen for: a request-scoped store that leaked into another request would be worse than a missing one.

## Consequences

- Inside a frame, a compiled `await` resumes one tick later than the platform's. The private promise has to be pending when the `await` registers its continuation, otherwise the re-entry, the continuation and the leave would not run as consecutive jobs. Outside a frame the tick is unchanged.
- Source the compiler does not see (`eval`, the `Function` constructor, `vm` scripts) keeps the frame for its synchronous part and through `then`, but loses it at its first `await`.
- Runtime code is not compiled by the Runtime Artifact Compiler. A Node Compatibility API that calls a program's callback after its own `await` must schedule that callback through the event loop or a `then` reaction, both of which carry the frame; `node:fs` callbacks already do.
- `async_hooks.createHook` stays unsupported and throws `ENOTSUP`: lifecycle hooks for every promise need the promise hooks this design works without. `executionAsyncId`, `triggerAsyncId` and `executionAsyncResource` report the `AsyncResource` whose scope is running, and the main script's identity otherwise.

## Rejected alternatives

Restoring the store in `finally` when `run` returns, the previous behaviour, loses it at the first `await`. Wrapping only the scheduling entry points covers timers but not `await`, which is where request-scoped stores are read. Lowering `async` functions to generators so that a patched `then` sees every continuation changes stack traces, function identity (`AsyncFunction`) and performance for every program, whether or not it uses `AsyncLocalStorage`.
