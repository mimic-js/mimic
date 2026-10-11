# Research: the Node.js application compatibility frontier

> Snapshot note: source findings and dated evidence are retained, but repo-specific
> “current state” statements may be obsolete. Verify them against current code,
> tests, issues, and [`compatibility-status.md`](../compatibility-status.md). See
> [the research status rules](./README.md).

Date: 2026-07-11

## Question

For representative current Node.js workloads, what capability classes must a browser-resident runtime implement to support pure-JavaScript packages and native dependencies with declarative browser/Wasm replacements, while emulating only the OS surface those workloads actually observe? Which package graphs define a useful compatibility frontier across CLIs, servers, package managers, workspaces, frameworks, and data tooling?

This is a requirements survey, not a claim that Mimic currently satisfies the requirements. Current repo evidence was assessed separately in a 2026-07-11 evidence-baseline note that has since been retired; the maintained Compatibility Claims are the current evidence.

## Scope and method

- The representative workload categories follow WebContainers' first-party runtime test suite: Node runtime behavior, npm/Yarn/pnpm, CLI work, Vite, Next.js, React Router, Nuxt, LibSQL, and Drizzle. WebContainers says that suite is based on common patterns observed across StackBlitz usage and npm trends, and asks evaluators to install packages, execute their commands, start applicable servers, and validate results. [Source: WebContainers runtime test cases](https://webcontainers.io/guides/ai-agents)
- Package versions and graph facts below are a snapshot of npm's first-party registry metadata on 2026-07-11. Version-specific registry documents are linked so that the snapshot remains auditable even after `latest` moves.
- “Declaratively replaceable” means the published graph identifies a browser, WebContainers, Wasm, or WASI payload through package metadata or an explicit sibling entrypoint. A coincidentally named community port does not qualify.
- “Minimal OS emulation” means implementing the observable Node contracts required by JavaScript and declared Wasm payloads. It does not mean accepting arbitrary ELF/Mach-O/PE executables, loading arbitrary `.node` addons, running system daemons, or reproducing a general POSIX userland.

## Executive answer

Broad pragmatic Node application compatibility is achievable without a general-purpose OS, but “pure JavaScript” is no longer a stable shorthand for the target. Current mainstream graphs increasingly fall into four different classes:

1. **JavaScript-only at the executed boundary.** Prettier, ESLint, Express, Fastify, and the TypeScript 6 compatibility package can execute if the Node module, filesystem, process, stream, and network contracts they use are present. Their package-manager and server behavior still exercises substantial runtime semantics. [Sources: npm registry metadata for [Prettier 3.9.5](https://registry.npmjs.org/prettier/3.9.5), [ESLint 10.7.0](https://registry.npmjs.org/eslint/10.7.0), [Express 5.2.1](https://registry.npmjs.org/express/5.2.1), [Fastify 5.10.0](https://registry.npmjs.org/fastify/5.10.0), and [the TypeScript 6 compatibility package](https://registry.npmjs.org/%40typescript%2Ftypescript6/6.0.2)]
2. **Native by default, with a declarative Wasm/WASI route.** Rolldown, Oxc, Astro's compiler, and sharp publish `cpu: ["wasm32"]` packages in their official optional-dependency graphs; sharp publishes a payload specifically named for WebContainers. These graphs are plausible targets for a generic `wasm32`/WASI selection and NAPI-Wasm runtime, not package-specific command adapters. [Sources: npm registry metadata for [Rolldown 1.1.5](https://registry.npmjs.org/rolldown/1.1.5), [Oxc parser 0.139.0](https://registry.npmjs.org/oxc-parser/0.139.0), [Astro compiler binding 0.3.1](https://registry.npmjs.org/%40astrojs%2Fcompiler-binding/0.3.1), and [sharp 0.35.3](https://registry.npmjs.org/sharp/0.35.3)]
3. **Native with an explicit alternate package or entrypoint.** Drizzle documents browser, HTTP, WebSocket, and experimental LibSQL Wasm paths; Prisma 7 makes its query compiler TypeScript-based and driver-adapter driven, although its CLI still depends on engine installation. These require selecting the supported alternate graph and preserving its documented feature boundary. [Sources: [Drizzle's LibSQL driver matrix](https://orm.drizzle.team/docs/sqlite/get-started-sqlite), [Prisma engine architecture](https://docs.prisma.io/docs/orm/v6/more/internals/engines), and npm registry metadata for [Prisma 7.8.0](https://registry.npmjs.org/prisma/7.8.0)]
4. **Native without a declared browser payload.** TypeScript 7's `typescript` package is now a Go-native compiler distributed through platform packages; Next.js 16 publishes platform SWC packages and defaults to Turbopack; Nx and Turbo publish platform executables without a Wasm alternative in their current root metadata. Under a declarative-replacement-only policy, these current versions are outside the first compatibility frontier. [Sources: [TypeScript 7 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/), [TypeScript 7.0.2 registry metadata](https://registry.npmjs.org/typescript/7.0.2), [Next.js 16 upgrade guide](https://nextjs.org/docs/app/guides/upgrading/version-16), and npm registry metadata for [Next 16.2.10](https://registry.npmjs.org/next/16.2.10), [Nx 23.0.2](https://registry.npmjs.org/nx/23.0.2), and [Turbo 2.10.4](https://registry.npmjs.org/turbo/2.10.4)]

The most useful compatibility boundary is therefore:

> Execute published JavaScript package graphs and upstream-declared browser/Wasm/WASI variants through generic Node-like process, module, filesystem, and virtual-network contracts; reject undeclared host-native executables and addons clearly.

That boundary is materially broader than a Vite demo, but it remains honest about native-only tools.

## The minimal runtime contract

### 1. Modules and executable discovery

The runtime needs both CommonJS and ESM, package `exports`/`imports` and conditions, `type`, `main`, dynamic `import()`, `createRequire()`, `require.resolve()`, JSON loading, file URLs, source maps, and `.bin` discovery through `PATH`. Package-manager and CLI compatibility also requires shebang handling and npm-script command lookup.

This is not optional loader polish. Node's package documentation defines `exports` and `imports` as the package entrypoint and internal-import mechanisms, with conditional exports selecting implementations by environment. [Source: Node.js packages documentation](https://nodejs.org/api/packages.html)

Yarn Plug'n'Play raises the loader bar further: modern Yarn's default PnP strategy writes `.pnp.cjs` instead of `node_modules` and uses it to tell Node where `require` and `import` targets live. A runtime can reach useful Yarn coverage earlier by using Yarn's supported `node-modules` linker, but a claim of default Yarn 4 compatibility eventually requires PnP loader hooks and ZipFS behavior. [Sources: [Yarn Plug'n'Play](https://yarnpkg.com/features/pnp) and [Yarn install modes](https://yarnpkg.com/features/linkers)]

### 2. Filesystem semantics

The first broad frontier needs:

- callback, promise, and synchronous file APIs;
- byte-correct reads/writes, append, truncate, rename, copy, unlink, and recursive directory operations;
- `stat`/`lstat`, directory entries, timestamps, file types, and stable errors;
- symbolic links, `readlink`, `realpath`, and link-aware module resolution;
- file descriptors and streams;
- temporary directories, cache directories, atomic write/rename patterns, and recursive watches;
- enough permission/mode behavior for executable package bins, without reproducing a full Unix permission model.

Node exposes all three callback, synchronous, and promise forms from `node:fs`, and warns that concurrent modifications are not synchronized; compatibility tests therefore need observable ordering and error behavior, not merely a key-value VFS. [Source: Node.js filesystem documentation](https://nodejs.org/api/fs.html)

Package managers make links a hard requirement. npm workspaces automatically symlink local workspace packages into root `node_modules`. pnpm's default layout hard-links package files from a content-addressable store, then uses symbolic links to construct the dependency graph. A browser VFS may internally copy or deduplicate bytes instead of creating host hard links, but its visible inode/link, `realpath`, traversal, and module-resolution behavior must match what the package manager expects. [Sources: [npm workspaces](https://docs.npmjs.com/cli/using-npm/workspaces/) and [pnpm's symlinked `node_modules`](https://pnpm.io/symlinked-node-modules-structure)]

### 3. Processes, shell, and terminal behavior

The minimum useful process model needs independent records for PID/parent, cwd, argv, env, exit status, signals/cancellation, stdin/stdout/stderr, and lifecycle events. It must execute JavaScript bins and nested npm scripts, search `PATH`, connect pipelines, and support a deliberately bounded shell grammar for quoting, environment assignment, `&&`, `||`, pipes, and redirection.

Node's `child_process.spawn()` contract includes piped stdio, `PATH` lookup, process events, exit/close distinction, signals, and backpressure; `fork()` additionally creates a Node process with an IPC channel. Synchronous variants block the calling event loop. A browser implementation can use workers and shared memory rather than OS processes, but packages must observe these contracts for JavaScript children. [Source: Node.js child-process documentation](https://nodejs.org/api/child_process.html)

Interactive CLIs add TTY and `readline` pressure: terminal dimensions and color detection, raw/canonical input, prompts, cancellation, and non-interactive CI behavior. The first gate can use non-interactive flags, but broad CLI compatibility cannot permanently equate stdin with a completed string.

### 4. Package installation

A package manager is itself a demanding Node workload. The runtime needs registry HTTPS, redirects, proxies/auth configuration, integrity hashing, tar and compression, cache writes, lockfile fidelity, semver and peer resolution, platform/CPU/libc filtering, optional dependencies, aliases, `.bin` links, lifecycle scripts, workspaces, and deterministic error reporting.

npm installs the graph selected by the applicable lockfile and runs `preinstall`, `install`, `postinstall`, and related lifecycle phases; a package containing `binding.gyp` and no explicit install script implicitly runs `node-gyp rebuild`. For this frontier, lifecycle scripts that run JavaScript are supported, while compilation of an undeclared native addon must fail explicitly. [Sources: [npm install](https://docs.npmjs.com/cli/install/) and [npm lifecycle scripts](https://docs.npmjs.com/misc/scripts/)]

The package-manager version is part of the fixture, not ambient runtime state. Current registry releases require different Node compatibility identities: npm 12.0.1 declares `^22.22.2 || ^24.15.0 || >=26.0.0`, pnpm 11.11.0 declares `>=22.13`, and Yarn's distributable CLI 4.17.1 declares `>=18.12.0`. Node no longer distributes Corepack beginning with Node 25, so pnpm/Yarn provisioning cannot assume a built-in Corepack binary. [Sources: npm registry metadata for [npm 12.0.1](https://registry.npmjs.org/npm/12.0.1), [pnpm 11.11.0](https://registry.npmjs.org/pnpm/11.11.0), and [Yarn CLI 4.17.1](https://registry.npmjs.org/%40yarnpkg%2Fcli-dist/4.17.1); [Node Corepack documentation](https://nodejs.org/download/release/v25.8.0/docs/api/corepack.html)]

### 5. HTTP servers and virtual sockets

Server compatibility needs a generic virtual `net`/HTTP transport rather than framework adapters:

- bind/listen/address/close lifecycle and deterministic port allocation;
- Node request and response objects, headers, status codes, streaming bodies, aborts, trailers, and backpressure;
- TCP-like socket metadata and lifecycle sufficient for `node:http` and common libraries;
- HTTP upgrade plus persistent WebSocket framing;
- preview routing from browser requests to the owning virtual server;
- outbound HTTP(S), DNS-like name resolution, TLS validation, proxy configuration, and fetch/undici-compatible behavior.

Express 5.2.1 is a representative JavaScript server graph: its application is a Node HTTP request callback, and `app.listen()` is a convenience around `http.createServer(app).listen(...)` returning `http.Server`. Fastify similarly exposes the Node core server and extends Node's listen options. Passing either framework therefore means the generic HTTP server is compatible; dispatching an Express- or Fastify-shaped adapter is not equivalent. [Sources: [Express 5 application API](https://expressjs.com/en/5x/api/application/) and [Fastify server API](https://fastify.dev/docs/v5.5.x/Reference/Server/)]

### 6. Watches, workers, shared memory, and WASI

Dev servers, compilers, and monorepo tools need stable recursive change observation, rename/change semantics, debouncing tolerance, and teardown. Worker-backed JavaScript processes need `MessagePort`, transferable values, worker lifecycle, and error propagation. Declared `wasm32-wasi` NAPI payloads also require WebAssembly compilation/instantiation plus the imports, memory, threads, and filesystem bindings their upstream runtime expects.

The distinction between `child_process` and `worker_threads` must remain visible: Node workers can share memory through `SharedArrayBuffer`, while child processes have isolated process state and communicate through stdio or IPC. [Source: Node.js worker-threads documentation](https://nodejs.org/api/worker_threads.html)

Rolldown's official install guide says that its platform binary can fall back to its Wasm binary and documents `wasip1-threads`/`wasm32` as the package-manager architecture. Its published Wasm binding depends on `@napi-rs/wasm-runtime` and Emscripten NAPI runtime packages. This makes generic NAPI-Wasm/WASI-threads support a high-leverage compatibility seam rather than a Rolldown-only special case. [Sources: [Rolldown getting started](https://rolldown.rs/guide/getting-started) and npm registry metadata for [`@rolldown/binding-wasm32-wasi` 1.1.5](https://registry.npmjs.org/%40rolldown%2Fbinding-wasm32-wasi/1.1.5)]

### 7. Minimal `process` and `os` identity

Packages routinely branch on `process.platform`, `process.arch`, Node version, cwd, env, argv, uid-like values, home/temp directories, CPU count, total/free memory, endianness, and terminal/CI flags. The runtime needs a coherent virtual identity, not a claim to be the browser host OS.

The key design requirement is internal consistency: the identity used by `process`, `os`, package-manager `os`/`cpu` filtering, and native-replacement selection must describe the same virtual platform. For the declarative Wasm frontier, that likely means a browser-specific policy identity combined with `cpu: wasm32`, rather than falsely selecting a Linux x64 binary.

## Representative package-graph frontier

The classifications below are requirements-side predictions. Each still needs browser execution evidence before it becomes a compatibility claim.

| Workload | Maintained graph snapshot | Native boundary | Frontier classification | What a representative proof must observe |
| --- | --- | --- | --- | --- |
| Formatting CLI | `prettier@3.9.5`; no direct dependencies | None in root graph | JavaScript-first | Install, run `.bin/prettier` with arguments/stdin, read several files, write/check output, propagate exit code. [Registry](https://registry.npmjs.org/prettier/3.9.5) |
| Lint CLI | `eslint@10.7.0`; 30 direct dependencies; Node `^20.19 || ^22.13 || >=24` | None declared in the root graph | JavaScript-first, deeper loader/fs pressure | Resolve flat config and plugins, traverse files, report diagnostics, honor ignore patterns and non-zero exit. [Registry](https://registry.npmjs.org/eslint/10.7.0) |
| TypeScript CLI | `typescript@7.0.2` is Go-native and publishes platform packages; `@typescript/typescript6@6.0.2` is the maintained JS compatibility path | TS 7 has no published `wasm32` package in its current graph | TS 6 is inside; TS 7 is outside declarative frontier | Prove TS 6 typecheck, emit, project references, incremental files, and watch. Record TS 7 as native-unsupported rather than silently substituting an older compiler. [TypeScript 7 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/), [TS 7 registry](https://registry.npmjs.org/typescript/7.0.2), [TS 6 compatibility registry](https://registry.npmjs.org/%40typescript%2Ftypescript6/6.0.2) |
| HTTP server | `express@5.2.1`; 28 direct dependencies | None declared | JavaScript-first, HTTP-contract heavy | Start a real `http.Server`, serve routing/static/body/stream cases, handle errors and close, with no framework adapter. [Registry](https://registry.npmjs.org/express/5.2.1), [API](https://expressjs.com/en/5x/api/application/) |
| HTTP server | `fastify@5.10.0`; 15 direct dependencies | None declared | JavaScript-first, plugin/schema/stream pressure | Register plugins/routes, listen on a virtual port, stream request/response data, close after in-flight requests. [Registry](https://registry.npmjs.org/fastify/5.10.0), [API](https://fastify.dev/docs/v5.5.x/Reference/Server/) |
| WebSocket server | `ws@8.21.0`; no direct dependencies | Optional acceleration addons are not required by the root graph | JavaScript-first after generic upgrade/socket support | Upgrade through `http.Server`, exchange fragmented/binary/text frames, ping/pong, close, and observe backpressure. [Registry](https://registry.npmjs.org/ws/8.21.0) |
| npm workspaces | `npm@12.0.1` | JavaScript CLI with a large graph; lifecycle scripts may encounter native packages | Inside after installer/process/fs contract | Install a two-package workspace, verify lockfile and workspace symlink, run ordered workspace scripts, perform an offline repeat from cache. [Registry](https://registry.npmjs.org/npm/12.0.1), [workspaces](https://docs.npmjs.com/cli/using-npm/workspaces/) |
| pnpm workspaces | `pnpm@11.11.0` | Bundled JavaScript CLI | Inside after content-store, links, and child-script contract | Install a workspace with peers, verify `.pnpm` structure and visible realpaths, run filtered recursive scripts, repeat from store. [Registry](https://registry.npmjs.org/pnpm/11.11.0), [layout](https://pnpm.io/symlinked-node-modules-structure) |
| Yarn workspaces | `@yarnpkg/cli-dist@4.17.1` | Bundled JavaScript CLI | `node-modules` linker first; default PnP is a higher tier | Pin version, install/run workspace scripts with `nodeLinker: node-modules`; separately prove `.pnp.cjs` loader and ZipFS before claiming default Yarn 4 parity. [Registry](https://registry.npmjs.org/%40yarnpkg%2Fcli-dist/4.17.1), [PnP](https://yarnpkg.com/features/pnp), [linkers](https://yarnpkg.com/features/linkers) |
| Vite application | `vite@8.1.4` → `rolldown@~1.1.4`, `lightningcss`, PostCSS, glob/match utilities | Rolldown publishes `@rolldown/binding-wasm32-wasi`; `fsevents` is optional | Declarative WASI target | Install exact graph with wasm32 selection, run dev/build/preview, exercise dependency optimization, transforms, watches, HTTP and WebSocket HMR, and teardown. [Vite registry](https://registry.npmjs.org/vite/8.1.4), [Rolldown registry](https://registry.npmjs.org/rolldown/1.1.5), [Vite 8 architecture](https://vite.dev/blog/announcing-vite8) |
| Astro application | `astro@7.0.7` → `@astrojs/compiler-rs`, Vite 8, esbuild, and optional sharp | Astro compiler publishes `@astrojs/compiler-binding-wasm32-wasi`; sharp publishes `@img/sharp-webcontainers-wasm32`; esbuild needs its separate browser policy | Declaratively replaceable, but crosses several replacement contracts | Render `.astro`, dev/HMR, build/static output, image path, and teardown with every selected Wasm payload recorded. [Astro registry](https://registry.npmjs.org/astro/7.0.7), [compiler binding](https://registry.npmjs.org/%40astrojs%2Fcompiler-binding/0.3.1), [sharp](https://registry.npmjs.org/sharp/0.35.3) |
| Nuxt application | `nuxt@4.4.8` → Vite builder plus Oxc parser/transform/minifier | Current Oxc packages publish matching `binding-wasm32-wasi` optional packages; Vite 8 adds the Rolldown WASI seam | Declarative WASI target with large graph | Run `nuxt dev`, SSR a page/API route, file-route update, production build and Node-server output; prove Oxc/Rolldown Wasm selection rather than fallback. [Nuxt registry](https://registry.npmjs.org/nuxt/4.4.8), [Nuxt architecture](https://nuxt.com/docs/4.x/getting-started/introduction), [Oxc parser registry](https://registry.npmjs.org/oxc-parser/0.139.0) |
| SvelteKit application | `@sveltejs/kit@2.69.2` peers on Svelte, Vite 5–8, and the Svelte Vite plugin | Inherits the selected Vite major's native seam | Inside when the chosen Vite graph is inside | Dev SSR, routing/load/action, HMR with state/lifecycle, adapter build, production server. [Registry](https://registry.npmjs.org/%40sveltejs%2Fkit/2.69.2) |
| Next.js application | `next@16.2.10` with platform `@next/swc-*` packages and optional sharp; Turbopack is default for dev/build | No `wasm32` SWC package in current root graph; Next 14 removed its WASM target | Outside the declarative-only frontier | Keep as a negative fixture until upstream metadata offers a supported browser payload or the effort explicitly approves a maintained replacement policy. [Registry](https://registry.npmjs.org/next/16.2.10), [Next 16 upgrade guide](https://nextjs.org/docs/app/guides/upgrading/version-16), [Next 14 upgrade guide](https://nextjs.org/docs/app/guides/upgrading/version-14) |
| Monorepo task runner | `nx@23.0.2` | Platform `@nx/nx-*` packages, no Wasm variant in root metadata | Outside current frontier | Negative install/execute proof with an explicit native-boundary diagnostic. [Registry](https://registry.npmjs.org/nx/23.0.2) |
| Monorepo task runner | `turbo@2.10.4` | Platform `@turbo/*` executables, no Wasm variant in root metadata | Outside current frontier | Negative install/execute proof with an explicit native-boundary diagnostic. [Registry](https://registry.npmjs.org/turbo/2.10.4) |
| Drizzle + remote LibSQL | `drizzle-orm@0.45.2` plus the documented `@libsql/client/web`, `/http`, or `/ws` entrypoint | Avoid the default Node native `libsql` route | Inside after outbound HTTP/WebSocket and crypto/env support | Perform schema-defined CRUD and transactions against a controlled remote endpoint; prove selected entrypoint and network lifecycle. [Drizzle registry](https://registry.npmjs.org/drizzle-orm/0.45.2), [driver matrix](https://orm.drizzle.team/docs/sqlite/get-started-sqlite) |
| Drizzle + local LibSQL Wasm | `drizzle-orm@0.45.2` plus `@libsql/client-wasm@0.17.4` | Explicit experimental Wasm package | Experimental declarative Wasm target | Create local database, migrate schema, CRUD/transaction, persistence across reopen, binary asset loading. [Client registry](https://registry.npmjs.org/%40libsql%2Fclient-wasm/0.17.4), [Drizzle driver matrix](https://orm.drizzle.team/docs/sqlite/get-started-sqlite) |
| Drizzle CLI | `drizzle-kit@0.31.10` → `tsx`, `esbuild`, BroCLI, ESM loader | esbuild requires an explicit `esbuild-wasm` policy and initialization contract | Policy-replaceable | Generate and apply migration files, load TS config, exercise JS child process and filesystem mutation, record esbuild substitution. [Registry](https://registry.npmjs.org/drizzle-kit/0.31.10) |
| Prisma application | `prisma@7.8.0` + generated `@prisma/client@7.8.0` and a driver adapter | Query compiler is TypeScript in v7, but the CLI still depends on `@prisma/engines` with postinstall and schema-engine responsibilities | Split frontier: generated client/remote adapter plausible; full CLI/migrate outside until engine path is replaced | Test generated client separately from `prisma generate/migrate`; never infer CLI compatibility from a successful query. [Prisma registry](https://registry.npmjs.org/prisma/7.8.0), [client registry](https://registry.npmjs.org/%40prisma%2Fclient/7.8.0), [engine architecture](https://docs.prisma.io/docs/orm/v6/more/internals/engines) |

## What “declarative replacement” must mean operationally

An installer cannot treat the presence of any Wasm-looking package name as success. It must:

1. Resolve `os`, `cpu`, and `libc` against one coherent virtual target and select `cpu: wasm32` optional packages where upstream metadata offers them.
2. Preserve the exact version coupling between wrapper and binding. The surveyed Rolldown, Oxc, Astro compiler, and sharp graphs pin or closely couple their binding versions. [Sources: registry metadata for [Rolldown](https://registry.npmjs.org/rolldown/1.1.5), [Oxc parser](https://registry.npmjs.org/oxc-parser/0.139.0), [Astro compiler binding](https://registry.npmjs.org/%40astrojs%2Fcompiler-binding/0.3.1), and [sharp](https://registry.npmjs.org/sharp/0.35.3)]
3. Materialize Wasm assets byte-for-byte and honor package exports, worker/bootstrap code, and initialization order.
4. Provide the generic runtime named by the payload: WebAssembly, WASI preview/threads behavior, NAPI-Wasm glue, workers, shared memory, VFS, and streams as applicable.
5. Record provenance: logical package, native candidates skipped, selected browser/Wasm package, version rule, assets, initialization contract, and capability caveats.
6. Fail closed when the graph exposes no approved browser route. Choosing a Linux binary because the browser runtime reports `process.platform = "linux"` would be a false-positive install.

This supports two distinct mechanisms:

- **Metadata-selected target:** upstream publishes the Wasm package inside the same optional-dependency graph, as Rolldown/Oxc/Astro compiler/sharp do.
- **Curated explicit replacement:** upstream documents a sibling package but the root metadata cannot select it, as with `esbuild` → `esbuild-wasm` or the experimental LibSQL Wasm client. This must be a versioned policy, not suffix guessing. [Sources: [esbuild browser API](https://esbuild.github.io/api/#running-in-the-browser) and [Drizzle's LibSQL driver matrix](https://orm.drizzle.team/docs/sqlite/get-started-sqlite)]

## Highest-leverage generic blockers, from the requirements side

These are ordered by the number and diversity of representative current graphs they unlock, not by estimated implementation effort.

### 1. A coherent wasm32/WASI/NAPI-Wasm package target

This single seam reaches Vite 8/Rolldown, Nuxt's Oxc dependencies, Astro's compiler, and sharp's WebContainers build. It needs platform filtering, asset materialization, WASI threads/shared memory, NAPI-Wasm glue, and explicit provenance. The same capability should be exercised by a small direct Rolldown/Oxc fixture before relying on a meta-framework to diagnose it.

### 2. A real JavaScript process tree with shell, stdio, IPC-shaped messaging, and lifecycle control

This unlocks package lifecycle scripts, npm/pnpm/Yarn script execution, CLI composition, generators, workspace orchestration, test runners, and framework child work. It also prevents a compatibility program from confusing in-process command adapters with Node process behavior.

### 3. Link-correct, watchable, byte-correct filesystem semantics

Symlink/realpath behavior is shared by npm workspaces, pnpm, Node resolution, and monorepos. Recursive watch and atomic rename behavior is shared by TypeScript watch, Vite, Nuxt, Astro, and SvelteKit. Binary-safe Wasm/database assets add pressure that text-oriented VFS paths will miss.

### 4. Generic Node HTTP/socket/stream parity

One compatible server substrate unlocks Express, Fastify, WebSocket packages, SSR frameworks, dev servers, and preview routing. The proof boundary should be Node `http.Server`/`net.Socket` observable behavior, not framework names.

### 5. Package-manager fidelity beyond tarball materialization

Real npm first, then pnpm's link/store layout, then Yarn with its supported `node-modules` linker and finally default PnP gives an incremental route. Required behaviors include lockfiles, peer/optional/platform resolution, lifecycle approval/execution, workspaces, cache/offline behavior, auth/proxy/TLS, and failure atomicity.

### 6. Loader completeness and alternate-resolution hooks

CJS/ESM interop, conditions, config loading, and mutable/cache behavior are cross-cutting requirements for every category. Yarn PnP is the later high-pressure fixture that proves the loader can accept a package-manager-supplied resolution model rather than assuming physical `node_modules` forever.

## Recommended compatibility ladder

Each rung should use exact published versions and public Mimic APIs in Chromium. A rung is not complete until install, execute, output/lifecycle, and teardown are observed.

1. **Pure-JS CLI:** Prettier 3.9.5, then ESLint 10.7.0, then TypeScript 6.0.2 through the upstream compatibility package.
2. **Pure-JS server:** Node HTTP/stream fixture, Express 5.2.1, Fastify 5.10.0, then `ws` 8.21.0 through the generic upgrade transport.
3. **npm workspace:** npm's maintained project-workspace flow with local symlink, lifecycle script, cache/offline repeat, and two workspace scripts.
4. **Alternative package managers:** pnpm 11.11.0 workspace, Yarn 4.17.1 with `node-modules`, then a separate Yarn PnP tier.
5. **Direct declarative Wasm:** exact Rolldown and Oxc APIs using their published `wasm32-wasi` bindings; this isolates WASI/NAPI behavior from framework orchestration.
6. **Current frameworks:** Vite 8.1.4, Astro 7.0.7, Nuxt 4.4.8, and SvelteKit 2.69.2 on exact graphs.
7. **Data runtime:** Drizzle with remote LibSQL browser/HTTP/WebSocket entrypoint, then experimental local LibSQL Wasm.
8. **Split native tools:** Drizzle Kit with declared esbuild replacement; Prisma 7 generated client separately from its native-engine CLI boundary.
9. **Maintained negative fixtures:** TypeScript 7.0.2, Next 16.2.10, Nx 23.0.2, and Turbo 2.10.4 must fail at a named native boundary until an upstream-declared or explicitly approved replacement exists.

## Conclusions

- Minimal OS emulation is a viable product boundary if “minimal” still includes serious Node semantics: process trees, stdio/backpressure, links/realpaths, watches, package installation, HTTP/socket streaming, workers/shared memory, and coherent platform identity.
- The current high-value frontier is **JavaScript plus declared browser/Wasm/WASI**, not JavaScript alone and not arbitrary native execution.
- Declarative Wasm support has unusually high leverage in the 2026 ecosystem because the same NAPI-Wasm/WASI publishing pattern now appears in Rolldown, Oxc, Astro's compiler, and sharp.
- Compatibility must be graph- and feature-scoped. Astro can be inside the frontier only when all of compiler, bundler, image, and esbuild seams are handled; Prisma client queries can be inside while Prisma CLI migrations remain outside.
- Negative fixtures are essential. TypeScript 7, Next 16, Nx, and Turbo prevent a runtime from turning install success, a hidden host binary, or a silent version downgrade into a false compatibility claim.
- The first generic work should target capabilities shared by several categories: wasm32/WASI/NAPI-Wasm selection, process trees, link/watch filesystem behavior, and generic HTTP/socket streams. Package-specific framework adapters would not move the broad Node application frontier.
