# Installation

> Mimic is experimental. It has been developed largely with AI assistance, and it
> is not recommended for production use until its first major version (1.0).
> While it is 0.x, the API may change between minor versions.

## Install

```sh
npm install @mimic-js/mimic
```

The package is self-contained: the document that hosts the runtime, its
workers, its Service Worker and the SQLite WebAssembly binary are files under
`dist/assets`, which the entry locates with
`new URL('./assets/…', import.meta.url)`. Bundlers copy and rewrite those
references on their own. It has no runtime dependencies.

```ts
import { Mimic } from '@mimic-js/mimic';

const container = await Mimic.boot();
```

One container runs per page at a time. The [API reference](/docs/api) covers
everything `container` offers.

## The two headers

What the package cannot do from inside a page is choose the response headers
of your server, and it needs two:

| Header | Sent with |
| --- | --- |
| `Cross-Origin-Opener-Policy: same-origin` | the page that calls `boot()` |
| `Cross-Origin-Embedder-Policy: require-corp` or `credentialless` | the page that calls `boot()`, and every file under `dist/assets` |

Together they make the page *cross-origin isolated*, which the browser requires
for `SharedArrayBuffer`; the runtime's processes and its file system share
memory through it. `boot()` rejects with an error that names the headers when
they are absent.

The runtime itself runs in a hidden frame the page opens, with the embedder
policy of its own document and of the worker scripts it loads, so the second
header belongs on the package's assets too. **Sending both headers with every
response is the simplest correct rule.** The page also delegates the
`cross-origin-isolated` permission to that frame, so a `Permissions-Policy`
header of yours must not withhold it.

### Choosing an embedder policy

Cross-origin isolation also applies to what the page embeds:

- With `require-corp`, images, scripts and frames from other origins must be
  served with CORS or `Cross-Origin-Resource-Policy` headers, or they stop
  loading.
- With `credentialless`, the page loads cross-origin images, scripts and
  styles without credentials instead, so no CORP headers are needed for them;
  frames from other origins still need their own
  `Cross-Origin-Embedder-Policy`.

Chromium and Firefox support `credentialless`; Safari needs `require-corp`.
Either policy closes `window.opener` for popups the page opens, which breaks
popup-based sign-in flows.

Pass the policy you serve to `boot()`. The documents of Published Endpoints
are served with the same one, so a preview may load what its page may:

```ts
const container = await Mimic.boot({ embedderPolicy: 'credentialless' });
```

## Vite

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { mimic } from '@mimic-js/mimic/vite';

export default defineConfig({
  plugins: [mimic()]
});
```

The plugin sends the two headers from `vite dev` and `vite preview`, and keeps
the package out of dependency pre-bundling, which would separate the entry
from its assets.

- `mimic({ embedderPolicy: 'credentialless' })` sends that policy instead of
  `require-corp`.
- `mimic({ previewOrigin })` adds the `Cross-Origin-Resource-Policy: cross-origin`
  header a [preview origin](#running-the-container-on-a-preview-origin) needs,
  and `Service-Worker-Allowed: /` when the preview origin is a wildcard.

## webpack 5

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

## Without a bundler

Map the package name to its entry and serve `node_modules` as it is:

```html
<script type="importmap">
  { "imports": { "@mimic-js/mimic": "/node_modules/@mimic-js/mimic/dist/mimic.js" } }
</script>
```

The server still sends the two headers.

## Production hosting

A development server's headers do not travel with the build. Configure the
same two headers on the host that serves your application; applying them to
every response is the simplest correct rule.

For servers written in Node, the same headers are exported from
`@mimic-js/mimic/vite`:

```ts
import { mimicHeaders, mimicHeadersFor } from '@mimic-js/mimic/vite';

// require-corp
response.writeHead(200, { ...mimicHeaders, 'Content-Type': 'text/html' });

// either policy
const headers = mimicHeadersFor('credentialless');
```

## The Service Worker and your own

Published Endpoints are served by a Service Worker registered for the
`__mimic__/` directory beside its script, for example `/assets/__mimic__/`
after a Vite build. Every endpoint URL starts with that directory, so the
worker controls endpoint documents and nothing else: the page that calls
`boot()` keeps the Service Worker it has, if any, and the rest of your
application is never routed through Mimic.

The same scope rule means the page's own `fetch` does not reach an endpoint.
`container.endpoints.fetch(url, init)` requests one from the page with `fetch`
semantics. An endpoint document reaches the other servers of its container as
a page on a developer machine does: a request to `localhost`, `127.0.0.1` or
`[::1]` on a port the container publishes goes to that server.

## Running the container on a preview origin

By default the runtime and the endpoints are served from your page's origin.
A project's code then holds that origin's ambient authority: its processes
run in workers of your origin, where a bare `fetch` carries your users'
cookies and `indexedDB` is your application's, and the documents its server
publishes, framed by your page, can read the page through `window.parent`.
Fine for your own code; not for a repository you did not write. Both move to
an origin of their own with one option:

```ts
const container = await Mimic.boot({ previewOrigin: 'https://preview.example' });
```

Serve the same build from that origin too, with the two headers and
`Cross-Origin-Resource-Policy: cross-origin`; the package needs only its
assets there, at the same paths. `boot()` then loads the package's Runtime
Host document from the preview origin in a hidden frame, and that document
starts the runtime's workers, registers the Service Worker and serves the
endpoints: every endpoint URL starts with that origin, and the page talks to
the container only over a `MessagePort`. `endpoints.fetch()`, cookies and
WebSockets work the same.

In development, `http://localhost:5173` beside `http://127.0.0.1:5173` is
already a second origin of the same server:

