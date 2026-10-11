# Demo application pool: which official starters run in the playground

Date: 2026-10-09 and 2026-10-10. Scope: which mainstream stacks start in
development mode in `apps/repo-playground`, and for each one that does not,
why. The runtime was `main` at 6509ab9 for the first run (35 of 121), the
branch of #713 at ee8ae6b for the second (61 of 121), and that branch after
its review fixes for the applications named below. The current boundary is
the maintained claims and their CI results, not this note.

## The pool

[`apps/repo-playground/demo-pool`](../../apps/repo-playground/demo-pool) holds
the list (`build-pool.mjs` generates `pool.json`), the runner and the report
generator. Each application is the authors' own starter wherever one exists:

- the create-vite templates as each Vite release shipped them (`vitejs/vite` at
  `v2.9.18`, `v3.2.11`, `v4.5.14`, `v5.4.21`, `v6.3.7`, `v7.3.7`, `v8.3.4`);
- official generators run in the container's terminal, in an empty repository
  (`octocat/Hello-World`): `ng new` of Angular CLI 12 and 14–22, create-react-app 5,
  create-next-app 12–16, create-vue, Vue CLI 5, `sv create`, create-analog,
  create-docusaurus, create-expo-app, create-nx-workspace 20/21,
  create-webpack-app, create-parcel, create-snowpack-app, `ember new`,
  express-generator, fastify-cli;
- official example and template repositories: Redux, React Router 7, Remix 2,
  TanStack Query/Router/Start, Nuxt 2/3/4 starters, Solid templates, Astro and
  Starlight examples, Nx recipes and nx-examples, Rspack/Rsbuild/Rspress
  examples, Phaser, Rollup, Lit, Stencil, Eleventy, Gatsby, NestJS, Socket.IO,
  Koa, Hono, Ionic conference apps, Angular QuickStart and angular-seed;
- where the authors publish no runnable example, the most popular demo:
  RealWorld (Angular, React, Vue), TodoMVC (Angular, React, Vue, Svelte),
  react-boilerplate, vue-element-admin, Ant Design Pro.

## Method

`run-pool.mjs` drives the playground in Chromium, one application after another,
each in a fresh browser context: it opens `?repo=owner/name&ref=…`, waits for the
mount, types each command into the playground's terminal (`cd`, install,
generator) and checks its exit status, types the dev command, waits for the
preview the server publishes, and reads the preview document until it shows
content. An application **passes** when the dev server's page renders its own
content with no error overlay. Every failure was read from the terminal output
and the preview's console; where the cause could lie in the project rather
than the container, the same commands were run with native Node 22 and the
container's npm.

Limits of these runs:

- The cloud sandbox denies `codeload.github.com`, so the playground's
  `/github-archive` proxy was replaced locally by `git fetch --depth 1` and
  `git archive` of the same ref: the same tar.gz, served the same way.
- The sandbox's egress policy also blocks unpkg.com, jsonplaceholder.typicode.com,
  dummyjson.com and codeload tarballs inside the container. These are marked
  `sandbox`; they are not container failures.
- One 4-core machine, two playground instances. Timeouts: 20 minutes per
  command, 10 minutes for a dev server to publish, 3 minutes for the page.

## Result

| Stack | `main` (6509ab9) | #713 at ee8ae6b | after review |
| --- | --- | --- | --- |
| Vite templates (incl. Phaser) | 20 / 30 | 27 / 30 | 27 / 30 |
| Angular | 1 / 16 | 5 / 16 | 5 / 16 |
| React frameworks and demos | 3 / 17 | 5 / 17 | 5 / 17 |
| Next.js | 0 / 7 | 0 / 7 | 3 / 8 |
| Vue | 2 / 8 | 3 / 8 | 3 / 8 |
| Svelte | 3 / 5 | 5 / 5 | 5 / 5 |
| Solid | 1 / 3 | 2 / 3 | 2 / 3 |
| Astro | 3 / 4 | 3 / 4 | 3 / 4 |
| Nx | 0 / 8 | 0 / 8 | 0 / 8 |
| webpack, Rspack, Parcel, Rollup, Snowpack | 0 / 10 | 5 / 10 | 5 / 10 |
| Lit, Stencil, Ember, Eleventy, Docusaurus, Gatsby | 0 / 7 | 1 / 7 | 1 / 7 |
| Node servers | 2 / 6 | 5 / 6 | 5 / 6 |
| **All** | **35 / 121** | **61 / 121** | **64 / 122** |

