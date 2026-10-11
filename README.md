<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo/01-chameleon-hex-wordmark-dark.svg">
    <img alt="Mimic" src="assets/logo/01-chameleon-hex-wordmark.svg" height="80">
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

Mimic runs Node.js programs in Web Workers over a shared, in-memory virtual file
system. Its package managers (npm, pnpm and Yarn, the real upstream CLIs) install
real packages from the npm registry, and when a program starts an HTTP or
WebSocket server, its port is published as a URL that your page can load in an
iframe. Programs see Node 22 on `linux`.

## How it compares

Three ways to run a user's Node.js project from a web app:

| | Cloud VM or container | Proprietary in-browser runtime (WebContainers) | Mimic |
| --- | --- | --- | --- |
| Licence | A hosted service's terms, or infrastructure you run | The vendor's licence and terms | MIT: self-hosted, no API key, no usage limits |
| Where the project runs | A remote machine per user | The user's browser tab, with the runtime served by its vendor | The user's browser tab, served from your own origin |
| Startup | Provision or wake a machine | No machine to provision; installs run on the user's CPU | No machine to provision; installs run on the user's CPU |
| Server cost per user | A machine per active user | None beyond hosting the page | None beyond hosting the page |
| Isolation | A VM or container boundary | The browser's sandbox | A cross-origin-isolated tab, optionally with a separate [preview origin](packages/runtime/README.md#running-the-container-on-a-preview-origin) |
| Limits | Anything Linux runs, Docker included | No native binaries without a WebAssembly build, a tab's memory, no Docker | No native binaries without a WebAssembly build, a tab's memory, no Docker |

Mimic is MIT-licensed and hosted by you, with no API key, usage limits or terms
that restrict commercial use. The project's files, processes and development
server stay in the user's tab and nothing is uploaded to a third-party service:
only package downloads from the public npm registry and the project's own
outbound requests leave the browser, which matters for private code and for
compliance.

## Capabilities

- **Node.js runtime**: Node 22 on `linux`, ES modules and CommonJS, the common builtins,
  `child_process` with `fork`, `worker_threads`, and `node:sqlite` on WebAssembly SQLite.
- **Virtual file system**: one in-memory, POSIX-like file system shared by every process,
  mounted and exported as a tree, ZIP or TAR; only the compile and install caches persist.
- **Shell**: `sh -c` and shell scripts as package scripts use them, with common commands such
  as `ls`, `cp` and `sed`; no here-documents, functions or `[[ ]]`.
- **Package managers**: the upstream npm 11, pnpm 11 and Yarn 4 CLIs (or the project's
  `packageManager` release); packages with native code get their publishers' WebAssembly builds.
- **WebAssembly and WASI**: WASI Preview 1 programs and `node:wasi`; publisher WebAssembly
  builds of esbuild, Rspack, Rolldown, oxc-parser, Lightning CSS and Rollup.
- **Networking**: published ports with streaming HTTP, WebSockets and cookies; outbound HTTP,
  HTTPS and WebSocket through the browser; an optional preview origin.
- **Tooling**: TypeScript, Prettier, ESLint, Sass, Vitest, Jest, Tailwind CSS, webpack and
  Rollup; Express, Fastify, Koa, Hono, NestJS, Socket.IO and `ws`.
- **Frameworks and toolchains**: Vite 6 to 8 with HMR for React, Vue, Svelte and Solid, the
  Angular CLI, Astro and SvelteKit; the playground also runs Nx, Rsbuild, Eleventy and more.
- **Compatibility evidence**: Playwright Compatibility Claims, run in Chromium in CI against
  exact lockfiles; see [`docs/compatibility-status.md`](docs/compatibility-status.md).

Decisions behind these: see [`docs/adr/`](docs/adr/). The full lists of builtins, shell
features and claimed packages are in the ADRs and in [`packages/runtime/tests/e2e/`](packages/runtime/tests/e2e/).

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

## Playground and documentation

<!-- TODO: site URL -->
- Site and playground: [mimic-js.dev](https://mimic-js.dev)
- [`apps/site`](apps/site): the site, with the documentation (`/docs`) and the playground, which opens a public GitHub repository (`/playground?repo=owner/name`) or a demo app (`/playground?example=<id>`) in an editor with a terminal. [`docs/deploying.md`](docs/deploying.md) covers its Vercel deployment.
- [`docs/README.md`](docs/README.md): the documentation map.
- [`docs/adr/`](docs/adr/): accepted architecture decisions.
- [`CONTEXT.md`](CONTEXT.md): the domain glossary.

## Repository layout

| Path | Contents |
| --- | --- |
| [`packages/runtime`](packages/runtime) | The published `@mimic-js/runtime` package, its unit tests and its Playwright Compatibility Claims |
| [`apps/site`](apps/site) | The site: landing page, documentation and playground |
| [`apps/e2e-demo`](apps/e2e-demo) | The demo application the Playwright suite drives as the package's browser witness |
| [`docs/`](docs) | ADRs, the roadmap, the compatibility evidence contract and dated research |

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

## Browser support

Mimic needs a cross-origin-isolated page (for `SharedArrayBuffer`), Web Workers
and Service Workers. The Compatibility Claims run in Chromium. Chromium and
Firefox support both embedder policies; Safari needs `require-corp`, as it does
not support `credentialless`. The [package README](packages/runtime/README.md#setup) explains
what each embedder policy changes for the rest of your page.

## Status

[`docs/roadmap-alignment.md`](docs/roadmap-alignment.md) states the target and
the evidence bar. Known gaps include:

- the Next.js development server;
- Analog;
- Turbopack.

## License

[MIT](LICENSE)