```ts
plugins: [mimic({ previewOrigin: 'http://localhost:5173' })]
```

### An origin per endpoint

Under a single preview origin an endpoint is still served under a directory,
`https://preview.example/assets/__mimic__/<id>/<route>/<port>/`, and the
document sees that prefix in `location.pathname`. A client-side router then
matches nothing: Angular's `ng serve`, Ember, Nuxt 2, React Router 7, Remix 2,
SolidStart and TanStack Router render their 404 page or fail to hydrate. A
wildcard preview origin serves each endpoint from the root of an origin of
its own instead, the way `http://localhost:<port>/` does on your machine:

```ts
const container = await Mimic.boot({ previewOrigin: 'https://*.preview.example' });
```

An endpoint of port 4200 is then `https://<id>--4200.preview.example/`, where
`<id>` is the container's epoch, and the Runtime Host document runs on
`https://mimic.preview.example`. A wildcard needs:

- the package's assets served from **every hostname of the wildcard** (one
  wildcard DNS record and certificate), at the same paths;
- the two headers and `Cross-Origin-Resource-Policy: cross-origin`;
- `Service-Worker-Allowed: /` on the Service Worker script: the worker of an
  endpoint's origin takes the whole origin, and a script under `/assets/` may
  only do so when its response allows it.

The package opens a hidden frame of each port's origin to register that
worker, once per port, so the first request of a port costs a registration.
In development `http://*.localhost:5173` is such a wildcard on one Vite
server, since Chromium and Firefox resolve every `*.localhost` to your
machine:

```ts
plugins: [mimic({ previewOrigin: 'http://*.localhost:5173' })]
```

sends the third and fourth headers from `vite dev`, and
`boot({ previewOrigin: 'http://*.localhost:5173' })` uses them.

### What a preview origin does and does not contain

With a preview origin, a project reaches your page only through what the
container serves on its port, and its ambient `fetch`, storage and workers
belong to an origin that hosts nothing. It still spends the tab's CPU, memory
and worker budget. Anything you host on the preview origin is reachable by
the project, so host nothing else there, and any page that can load the
Runtime Host document may use the origin for its own containers. Two projects
in two tabs on the same preview origin share that origin's storage with each
other.

## Hosting on Vercel

This site is a static Vite build deployed on Vercel. Its root `vercel.json`
sends the headers with every response, including the static assets, and
serves the single-page application for every path that is not a file:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": null,
  "installCommand": "npx --yes pnpm@11.7.0 install --frozen-lockfile",
  "buildCommand": "npx --yes pnpm@11.7.0 nx run site:build",
  "outputDirectory": "apps/site/dist",
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
        { "key": "Cross-Origin-Embedder-Policy", "value": "require-corp" },
        { "key": "Cross-Origin-Resource-Policy", "value": "cross-origin" },
        { "key": "Service-Worker-Allowed", "value": "/" }
      ]
    }
  ],
  "rewrites": [
    { "source": "/github-archive/:path*", "destination": "https://codeload.github.com/:path*" },
    { "source": "/(.*)", "destination": "/index.html" }
  ]
}
```

For an application of your own, keep the `headers` entry and adapt the
commands; the last two headers are needed only with a preview origin. The
`/github-archive` rewrite is the playground's: it reads repository archives
from codeload.github.com, which sends no CORS headers.

The preview origin is chosen at build time with `VITE_PREVIEW_ORIGIN`, for
example a wildcard on a domain of its own:

```sh
VITE_PREVIEW_ORIGIN=https://*.mimic-preview.dev
```

Assign the site's domain, the preview domain and its wildcard
(`*.mimic-preview.dev`) to the same Vercel project, so that every hostname
serves the same build. Vercel issues a certificate for a wildcard domain
only when the domain uses Vercel's nameservers. The Runtime Host document
then runs on `https://mimic.mimic-preview.dev`, and each endpoint on
`https://<epoch>--<port>.mimic-preview.dev/`. The repository's
[`docs/deploying.md`](https://github.com/mimic-js/mimic/blob/main/docs/deploying.md)
has the step-by-step setup.

## Browser support

Mimic needs a cross-origin-isolated page (for `SharedArrayBuffer`), Web
Workers and Service Workers. The Compatibility Claims run in Chromium.
Chromium and Firefox support both embedder policies; Safari needs
`require-corp`, as it does not support `credentialless`.
