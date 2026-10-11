# @mimic-js/runtime

Runs Node.js programs, package managers and development servers inside a
browser tab. `Mimic` is the whole public API: a virtual file system,
processes, and the URLs of the HTTP servers those processes start.

```ts
import { Mimic } from '@mimic-js/runtime';

const container = await Mimic.boot();

await container.fs.mount({
  'server.mjs': {
    file: {
      contents: `
        import http from 'node:http';
        http.createServer((request, response) => response.end('hello')).listen(3000);
      `
    }
  }
});

container.endpoints.on('published', async (endpoint) => {
  // A URL that reaches the server: load it in an iframe, or request it
  // through the container, since the page's own fetch does not reach it.
  console.log(endpoint.port, endpoint.url);
  console.log(await (await container.endpoints.fetch(endpoint.url)).text());
});

const server = await container.spawn('node', ['server.mjs']);
const print = () => new WritableStream({ write: (chunk) => console.log(new TextDecoder().decode(chunk)) });
server.stdout.pipeTo(print());
server.stderr.pipeTo(print());

// Later: server.kill(); await container.teardown();
```

One container runs per page at a time.

## Setup

The package is self-contained: the document that hosts the runtime, its
workers, its Service Worker and the SQLite WebAssembly binary are files under
`dist/assets`, which the entry locates with `new URL('./assets/…',
import.meta.url)`. Bundlers copy and rewrite those references on their own.
What the package cannot do from inside a page is choose the response headers
of your server, and it needs two.

| Header | Sent with | Why |
| --- | --- | --- |
| `Cross-Origin-Opener-Policy: same-origin` | the page that calls `boot()` | Together they make the page cross-origin isolated, which the browser requires for `SharedArrayBuffer`. |
| `Cross-Origin-Embedder-Policy: require-corp` or `credentialless` | the page that calls `boot()`, and every file under `dist/assets` | |

`boot()` rejects with an error that names them when they are absent. The
runtime itself runs in a hidden frame the page opens, with the embedder
policy of its own document and of the worker scripts it loads, so the second
header belongs on the package's assets too; sending both headers with every
response is the simplest correct rule. The page also delegates the
`cross-origin-isolated` permission to that frame, so a `Permissions-Policy`
header of yours must not withhold it.

Cross-origin isolation also applies to what the page embeds. With
`require-corp`, images, scripts and frames from other origins must be served
with CORS or `Cross-Origin-Resource-Policy` headers, or they stop loading.
With `credentialless` the page loads cross-origin images, scripts and styles
without credentials instead, so no CORP headers are needed for them; frames
from other origins still need their own `Cross-Origin-Embedder-Policy`.
Chromium and Firefox support `credentialless`; Safari needs `require-corp`.
Either policy closes `window.opener` for popups the page opens, which breaks
popup-based sign-in flows.

Pass the policy you serve to `boot()`, and the documents of Published
Endpoints are served with the same one, so a preview may load what its page
may:

```ts
const container = await Mimic.boot({ embedderPolicy: 'credentialless' });
```

### The Service Worker and your own

Published Endpoints are served by a Service Worker registered for the
`__mimic__/` directory beside its script, for example
`/assets/__mimic__/` after a Vite build. Every endpoint URL starts
with that directory, so the worker controls endpoint documents and nothing
else: the page that calls `boot()` keeps the Service Worker it has, if any,
and the rest of your application is never routed through Mimic.

The same scope rule means the page's own `fetch` does not reach an endpoint.
`container.endpoints.fetch(url, init)` requests one from the page with `fetch`
semantics (streaming bodies, redirects, `AbortSignal`), through a hidden frame
under the worker's scope. Read the response before `teardown()`, which closes
that frame.

An endpoint document reaches the other servers of its container as a page on
a developer machine does: a request or WebSocket to `localhost`, `127.0.0.1`
or `[::1]` on a port the container publishes goes to that server, even one
that published after the document loaded, and any other loopback port goes to
the network. The server sees the document's loopback origin, such as
`http://localhost:4200`, as `Origin`.

### Running the container on a preview origin

By default the runtime and the endpoints are served from your page's origin.
A project's code then holds that origin's ambient authority, in two places:
its processes run in workers of your origin, where a bare `fetch` carries
your users' cookies and `indexedDB` is your application's; and the documents
its server publishes, framed by your page, can read the page through
`window.parent`. Fine for your own code; not for a repository you did not
write. Both move to an origin of their own with one option:

