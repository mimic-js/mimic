---
status: accepted
---

# Keep Exact Graph evidence additive

After the one-time Node `22.22.3` Runtime Platform Profile migration adds the previously omitted Node identity and rebaselines every existing positive claim without changing its fixture or lockfile, each Exact Graph, fixture, reviewed lockfile, and positive Compatibility Claim remains unchanged and required on every pull request indefinitely. Testing another package version or profile adds a new Exact Graph and claim rather than refreshing, superseding, archiving, or removing the existing evidence; this deliberately trades an ever-growing, parallel-sharded required matrix for an explicit cumulative support contract and immutable proof history.

Every maintained Exact Graph execution begins from a fresh project workspace without `node_modules` or a project installation snapshot and performs the graph's frozen upstream package-manager install before running its behavioral suite. The ignored Playwright Tarball Cache may reuse integrity-addressed publisher downloads, but shared installed trees, lockfile mutation, and cached package-manager resolution are not compatibility evidence. Nightly validation repeats the complete matrix for external drift but is not the first regression gate.