"After review" counts the applications rerun on the branch after its review
fixes (the Next.js ones, Nuxt 3 and 4, Docusaurus, the Ionic apps, the Nx and
Cypress ones, Socket.IO chat and Expo) on top of the second run's results;
the 122nd application is create-next-app 15 run without Turbopack. The
per-application verdicts of the second full run are in git history
(`apps/repo-playground/demo-pool/results` and `notes.json` at 665eba8);
`report.mjs` prints the table of any run.

What runs, in short:

- **Vite** 2–8 templates for React, Vue, Svelte, Solid, Preact, Lit and
  vanilla, and Phaser's Vite template. The Qwik templates and the Vite 2
  Svelte template fail natively too.
- **Angular**: `ng new` 15 and 16, Analog, TodoMVC and AngularJS seed.
  `ng new` 17–22 build and serve, but the router sees the endpoint prefix (#706).
- **React**: create-react-app 5, react-scripts 1 (RealWorld), the Redux Vite
  template, TanStack Query, TodoMVC.
- **Next.js**: create-next-app 13 (pages), and 15 and 16 with webpack; after
  ADR-0045 also create-next-app 14, Next 12 pinned and the Learn dashboard with
  webpack (the rerun of 2026-10-10 below). Turbopack has no WASM bindings (#707).
- **Vue**: create-vue, Vue CLI 5, TodoMVC. **Svelte**: `sv create`, SvelteKit
  RealWorld, Sapper, the Svelte 3 Rollup template, TodoMVC.
- **Solid**: the Vite template and SolidStart 2. **Astro**: three examples.
- **Rspack, Rsbuild** (React, Vue), the **Rollup** starter, **Eleventy**.
- **Node servers**: Express, Koa, Hono, NestJS, fastify-cli.

## What changed in the runtime

Five decisions, recorded as ADRs:

- [ADR-0039](../adr/0039-report-linux-as-the-node-platform.md): the Node
  platform is `linux` (architecture `wasm32`), so platform switches and
  native-binding loaders take their Linux path.
- [ADR-0040](../adr/0040-let-a-native-addon-build-end-without-the-addon.md):
  a node-gyp build ends without the addon instead of failing the install.
- [ADR-0041](../adr/0041-run-the-package-manager-release-a-project-asks-for.md):
  the package-manager release `packageManager` names is the one that runs.
- [ADR-0042](../adr/0042-let-a-published-request-wait-while-its-host-is-open.md):
  a published request waits while its host document is open, instead of a
  35-second deadline that cut off webpack-dev-server's first build
  (create-react-app 5).
- [ADR-0043](../adr/0043-run-a-projects-install-scripts-again-after-its-replacements.md):
  a project's install scripts run again once the replacements and WASI
  companions are in place (Nuxt 4's `nuxt prepare`, Ant Design Pro's
  `max setup`).

The other commits are Node Compatibility and Module Execution fixes, each
driven by an application of the pool: the missing `fs` ownership, `fdatasync`,
`glob` and `FileHandle` members; `Module.prototype.require`;
`monitorEventLoopDelay` and `process.binding` (`uv`, `http_parser`, `natives`);
`import()` in code built by `Function` or direct `eval`; `require(esm)` and its
`module.exports` export; the browser worker's globals hidden from modules; a
port free as soon as `close()` is called; `cluster.fork()`; structured stack
traces that name module files; Worker `name`, `env` and `resourceLimits`;
`net.BlockList`; writes to descriptors 1 and 2; `getconf`; zlib's trailing
data; synchronous VFS calls larger than one mailbox message; and the rest
listed in the branch history.

The review of the branch added, with a unit test each: WASI rights checks for
the Preview1 operations that resize, retime, rename and link, lookup flags on
`path_link` and `path_filestat_set_times`, and no operation that removes or
replaces the capability root; the ADR-0043 rerun only after the manager
reports a project script failed, and never under `--ignore-scripts`; a
`packageManager` hash checked for an already installed release; `os.type()`
as `Linux`; a native `new Function` in modules; a hidden worker global a
program defines itself; `module._compile` of ES syntax; `cluster.worker.kill()`,
`NODE_UNIQUE_ID` and the primary's `'listening'`; stdin `resume()` after
`pause()`; `fs.glob` `exclude` pruning; bounded perf_hooks histograms with
Node's loop-delay semantics; gzip errors as Node raises them;
`net.BlockList.check()` on non-addresses. The Next.js trace added `fs.WriteStream`
writing through its open file, `file:/` specifiers, an `await` in a direct
eval resuming in its Async Context (webpack's eval devtool), and
`http.Server.closeAllConnections`; the Nuxt and Docusaurus traces added
`new tls.TLSSocket(socket)` and `worker_threads.BroadcastChannel` over the
browser's channel, scoped to the process; the Nuxt 4 trace found Chrome
stopping the Service Worker, and every stream it served, when one fetch
event waited more than five minutes, so a request now gets a `504` after 4.5
minutes (ADR-0042). The Ionic, Nx and Expo traces added `PUPPETEER_SKIP_DOWNLOAD`
and `CYPRESS_INSTALL_BINARY=0` as container defaults (no downloaded browser
could run), a `dgram` socket that binds and sends nothing instead of throwing
(Metro's Bonjour), enumerable `Module._nodeModulePaths` and the other lookup
functions (Babel's namespace interop dropped them), and Node's `navigator`
(`Node.js/22`, `Linux wasm32`) in place of the worker's, which expo-constants
took for a browser.

## Causes of the remaining failures

| Cause | Apps | Applications |
| --- | --- | --- |
| **Client routing under the endpoint prefix** (#706) | 15 | `ng new` 17–22, create-nx-workspace 20 (Angular), `ember new`, Nuxt 2, React Router 7, Remix 2, SolidStart 1, TanStack Router (Vite), Ionic React (its `ion-router-outlet` matches nothing), create-expo-app (Metro serves and renders Expo Router's "Unmatched Route") |
| **No WASI build of the tool, or one that fails** (#707, #708, #709) | 12 | Turbopack (Next.js Learn, create-next-app 12, 15, 16 with their default `dev`), Nx 18 recipes (3), Stencil's bundled Rollup, Snowpack's esbuild 0.8, `@swc/core` (TanStack Router webpack), Rspack's WASI build under Rspress (`no pids on this platform`) and under Docusaurus 3.10 (`loadBrowserslist` answers `[]`, reproduced in Node) |
| **Fail natively too** | 14 | create-nx-workspace 21, nx-examples (Nx 23.3's `getpid` panic) and the Nx 21 Angular recipe (its postinstall loads the hanging binding) (Nx 21's WASI binding hangs in Node 22 too), Angular 12 and create-react-app 4 (webpack `md4` on Node 17+), Angular 14 and 4, Lit starter (today's type packages), Phaser webpack (`phaser@4` ESM), create-webpack-app, create-vite Svelte 2 and Qwik 4/8 and the Nx 20 React recipe (npm ERESOLVE) |
| **A published dependency graph npm cannot place** (#709) | 1 | Nuxt 3: `@oxc-parser/binding-wasm32-wasi@0.143+` pins `@emnapi/*@2.0.0-alpha.3`, which its own `@napi-rs/wasm-runtime` peer range excludes, so npm nests one emnapi and hoists another and the binding fails with `this.bridge.setLastError is not a function`; reproduced with native npm |
| **Next 14's WASM gate** (#707) | 1 | `loadBindings` tries the WASM SWC only for a known triple or under `process.versions.webcontainer`; linux/wasm32 was neither until ADR-0045 set the marker (the rerun of 2026-10-10 below) |
| **Not traced to the end** (#712) | 4 | Ant Design Pro (esbuild-wasm service stops while umi parses its config), TanStack Start (Nitro's Vite environment), Nuxt 4 (`nuxt dev` is ready; its first SSR compile takes minutes on the loaded machine, and before the Service Worker deadline below its loading page lost its progress stream), Ionic Angular (installs since puppeteer skips its download; Vite's optimizer then stops in rolldown's WASI binding with `memory access out of bounds at napi_create_error`, which the same binding does not do under Node) |
| **A system tool or binary the runtime does not have** (#711) | 2 | `autoreconf` (react-boilerplate's image minifiers), `git` (create-parcel). Cypress's installer is skipped by default now; nx-examples and the Nx 21 Angular recipe then stop in Nx's own WASI binding (#708: the `getpid` panic of 23.3, and the Nx 21 hang in its postinstall) |
| **Native addons** (#711) | 3 | `sharp@0.32` (no WASM build before 0.33; Gatsby ×2), `sqlite3` required at start (Socket.IO chat: the example needs about 80 lines of the `sqlite3` callback API over `node:sqlite`, but no official package publishes that, so it does not fit ADR-0021's replacements without a new kind of replacement) |
| **Not runnable from the archive** | 3 | Angular and Vue RealWorld (git submodule), Starlight (monorepo tsconfig) |
| **Sandbox network** | 2 | React tutorial (unpkg.com), vue-element-admin (codeload) |
| **esbuild `--serve`** (#710) | 1 | TanStack Router esbuild |

TanStack Query and the react-scripts 1 RealWorld app render and only their
demo APIs fail in the sandbox; both count as passes. Nuxt 2 renders Nuxt's own
"page not found" (routing), which the runner's text check took for a pass.

Next.js, after the review: Next 13 fetched its WASM SWC with undici and `tar`,
not a child npm; the download failed because `fs.WriteStream` appended to its
path while Next renamed the file, and the import failed on a `file:/` URL.
Next 15 and 16 with webpack lost their `AsyncLocalStorage` store across an
`await` inside code webpack's eval devtool runs through direct `eval`. Next
16 still warns that Cache Components cannot be validated: the runtime's
timers have no `_idleStart` and no Node loop phases. `NODE_OPTIONS=-r` preloads
are not honoured.

### Next.js rerun of 2026-10-10 (#707)

The Next.js entries were rerun on the branch that sets
`process.versions.webcontainer` ([ADR-0045](../adr/0045-report-the-webcontainer-runtime-version.md)),
with two entries added: the Learn dashboard started with `pnpm exec next dev
--webpack`, and create-next-app 12 followed by `npm install next@12 react@18
react-dom@18`, because create-next-app 12 installs the current Next.

| Application | Before | After | Note |
| --- | --- | --- | --- |
| create-next-app 12, Next 12.3 pinned (pages) | not run | pass, 130 s | Next 12 downloads its WASM SWC itself |
| create-next-app 13 (pages, JS) | pass, 148 s | pass, 104 s | |
| create-next-app 14 (App Router, Tailwind) | `Failed to load SWC binary for linux/wasm32` | pass, 118 s | the marker opens Next 14's only path to `@next/swc-wasm-nodejs` |
| create-next-app 15, `next dev --turbopack` (its `dev` script) | not run | listens, serves nothing | Next: `` `turbo.createProject` is not supported by the wasm bindings`` |
| create-next-app 15, `npx next dev` | one silent exit 0 right after `Downloading swc package`, not reproduced on three later starts | pass, 91 s | |
| create-next-app 16, `next dev` (Turbopack) | exit 1 | exit 1 | Next: `Turbopack is not supported on this platform (linux/wasm32) … use Webpack instead: next dev --webpack` |
| create-next-app 16, `npx next dev --webpack` | pass, 165 s | pass, 137 s | `next.config.ts` loads: Next transpiles it with the WASM SWC, which leaves the `export`, and `module._compile` loads the ES source as Node 22 does |
| Next.js Learn dashboard, `pnpm dev` (`next dev --turbopack`, Next 16.0.10) | `turbo.createProject` not supported | same | 16.0.10 does not name `--webpack` yet |
| Next.js Learn dashboard, `pnpm exec next dev --webpack` | not run | pass, 76 s | bcrypt installs without its addon (ADR-0040); the start page needs no database |

Turbopack itself has no WebAssembly build: `@next/swc-wasm-nodejs` carries
the SWC transforms only, and Next's WASM bindings throw on `turbo.createProject`.
Next 16.1 and later name `--webpack` in that error; the playground's Next
examples run webpack and say so. Next 13, 15 and 16 download the WASM SWC at
every start of a fresh project (into `~/.cache/next-swc`, with the Virtual File
System's lifetime): Next 15 and 16 import it by a `file:` URL of the bare
package name, so an installed `@next/swc-wasm-nodejs` would not be found, and
a companion (ADR-0028) would not spare the download.

## Nx

Nx needs its WASI binding for the project graph, hashing and tasks. Two
runtime gaps were found and fixed:

- `path_open` answered `ENOTCAPABLE` to any rights mask other than three known
  wasi-libc masks. Rust's standard library opens a directory with its own
  mask, so Nx 20 could not list the workspace and its file-gathering thread
  waited forever. Preview1 and Node's WASI grant fewer rights instead.
- Nx installs a package it needs during generation into a temporary
  directory, adds that to `NODE_PATH` and calls `Module._initPaths()`, which
  was missing.

With both fixes, `nx show projects`, `nx run` with its cache, and `nx graph`
work on Nx 20.8, 22.7 and 23.1. create-nx-workspace 20 creates an Angular
workspace and `nx serve` builds it. Every other failure is in Nx's own WASI
support and was reproduced in Node 22 with `NAPI_RS_FORCE_WASI=1`, or read
from Nx's source (#708): Nx 18 has no WASI build; Nx 21's binding hangs while
it loads; from 22.7 to 23.1 generators fail (`customDimensions` is `null`
under WASM and `reportNxGenerateCommand` reads it); from 23.2 the binding
panics in Rust's `getpid`.

## Notes

- Maintained e2e specs for WASI were run against the branch before the
  review. All pass except eight that fail the same way on `main` (6509ab9) in
  this sandbox: the napi-companion pair, oxc-parser, Rolldown Browser, Rspack
  WASI and the two Lightning CSS specs. The node:wasi claim now expects a
  `path_open` with an untracked right to succeed with fewer rights, as Node's does.
- Unit tests that fail only under the load of a full parallel run on a loaded
  machine and pass alone: the WASI "bounds oversized file reads" case, the
  zlib incremental case, a `nextTick` ordering case and the mailbox megabyte case.
- The oxc e2e claim passes because oxc-parser 0.139–0.142 pin an emnapi their
  wasm-runtime accepts; 0.143 and later do not.

## Rerunning

From the repository root, with the playground served at `PLAYGROUND_URL`
(default `http://127.0.0.1:5173`):

```sh
node apps/repo-playground/demo-pool/build-pool.mjs
node apps/repo-playground/demo-pool/run-pool.mjs apps/repo-playground/demo-pool/pool.json <out-dir> [id-regex]
node apps/repo-playground/demo-pool/report.mjs apps/repo-playground/demo-pool/pool.json <out-dir>
```

`SKIP_DONE=1` resumes a run; `CHROMIUM_PATH` picks the browser. Chromium reaches
the npm registry through `HTTPS_PROXY` when one is set.
