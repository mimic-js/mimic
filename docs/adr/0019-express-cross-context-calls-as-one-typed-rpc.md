---
status: accepted
supersedes: the Worker Transport definition in ADR-0015
---

# Express cross-context calls as one typed RPC

Worker Transport no longer provides a request/response peer with envelopes,
cancellation acknowledgements, and in-flight limits. It provides one typed RPC.
This replaces ADR-0015's description of Worker Transport as the owner of
"generic request correlation, cancellation, bounded overload, terminal failure,
and cleanup". The module graph of ADR-0015 is unchanged.

The previous design made every runtime module repeat a type map of operations,
a service that registered handlers, a client that unwrapped results, and a peer
adapter that wrapped messages in module envelopes. Because a throwing request
handler closed the whole peer, every operation answered with an `{ ok, value }`
or `{ status: 'rejected' }` wrapper, and messages produced by the same build were
validated field by field.

## Decision

- Both sides of a connection share an interface type. The callee exposes an
  object implementing it; the caller drives it through a generic proxy,
  `connectRpc<Api>(port, local).remote`, on which every method returns a promise.
  Interfaces may nest, so one connection carries several modules' interfaces.
- An error the callee throws is serialised (name, message, stack, and primitive
  own properties such as `code`) and rethrown at the call site. It rejects only
  that call; the connection keeps serving.
- Events are notifications, `connection.notify`, which have no reply. A
  notification to a closed connection is dropped.
- Values that must move rather than be cloned (streams, ports, large buffers) are
  marked with `transfer(value, transferables)`.
- A connection is a MessagePort, a Worker, or a dedicated worker's own scope.
  There is no handshake; a worker that fails to load is observed through its
  `error` event. Closing either side rejects the other side's pending calls.
- Adding an operation to a module means adding a method to its interface type
  and to the object that implements it.

A worker that must block until another context answers uses the synchronous
counterpart of this RPC, with the same interface and error semantics
([ADR-0025](./0025-use-one-synchronous-channel.md)).

Worker Transport owns no cancellation and no capacity limit. Cancellation is a
domain operation where a named failure mode needs it: a committed watch that
stops releases its waiting commit-journal call (`cancelCommitJournalWait`), and
an aborted or timed-out published HTTP request releases the host exchange that
serves it (`cancelHttp`, `cancelHttp1`). The in-flight limit is deleted: its
only effect was rejecting legitimate Virtual File System traffic, which is why
that module had already raised it to 4,096.

Validation remains only where data enters from outside the build: messages from
documents served by a Published Endpoint, which are application code, and the
Service Worker's protocol token, because a page can meet a Service Worker
installed by another build. Result wrappers, same-build message validators, and
mailbox layout versions are deleted, as is the thread identity lease, which was
always the constant range 1 to 1,000,000.

The transport is one self-contained factory. The Service Worker and the
document runtime of a Published Endpoint, which cannot import package modules,
embed it as source.

## Consequences

- An error keeps its name, message, stack, and code across a connection, but not
  its class. A module whose public seam promises a class projects it there:
  Process Execution rethrows `RuntimeProcessExecutionError`, and Virtual Network
  rethrows `VirtualNetworkError`.
- A notification whose method the callee does not implement throws in the
  callee, where the defect is.
- Process I/O keeps its sequence-numbered drain notifications, because the host
  must release inherited input to a synchronous child before the parked worker
  can answer.