```ts
const container = await Mimic.boot({ previewOrigin: 'https://preview.example' });
```

Serve the same build from that origin too, with the two headers above and
`Cross-Origin-Resource-Policy: cross-origin`; the package needs only its
assets there, at the same paths. `boot()` then loads the package's Runtime
Host document from the preview origin in a hidden frame, and that document
starts the runtime's workers, registers the Service Worker and serves the
endpoints: every endpoint URL starts with that origin, and the page talks to
the container only over a `MessagePort`. Frame or open the endpoints as
before; `endpoints.fetch()`, cookies and WebSockets work the same. In
development, `http://localhost:5173` beside `http://127.0.0.1:5173` is already
a second origin of the same server:

```ts
plugins: [mimic({ previewOrigin: 'http://localhost:5173' })]
```

sends the third header from `vite dev`.

#### An origin per endpoint

Under a single preview origin an endpoint is still served under a directory,
`https://preview.example/assets/__mimic__/<id>/<route>/<port>/`,
and the document sees that prefix in `location.pathname`. A client-side
router then matches nothing: Angular's `ng serve`, Ember, Nuxt 2, React
Router 7, Remix 2, SolidStart and TanStack Router all render their 404 page
or fail to hydrate. A wildcard preview origin serves each endpoint from the
root of an origin of its own instead, the way `http://localhost:<port>/`
does on your machine:

```ts
const container = await Mimic.boot({ previewOrigin: 'https://*.preview.example' });
```

An endpoint of port 4200 is then `https://<id>--4200.preview.example/`, where
`<id>` is the container's epoch, and the Runtime Host document runs on
`https://mimic.preview.example`. Serve the package's assets from
every hostname of the wildcard (one wildcard DNS record and certificate), with
the headers above and one more, `Service-Worker-Allowed: /`, on the Service
Worker script: the worker of an endpoint's origin takes the whole origin, and
a script under `/assets/` may only do so when its response allows it. The
package opens a hidden frame of each port's origin to register that worker,
once per port, so the first request of a port costs a registration. In
development `http://*.localhost:5173` is such a wildcard on one Vite server,
since Chromium and Firefox resolve every `*.localhost` to your machine:

```ts
plugins: [mimic({ previewOrigin: 'http://*.localhost:5173' })]
```

sends the third and fourth headers from `vite dev`, and
`boot({ previewOrigin: 'http://*.localhost:5173' })` uses them. A project
owns its endpoint's origin as it would own `localhost:<port>`: it may
register a Service Worker there, and a page of its own under the directory
your build serves the package's assets from (`/assets/page.html`) is the one
path the origin does not answer with the project's document.

What this does and does not contain. With a preview origin, a project
reaches your page only through what the container serves on its port, and its
ambient `fetch`, storage and workers belong to an origin that hosts nothing.
It still spends the tab's CPU, memory and worker budget. Anything you host on
the preview origin is reachable by the project, so host nothing else there,
and any page that can load the Runtime Host document may use the origin for
its own containers. The endpoints and the processes share the preview origin,
so a project reads what it published, which is its own; two projects in two
tabs on the same preview origin share that origin's storage with each other.

### Vite

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { mimic } from '@mimic-js/runtime/vite';

export default defineConfig({
  plugins: [mimic()]
});
```

The plugin sends the two headers from `vite dev` and `vite preview` and keeps
the package out of dependency pre-bundling (which would separate the entry
from its assets). `mimic({ embedderPolicy: 'credentialless' })`
sends that policy instead of `require-corp`, and
`mimic({ previewOrigin })` adds the
`Cross-Origin-Resource-Policy` header a preview origin needs, and
`Service-Worker-Allowed: /` for a wildcard.

### webpack 5

No loader or plugin is needed; webpack follows the `new URL` references
itself. Send the headers from the development server:

```js
// webpack.config.js
module.exports = {
  devServer: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  }
};
```

### Without a bundler

Map the package name to its entry and serve `node_modules` as it is:

```html
<script type="importmap">
  { "imports": { "@mimic-js/runtime": "/node_modules/@mimic-js/runtime/dist/mimic.js" } }
</script>
```

### Production hosting

A development server's headers do not travel with the build. Configure the
same two headers on the host that serves your application; applying them to
every response is the simplest correct rule. The same headers are exported
from `@mimic-js/runtime/vite` for servers written in Node:
`mimicHeaders` for `require-corp`, and
`mimicHeadersFor(policy)` for either policy.
