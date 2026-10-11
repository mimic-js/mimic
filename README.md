<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo/01-chameleon-hex-wordmark-dark.svg">
    <img alt="Mimic" src="assets/logo/01-chameleon-hex-wordmark.svg" height="80">
  </picture>
</p>

<p align="center">Node.js programs, package managers and development servers, inside a browser tab.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@mimic-js/mimic"><img alt="npm" src="https://img.shields.io/npm/v/@mimic-js/mimic"></a>
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
iframe. Programs see a Node 22 on `linux`, and `process.versions.webcontainer` is
set, so packages take the code paths they already have for a browser-hosted Node.

It is an independent, open-source implementation of the idea behind StackBlitz
WebContainers, with a similar API shape. It is not affiliated with StackBlitz.

## Capabilities

Each item below comes from an [ADR](docs/adr/), a Compatibility Claim in
[`packages/runtime/tests/e2e/`](packages/runtime/tests/e2e/) or the runtime's
source.

**Node.js runtime**
- Node 22.22.3 on `linux`/`wasm32`; `process.versions.webcontainer` reports the package version ([ADR-0039](docs/adr/0039-report-linux-as-the-node-platform.md), [ADR-0045](docs/adr/0045-report-the-webcontainer-runtime-version.md)).
- ES modules and CommonJS with Node semantics: one module registry per context, Node module identities, `--import`/`--require` preloads and `node:module` customization hooks.
- Builtins include `fs`, `path`, `events`, `stream`, `buffer`, `crypto`, `zlib`, `util`, `url`, `os`, `http`, `https`, `net`, `child_process`, `worker_threads`, `async_hooks`, `readline`, `timers`, `vm`, `module` and `wasi`. Pure builtins come from maintained ports ([ADR-0026](docs/adr/0026-take-pure-node-builtins-from-maintained-ports.md)). `dns`, `tls` and `http2` report the limits of a browser.
- `node:sqlite` runs real SQLite compiled to WebAssembly, and its databases are SQLite files on the virtual file system ([ADR-0017](docs/adr/0017-back-node-sqlite-with-sqlite-webassembly.md)).
- `child_process`: `spawn`, synchronous `spawnSync` and `execFileSync` for JavaScript and WASI children, and `fork` with an IPC channel ([ADR-0036](docs/adr/0036-carry-a-forked-process-ipc-channel-over-the-port-relay.md)).
- `worker_threads`, including inline workers and `receiveMessageOnPort` ([ADR-0025](docs/adr/0025-use-one-synchronous-channel.md)).
- `AsyncLocalStorage` context follows awaits, promise reactions and scheduled callbacks ([ADR-0018](docs/adr/0018-carry-async-context-through-compiled-continuations.md)).
- Each module is compiled once with Babel and cached in the origin private file system, shared across processes and reloads ([ADR-0023](docs/adr/0023-compile-once-with-babel-and-a-shared-compile-cache.md)).
- The embedding page's main thread stays free of long tasks while npm installs.

**Virtual file system**
- One in-memory, POSIX-like file system shared by every process: stats, symlinks, file descriptors that survive rename and unlink, atomic rename, and recursive watches.
- `fs.mount()` takes a file tree or a ZIP or TAR archive; `fs.export()` returns a JSON tree, ZIP or TAR, with metadata and symlinks.
- The file system lasts as long as the container. Only the Compile Cache and the package-manager artifact cache persist (in the origin private file system).

**Shell**
- `sh -c` and shell scripts for package scripts: `&&`, `||`, `;`, pipes, `<`, `>`, `>>`, descriptor redirection (`2>&1`, `2>/dev/null`), background jobs and `wait`, `$(...)` substitution, `${VAR:-default}`, globs, quoting, subshells, `if`, `for`, `while` and `case`.
- Builtins such as `cd`, `export`, `unset`, `set -e`/`-u`/`-x`/`-o pipefail`, `test`/`[`, `echo`, `printf`, `read`, `source`, `exec`, `command`, `kill`; and `ls`, `cat`, `cp`, `mv`, `rm`, `mkdir`, `touch`, `env`, `which`, `dirname`, `basename`, `uname` and `sed` as programs.
- `PATH` lookup of package bins, `#!/usr/bin/env node`, `#!/bin/sh` and `env -S` shebangs, and status 127 for an unknown command.
- Not supported: here-documents, shell functions, `[[ ]]`, arrays, process substitution and `&>`.

