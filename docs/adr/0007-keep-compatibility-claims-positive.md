---
status: accepted
---

# Keep compatibility claims positive

Mimic Compatibility Claims prove successful supported behavior; a maintained test must not pass by accepting a workload's first compatibility failure. Unsupported workloads and precise failure reproductions remain useful in GitHub Issues and during implementation, but they do not belong in the Compatibility Evidence Matrix until the runtime can satisfy a positive claim.

This does not prohibit tests for specified error semantics such as rejecting an invalid API call: those tests positively prove the error contract itself. The rejected alternative was retaining accepted-failure claims as executable frontier documentation, because their green test result is too easily mistaken for supported compatibility and permits incomplete workflows to survive cumulative verification.

An optional platform package may remain unmaterialized when the upstream workload
provides a useful generic fallback. Evidence must prove the successful workload
through that fallback; merely asserting that the optional package is absent is not
a Compatibility Claim. For example, Vite development and HMR may omit `fsevents`
only when the positive browser-level scenarios prove that its Chokidar path falls
back to Mimic's `fs.watch` behavior and still completes initial render,
update, and teardown.
