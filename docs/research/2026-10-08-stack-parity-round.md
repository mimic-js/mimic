# Stack parity round: probes turned into claims, and what still stops the rest

Date: 2026-10-08. Scope: the stack probes of
[`2026-10-04-compatibility-test-approach-validation.md`](./2026-10-04-compatibility-test-approach-validation.md)
(`packages/runtime/tests/e2e/stack-probes.spec.ts`), run against the runtime
until each either passed or stopped at a gap that needs its own decision. The
current boundary is the maintained claims and their CI results, not this note.

## Stacks that became claims

| Stack | Claim | Fixture |
| --- | --- | --- |
| Express 5.2.1 REST API, graceful SIGTERM | `express-5-2-1-rest-api` | `express-5-todo-api` |
| Express 5.2.1 with EJS, sessions and a multer upload | `express-5-2-1-ejs-blog` | `express-5-ejs-blog` |
| SvelteKit 3.0.0 on Vite 8.3.2 | `sveltekit-3-0-0-guestbook` | `sveltekit-3-guestbook` |
| Tailwind CSS 4.3.3 with Vite 8.3.2 and React 19 | `tailwind-4-3-3-vite-react` | `tailwind-4-vite-react` |
| Vitest 5.0.3 | `vitest-5-0-3-cart` | `vitest-5-cart` |
| Jest 30.5.2 | `jest-30-5-2-cart` | `jest-30-cart` |
| Astro 7.3.5, development, navigation and build | `astro-7-3-5-blog` | `astro-7-blog` |

## What each needed

Every change is generic; none names a package.

- **Signals.** A `SIGTERM` or `SIGINT` listener takes the signal over, as in
  Node, and a later signal is delivered again (they were one-shot through
  every layer). Listeners receive the signal's name and number, which Vite's
  `128 + number` exit status relies on: Vite and the Angular CLI still exit
  143 on `SIGTERM`, now by closing their servers first; webpack-cli and
  webpack-dev-server exit 0, as under Node. A program that ends, by
  `process.exit()` or otherwise, closes its servers instead of waiting for
  them. A process reports a signal only when the signal ended it, so npm no
  longer re-raises a `SIGTERM` its script handled. A shell that `exec`'d its
  last command leaves that program's status alone. A signal sent while a
  package manager proxy is still starting its manager reaches the manager.
- **Uploads.** The endpoint Service Worker reads a multipart body whole
  (Chromium errors the stream of a body with a file part), and `Buffer` has
  Node's per-encoding `latin1Slice`, `utf8Write`, … that busboy parses with.
- **Archives.** TAR export carries long paths and symlink targets in pax
  headers; install layers of the Vite 8.3 graphs have them.
- **`vm` contexts.** `runInContext`, `runInNewContext`, `Script` and
  `compileFunction` with a parsing context run against a contextified object
  through scoped evaluation owned by the Runtime Artifact Compiler; the realm's
  intrinsics are shared. Jest's node environment needs it.
- **Globals.** A name a program adds to its global, and Node's own globals
  (`process`, `setImmediate`, …), are defined on the process worker's global,
  so free identifiers in other modules and code built by `Function`, `eval`,
  `AsyncFunction` or `vm.runInThisContext` see them (c12 and jiti for Nuxt,
  Vite's module runner for Astro). Names the worker already has stay shadowed.
- **Builtins.** `readline` reads its input (lines, `question`, async iteration,
  keypresses) and `readline/promises`, `path/win32`, `domain`, `punycode`,
  `cluster`, `dgram`, `trace_events` and `repl` load. `node:constants` is flat,
  `os.constants.errno` complete, `console.Console` subclassable, the process
  prototype chain callable (Jest copies the process), `child_process.execSync`
  implemented, `require.resolve` of a builtin answers its name,
  `module.findSourceMap` exists, `async_hooks.createHook` returns an inert hook
  and `fs` streams have `close()`.
- **File URLs.** `url.pathToFileURL` keeps a directory's trailing slash,
  resolves against the working directory and escapes `%`, `#` and `?`;
  exsolve resolves `@nuxt/kit` from a directory URL.
- **Sockets.** `net` and `http` listen on, and connect to, Unix domain socket
  paths; a socket holds what is written before its connection opens.
- **Navigation.** A published document's navigation to a root-relative path
  (`/posts/first`) stays on its endpoint instead of leaving for the embedding
  origin.
- **WebSockets.** A server that `close()` was called on accepts no published
  WebSocket, and a document acknowledges what it received before it sends a
  reply, so a server's write callback runs before the reply arrives, as over
  TCP.

## Still open

- **Client-side routers under the endpoint path.** Next.js 16 (on webpack,
  with `@next/swc-wasm-nodejs`, which it now downloads itself) and React
  Router 7 render on the server, but their client routers read
  `location.pathname`, which carries the endpoint's prefix, and fail to
  hydrate. Replacing the document's URL with the logical path was tried and
  reverted: document WebSockets and loopback requests resolve their endpoint
  from the document's location, and reloads the browser starts itself cannot
  be redirected. WebContainers serves each port at the root of an origin of its
  own; matching that is an endpoint-origin decision for an ADR.
- **Turbopack** needs native bindings in Next.js 16; the Next probe runs
  `next dev --webpack`, which is what Next itself suggests on WASM bindings.
- **Nuxt 4** builds its client, server and Nitro bundles; the first page
  request is not answered (504 after 35 s). Not traced further.
- **Prisma 7** downloads a native schema engine; **better-sqlite3** builds a
  native addon through node-gyp. Both need a replacement policy decision, as
  WebContainers has none either.
- A pending top-level `await` still hangs where Node exits 13: detecting it
  needs every pending host operation to count as referenced work.
- **Workers of published documents** open WebSockets without the document's
  transport, on the embedding origin. Vite 8's client pings its server from a
  SharedWorker at the origin's root, so an embedding server that answers there
  (the claims host is a Vite server; its own HMR socket now has a path of its
  own) makes a stopped container server look alive. An endpoint origin per
  port, as above, would remove the case.

## Local runs

Chromium in the cloud sandbox reaches the npm registry only through the agent
proxy; a local Playwright config that passes `HTTPS_PROXY` to Chromium and
ignores the proxy's certificate is enough. Editing runtime sources while a
Playwright run uses the Vite dev server reloads its test page, so long runs
were made from a copy of the tree.

Each new claim's fixture also ran end to end in `apps/repo-playground` against
this branch: installed and started from the playground's terminal, with the
server's page read from its preview (Vitest and Jest from the terminal). The
playground's archive proxy needs the sandbox proxy as its agent there.
