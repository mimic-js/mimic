---
status: superseded by ADR-0021
---

# Replace Lightning CSS with its publisher WASM sibling

ADR-0021 supersedes this decision: the same-version `lightningcss-wasm` replacement now replaces the installed package contents after an install, and no receipt or lockfile overlay exists.

For the browser/wasm32 Runtime Platform Profile, Effective Package Resolution will map logical `lightningcss` requests to the same-version official `lightningcss-wasm` package through the Browser Package Replacement Catalog. The publisher lockfile remains unchanged, installation receipts preserve replacement provenance and logical identity, and Vite continues to import `lightningcss`; post-install rewrites, loader aliases, runtime package-name branches, and direct fixture substitution are forbidden.
