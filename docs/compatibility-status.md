# Compatibility evidence

Mimic does not keep a Markdown scoreboard of what works. Its compatibility is
whatever the maintained co-located Playwright Compatibility Claims under
`packages/runtime/tests/e2e/` prove, and their latest CI results are the
current status. This page states the contract every such claim follows.

## Evidence contract

- Each maintained claim is declared in its `tests/e2e/*.spec.ts` file with a
  stable identity, a human-readable statement, and an Exact Graph or Runtime
  Capability target.
- Every registry-backed Exact Graph mounts a reviewed Tracked Compatibility
  Lockfile and runs its selected package manager in frozen or immutable mode
  through the canonical `tests/e2e/compatibility-test.ts` fixture.
- A claim about a stack rather than about installation may mount the Install
  Layer of its Exact Graph in place of the install, through the same fixture.
  Claims about installing, or about what an install selects or replaces,
  never do, and the nightly run sets
  `COMPATIBILITY_INSTALL_LAYERS=0`, so every frozen install is still proved
  once a day.
- Every maintained claim must prove positively supported behavior. A failed or
  otherwise non-positive outcome is not compatibility evidence. Unsupported
  workloads and observed compatibility failures are tracked as issues until
  the runtime can satisfy a positive claim; an accepted workload failure is
  not compatibility evidence
  ([ADR-0007](./adr/0007-keep-compatibility-claims-positive.md)).
- Tests for specified error semantics remain valid when the error itself is the
  supported Runtime Capability being asserted.
- An omitted optional platform package is acceptable only when a positive claim
  proves the workload's useful fallback behavior. Package absence by itself is
  not compatibility evidence.
- Compatibility registries, persisted compatibility receipts, custom
  evaluators, generated projections, and manually updated Pass/Partial tables
  are not evidence authorities.

Use the relevant co-located claim for the executable contract and GitHub
Actions for the latest run result. Historical research under `docs/research/`
remains a dated snapshot and must not be read as current status.
