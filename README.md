<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo/mimic-wordmark-dark.svg">
    <img alt="Mimic" src="assets/logo/mimic-wordmark.svg" height="80">
  </picture>
</p>

<p align="center">Node.js programs, package managers and development servers, inside a browser tab.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@mimic-js/runtime"><img alt="npm" src="https://img.shields.io/npm/v/@mimic-js/runtime"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <a href="https://github.com/mimic-js/mimic/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/mimic-js/mimic/actions/workflows/ci.yml/badge.svg"></a>
</p>

> [!WARNING]
> Mimic is experimental. It has been developed largely with AI assistance, and it
> is not recommended for production use until its first major version (1.0).
> While it is 0.x, the API may change between minor versions.

## What it is

Mimic is a Node.js runtime for the browser. Programs run in Web Workers over an
in-memory file system, npm, pnpm and Yarn install real packages from the npm
registry, and a server a program starts becomes a URL your page can load in an
iframe. Nothing runs on your servers, and nothing leaves the browser but package
downloads and the project's own requests.

## How it compares

Three ways to run a user's Node.js project from a web app:

| | Cloud VM or container | WebContainers | Mimic |
| --- | --- | --- | --- |
| **Licence** | A hosted service's terms, or infrastructure you run | The vendor's licence and terms | **MIT**: self-hosted, no API key, no usage limits |
| **Where the project runs** | A remote machine per user | The user's tab; the runtime served by the vendor | The user's tab; the runtime served from your origin |
| **Startup** | Provision or wake a machine | No machine; installs use the user's CPU | No machine; installs use the user's CPU |
| **Server cost per user** | A machine per active user | None beyond hosting the page | None beyond hosting the page |
| **Isolation** | A VM or container | The browser's sandbox | A cross-origin-isolated tab, optionally a separate [preview origin](packages/runtime/README.md#running-the-container-on-a-preview-origin) |
| **Limits** | Anything Linux runs, Docker included | No native binaries or Docker; a tab's memory | No native binaries or Docker; a tab's memory |

## Capabilities

- **Node.js runtime**: Node 22 with ES modules, CommonJS, the common builtins and SQLite.
- **Virtual file system**: one in-memory file system shared by every process, mounted and
  exported as a tree, ZIP or TAR.
- **Shell**: `sh -c` and the shell scripts package scripts use, with common commands such as
  `ls`, `cp` and `sed`.
- **Package managers**: npm, pnpm and Yarn, the real upstream CLIs; packages with native code
  use their publishers' WebAssembly builds.
- **WebAssembly**: WASI programs, and the WebAssembly builds of tools such as esbuild, Rollup
  and Rspack.
- **Networking**: published ports with streaming HTTP, WebSockets and cookies; outbound HTTP
  and WebSocket requests through the browser.

## Quick start

```sh
npm install @mimic-js/runtime
```

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

container.endpoints.on('published', (endpoint) => {
  document.querySelector('iframe').src = endpoint.url;
});

const server = await container.spawn('node', ['server.mjs']);
server.stdout.pipeTo(new WritableStream({ write: (chunk) => console.log(new TextDecoder().decode(chunk)) }));
// Later: server.kill(); await container.teardown();
```

One container runs per page at a time.

The page that calls `boot()` must be cross-origin isolated, so serve it (and the
package's `dist/assets`) with these headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp   (or credentialless)
```

`boot()` rejects with an error naming them when they are missing. With Vite, the
plugin sends them from `vite dev` and `vite preview`:

```ts
import { mimic } from '@mimic-js/runtime/vite';

export default defineConfig({ plugins: [mimic()] });
```

The [package README](packages/runtime/README.md#setup) covers the rest: webpack,
use without a bundler, production hosting, and the preview origin.

## Development

Requires Node 22 and pnpm 11.

```sh
pnpm install
pnpm run dev              # start the site and its playground at http://localhost:5173
pnpm run test:build       # build and typecheck every project
pnpm run test:unit        # Vitest unit tests of the runtime
pnpm run test:e2e         # Playwright browser tests, including every Compatibility Claim
pnpm run package:check    # build the package and check what it would publish
```

[`docs/README.md`](docs/README.md) maps the rest of the documentation, including the
architecture decisions under [`docs/adr/`](docs/adr/).

## Browser support

Mimic needs a cross-origin-isolated page (for `SharedArrayBuffer`), Web Workers
and Service Workers. The Compatibility Claims run in Chromium. Chromium and
Firefox support both embedder policies; Safari needs `require-corp`, as it does
not support `credentialless`. The [package README](packages/runtime/README.md#setup) explains
what each embedder policy changes for the rest of your page.

## License

[MIT](LICENSE)
