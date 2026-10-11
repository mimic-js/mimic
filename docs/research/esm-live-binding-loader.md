# Research: mutable ESM live bindings in the browser loader

> Snapshot note: source findings and dated evidence are retained, but repo-specific
> “current state” statements may be obsolete. Verify them against current code,
> tests, issues, and [`compatibility-status.md`](../compatibility-status.md). See
> [the research status rules](./README.md).

## Scope

This note defines the minimum correct behavior for mutable ESM exports in Mimic's transformed module loader. The observed blocker was Svelte 5.37.3: compiler `state.adjust()` changes exported `dev`, while `transform-client.js` imports that binding and must observe the new value before compiling an HMR component.

## Primary evidence

- [ECMAScript module records and `ResolveExport`](https://tc39.es/ecma262/multipage/ecmascript-language-scripts-and-modules.html) resolve an exported name to a module binding rather than a copied value.
- [ECMAScript environment records](https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-module-environment-records) define imports through `CreateImportBinding`; reads resolve the target module binding, while writes to the mutable source binding use `SetMutableBinding`.
- The browser failure captured by the former Svelte browser smoke showed `state.adjust()` assigning exported `dev`, but the transformed importer retained its initial `false` value. With compiler HMR enabled this produced a production-shaped component and an invalid HMR wrapper result.

## Selected implementation

The existing loader namespace/subscriber protocol remains the linking boundary. Mutable export initialization publishes a getter. A parser-backed Babel visitor now instruments subsequent `AssignmentExpression` and `UpdateExpression` nodes only when Babel scope resolution identifies the same module-level `export let` or `export var` binding. After the write, the namespace publishes the current getter value to import subscribers.

This preserves assignment results and postfix update results, ignores shadowed locals, and avoids regex replacement of identifier text. Destructuring assignments remain an explicit future loader gap; they are not needed by the observed Svelte path and should be added with parser-backed binding analysis when encountered.

## Verification

- `tests/unit/runtime-command-contracts.test.ts` proves initial values, direct assignment, postfix update result semantics, and importer visibility.
- The Playwright browser fixture matrix now runs the installed Svelte plugin/compiler with HMR enabled and proves a component edit updates Chromium DOM without reloading the runtime-backed iframe.
