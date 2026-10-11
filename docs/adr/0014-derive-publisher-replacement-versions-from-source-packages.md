---
status: superseded by ADR-0021
---

# Derive publisher replacement versions from source packages

ADR-0021 supersedes this decision: replacements still use the source package's exact version, but there is no Catalog version, receipt or attestation, and a version outside the validated range is installed unchanged instead of failing closed.

Browser Package Replacement Catalog records package-level publisher relationships rather than an exact mapping row for every supported source version. When a selected source-package version falls within a relationship's semantic family or major-line applicability, Package Installation requests the related browser, WASM, or WASI package at that same exact version, validates registry identity and publisher integrity, verifies the declared assets, and attests the resolved identity, integrity, and relationship in the Package Installation Receipt. A missing same-version package, identity mismatch, integrity mismatch, or missing required asset fails closed.

The rule applies both to Effective Package Resolution replacements and Catalog Execution Artifacts. In particular, one `esbuild` to `@esbuild/wasi-preview1` relationship replaces the current per-version execution-artifact rows; adding an Exact Graph that contains another compatible esbuild version no longer changes Catalog data. Semantic applicability or a direct-source family may still distinguish publisher product lines, such as direct Rollup 3 from the same-version `@rollup/wasm-node` relationship available for Rollup 4, but the Catalog does not list evidence patches as mapping exceptions.

This decision refines the per-version Catalog v4 data shape described by ADR-0004 without changing that ADR's publisher-WASI execution architecture. Compatibility Claims remain immutable Exact Graphs: version-agnostic replacement selection does not turn a tested package version into a version-range compatibility claim. A claim may pin and assert the exact replacement identity and integrity observed in its receipt, but those evidence expectations never participate in runtime selection.

The migration lands before the Node `22.22.3` Runtime Platform Profile change. First, the current replacement and execution-artifact paths converge on one same-version resolver and the complete existing matrix passes unchanged on Node `22.13.0`; then the Node profile advances and the complete matrix passes again. This separates Catalog regressions from platform-profile regressions.
