# Compatibility tests: speed, scenario code, realism and stack coverage

**Snapshot:** 2026-10-04, `main` at 7387ab3d. The paths below follow the workspace layout that landed on `main` afterwards, where the runtime lives in `packages/runtime`.
**Question:** Is the current approach to the tests that prove Mimic runs a stack sound? Four parts: where a run spends its time, how much code a scenario costs, how close the code inside the container is to a real application, and which mainstream stacks are missing.

Measured on one machine (8 cores, 16 GB, macOS, Chromium). The prototype and the probe applications are in the working tree next to this note; nothing in `src/` was changed.

## Answer

1. **Downloads are not the bottleneck once the Playwright Tarball Cache is warm; the install work is.** Package installs take 31% of all test time, and 41 of the 109 installs in a run are a second install inside the same test. A cold cache is the other problem: it is slow, and on macOS it fails outright for large graphs.
2. **A scenario costs roughly nine lines of harness for one line of application.** The 46 Exact Graph specs are 10,046 lines; about 1,080 of them are the program that runs in the container, written as arrays of strings.
3. **The programs in the container are shaped like evidence, not like applications, and that hides gaps.** The first realistic application written for this note, an Express API that accepts JSON, crashed on its first `POST`.
4. **Of 18 scenarios for mainstream stacks without a claim, 2 pass.** Most failures are small and package-neutral: four fixes of 17 lines in total, applied as an experiment and reverted, made three more pass.

## Where the time goes

Whole e2e suite, 127 tests, warm tarball cache:

