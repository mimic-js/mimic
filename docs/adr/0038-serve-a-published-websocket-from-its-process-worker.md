---
status: accepted
amends: ADR-0024 (where a published WebSocket's bytes travel), ADR-0033 (how endpoint documents reach their host), ADR-0037 (the WebSocket stream of a loopback socket)
---

# Serve a published WebSocket from its process worker

A published document's `WebSocket` is the document WebSocket program's own
class. Until now it carried RFC 6455 bytes: the document built and masked the
client's frames and parsed the server's, posted each chunk to the Runtime Host
Document, which copied it and posted it to the process worker that owns the
listener, whose `upgrade` socket handed the bytes to the server. A review of
that path on 2026-10-08 found it fails in ways a browser's own socket does not,
and spends work where none is needed:

- **A socket opened after the browser stopped the Service Worker never
  settled.** The worker's host connections live in its memory. HTTP raced the
  windows for a lost host; `document-connect` dropped the port, so the socket
  stayed `CONNECTING` with no `error` or `close`, and `document.cookie`
  synchronisation, which opens the same stream, stopped. Chromium stops an idle
  worker after about 30 seconds, so a preview left alone and then reconnecting
  its HMR client hung. The host also ignored a connection naming another
  instance without closing it.
- **A server that dropped its socket reported a clean closure.** The process
  worker passed every socket close as `1000`, which the document turned into
  `wasClean: true`; clients that do not reconnect after a deliberate close
  stayed down.
- **Messages could reorder or vanish.** `send(blob)` posted after reading the
  blob, so a later `send(text)` reached the server first, and a `close()` right
  after it dropped the blob.
- **Nothing pushed back.** `bufferedAmount` returned to zero at the next
  microtask, and the upgrade socket's `write` always succeeded, so a flooding
  server queued without bound in the document's port, and a document's
  uploads did the same towards the server. Published HTTP has had backpressure
  since ADR-0024.
- **No side learned that the other was gone.** A `MessagePort` reports no
  closure; a crashed or removed document left its server connection open, and
  a document outlived the process worker that served it with an `OPEN` socket.
- **Each message crossed the Runtime Host Document's main thread and was
  copied about five times**: in the process worker, in the host, when the
  document appended a chunk to its frame buffer, when it sliced the payload, and
  when it built the event's data. Without a preview origin the host document
  shares its thread with the embedding page, so every frame of an HMR socket
  competed with the editor.
- **`instanceof WebSocket` was false for a browser socket**, which the program
  returns for a URL it does not route, and a listener added to two sockets ran
  with the first socket as `this`.

## Decision

- **The process worker is the WebSocket client.** Since the server's
  `upgrade` handler speaks RFC 6455 on its socket, the code beside it,
  `published-endpoint/websocket-session.ts`, plays the client: it masks the
  document's messages into frames, reads the server's frames into whole
  messages, answers pings, echoes a server's close frame and fails the
  connection on the protocol errors a browser fails it on (masked or reserved
  frames, fragmented or oversized control frames, invalid UTF-8, invalid close
  codes, a subprotocol or extension the handshake did not offer). It knows
  whether a close frame came, so a socket that ends without one closes with
  `1006` and `wasClean: false`. The document no longer builds or reads frames.
- **The socket's messages travel on a port between the document and that
  worker.** The document still sends its handshake request on a stream to its
  host. The host selects the request's cookies, creates a `MessageChannel`,
  hands one end to the document (`published-endpoint:websocket-connect`) and
  the other to the listener's process worker (`openWebSocket`), and stores the
  cookies of the response head the call resolves with. It answers `close` instead when the route is stale or the listener's process
  is gone before the server answered, and `unrouted` for a loopback port the
  container does not publish (ADR-0037). On the port, which carries plain
  messages and no RPC, the worker sends `open`, `message`, `ack` and `close`,
  and the document sends `send`, `ack`, `close` and `abort`. Strings cross as
  strings, binary data as transferred `ArrayBuffer`s, so a message is copied
  once on its way in each direction.
- **Each direction is acknowledged by count.** The worker acknowledges the
  document's `send`s once the server's socket took them, which a paused socket
  delays: `bufferedAmount` counts the bytes still waiting, as a browser's does.
  The document acknowledges the messages it dispatched; while more than 1 MiB
  of them is unacknowledged, the upgrade socket's `write` returns `false` and
  the server's `drain` waits, so a flooding server is held as on a slow
  network. Acknowledgements are batched up to 32 or until the next task.
- **Each side watches the other's Web Lock.** The document holds a lock for its
  lifetime and names it in the handshake request; the process worker holds one
  for its lifetime and names it in `open`. Each requests the other's lock in
  shared mode, which the lock manager grants once its holder is gone: the
  worker then drops the server's connection, and the document fires `error`
  and an abnormal `close`. A side that cannot see the other's lock in its own
  lock manager, as for a document opened in a tab of another storage
  partition, watches nothing.
- **The handshake's stream stays open as the socket's control stream.** The
  host closes a socket on it, as a dropped connection (`1006`), when its
  endpoint is unpublished or replaced or the host is disposed, which also
  reaches a document whose locks it cannot see; the document then drops the
  server's connection, and closes the stream when its socket closes. The locks
  cover what the host cannot see: a document that crashed or was removed, and
  process workers terminated with the Runtime Host Document. No message of
  the socket travels on this stream.
- **A Service Worker that lost its host asks for it.** A worker without a
  connection for an instance posts `published-endpoint:host-lost` to the
  windows outside its scope, where the Runtime Host Documents are, and waits up
  to 10 seconds; the instance's host connects again with its embedder policy
  and host origin, which the restarted worker had also lost. HTTP, loopback
  route resolution and `document-connect` all wait for that connection; a
  document whose host does not come back gets its port closed, so its socket
  fails and its cookie mirror stops, instead of waiting forever. The race of
  every window for each request (`http-connect`) is gone. The protocol token
  moves to `mimic-published-endpoint-v3`.
- **The document refuses nothing silently.** A host stream that closes before
  answering, or no answer in 30 seconds, fails the socket. The host closes a
  connection whose first message names another instance or nothing it serves.
- **The document's class behaves like the browser's.** A browser socket for an
  unrouted URL is `instanceof WebSocket`; listeners run with their own socket
  as `this`; `onopen` and the other handler attributes join the listeners
  where they are first set; sends after a `Blob` wait for it; `message` events
  carry the socket's origin; `pagehide` closes the document's sockets on every
  unload, not only the first.

## Considered and not done

- **Keeping the frames in the document and only fixing the faults.** Close
  codes would still be guessed from a socket's end, the codec would run on the
  application's main thread, and acknowledgements would have to count bytes of
  frames rather than messages.
- **Keeping the host on the data path.** Every message would still cross its
  thread and be copied there; the control stream lets it close sockets
  without that.
- **A heartbeat between the document and the worker.** It finds a dead peer
  only after a timeout and costs messages for the socket's whole life; a lock
  is released when its holder is gone, at no cost before.
- **Waiting for the server's close frame before the document's `close` event.**
  A browser does, until a timeout; existing applications and the maintained
  claim expect the event to follow `close()` at once. The worker still sends
  the close frame and waits up to 5 seconds for the server to end its socket.
- **A zero masking key.** Masking guards intermediaries on a real network,
  which a port has none of, but RFC 6455 requires an unpredictable key and the
  masking now runs in the worker, not on the document's thread; it masks with a
  fresh key four bytes at a time.

## Consequences

- `PublishedEndpointServer.openWebSocket` is byte-level and observes the
  server's head, data, end and close; `onData` returns whether the client takes
  more, and the connection's `send` reports when the server's socket took the
  bytes. The host reaches a listener as a `PublishedEndpointListener`, whose
  `openWebSocket(request, port, { documentLock })` resolves with the head.
- A socket whose endpoint goes closes with `1006` and an empty reason, where it
  closed with `1001` or `1012` and the host's reason before.
- `ExchangeConnection` holds the client's bytes while the program pauses its
  socket and emits `drain` when its sink takes writes again.
- The committed `service-worker.js` is regenerated.
- `websocket-session.test.ts` covers the codec, the acknowledgements and the
  failures; `tests/e2e/mimic-published-websocket-transport.spec.ts`
  checks send order across a `Blob`, a `bufferedAmount` that drains, a
  flooding server held by a slow document, an abrupt server closing with
  `1006`, a socket opened after the Service Worker is stopped, and a socket
  closing when its server process is killed. The maintained claim of
  `mimic-published-endpoint-websocket.spec.ts` holds unchanged.
