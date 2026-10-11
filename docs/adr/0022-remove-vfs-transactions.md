---
status: accepted
amends: ADR-0015 (Virtual File System responsibilities)
---

# Remove VFS Transactions

A VFS Transaction staged a set of filesystem reads and mutations in an
isolated overlay and published them as one commit after checking the versions
it had observed. Its one production caller was the package-manager Command
Proxy, which ran each install in a transaction so that a failed install left
the tree untouched. ADR-0021 removed that: the Command Proxy runs the pinned
CLI against the Virtual File System directly, and a failed or cancelled install
leaves what the manager wrote, as on any machine. Transactions had no
production caller left (issue #673).

They still cost: `transaction.ts` (468 lines); a transaction-scoped authority
adapter in the service and an "authority, transaction or unavailable" branch
in every handler; a leading `transactionId | undefined` parameter on every
`VirtualFileSystemApi` method; a transaction client with a scoped proxy for
nested contexts; transaction-scoped synchronous mailboxes for child processes;
an `executionFileSystem` that the Runtime Host threaded through every program
context, child spawn, executable resolution and process worker; a release hook
that rolled back a killed process's transactions; and, inside the Virtual File
System, copy-on-write layers, pins, compaction, a `clone`/`absorb` pair and
per-path, per-directory-entry and per-inode versions used only to detect
conflicts.

## Decision

- **The Virtual File System keeps one mutable state.** One map of namespace
  paths to nodes and one map of inodes; a commit changes them in place. There
  are no copy-on-write layers, pins, compaction or clones, and nodes and inodes
  carry no versions.
- **A commit is still all or nothing.** While a commit applies, the Virtual
  File System records each entry it replaces and each node field it changes in
  place; a rejected commit restores them, newest first, and the record is
  dropped when the commit ends. It is not history and is never read by anything
  else. Its caller is `mount` (`Mimic` `fs.mount` and archive
  mounts): a tree that meets a conflicting entry part way, such as a directory
  where a file exists, is rejected without leaving the entries before it
  (issue #619). It also keeps a multi-operation commit request atomic, which the
  asynchronous client and the mailbox protocol still accept.
- **The revision and the VFS Commit Journal stay.** They never depended on
  transactions: the journal's invalidations drive committed watches
  (`watchCommitted`, `node:fs` watch), `waitForCommitJournal` and
  `cancelCommitJournalWait`, and the revision is the cursor the synchronous
  mailbox clients compare their caches against.
- **One authority, one branch.** `VirtualFileSystemApi` methods take only their
  own arguments; `openTransaction`, `commitTransaction` and
  `rollbackTransaction` are gone, and so is the asynchronous client's
  `openTransaction`, its scoped `api` and its `workdir` argument. The mailbox
  host serves the one authority, so every mailbox reads the committed state.
- **Runtime Programs and process workers see the committed state.** Program
  contexts have no `executionFileSystem`; Process Execution resolves every
  command in the one executable filesystem view; process workers call the
  served Virtual File System directly; `runtimeProcessTransactionOwner` and
  Process Execution's `onProcessReleased` option are gone, as is the
  `workdir` field of the process start message.

## Install time

`npm ci` of the tracked `vanilla-vite-6.4.3` graph,
`tests/e2e/mimic-main-thread-responsiveness.spec.ts`
(`installMs`), Chromium, one worker, two batches of five on each tree, run
alternately. The first run of the second batch on each tree is excluded: Vite
re-optimized its dependencies after the other tree had served (11,840 ms
before, 7,119 ms after).

| Tree | Runs (ms) | Median | Mean |
| --- | --- | --- | --- |
| Before (`faf418d8`) | 5,495 · 4,865 · 5,401 · 4,757 · 5,162 · 4,778 · 5,759 · 5,064 · 4,842 | 5,064 | 5,125 |
| After | 5,624 · 4,820 · 4,766 · 4,664 · 4,851 · 5,037 · 5,238 · 4,852 · 5,064 | 4,852 | 4,991 |

The difference (4 % in the median, 3 % in the mean) is inside the run-to-run
spread of several hundred milliseconds, most of it registry fetches. Since
ADR-0021 no install ran inside a transaction, so its per-write cache clearing
and whole-file rewrites were already off the install path; what remains is a
plain map lookup where a layer lookup also checked a deleted-key set. The
longest main-thread task stayed at 2 to 4 ms on both trees.

## Consequences

- The `vfs-conflict-aware-transactions-v1` claim
  (`mimic-vfs-transactions.spec.ts`) and the transaction unit tests
  are deleted. Commit atomicity, the journal, watches, appends and mailboxes
  keep their tests (`tests/unit/virtual-file-system-commits.test.ts`,
  `tests/unit/virtual-file-system.test.ts`).
- Concurrent writers are not isolated from each other: two processes writing
  the same files interleave their commits, as on a machine.
- A failed or cancelled install leaves a partial tree; npm, pnpm and Yarn
  repair it on the next install, as they do anywhere else.
