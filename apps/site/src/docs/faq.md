# FAQ

## What is Mimic?

A dev container in a browser tab: a browser-based runtime that executes
Node.js applications and shell commands entirely client-side. Programs run in
Web Workers over an in-memory file system, npm, pnpm and Yarn install real
packages from the npm registry, and a server a program starts becomes a URL
your page can load in an iframe. Workloads that used to need a cloud VM per
user run on the user's CPU instead; nothing runs on your servers, and nothing
leaves the browser but package downloads and the project's own requests. It is
not Docker: there are no images and no native binaries, only JavaScript and
WebAssembly.

## Is it ready for production?

Not yet. Mimic is experimental and `0.x`: the API may change between minor
versions, and it has been developed largely with AI assistance. It is not
recommended for production use until 1.0.

## How does it compare to WebContainers or a cloud VM?

Mimic and WebContainers both run the project in the user's tab, on the user's
CPU, with no machine per user. The differences are the licence and where the
runtime is served from: Mimic is MIT, self-hosted from your own origin, with
no API key and no usage limits. A cloud VM or container runs anything Linux
runs, Docker included, at the cost of a machine per active user. The
[landing page](/#how-it-compares) has the table.

## What leaves the browser?

Package downloads from the npm registry (or the registry a project
configures), and the HTTP and WebSocket requests the project's own code
makes. There is no Mimic service: the runtime is static files served by your
host, and no telemetry is sent.

## Can a program reach the network?

Outbound HTTP, HTTPS and WebSocket requests work and go through the browser's
own `fetch` and `WebSocket`, so the browser's rules apply: a server on another
origin must allow yours with CORS, as it would for a request from your page.
Raw TCP sockets, custom TLS and other protocols are rejected. Between the
container's own processes, loopback sockets work as on a machine.

## How many containers can a page run?

One at a time. `boot()` rejects while another container is alive; call
[`teardown()`](/docs/api#container-teardown) first. Processes inside a
container are not limited that way: a container runs a dev server, a test
runner and a shell side by side.

## Why does my page need two response headers?

Workers share memory through `SharedArrayBuffer`, which browsers enable only
on a cross-origin-isolated page: one that is served with
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`). The
headers change what the rest of your page may embed; the
[installation page](/docs/installation#the-two-headers) explains how to send
them with each bundler and host, and what they affect.

## Which Node.js version do programs see?

Node 22 on `linux`, so packages take the code paths they already have for
Node and Linux. Programs that spawn native binaries, or that need a native
addon without a WebAssembly build from its publisher, do not work.

## Can it run native binaries or Docker?

No. Everything runs as JavaScript or WebAssembly in the tab. Tools with
native code, such as esbuild, Rollup and Rspack, run from the WebAssembly
builds their publishers ship.

## Is it safe to run a repository I did not write?

By default the runtime and the previews are served from your page's origin,
and the project's code holds that origin's authority: its processes `fetch`
with your users' cookies, and its pages can read yours through
`window.parent`. For untrusted code, boot with a
[preview origin](/docs/installation#running-untrusted-projects-on-a-preview-origin)
of its own, as this site does with `*.mimicjs.com`. Inside that origin, the
code is still sandboxed by the browser: it reaches no file on the user's
machine.

## Can the playground open a private repository?

No. The playground downloads a public repository's archive through a proxy
on this site and has no GitHub credentials. For your own code, run your own
page with the package and mount the files with `fs.mount()`, or open a
public fork.

## Where do I report a problem?

In the [GitHub issues](https://github.com/mimic-js/mimic/issues). The most
useful report names the repository or the package and version, the command,
and what the terminal and the preview's console showed. Compatibility
failures become issues until the runtime satisfies a positive claim; an
issue is the honest form of "partially works".

## What is the licence?

[MIT](https://github.com/mimic-js/mimic/blob/main/LICENSE), for the runtime,
the site and the playground.