**Package managers**
- npm 11.18.0, pnpm 11.11.0 and Yarn 4.17.1, each the pinned upstream CLI run as an ordinary process with its arguments untouched (a Command Proxy, [ADR-0021](docs/adr/0021-reduce-package-management-to-a-pinned-cli-and-a-replacement-map.md)). A project's `packageManager` field selects another release ([ADR-0041](docs/adr/0041-run-the-package-manager-release-a-project-asks-for.md)).
- Frozen installs from exact lockfiles, including npm and pnpm workspaces and Yarn PnP.
- Browser Package Replacements: packages with native code are swapped after install for their publishers' same-version browser builds (`esbuild` → `@esbuild/wasi-preview1`, `rollup` → `@rollup/wasm-node`, `lightningcss` → `lightningcss-wasm`, `@parcel/watcher` → `@parcel/watcher-wasm`).
- NAPI-RS packages get their same-version `wasm32-wasi` binding installed as a companion ([ADR-0028](docs/adr/0028-install-wasi-bindings-as-companions-from-napi-metadata.md)).
- A `node-gyp` build ends without the native addon instead of failing the install ([ADR-0040](docs/adr/0040-let-a-native-addon-build-end-without-the-addon.md)).

**WebAssembly and WASI**
- WASI Preview 1 programs, as commands and through `node:wasi`, with the virtual file system preopened.
- Publisher WASI/WASM builds proven: esbuild, Rspack, Rolldown, oxc-parser, Lightning CSS ([ADR-0012](docs/adr/0012-replace-lightning-css-with-its-publisher-wasm-sibling.md), now ADR-0021), Rollup.

**Networking**
- A server's listening port is published as a URL; `container.endpoints.fetch()` requests it from the page.
- HTTP with streaming bodies, WebSockets and a per-endpoint cookie jar with `document.cookie` ([ADR-0024](docs/adr/0024-deliver-published-http-as-structured-requests.md), [ADR-0038](docs/adr/0038-serve-a-published-websocket-from-its-process-worker.md)).
- A published page's requests to `localhost` ports reach the container's other servers ([ADR-0037](docs/adr/0037-route-a-documents-loopback-requests-to-its-containers-ports.md)).
- Outbound HTTP, HTTPS and WebSocket from programs, through the browser's network stack.
- An optional preview origin keeps a project's code off your page's origin, and a wildcard preview origin serves each endpoint from the root of an origin of its own, as client-side routers need ([ADR-0032](docs/adr/0032-serve-published-endpoints-from-a-preview-origin.md), [ADR-0044](docs/adr/0044-serve-each-published-endpoint-from-an-origin-of-its-own.md)).

**Tooling with Compatibility Claims**
- TypeScript 6, Prettier, ESLint, Sass, Vitest, Jest, Tailwind CSS 4, webpack 4 and 5 with webpack-dev-server, Rollup 3 and 4, `@parcel/watcher`.
- Vite 6, 7 and 8 development servers with upstream HMR for React, Vue, Svelte and Solid; Angular 21 and 22 through the Angular CLI; Astro; SvelteKit.
- Express, Fastify, Koa, Hono, NestJS, GraphQL Yoga, Socket.IO and `ws`.

**Stacks the playground runs**
- Vite templates (React, Vue, Svelte, Solid, Lit, Preact, vanilla TypeScript, Phaser); Angular CLI 16 and 21 (`ng new`, `ng serve`); TodoMVC (Angular, React, Vue, Svelte); Redux Toolkit; TanStack Query; react-scripts and webpack-dev-server; SvelteKit, Svelte with Rollup, Sapper; Solid and SolidStart; Astro; Rspack and Rsbuild; Nx 20 (`create-nx-workspace`, `nx serve`); Rollup; Eleventy; NestJS; Koa; Hono.
- Angular and Nx routing need the wildcard preview origin, which the playground uses in development.

**Compatibility evidence**
- What works is defined by Playwright Compatibility Claims, each with an id and a statement, run in Chromium in CI against exact lockfiles. See [`docs/compatibility-status.md`](docs/compatibility-status.md).

## Quick start

```sh
npm install @mimic-js/mimic
```

```ts
import { Mimic } from '@mimic-js/mimic';

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
import { mimic } from '@mimic-js/mimic/vite';

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
| [`packages/runtime`](packages/runtime) | The published `@mimic-js/mimic` package, its unit tests and its Playwright Compatibility Claims |
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
