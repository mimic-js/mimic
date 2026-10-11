---
status: accepted
---

# Use one attested Runtime Platform Profile

Mimic will use one immutable Runtime Platform Profile for an entire runtime epoch rather than selecting a Node identity per package. The first profile change for Angular 22 advances Node from `22.13.0` to `22.22.3`, adds the Node version to Exact Graph targets and compatibility evidence, and must pass the complete existing positive Compatibility Evidence Matrix before Vite 8 or Angular delivery begins. Any failure blocks the profile migration and the complete new program until repaired through package-neutral runtime capabilities; claim weakening, removal, dependency substitution, and hidden per-fixture overrides are forbidden.

This decision does not introduce version-selectable profiles, npm-distributed Node Compatibility implementations, or project-manifest profile selection. Mimic exposes only Node `22.22.3`; any future need for another Node identity requires a separate design decision.
