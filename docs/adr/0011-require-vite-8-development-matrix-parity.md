---
status: accepted
---

# Require Vite 8 development-matrix parity

Vite 8 becomes a Validated Major Line only after its Vanilla, TypeScript, React 19 with `@vitejs/plugin-react` 6, Vue 3 with `@vitejs/plugin-vue` 6, Solid 1 with `vite-plugin-solid` 2, and Svelte 5 with `@sveltejs/vite-plugin-svelte` 7 Exact Graphs pass the development contracts established for Vite 7 by ADR-0008. Exact compatible patches are captured at curation time from each publisher graph without dependency overrides or deduplication and then remain immutable under ADR-0013.

Each framework lane proves a cold optimizer path, initial render, framework-native HMR, hard reload, process stop, endpoint and descendant-resource cleanup, teardown, and clean reboot. Shared Vanilla and TypeScript lanes prove JavaScript and TypeScript edits, CSS HMR, syntax-error recovery in the same process, `vite.config.ts`, assets, JSON and environment loading, warm optimizer restart, and late bare-import discovery. A focused development configuration also executes `css.transformer: "lightningcss"` through the Catalog replacement selected by ADR-0012 and proves transform, HMR, and error recovery.

A render-only smoke test is insufficient, and Vite 8 evidence retains the existing bans on response mutation, synthetic HMR, VFS serving fallbacks, and package- or framework-specific runtime behavior. Production `vite build`, minification, and `vite preview` remain independent compatibility surfaces.
