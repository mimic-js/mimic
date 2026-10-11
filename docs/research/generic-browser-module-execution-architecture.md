# Research: a generic browser module execution architecture

> Snapshot note: source findings and dated evidence are retained, but repo-specific
> “current state” statements may become obsolete. Verify them against current code,
> tests, issues, and [`compatibility-status.md`](../compatibility-status.md). See
> [the research status rules](./README.md).

Date: 2026-07-18

## Question

How do the current Mimic module and process modules resolve,
transform, link, and evaluate CommonJS (CJS) and ECMAScript modules (ESM)?
Which execution context owns each step? What browser/runtime architecture can
replace the current semantic approximations with a package-agnostic Module
Execution Engine that does not depend on build tools installed by the user
project?

This is architecture research for
Research a generic browser module execution architecture (#233).
It does not implement the replacement.

## Executive decision

Mimic should keep module resolution, source loading, compilation,
linking, and evaluation behind one deep **Module Execution Engine** whose public
interface is essentially “run this entry in this Execution Context.” Resolution,
format selection, CJS/ESM interop, caches, the ESM graph, generated wrappers,
and the pinned parser/transformer belong inside its implementation.

The engine should:

1. run only in a worker-isolated Execution Context;
2. use canonical URL-like module identities and one registry per Execution
   Context;
3. separate resolve, load, compile, instantiate/link, and evaluate as explicit
   internal phases, following Node's loader split and ECMAScript Module Record
   lifecycle;
4. compile every ESM source with the runtime-owned pinned parser/transformer to
   a `System.register`-like definition (`dependencies`, setters, and an
   `execute` function), then let an engine-owned graph linker implement cycles,
   live bindings, re-exports, dynamic import, and top-level await;
5. keep the Node-compatible CJS wrapper and pre-execution cache insertion, but
   make CJS another format adapter in the same registry rather than a parallel
   loader with ad hoc cross-cache writes;
6. remove package-name checks, framework patches, and project-provided build
   tool discovery from the engine; and
7. centralize the small number of generated execution wrappers, with source
   URLs/maps and an explicit CSP/deployment requirement.

`@babel/standalone` is already a direct runtime dependency and is explicitly
intended for browser/non-Node environments that compile user-provided code in
real time. Its built-in SystemJS transform converts module syntax while leaving
resolution to the host. Therefore a pinned, Mimic-owned Babel
pipeline is a suitable initial compiler implementation; it is not a user
project dependency. [Babel standalone](https://babeljs.io/docs/babel-standalone/),
[Babel SystemJS transform](https://babeljs.io/docs/babel-plugin-transform-modules-systemjs/)

Native browser ESM should not be the primary engine. Module workers do provide
native module graphs, but their graph is fetched by URL, and document import
maps do not apply to workers. A native adapter would therefore need a stable
VFS-to-URL source gateway plus specifier rewriting, and it would still not
execute CJS. It can be evaluated later as a real second adapter, not exposed in
the first engine interface. [WHATWG module workers](https://html.spec.whatwg.org/multipage/workers.html),
[WICG worker import-map design issue](https://github.com/WICG/import-maps/issues/2)

## Current execution topology

The normal public path is:

```text
Mimic.spawn("node", ...)
  -> WorkerNodeCommand on the host/main thread
  -> dedicated module Worker (node-process-worker.ts)
  -> worker-local VFS snapshot and RuntimeCommandContext
  -> NodeCommand
  -> JsModuleLoader
  -> ModuleResolver + CJS/ESM executors
  -> generated Function/AsyncFunction in that worker realm
```

The host and process worker mirror VFS mutations over messages. Standard output,
errors, module-start/module-end diagnostics, signals, and preview operations
also cross the worker transport. The worker constructs its own VFS from the
host snapshot before `NodeCommand` begins. See
[`worker-node-command.ts`](../../src/runtime/worker-node-command.ts) and
[`node-process-worker.ts`](../../src/runtime/node-process-worker.ts).

This means the normal top-level `node` process resolves, transforms, links, and
evaluates user modules off the main thread. There are three important caveats:

- `WorkerNodeCommand` falls back to an in-realm `NodeCommand` when `Worker` is
  absent. If the caller is the page, that can evaluate user code on the main
  thread and contradicts the target Execution Context invariant.
- `child_process.spawn()` recursively creates another `NodeCommand`, but it
  runs inside the same process worker and realm. It has a distinct emulated
  process record, not worker isolation.
- the current `worker_threads.Worker` creates a child loader with
  `Object.create()`-based process/global objects, but evaluates it in the same
  JavaScript worker realm. It is not backed by another browser worker.

Those caveats are topology concerns around the engine. They should not cause
the Module Execution Engine interface to expose worker construction or browser
messaging.

## Current module pipeline

### Entry and process setup

[`node-runner.ts`](../../src/runtime/node-runner.ts) normalizes the entry against
the process cwd, creates Node-like `process`, console, stdio, timers, file-watch,
child-process, and runtime-global objects, then constructs `JsModuleLoader` and
calls `runEntry()`.

The runner waits for the entry plus loader-tracked imports/tasks and referenced
timers/watchers. It owns process exit and signal semantics; these are not module
graph semantics and should remain outside the future engine.

### Resolution

[`module-loader.ts`](../../src/runtime/module-loader.ts) asks the stdlib registry
first. All other specifiers flow into
[`module-resolution.ts`](../../src/runtime/module-resolution.ts):

- `file:`, absolute, and relative paths are normalized against the importer;
- bare packages walk parent directories looking for `node_modules`;
- optional PnP mode reads the repository's PnP data;
- package `imports`, `exports`, subpaths, `browser`, `module`, and `main` fields
  are partially recognized;
- `import` and `require` pass different resolution modes; and
- extension and directory-index probing resolves `.js`, `.cjs`, `.mjs`, and
  `.json`.

Format selection then happens separately in `JsModuleLoader`: `.mjs` is ESM,
`.cjs` is CJS, and other files consult the nearest `package.json` `type` field.
For asynchronous `import`, an additional regular expression guesses whether a
nominally CJS file contains ESM syntax.

This resembles Node's externally useful split: resolve maps a specifier and
context to a URL, while load maps a resolved URL to source and a format. Node's
customization hook documentation names exactly those responsibilities.
[Node module customization hooks](https://nodejs.org/api/module.html#customization-hooks)

### Loading and builtins

The loader reads JavaScript synchronously from the Virtual File System and
parses JSON directly. A stdlib registry returns Mimic-owned builtin
modules before filesystem resolution.

The generic path currently has special cases:

- a resolved `esbuild/lib/browser.js` path receives a custom Wasm/VFS runtime;
- any path inside `node_modules/fsevents` returns `undefined`;
- package runtime policy can reject a resolved path; and
- `ModuleLoaderRuntimeServices.moduleSourceFooter()` can append a Vite
  compatibility footer to ESM source.

The runtime-services object hides some imports, but the observable module
behavior is still package-aware. The target engine cannot retain these as
generic resolution/load/evaluation rules. Browser package replacement belongs
before materialization; HTTP/dev-server behavior belongs at its named runtime
seam.

### CommonJS transform and evaluation

[`cjs-execution.ts`](../../src/runtime/cjs-execution.ts) and
[`generated-loader-artifacts.ts`](../../src/runtime/generated-loader-artifacts.ts)
currently do the following:

1. return a cached module if present;
2. insert an empty `{ exports }` record in the cache before running source,
   which enables partially initialized exports during cycles;
3. strip the shebang;
4. use Babel to inject module-local `process` and `Buffer` bindings when the
   source does not declare them, and wrap top-level expression statements with
   async-task tracking;
5. rewrite dynamic `import()` to the loader callback;
6. compile one centralized Node-shaped wrapper with `new Function`;
7. call it with `exports`, `require`, `module`, filename/dirname, runtime
   globals, timers, console, and dynamic-import helpers; and
8. return `module.exports`.

This matches two essential Node contracts: CJS source is executed in a module
wrapper, and the resolved-filename cache is populated early enough for partial
exports to break cycles. [Node CommonJS wrapper and caching](https://nodejs.org/api/modules.html)

### ESM transform, graph, linking, and evaluation

[`esm-execution.ts`](../../src/runtime/esm-execution.ts) owns an evaluation map
and source transform:

1. it creates and caches a namespace-like object before evaluating dependencies;
2. it reads source and uses Babel for selected tasks: mutable-export binding
   analysis, top-level async-IIFE detection, template-literal ranges, and
   top-level-await detection;
3. it then uses regular expressions/string scanning to rewrite static imports,
   dynamic import, `import.meta`, declarations, default exports, re-exports,
   and export lists;
4. rewritten imports call back into `JsModuleLoader.import()`; the ancestor set
   returns the in-progress namespace when a cycle is encountered;
5. a namespace subscriber protocol pushes mutable exported values into importer
   locals to approximate live bindings;
6. asynchronous ESM runs in an `AsyncFunction`; synchronous CJS-to-ESM require
   rejects detected top-level await and runs a `Function`; and
7. both return the synthetic namespace object.

This is a graph-shaped loader, but not yet an ECMAScript-compatible linker.
The ECMAScript specification models modules as Module Records with requested
modules, import/export entries, explicit `Link()` and `Evaluate()` phases,
cycle states, live resolved bindings, and asynchronous dependency bookkeeping.
[ECMAScript modules and Module Records](https://tc39.es/ecma262/multipage/ecmascript-language-scripts-and-modules.html)

Node's `vm.SourceTextModule` is a useful host-facing reference even though it is
not available in browsers: parse first, inspect ordered module requests, resolve
and link each request to the same cached module instance, instantiate all cycle
members, then evaluate the root and await its graph. [Node
`vm.SourceTextModule`](https://nodejs.org/api/vm.html#class-vmsourcetextmodule)

### CJS/ESM interop

- asynchronous ESM importing CJS receives an object-like namespace with a
  default export;
- `require()` of ESM uses the synchronous ESM transform and rejects top-level
  await;
- ESM and CJS maintain separate primary maps, with synchronous ESM records also
  inserted into the CJS cache; and
- JSON import and require parse source directly rather than sharing a canonical
  module record.

The target should make these explicit format-adapter rules over one registry.
Node itself uses separate ESM and CJS caches, but also creates a CJS cache entry
for imported JSON so both systems return the same object; Mimic
should choose and test its interop deliberately rather than obtain it as a side
effect of executor maps. [Node ESM interoperability and JSON modules](https://nodejs.org/api/esm.html)

## Semantic gaps in the current implementation

### Resolution is an approximation, not Node's algorithm

The current resolver is useful but incomplete:

- it uses a hard-coded condition preference with `development` first instead
  of processing package condition objects in their defined key order;
- it falls back to the first object value, which can bypass an unknown or null
  condition instead of rejecting;
- package exports encapsulation is not enforced when an unexported subpath
  exists physically;
- wildcard subpath patterns, package self-references, array targets, target
  validation, and imports that target external packages are incomplete;
- path traversal and invalid package target segments are not rejected;
- canonical realpath/symlink identity and URL query/fragment identity are not
  consistently modeled; and
- import attributes are absent from resolution and cache identity.

Node documents that `exports` takes precedence over `main`, encapsulates all
unlisted package subpaths, applies ordered conditions to both CJS and ESM, and
restricts targets to relative URLs without traversal/`node_modules` segments.
[Node packages](https://nodejs.org/api/packages.html)

The future resolver therefore needs a conformance implementation, not more
package-specific branches.

### Regex is not a complete ESM compiler or linker

The current transform can pass maintained fixtures while missing valid syntax
or semantics. Risks include multiline and compact forms, import attributes,
namespace re-exports, destructuring declarations and mutations, ambiguous
star exports, early errors, temporal dead zones, hoisting across cycles,
live re-exports, and top-level-await cycles. A syntax-presence regex can also
misclassify format.

The specification's module states and binding resolution cannot be recovered
reliably by accumulating more textual rewrites. All module syntax must be
parsed into one AST, and the graph linker must own lifecycle and binding
propagation.

### Evaluation wrappers are deployment policy

`new Function` and `AsyncFunction` are centralized today, which is better than
scattered generated programs, but they are still CSP `unsafe-eval` sinks. CSP
Level 3 explicitly gates `Function()` on `unsafe-eval` (or the corresponding
Trusted Types evaluation permission). [CSP Level
3](https://w3c.github.io/webappsec-csp/)

A runtime that compiles arbitrary VFS source at run time must choose one of:

- an isolated runtime origin/worker policy that permits the small audited
  evaluation wrapper;
- a source-serving native-module path with no dynamic string evaluation; or
- a separate JavaScript interpreter/engine.

The first is the smallest match for the existing roadmap. It must be an
explicit boot/deployment capability check, not an accidental requirement.
Generated wrappers must include source URL and source map support so diagnostics
point to VFS modules.

### Realm isolation is weaker than the names imply

Object-created `global` values do not create ECMAScript realms. All modules in
one `NodeCommand`, emulated child processes, and emulated worker threads share
the same actual worker realm and host intrinsics. That limits isolation and
termination guarantees. The engine should be scoped to one true Execution
Context; the process/worker topology decides when a fresh browser worker and
therefore a fresh engine/registry is required.

## Target deep module

### External seam

The external interface should remain small and process-oriented:

```ts
interface ModuleExecutionEngine {
  runEntry(request: EntryRequest): Promise<unknown>;
}
```

`EntryRequest` needs the entry specifier, cwd/parent identity, resolution
conditions, argv/environment, and the Execution Context ports required by
Node builtins. Callers should not orchestrate `resolve()`, caches, compilation,
or graph traversal. `require.resolve`, dynamic import, and worker entry loading
are capabilities implemented inside the same engine.

Deleting this module should force all callers to reimplement resolution,
format/interop rules, graph lifecycle, compilation, caching, and evaluation;
that is the intended depth and locality.

### Internal model

The implementation should maintain these concepts without necessarily exposing
each as a public TypeScript interface:

```text
ModuleRequest
  specifier + parent URL + import/require kind + conditions + attributes

ResolvedModule
  canonical URL + format hint + resolution provenance

LoadedModule
  canonical URL + final format + source bytes/text + source version

ModuleDefinition
  canonical identity + ordered dependencies + instantiate/execute behavior

ModuleRecord
  definition + namespace/bindings + lifecycle state + evaluation promise/error
```

The registry key should include canonical URL and module attributes/type where
the host semantics distinguish them. A source version belongs in compiled
artifact caching and invalidation, not in ordinary runtime identity unless a
new graph generation is intentionally created.

Internal phases:

1. **Resolve** — implement Node-compatible path/package/builtin rules from the
   request and return a canonical identity plus suggested format.
2. **Load** — obtain source from the authoritative VFS or create a synthetic
   builtin/JSON/Wasm definition; return the final format.
3. **Compile** — parse once with the pinned runtime compiler and emit a
   source-mapped module definition.
4. **Instantiate/link** — create records for the whole reachable graph, connect
   imports/re-exports to exporter bindings, validate missing/ambiguous exports,
   and make cycles linkable before any body executes.
5. **Evaluate** — execute in dependency order, preserve synchronous subgraphs,
   await asynchronous dependencies/top-level await, cache completion or error,
   and route dynamic import back through the same pipeline.

These phases are internal seams justified by actual format variation and test
control. They must not become a broad plugin interface for user packages.

### ESM definition format

A `System.register`-like intermediate representation is the strongest browser
reference for the first implementation:

- dependencies are declared before execution;
- setters receive dependency namespace/binding updates, including cycles;
- the execute function preserves the point at which module code runs;
- an async execute function models top-level await; and
- contextual import and metadata route dynamic import/`import.meta` back to the
  owning loader.

SystemJS documents this exact structure and its support for live bindings,
circular references, dynamic import, and top-level await. It also explains that
setters push binding updates without circular deadlock. [System.register
format](https://github.com/systemjs/systemjs/blob/main/docs/system-register.md)

Mimic does not need to expose or necessarily adopt the SystemJS
package. The architectural decision is to use the proven register-style
definition and graph semantics. The current pinned Babel standalone build
already contains the official `transform-modules-systemjs` plugin, so the first
compiler can be runtime-owned and package-agnostic.

### CJS definition format

Keep the current good properties:

- module-local wrapper parameters;
- cache insertion before execution;
- one evaluation per canonical resolved filename;
- partial exports during cycles; and
- dynamic import routed into the same registry.

Change the ownership: CJS compilation should return a `ModuleDefinition`; the
registry should create/cache the record; the evaluator should invoke the one
centralized wrapper. CJS-to-ESM namespace creation and ESM-to-CJS require become
explicit interop policy at this seam.

### Native ESM adapter criteria

The browser's native module worker loader provides a real module map per worker
and fetches an entire module graph. That can offer exact browser ESM semantics.
[WHATWG module maps](https://html.spec.whatwg.org/multipage/webappapis.html)

It should be added only if a prototype proves all of the following:

- stable same-origin URLs can serve authoritative VFS source to the process
  worker without creating a second mutable filesystem authority;
- every Node/bare/package specifier can be resolved or rewritten before native
  fetch, including dynamic imports;
- invalidation can create a new graph generation without leaking object URLs;
- errors and source maps retain VFS identities;
- CJS and synthetic Node builtins interoperate through a defined bridge; and
- it works under the runtime's CSP and service-worker lifecycle.

Until then, it is not a second adapter and should not widen the engine interface.

## Required invariants and evidence

The architecture is not complete until maintained tests exercise the engine
through its external seam for:

- canonical cache identity, duplicate requests, and CJS partial exports;
- CJS cycles, ESM cycles, and mixed CJS/ESM cycles;
- live imports, mutable exports, live re-exports, star exports, and ambiguous
  export errors;
- ESM hoisting and temporal-dead-zone behavior observable across cycles;
- top-level await ordering, rejection, and cyclic async graphs;
- dynamic import and `import.meta` identity;
- JSON/import attributes and synthetic builtin identity;
- Node package exports/imports, ordered conditions, patterns, self-reference,
  encapsulation, invalid targets, and PnP/node_modules resolution;
- syntax errors and evaluation errors cached/rethrown at the correct phase;
- source-mapped worker diagnostics; and
- proof that no entry, child process, or `worker_threads` module evaluates on
  the main thread.

Package/framework names must not appear in engine source or positive proof
fixtures. Compatibility matrices may use real packages as consumers of the
generic behavior.

## Migration direction

This is a planning sequence, not implementation in this note:

1. characterize the existing external behavior and add missing graph/resolver
   semantic fixtures before moving code;
2. introduce the deep Module Execution Engine seam around the existing loader;
3. replace ESM regex rewriting with the pinned parser's register-style output
   and an engine-owned graph registry;
4. move CJS into the same definition/record registry and make interop explicit;
5. replace the partial resolver with Node-compatible, test-backed package and
   URL semantics;
6. move/remove esbuild, `fsevents`, Vite footer, and other package/runtime
   special cases at their owning seams;
7. remove the main-thread fallback and make child/worker execution create true
   Execution Contexts according to the process-topology decision; and
8. benchmark compilation/cache behavior before deciding whether a native ESM
   adapter earns a real seam.

## Follow-up questions surfaced

These are recommendations to the map owner, not new tickets created by this
research session:

1. **Prototype the register-style engine core.** Can the pinned
   `@babel/standalone` SystemJS transform plus a minimal worker-local registry
   pass the cycle, live-binding, re-export, dynamic-import, and top-level-await
   fixtures with acceptable cold-start cost?
2. **Decide the execution-wrapper security contract.** Will Mimic
   explicitly require an isolated worker/runtime origin that permits the
   audited `Function` wrapper, or must the destination include a no-`unsafe-eval`
   execution adapter?
3. **Specify the Node resolution conformance slice.** Which maintained Node
   versions and condition sets define the exact `exports`/`imports`, PnP,
   symlink, attributes, and CJS/ESM interop evidence matrix?

## Primary sources

- [ECMAScript Language Specification: scripts and modules](https://tc39.es/ecma262/multipage/ecmascript-language-scripts-and-modules.html)
- [Node.js CommonJS modules](https://nodejs.org/api/modules.html)
- [Node.js ECMAScript modules](https://nodejs.org/api/esm.html)
- [Node.js packages](https://nodejs.org/api/packages.html)
- [Node.js module customization hooks](https://nodejs.org/api/module.html#customization-hooks)
- [Node.js `vm.SourceTextModule`](https://nodejs.org/api/vm.html#class-vmsourcetextmodule)
- [WHATWG HTML: workers](https://html.spec.whatwg.org/multipage/workers.html)
- [WHATWG HTML: module maps and import maps](https://html.spec.whatwg.org/multipage/webappapis.html)
- [WICG import maps: worker/worklet installation design issue](https://github.com/WICG/import-maps/issues/2)
- [Content Security Policy Level 3](https://w3c.github.io/webappsec-csp/)
- [Babel standalone](https://babeljs.io/docs/babel-standalone/)
- [Babel SystemJS module transform](https://babeljs.io/docs/babel-plugin-transform-modules-systemjs/)
- [SystemJS `System.register` format](https://github.com/systemjs/systemjs/blob/main/docs/system-register.md)