| Run | Wall time | Failures |
| --- | --- | --- |
| 1 worker | 16.2 min (962 s of tests, 7.6 s mean) | pnpm exact workspace (#632); two more failed while other runs shared the machine and passed alone |
| 4 workers | 7.8 min | 8, of which the same pnpm test is real; the other seven pass alone with one worker. The timing probe was active in this run and may have caused some of them |

Four workers give 2.1 times, not 4: the load average reached 18 on 8 cores, because every container starts its own worker pool.

The time is spread, not concentrated: 3 tests take over 40 s (the Compile Cache test and the two Angular tests), 38 take 10–30 s, 86 take under 10 s. The 40 slowest are 66% of the total.

Phases inside representative tests, 1 worker (a temporary probe in `Mimic.boot`, `spawn` and `teardown`):

| Test | Total | Installs | Share |
| --- | --- | --- | --- |
| Express 5.2.1 | 4.8 s | 2.1 s + 1.4 s | 73% |
| Fastify 5.10.0 | 4.6 s | 2.8 s | 62% |
| Vue 3 + Vite 7 | 12.8 s | 3.8 s + 2.3 s | 48% |
| Angular 22.1.0 | 44.1 s | 10.1 s + 9.3 s | 44% |
| React 19 + Vite 8 | 11.7 s | 2.6 s + 1.7 s | 37% |
| webpack 5 | 13.6 s | 4.2 s | 31% |
| TypeScript 6 | 12.3 s | 2.2 s | 18% |

- Booting a container takes 90–130 ms and loading the test page about 200 ms. Serving the runtime from the Vite development server is not a cost worth removing.
- Across the suite: 109 installs in 68 tests, 31% of test time. 41 are repeat installs, 9% of test time: the Vite, Angular and Express suites reboot a container and install again to prove a clean reboot, once per stack.
- The first package-manager command of a test is 0.7–1.5 s slower than the second, because a fresh browser context has an empty Compile Cache and Package Artifact Cache. `nest build` takes 4.4 s the first time and 2.0 s the second time in the same container.

### A cold tarball cache

| | Warm | Cold |
| --- | --- | --- |
| Express `npm ci` | 2.1 s | 10.8 s |
| React 19 + Vite 8 `npm ci` | 2.6 s | 6.6 s |
| Angular 22, webpack 5 (about 310 tarballs each) | pass | fail: `EMFILE: too many open files` in the cache's load lease |

- The load lease is a Lamport bakery lock made of files. Every waiting request lists the lock directory and reads every ticket every 25 ms, so 300 concurrent misses exceed the default macOS limit of 256 open files. Upstream loads are also capped at four at a time.
- The cache directory is relative to the working directory. A new worktree or clone starts cold. In this checkout the cache was 1.3 GB under a path left by another branch layout, and the path the tests read was empty.
- CI does not cache it either, so every shard downloads its tarballs on every run.

### CI

The workflow has not run since 2026-09-13; the last pull-request run was 2026-08-24, and #688 merged with no checks. When it last ran, the 12 shards took 253–1,325 s each (119 minutes of machine time, 36–40 minutes of wall time). Each shard spends about 60 s before its first test (dependencies, `playwright install --with-deps`, the package build), the shards are filled round-robin by file name rather than by duration, and a failing test is retried once.

## What makes a run faster

Ordered by what the measurements support.

**1. Fill the tarball cache before the tests, in one shared place.** `packages/runtime/scripts/prefetch-compatibility-tarballs.ts` reads every tracked npm lockfile, skips packages limited to another platform, and stores the rest in the cache's own layout: 2,296 tarballs, 300 MiB, 48.6 s from empty, 0.4 s when nothing is missing. With that, no install in a test waits on the registry, and the failing cold path is never taken. To finish it: a cache location outside the checkout (an environment variable with a per-user default), an `actions/cache` step keyed by the lockfiles, and a load lease that is an in-process limit plus the atomic rename the cache already does. pnpm and Yarn lockfiles are not read yet.

**2. Restore `node_modules` instead of installing, in tests that are not about installing.** The prototype stores the exported `node_modules` on the host under a key of `package.json`, lockfile and install command, and mounts it on the next run:

| Application | `npm ci` | Restore |
| --- | --- | --- |
| Koa 3 | 2.2 s | 0.06 s |
| Hono 4 + tsx | 3.7 s | 0.13 s |
| Vitest 5 | 2.3 s | 0.17 s |
| Tailwind 4 + Vite + React | 2.9 s | 0.37 s |
| NestJS 12 | 4.9 s | 0.53 s |
| React Router 7 | 5.3 s | 0.66 s |
| Astro 7 | 6.6 s | 0.78 s |
| Nuxt 4 | 9.0 s | 1.13 s |
| Next 16 | 9.6 s | 1.64 s |

The first package-manager command afterwards is about 0.8 s slower, because it now provisions the npm CLI that the install would have. End to end, the GraphQL Yoga scenario takes 3.3 s with a layer and 5.1 s without.

_This contradicts the evidence contract in `docs/compatibility-status.md` (every Exact Graph runs its package manager in frozen mode) and the glossary entry that tells the Playwright Tarball Cache to avoid an installed dependency snapshot. It is worth reopening because the install is the same work in every test, and it is already proved by the package-manager claims._ A split that keeps the proof: real installs stay in the npm, pnpm and Yarn claims and in a scheduled run with `COMPATIBILITY_INSTALL_LAYERS=0`; pull-request runs restore. This is the test-side form of the layer described in [the note on persisting installed packages](./2026-10-04-persisting-installed-packages.md).

**3. Prove a clean reboot once, not once per stack.** It is a Runtime Capability, and the second install it causes is 9% of the suite.

**4. Use two workers locally and shard CI by measured duration.** Four workers oversubscribe this machine and make timing-sensitive tests fail.

**5. Keep the Compile Cache between tests.** Not prototyped. The measurement above suggests 1–2 s per tool per test; it needs browser storage that outlives a context, and tests that assert a cold compile would have to opt out.

## Scenario code

What a stack spec repeats today, counted across `tests/e2e`:

| Repeated | Occurrences |
| --- | --- |
| `Mimic.boot(` | 101 in 55 files |
| Reading a fixture file with `readFileSync` | 109 in 49 files |
| `page.on('pageerror'` | 58 in 50 files |
| `prepareTrackedLockfileInstall(` | 46 in 44 files |
| The `virtualPlatform` literal | 39 in 33 files |
| A local `waitForOutput` or `waitForEndpoint` | 14 copies |

- `runTrackedCommandClaim` already wraps install, run and reboot; two specs use it.
- The whole scenario runs inside one `page.evaluate` and returns one object, so a spec cannot use Playwright locators or step-by-step assertions, and a failure is a serialized blob.
- A fixture directory holds only `package.json` and the lockfile. The application lives in the spec as string arrays: no highlighting, no linting, and it cannot be run outside the test.
- The additivity check in `scripts/compatibility-claim-matrix.ts` compares the source text of every Exact Graph target. Moving an existing target behind a helper counts as a refreshed claim, so existing specs cannot be shortened until the check compares evaluated targets.

### Prototype: a stack scenario

`packages/runtime/tests/e2e/stack-scenario.ts` and `stack-scenario-page.ts` (434 lines together). The application is a real directory; the spec drives it from Node:

```ts
test.use({ fixture: 'graphql-yoga-5-library' });

test(claim.statement, async ({ stack }) => {
  await stack.install();
  const server = await stack.start('npm start');
  const books = await server.fetch('/graphql', { method: 'POST', json: { query: '{ books { title } }' } });
  expect(books.status).toBe(200);
  const app = await server.open('/');            // a FrameLocator on the served page
  await expect(app.getByRole('heading')).toBeVisible();
});
```

- `install()` runs the frozen install and checks the lockfile is unchanged, or restores a layer. `start()` resolves when the process publishes an endpoint; `run()` runs a command to its exit.
- The fixture boots the container, collects page errors, tears down, and reports the phase timings.
- `npmExactGraph(fixture, packages, command)` builds the Exact Graph target; only the packages are stack-specific.
- `packages/runtime/tests/e2e/graphql-yoga-compatibility.spec.ts` is a complete claim in 29 lines. The Express claim today is 288.

Limits of the prototype: text files only, command lines split on spaces, a layer above 64 MiB compressed is not stored (Prisma's crashed the page), and layers travel through the browser's debugging protocol rather than a direct request.

## Realism

Existing programs print markers such as `express-compatibility-stream-first`, keep themselves alive with timers, and answer on routes that exist for one assertion. The Express claim sends only `GET` requests. The first realistic replacement, a to-do API with `express.json()`, a router, static files and an error handler (`packages/runtime/compatibility/probes/express-5-todo-api`), crashed the server process on its first `POST`.

The applications written for this note follow each stack's own starter layout: entry point, routes, a store or schema, views, scripts in `package.json`. Applications with a claim belong in `packages/runtime/compatibility/fixtures`; the ones still failing are in `packages/runtime/compatibility/probes`, which the additivity check does not freeze.

## Stacks without a claim

Run with `cd packages/runtime && STACK_PROBES=1 pnpm exec playwright test tests/e2e/stack-probes.spec.ts`. Versions are what the registry resolved on 2026-10-04.

| Stack | Scenario | Result on `main` | First blocker |
| --- | --- | --- | --- |
| GraphQL Yoga 5.24 | Queries, nested resolvers, a mutation | **Pass**, now a claim | |
| `node:sqlite` | Create, insert, aggregate | **Pass** | |
| Express 5 REST API | JSON CRUD, static page with a form, 404 and 400 | Fail | A |
| NestJS 12 | `nest build` (TypeScript 6), controllers, validation | Fail: builds and serves `GET`, `POST` hangs | A |
| Express 5 + EJS | Views, session login, form post, upload | Fail | A, then E |
| Koa 3 | Router, body parser, static files | Fail | B |
| Socket.IO 4 | Page and server exchange messages | Fail | C |
| Hono 4 on tsx | Validated JSON API from TypeScript sources | Fail | D, then F |
| Vitest 5 | TypeScript suite with mocks and snapshots | Fail | G, then H |
| React Router 7 (framework) | Loaders, client navigation | Fail | G, then C |
| SvelteKit 3 | Server load, form action, endpoint | Fail | G; with the binding added by hand the page and the endpoint work |
| Tailwind 4 + Vite 8 + React | Utilities in development and build | Fail | G, then I |
| Astro 7 | Pages, Markdown, static build | Fail | G |
| Nuxt 4 | Page and Nitro route | Fail | J (`inspector`) |
| Next 16 | App Router page and route handler | Fail | J (`dns/promises`, #560) |
| Prisma 7 | `prisma generate` | Fail | J (`stream/consumers`) |
| Jest 30 | CommonJS suite with fake timers | Fail | K |
| Drizzle + better-sqlite3 | Rows through a native driver | Fail | L |

### Gaps found

Small, package-neutral, in Node Compatibility:

- **A. `Buffer` static methods are not enumerable.** `safer-buffer` copies `Buffer` with `for…in`, so `iconv-lite` calls a `Buffer.isBuffer` that is not there, and `raw-body` throws inside a `data` handler. Every Express or NestJS request with a JSON or form body kills the process.
- **B. `StringDecoder` cannot be called without `new`.**
- **C. `IncomingMessage.connection`, `ServerResponse.req` and `ServerResponse.socket` are undefined.** engine.io reads `req.connection.remoteAddress`; React Router's development server reads `res.req.httpVersionMajor`.
- **D. `tty.WriteStream.prototype.hasColors` and `getColorDepth` are missing.**
- **E. `ServerResponse._implicitHeader` is missing**; `express-session` calls it.
- **J. Builtins that do not load:** `dns/promises`, `inspector`, `inspector/promises`, `stream/consumers`, `stream/web`, `readline/promises`, `cluster`, `dgram`, `domain`, `punycode`, `repl`, `sys`, `trace_events`, `test`, `path/win32`, `sea`.

An experiment patched A–D (17 lines, reverted): NestJS, Koa and Socket.IO passed. The Express API got past its `POST` and stopped at an assertion of the scenario that was too strict; the assertion is relaxed now, and the rest of that scenario was not re-run with the patch.

Larger:

- **F. `module.register()` with a transfer list is unsupported**, which is how tsx installs its loader.
- **G. rolldown 1.2.4 and later no longer list `@rolldown/binding-wasm32-wasi` as an optional dependency.** A lockfile for current Vite (8.3 depends on rolldown ~1.2.11) has no browser binding, so nothing built on it starts. The package is still published for each version; a Browser Package Replacement would have to add it next to rolldown, which the two existing kinds of replacement do not do.
- **H. `child_process.fork` is unsupported, and `worker_threads` rejects the `--experimental-import-meta-resolve` flag** that Node accepts. These are Vitest's two pools.
- **I. A second `npm install` removes packages a Browser Package Replacement added.** After `npm ci`, `npm install --no-save <package>` prunes `napi-wasm`, which `lightningcss-wasm` needs, and it is not put back.
- **K. `vm` contexts are unsupported**, so Jest cannot run a suite.
- **L. better-sqlite3 has no build for this platform** and falls back to `node-gyp`. It would need a replacement policy.

In the runtime itself:

- **A process whose main promise never settles exits 0 with no output.** Vite 8.3 without its binding does this, and so does Jest when it cannot start `watchman`. Node exits 13 with a warning; a silent 0 reads as success.
- **Mounting an archive fails when a path segment is named `constructor`.** `treeFromArchiveEntries` looks names up on a plain object. `@sinclair/typebox`, a dependency of Jest, has such a directory, so an exported `node_modules` cannot be mounted back. This affects the layer design directly.
- The shell has no `sed`. The Published Endpoint rewrites a `Location` response header under its own path prefix, which a `fetch` client sees.

### Not probed

`npm create vite@latest` followed by a lockfile-less install; tRPC and Apollo Server; Fastify with a JSON body and plugins; Storybook, VitePress, Docusaurus; Preact, Lit, Qwik; Drizzle on PGlite; the same applications installed by pnpm and Yarn; `node --watch` and nodemon.

## Closed after this note

The commit after this note fixed the gaps that were small enough to fix with their tests, and turned four probes into claims.

| Gap | What changed |
| --- | --- |
| A, B, C, D, E | `Buffer` statics are enumerable; `StringDecoder` is a function constructor again; a request and its response carry `connection`, `req` and `socket`; `tty.WriteStream` answers colour queries; `ServerResponse` has `_implicitHeader`, `_header` and `_headerSent` |
| J, in part | `dns/promises`, `stream/consumers`, `stream/web`, `sys` and `inspector` load; `process.binding('constants')` answers |
| F | `module.register()` accepts a transfer list and a hooks path with a query; module records have `_compile`; `node:http2` exports the request and response classes a server tests with `instanceof` |
| I | A replaced package gets its bundled dependencies back after a later install pruned them |
| H, in part | A worker accepts `--experimental-import-meta-resolve`; `child_process.execFile` and `exec` work, and a missing executable is reported as `ENOENT` |
| Archive names | A tree may contain `constructor`, `toString` or `__proto__` |
| Cold tarball cache | A process waits on at most eight load leases at once; Angular 22 and webpack 5 now install from an empty cache |

New claims: Hono 4.13.13 on tsx, NestJS 12.1.2, Koa 3.2.1, Socket.IO 4.8.4. Jest now fails with its real reason instead of exiting 0.

Still open, each large enough to be its own piece of work:

- **G.** ADR-0021 already decided that a rolldown without a `wasm32` optional dependency reports its missing binding itself. That decision now keeps every Vite 8.3 stack out; reversing it needs a replacement that adds a package rather than rewriting one.
- **`child_process.fork`**, which Next 16, Jest and Vitest's default pool need, and **`vm` contexts**, which Jest needs.
- **A signal handler that finishes asynchronously.** `process.on('SIGTERM')` runs, but the process ends with 143 before `server.close()` calls back. The Express REST probe fails on this alone (#630 is near it).
- **A multipart upload through a Published Endpoint** aborts while multer reads it; the rest of the Express blog scenario (views, session login, form post) passes.
- **Nuxt 4** cannot resolve `@nuxt/kit` through `exsolve`; **Prisma 7** stops at a missing `errno` table; **better-sqlite3** (L) and **TypeScript 7** need a decision about a replacement.
- A pending top-level `await` hangs the process where Node exits 13. The silent exit 0 of Vite 8.3 without its binding was not traced further.

## Install layers in the suites

Two further commits put every stack claim on install layers (`packages/runtime/tests/e2e/install-layer.ts`, `install-layer-store.ts`): first the Vite and Angular suites and the stack scenarios, then ESLint, Prettier, TypeScript 6, Sass, webpack 4 and 5, Rollup 3, Express, Fastify, ws and the tracked command helper. Whole suite, 1 worker, the same 127 tests as the first table:

| | Before | Vite and Angular on layers | Every stack claim on layers |
| --- | --- | --- | --- |
| All 127 tests | 962 s | 854 s (11% less) | 809 s (16% less) |
| The 36 Vite and Angular tests | 380 s | 251 s | 253 s (33% less) |
| Angular 22 | 41.4 s | 27.8 s | 31.7 s |
| A typical Vite test | 13 s | 8 s | 8 s |
| webpack 5 | 13.8 s | | 8.9 s |

What still installs for real, by intent:

- the claims about installing: the npm, pnpm and Yarn workspaces, the Command Proxy and toolchain claims, the Nx lifecycle claim, and the claim that the page stays responsive during an install;
- the claims about what an install selects or replaces: Rollup 4, Rolldown, Rspack, oxc-parser, Lightning CSS and esbuild;
- the Compile Cache claim, which is about the compile that follows an install and is now the slowest test at 52 s;
- the demo, toolchain and stress flows, where the demo application runs `npm install` itself.

Those tests are about half of the run time that is left (427 s of 827 s, the five new claims included). For the stack claims the install is no longer the first thing to cut; the Compile Cache that starts empty in every test and the repeated reboot are.

### The repeated reboot

A Vite claim repeats install, serving and an update in a rebooted container only when its statement names the reboot: the vanilla and TypeScript claims of each Vite line. The twelve framework claims and the Lightning CSS claim check that the reboot starts clean and stop there. The 27 Vite tests take 167 s instead of 199 s, a framework test about 6 s instead of 8.5 s, which brings the whole suite to about 777 s, 19% under the first measurement. Both Angular statements name a pristine reboot, so those two tests keep it.

### Specs without a claim

Three specs declared no claim, so CI never ran them, and what they checked is claimed elsewhere; they are removed. `browser-fixture-matrix` repeated the demo claim for vanilla and the Vite suite's Solid claims. `mimic-toolchain` asserted the text of served modules, which the Vite suite proves by behaviour. `browser-runtime-diagnostics` tested a helper of the tests. Together they were 45 s of a local run.

CI restores layers on pull requests and manual runs, and sets `COMPATIBILITY_INSTALL_LAYERS=0` on the nightly run; it now caches `.cache` and runs the prefetch before the tests. The workflow itself has not run since September, so none of that is exercised yet.

## Existing claims on the stack scenario

The additivity check freezes the text of a claim's declaration, not the test under it, so existing claims can move. Eleven specs did: Express, Fastify, ws, ESLint, Prettier, TypeScript 6, Sass, webpack 4 and 5, Rollup 3 and 4. Their programs became files of the fixture directories (383 lines), and the specs went from 3,566 lines to 769.

What each spec asserted by hand is now asserted for every scenario by `Stack.finish()`: the install left the tracked lockfile alone, the test page reported no error and no failed request, no process printed a forbidden fallback, the teardown ended every process still running and released its endpoints, and a container booted afterwards starts clean.

Three things changed in what is proved:

- Express and ws ran their whole graph again in a fresh container, reinstalling it. They now run once (ws also restarts in the same container), and the fresh container is the clean reboot every scenario checks.
- Rollup 4 no longer records the browser's user agent and the runtime revision.
- The webpack 5 claim ended a running dev server by tearing the container down and checked its exit code and its route itself; the scenario's shared checks do that now.

A second pass moved esbuild (six tests on three versions), Rolldown WASI, Vite 8 with Rolldown, the Vite 6 SSR claim, the Nx lifecycle claim and the main-thread responsiveness claim: 1,964 lines became 748, and `tracked-command-claim.ts` (242 lines) lost its last caller. A claim about the install itself calls `stack.install('npm ci', { layer: false })`. As with Express, the esbuild 0.25.12 and Rolldown claims no longer repeat their graph in a second container.

A third pass took the applications of the Vite suite out of the specs. They were generated from functions of a heading and a version, once per framework for three Vite lines; each is now the `index.html`, `vite.config.*` and `src/` of its fixture directory (131 files, 549 lines). A fixture whose graph serves several applications — the vanilla graph of each Vite line serves the JavaScript, TypeScript, configuration, optimizer, Lightning CSS and SSR applications — keeps each in `apps/<name>`, and a case names the one it runs. A case no longer passes its manifest, lockfile and install either: the lockfile path of its claim names the fixture, and the suite reads the rest from there. The source a workflow writes for a hot update is the application's own file with the heading replaced, so a case states three headings and no program text; the heading must occur in that file exactly once. The one program left in a spec is the optimizer's late source, the edit that adds a second bare import.

`tests/e2e` lost 1,105 lines and gained 214. Before the change every case's generated project was dumped, and after it the tree each case mounts and the sources each workflow writes were compared with the dump: all 26 have the same files with the same bytes, so the install layers kept their keys. The one difference is that a case without public assets no longer gets an empty `public` directory.

The repository's `typecheck` does not include `tests/e2e`: the specs are only transpiled by Playwright, so a type error in one surfaces only if it breaks at run time. This pass was checked by comparing the errors an ad hoc compiler run reports before and after it; that run has no configuration of its own and reports hundreds of errors on `main`, page-side imports of absolute paths among them.

### The Vite and Angular drivers

A fourth pass put both suites on the stack scenario. Each had its own driver: a function of about a thousand lines that ran inside the test page, booted its containers, polled the preview frame, and returned a record the spec then asserted. A case of either suite is now a scenario: the suite reads the fixture named by the claim's lockfile, drives the application from Node, and waits for what the frame shows. `tests/e2e` lost 3,702 lines and gained 1,215; the two drivers and the two workflow modules went from 3,065 lines to 984.

What the drivers proved for their own cases, every scenario now proves in `Stack.finish()`: the test page stayed responsive while the container lived, the teardown left no runtime worker and a container that refuses further use, npm's record of the install names no forbidden fallback, and no Rolldown binding for another platform was installed. A stopped server proves its endpoint was released, and a scenario that ran its package manager proves it asked the registry for tarballs. The 32 scenarios that existed before this pass hold all of it.

The scenario gained what the two suites needed: `reboot()` ends the container as `finish()` does and boots a fresh one with the same application, for the six Vite claims and the two Angular claims whose statements name the reboot; `takeDiagnostics()` hands the scenario the console errors and network events it provokes on purpose; `endpointEvents()` and `runtimeWorkers()` answer what the container published and which process workers remain.

Two things the rewrite found:

- **chokidar reports one change for two writes of a file less than 50 ms apart.** The first rewrite wrote the recovery of a transform error 40 ms after the error, and Vite never saw it. This is chokidar's own throttle, not a gap of the runtime; the old driver stayed clear of it only because it polled every 50 ms. `Stack.writeFile` now leaves 100 ms between two writes of one file.
- **Playwright's assertions wait up to a second between two looks.** With `expect(locator).toHaveText()` every hot update of the Angular cases took about 800 ms to be noticed, three seconds a case. The scenarios poll every 50 ms through `eventually()` instead.

What changed in what the claims prove:

- A stopped server must exit 143. The Vite driver accepted any exit code for the server its workflow stopped.
- The optimizer claims on Vite 7 and 8 allow one abandoned document request while the late dependency reloads the preview. The driver compared that request with the address of the first server, which is retired by then, so the allowance could never apply; it now names the restarted server.
- The native-binding check looks at every Rolldown binding installed, not only at the packages a suite listed.
- A case's working directory is the name of its fixture. The three applications of a vanilla graph used to run in directories of their own.
- A Vite process that exits in the middle of a workflow fails the case by timeout, with what it wrote attached, not at once.
- The late program of the optimizer cases is a file of the application, `src/App.late.js`, which the case copies over `src/App.js`.

The Vite and Angular cases took 207 s before this pass. After it they took 214 s run by themselves and 224 s inside a whole run, where single cases took four seconds longer than they do alone for a reason that was not found. Driving a case from Node costs a round trip for every look at the page.

Not moved, and why:

- Rspack, oxc-parser, Rolldown Browser and Lightning CSS already share `publisher-artifact-harness.ts`, which hashes the artifacts a page is served.
- The npm, pnpm and Yarn workspace claims, the Command Proxy claims and the toolchain catalog boot several containers in one test (cold, warm, offline, refused); a scenario is one container.
- The Compile Cache claim reloads the page between its two phases and reads the origin private file system.

## Not verified

- Timings are from single runs, except where two runs are shown side by side. The suite-wide install share comes from the four-worker run, so its absolute times are inflated; the ratios are what the note uses.
- Linux and CI hardware. The open-file limit there is higher, so the cold path may be slow rather than failing.
- What lies behind each blocker beyond the experiment with A–D.
- The probe applications use versions newer than the stacks' documentation this note was written against; two of them needed corrections for SvelteKit 3 and TypeScript 6, and others may carry mistakes of the same kind that their first blocker still hides.
