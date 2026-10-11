# Research: real Vite WebSocket HMR in a browser-resident runtime

> Snapshot note: source findings and dated evidence are retained, but repo-specific
> “current state” statements may be obsolete. Verify them against current code,
> tests, issues, and [`compatibility-status.md`](../compatibility-status.md). See
> [the research status rules](./README.md).

Date: 2026-06-20

## Why this research exists

The roadmap still has a cluster of open items around real Vite HMR:

- `Support WebSocket upgrades so Vite's real HMR server can run.`
- `Replace the virtual /@vite/client BroadcastChannel bridge with real Vite WebSocket HMR before treating React Fast Refresh as complete.`
- `Pass HMR browser smokes for JS, JSX, CSS, and framework component updates.`

This document answers the internet-research part of that gap for the current repo goal: execute a real Vite dev server inside a browser-only Node-like runtime, and let the preview iframe talk to it through the same HMR contract that real Vite expects.

## Repo-specific context

- The then-current `src/runtime/dev-server.ts` special-cased `/@vite/client` and
  returned a handwritten virtual client. That legacy file has since been deleted.
- The then-current `src/runtime/hmr-client.ts` used `BroadcastChannel` and
  `window.location.reload()` as the HMR transport model. That legacy file has
  since been deleted.
- [`../../src/runtime/server-manager.ts`](../../src/runtime/server-manager.ts) routes preview HTTP requests, but there is no equivalent virtual socket/WebSocket layer yet.
- [`../../docs/roadmap-alignment.md`](../../docs/roadmap-alignment.md) explicitly says the current React browser path is still transitional because `/@vite/client` is fake.

So the real question is not "how do we trigger a reload when a file changes?" The real question is how to satisfy Vite's actual browser WebSocket contract when the server itself lives inside the browser rather than on a host TCP socket.

## Source-backed findings

### 1. Vite's browser client expects a real `WebSocket`, not an abstract pub/sub channel

Vite's current client creates a `WebSocket` using a URL derived from the injected HMR constants, appends `?token=...`, and requests the `vite-hmr` subprotocol. The same client has a separate `vite-ping` connection path used when the HMR link drops and it polls for server restart.

That matters because the current repo bridge does not just differ in implementation detail. It skips the exact transport contract that the real Vite client uses.

Sources:

