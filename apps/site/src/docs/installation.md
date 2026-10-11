# Installation

> Mimic is experimental. It has been developed largely with AI assistance, and it
> is not recommended for production use until its first major version (1.0).
> While it is 0.x, the API may change between minor versions.

## Install

```sh
npm install @mimic-js/runtime
```

The package has no runtime dependencies and is self-contained: its workers, its
Service Worker and its WebAssembly binaries ship under `dist/assets`, and
bundlers pick them up on their own. The Service Worker is scoped to a directory
beside those assets, so your application's own Service Worker, if any, is
unaffected.

## Vite

Add the plugin, and the setup is complete:

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { mimic } from '@mimic-js/runtime/vite';

export default defineConfig({
  plugins: [mimic()]
});
```

```ts
import { Mimic } from '@mimic-js/runtime';

const container = await Mimic.boot();
```

One container runs per page at a time. The [API reference](/docs/api) covers
everything `container` offers.

The plugin sends the [two headers](#the-two-headers) Mimic needs from
`vite dev` and `vite preview`, and keeps the package out of dependency
pre-bundling, which would separate the entry from its assets. The headers do
not travel with the build: see [Production](#production) before deploying.

## The two headers

Mimic needs the page to be *cross-origin isolated*, which takes two response
headers from your server. `boot()` rejects with an error naming them when they
are missing.

| Header | Sent with |
| --- | --- |
| `Cross-Origin-Opener-Policy: same-origin` | the page that calls `boot()` |
| `Cross-Origin-Embedder-Policy: require-corp` | the page that calls `boot()`, and every file under `dist/assets` |

Sending both headers with every response is the simplest correct rule.

Cross-origin isolation also applies to what the page embeds: with
`require-corp`, images, scripts and frames from other origins must be served
with CORS or `Cross-Origin-Resource-Policy` headers, or they stop loading.
Chromium and Firefox accept `credentialless` instead, which loads such
resources without credentials; Safari does not. Pass the policy you choose to
both the plugin and `boot()`, so that a preview may load what its page may:

```ts
plugins: [mimic({ embedderPolicy: 'credentialless' })]
```

```ts
const container = await Mimic.boot({ embedderPolicy: 'credentialless' });
```

Either policy closes `window.opener` for popups the page opens, which breaks
popup-based sign-in flows.

### webpack 5

No loader or plugin is needed. Send the headers from the development server:

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

Map the package name to its entry and serve `node_modules` as it is; the
server still sends the two headers.

```html
<script type="importmap">
  { "imports": { "@mimic-js/runtime": "/node_modules/@mimic-js/runtime/dist/mimic.js" } }
</script>
```

## Production

A development server's headers do not travel with the build. Configure the
two headers on the host that serves your application, on every response. For
servers written in Node, the package exports them:

```ts
import { mimicHeaders, mimicHeadersFor } from '@mimic-js/runtime/vite';

// require-corp
response.writeHead(200, { ...mimicHeaders, 'Content-Type': 'text/html' });

// either policy
const headers = mimicHeadersFor('credentialless');
```

This site is a static build on Vercel, with the headers in its `vercel.json`;
the repository's
[`docs/deploying.md`](https://github.com/mimic-js/mimic/blob/main/docs/deploying.md)
has that setup.

## Running untrusted projects on a preview origin

By default the runtime and the previews are served from your page's origin,
and a project's code holds that origin's authority: its processes `fetch` with
your users' cookies, and the documents its server publishes, framed by your
page, can read the page through `window.parent`. Fine for your own code; not
for a repository you did not write. One option moves both to an origin of
their own:

```ts
const container = await Mimic.boot({ previewOrigin: 'https://preview.example' });
```

Serve the same build from that origin too, with the two headers and
`Cross-Origin-Resource-Policy: cross-origin`; only the package's assets are
needed there, at the same paths. Every endpoint URL then starts with the
preview origin, and `endpoints.fetch()`, cookies and WebSockets work as
before. Host nothing else on that origin: a project reaches anything served
there.

In development, `http://localhost:5173` beside `http://127.0.0.1:5173` is
already a second origin of the same Vite server, and the plugin sends the
extra header:

```ts
plugins: [mimic({ previewOrigin: 'http://localhost:5173' })]
```

### An origin per endpoint

Under a single preview origin a preview is still served under a directory,
`https://preview.example/assets/__mimic__/<id>/<route>/<port>/`, which a
client-side router sees in `location.pathname`. Angular's `ng serve`, Ember,
Nuxt 2, React Router 7, Remix 2, SolidStart and TanStack Router then render
their 404 page or fail to hydrate. A wildcard preview origin serves each
endpoint from the root of an origin of its own instead, the way
`http://localhost:<port>/` does on your machine:

```ts
const container = await Mimic.boot({ previewOrigin: 'https://*.preview.example' });
```

The endpoint of port 4200 is then `https://<id>--4200.preview.example/`. A
wildcard needs the package's assets served from **every hostname of the
wildcard** (one wildcard DNS record and certificate), with the headers above
and `Service-Worker-Allowed: /`. In development, `http://*.localhost:5173` is
such a wildcard on one Vite server, since Chromium and Firefox resolve every
`*.localhost` to your machine:

```ts
plugins: [mimic({ previewOrigin: 'http://*.localhost:5173' })]
```

## Browser support

Mimic needs a cross-origin-isolated page (for `SharedArrayBuffer`), Web
Workers and Service Workers. The Compatibility Claims run in Chromium.
Chromium and Firefox support both embedder policies; Safari needs
`require-corp`, as it does not support `credentialless`.