- [Vite client source](https://github.com/vitejs/vite/blob/main/packages/vite/src/client/client.ts)
- [MDN: WebSocket() constructor](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/WebSocket)

### 2. The HMR message protocol is richer than "file changed"

Vite's public payload types include:

- `connected`
- `ping`
- `update`
- `full-reload`
- `custom`
- `error`
- `prune`

`update` carries structured entries with `type`, `path`, `acceptedPath`, `timestamp`, and internal invalidation metadata. The client also uses `custom` events for connection-loss handling and framework/plugin coordination.

This means a replacement transport cannot stop at "send a changed path over BroadcastChannel". It must preserve the HMR payload envelope, or the real client and plugin ecosystem will misbehave.

Sources:

- [Vite HMR payload types](https://github.com/vitejs/vite/blob/main/packages/vite/types/hmrPayload.d.ts)
- [Vite HMR API](https://vite.dev/guide/api-hmr)

### 3. Vite assumes WebSocket proxying or a direct socket fallback path

Vite's server options document says HMR uses a WebSocket connection and notes that reverse proxies are expected to proxy WebSocket correctly. If they do not, the client falls back to a direct WebSocket connection to the HMR server.

This is directly relevant to this repo because the preview path already looks proxy-like: the iframe loads a same-origin preview URL instead of the raw server address. A WebContainers-like browser runtime therefore needs the moral equivalent of a reverse proxy that handles both HTTP and WebSocket traffic, not only fetch-based preview responses.

Sources:

- [Vite server options: `server.hmr`](https://vite.dev/config/server-options)
- [Vite client source](https://github.com/vitejs/vite/blob/main/packages/vite/src/client/client.ts)

### 4. Service Workers are a fetch interception mechanism, not a WebSocket upgrade mechanism

MDN's Service Worker API documentation describes the service worker request path in terms of `FetchEvent` and `respondWith()`. MDN's WebSocket documentation separately describes `WebSocket` as an API that immediately attempts to establish a socket connection to a target WebSocket URL.

Inference: the current Service Worker preview gateway is the right primitive for HTTP preview requests, but it is not by itself the final answer for Vite HMR transport. The repo needs either a browser-visible WebSocket endpoint or a deliberate `WebSocket` shim for preview pages. Trying to route HMR only through Service Worker fetch handling will leave a protocol gap.

Sources:

- [MDN: Service Worker API](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)
- [MDN: WebSocket() constructor](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/WebSocket)

### 5. Browser WebSocket is available in workers, which fits the runtime-kernel direction

MDN documents WebSocket support in workers. That aligns with the roadmap's earlier process-model research: once the runtime moves behind a worker-backed kernel, the kernel can own a virtual HMR connection broker instead of leaving transport state in the page thread.

That does not remove the need for a preview-page-facing socket abstraction, but it does mean the authoritative HMR session table can live off the main thread.

Sources:

- [MDN: WebSocket API](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API)
- [Research: browser process model for Node-like execution](./browser-process-model.md)

### 6. Vite HMR behavior includes restart detection and overlay/error flows

The real Vite client does more than apply module updates:

- it handles `error` payloads for the error overlay
- it handles `full-reload` for HTML and unrecoverable invalidation cases
- it emits lifecycle events such as `vite:beforeUpdate`, `vite:afterUpdate`, `vite:beforeFullReload`, and `vite:error`
- when the socket disconnects, it can poll with `vite-ping` and reload once the dev server is back

This matters because a transport that only carries successful `update` payloads will still be observably incomplete in real projects, especially with React Fast Refresh and compile errors.

Sources:

- [Vite client source](https://github.com/vitejs/vite/blob/main/packages/vite/src/client/client.ts)
- [Vite HMR API](https://vite.dev/guide/api-hmr)

## What this means for this repo

### Main conclusion

The repo should stop treating HMR as a file-reload side channel and instead implement a real Vite-compatible HMR transport boundary.

That means:

1. stop serving the handwritten `/@vite/client` in the real Vite path
2. let the real Vite client execute
3. satisfy its `WebSocket(..., 'vite-hmr')` and restart-ping expectations
4. preserve Vite payload types end to end

Without that, React Fast Refresh, CSS HMR, error overlays, and future framework HMR remain structurally unproven.

### Why the current Service Worker preview bridge is insufficient

The current preview architecture is good for same-origin HTTP asset loading, but the HMR channel is not just another fetch. The preview iframe runs browser code that constructs a `WebSocket`, and the current repo does not expose a real upgrade path behind the preview URL.

So the missing layer is not "better BroadcastChannel plumbing". The missing layer is a WebSocket-facing transport abstraction between the preview page and the runtime-owned Vite server.

## Inference: recommended architecture

This section is an inference from the sources and the current repo structure.

### Option A. Preferred near-term approach: inject a preview-scoped `WebSocket` shim

For a browser-resident runtime, the most practical first serious implementation appears to be:

1. inject a preview bootstrap script before the real `/@vite/client`
2. patch `window.WebSocket` only for preview-origin HMR URLs that target the active preview instance
3. back that shim with a `MessagePort`/worker bridge to a runtime-owned virtual socket table
4. emulate the browser-facing `WebSocket` object lifecycle: `open`, `message`, `error`, `close`, `send()`, `close()`, `readyState`, `protocol`
5. preserve the requested subprotocols, especially `vite-hmr` and `vite-ping`

Why this is the best immediate fit:

- it does not depend on a host TCP server, which the repo explicitly does not have
- it can coexist with the current same-origin preview URL model
- it lets the real Vite client run unchanged after the global `WebSocket` entrypoint is satisfied

Important constraint: the shim must be narrowly scoped. It should only intercept WebSocket URLs belonging to the preview/runtime endpoint, and delegate all unrelated sockets to the browser's native `WebSocket`.

### Option B. Longer-term target: full virtual socket layer used by both Node `net/http` and preview HMR

The long-term architecture should still converge on the roadmap direction:

- virtual socket table for `net.Server` and `net.Socket`
- HTTP request/response objects backed by stream semantics
- WebSocket upgrade path owned by that same socket layer

In that target model, the preview-side `WebSocket` shim becomes only the browser entry adapter into the virtual socket layer, not a Vite-specific transport.

## Recommended implementation sequence

### Phase 1. Stop hardcoding the virtual Vite client in the real Vite path

- Keep the fake client only behind explicit fallback/testing modes.
- In the real Vite path, serve Vite's real `/@vite/client` output.
- Add a smoke that fails if preview code still contains the handwritten BroadcastChannel client when running the real Vite stack.

### Phase 2. Add a preview bootstrap that installs a scoped WebSocket shim

- Inject the bootstrap before `/@vite/client` in HTML responses.
- Match HMR socket URLs by preview instance id, port, and base path.
- Support both `vite-hmr` and `vite-ping`.
- Mirror browser `WebSocket` event timing closely enough that the real Vite client does not detect a broken connection.

### Phase 3. Add a runtime-owned HMR connection broker

- Track virtual HMR sessions by preview instance + port + client id.
- Route browser `send()` frames to the Vite-side HMR server interface.
- Deliver server payloads back as `message` events with the original JSON payload shape.
- Surface close/error semantics so restart polling and reconnect logic still works.

### Phase 4. Connect the broker to a generic virtual socket/upgrade layer

- Reuse the same transport model for future `net`, `http`, and WebSocket upgrades.
- Avoid keeping a Vite-only side channel once the general socket layer exists.

### Phase 5. Validate with browser smokes, not only unit tests

Minimum smokes:

- JS module HMR applies without page reload
- CSS hot update applies without page reload
- React Fast Refresh updates component code and preserves state where expected
- syntax/plugin errors surface through the real Vite overlay path
- server restart triggers the real reconnect/ping flow instead of a custom reload shortcut

## Data-contract recommendation

The virtual browser-side socket adapter should preserve at least these fields and events:

- constructor URL and requested protocols
- `readyState`
- `protocol`
- `open`
- `message`
- `error`
- `close`
- `send(data)`
- `close(code?, reason?)`

And the runtime-side HMR broker should preserve Vite payload envelopes exactly, including:

- `connected`
- `ping`
- `update`
- `full-reload`
- `custom`
- `error`
- `prune`

Do not flatten these into ad hoc file-update messages. That would just recreate the current compatibility trap one layer deeper.

## Risks and constraints

### 1. A fake `WebSocket` that is too narrow will pass simple smokes and still break Vite

The client expects connection lifecycle, protocol negotiation, reconnect behavior, and mixed payload types. A minimalist wrapper that only forwards `update` JSON will be brittle.

### 2. A global `WebSocket` patch can break user applications

The patch must be scoped to preview-owned HMR URLs. Real user app sockets should continue using the browser-native implementation.

### 3. Service Worker and HMR should not be conflated

HTTP preview delivery and HMR transport are related, but they are not the same channel. Treating them as one mechanism will keep causing architectural shortcuts.

### 4. Real Vite client adoption will expose more missing payload cases

Once the fake client is removed, missing support for `error`, `custom`, restart ping, or framework-specific hot events will become visible quickly. That is expected and should be treated as progress, not regression.

## Decision

Recommended next implementation task:

- replace the handwritten real-path `/@vite/client` with the actual Vite client
- inject a preview-scoped `WebSocket` shim that bridges `vite-hmr` and `vite-ping` into a runtime-owned broker

That is the smallest credible step that moves the repo from "simulated updates" toward real Vite/WebContainers-style HMR.

## Sources

- [Vite client source](https://github.com/vitejs/vite/blob/main/packages/vite/src/client/client.ts)
- [Vite HMR payload types](https://github.com/vitejs/vite/blob/main/packages/vite/types/hmrPayload.d.ts)
- [Vite server options: `server.hmr`](https://vite.dev/config/server-options)
- [Vite HMR API](https://vite.dev/guide/api-hmr)
- [MDN: WebSocket API](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API)
- [MDN: WebSocket() constructor](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/WebSocket)
- [MDN: Service Worker API](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)
