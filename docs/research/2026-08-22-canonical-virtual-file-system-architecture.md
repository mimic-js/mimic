# A simpler canonical Virtual File System architecture

**Snapshot:** 2026-08-22
**Question:** Which established mechanisms preserve Mimic's maintained filesystem behavior with less custom authority, transaction, journal, cache, watcher, mailbox, archive, projection, and client-type machinery?

## Decision

Keep one **Virtual File System** deep module in the Runtime Supervisor, but reduce its implementation to one canonical inode/namespace state machine plus two pieces of authority-owned state: open file descriptions and a monotonically increasing change sequence. Everything else is either an adapter over that interface or a replaceable persistence/serialization mechanism below it.

The target interface should express semantic operations, not transports:

```text
lookup/stat/read/write/open/close/readdir/link/symlink/rename/remove
apply(batch, expectedVersions?) -> { sequence, changes }
subscribe(afterSequence) -> ordered changes | resync-required
```

This is a repo-specific recommendation inferred from current code and maintained tests, not a claim that Linux or Node exposes this exact interface.

## Why this is the smallest mechanism that holds

Linux's VFS distinguishes directory entries, inodes, and open file descriptions: multiple directory entries can point to one inode, while an opened file has its own state and is placed in a process descriptor table. Directory entries are an in-memory lookup cache, not another durable authority ([Linux VFS documentation](https://docs.kernel.org/filesystems/vfs.html)). Node deliberately exposes the same observable split: `node:fs` is modeled on POSIX, a `FileHandle` wraps a numeric descriptor, and synchronous, callback, and Promise forms share filesystem semantics ([Node `fs` documentation](https://nodejs.org/api/fs.html)). Mimic therefore needs the mechanism, but not Linux's full superblock, dentry-cache, page-cache, or mount-driver structure.

The current implementation already has the right center but repeats its state around it:

- `VirtualFileSystem` stores paths, inode identities, directory membership, bytes, symlinks, and timestamps. Hard links share a `FileContents` object ([source](https://github.com/mimic-js/mimic/blob/main/src/runtime/modules/virtual-file-system/virtual-file-system.ts)).
- Every ordinary commit clones the filesystem; the conflict index then walks a snapshot and maintains separate path, directory, and inode version maps. Opening a transaction clones those maps and another filesystem overlay ([authority](https://github.com/mimic-js/mimic/blob/main/src/runtime/modules/virtual-file-system/authority.ts), [conflict index](https://github.com/mimic-js/mimic/blob/main/src/runtime/modules/virtual-file-system/conflict-index.ts), [transaction](https://github.com/mimic-js/mimic/blob/main/src/runtime/modules/virtual-file-system/transaction.ts)).
- The bounded commit journal feeds both immutable client-cache invalidation and committed watches, but separate types and projection machinery describe these views ([client](https://github.com/mimic-js/mimic/blob/main/src/runtime/modules/virtual-file-system/client.ts), [watch projection](https://github.com/mimic-js/mimic/blob/main/src/runtime/modules/virtual-file-system/committed-watch.ts)).
- Node descriptor records currently retain paths and positions in the Node adapter. Canonically, the adapter should own descriptor numbers while the VFS owns open file descriptions referring to inode identity; otherwise rename or unlink can invalidate a still-open descriptor in a way POSIX-shaped callers do not expect ([current descriptor adapter](https://github.com/mimic-js/mimic/blob/main/src/runtime/modules/node-compatibility/filesystem-descriptors.ts)).

The maintained evidence requires POSIX-like inode/link/path behavior, Node-shaped descriptors and stats, atomic rename, isolated conflict-aware installation transactions, ordered committed watches, and bounded fail-stop synchronous access ([filesystem claim](https://github.com/mimic-js/mimic/blob/main/tests/e2e/mimic-filesystem.spec.ts), [transaction claim](https://github.com/mimic-js/mimic/blob/main/tests/e2e/mimic-vfs-transactions.spec.ts), [watch claim](https://github.com/mimic-js/mimic/blob/main/tests/e2e/mimic-vfs-committed-watches.spec.ts), [mailbox claim](https://github.com/mimic-js/mimic/blob/main/tests/e2e/mimic-vfs-mailbox.spec.ts)). It does not require the present internal decomposition.

## Canonical responsibilities

| Concern | Canonical owner and smallest mechanism | Decision on current machinery |
| --- | --- | --- |
| Authority | One Supervisor-owned VFS state machine; all mutations are serialized there and return one sequence plus semantic changes. | **Keep and deepen** `authority.ts` + `virtual-file-system.ts` into one implementation. `service.ts` should only bind transport. |
| Namespace and inodes | Directory inodes map names to inode IDs; an inode table stores kind, bytes/target/entries, metadata, link count, and last-change version. Path lookup follows directory entries and symlinks. | **Replace** the path-keyed node map and shared `FileContents` identity trick. Do not add dentries as a separate module or cache. |
| Handles and descriptors | VFS owns open file descriptions `{ inode, offset, flags, refs }`; each Execution Context's Node/WASI adapter owns only its descriptor-number table and maps numbers to authority handle IDs. | **Move** path-independent handle semantics out of `node-compatibility/filesystem-descriptors.ts`; keep Node flags, `FileHandle`, errors, streams, and descriptor numbers in Node Compatibility. WASI retains its own descriptor projection over the same VFS handles. |
| Mutations and revisions | One atomic `apply` path handles both a single mutation and a batch, increments a global sequence once, and emits the exact changed inode/directory-entry set. | **Merge** `commit`, direct mutation wrappers, invalidation synthesis, and transaction publication. Avoid cloning the full filesystem for an ordinary one-operation commit. |
| Transactions | A transaction is a private copy-on-write overlay plus a read/write version set. Validate only touched inode and directory-entry versions, then pass its operation batch through the same `apply`. Fence it by owning Runtime Process. | **Keep the maintained behavior; delete** full-tree snapshots and the standalone three-map `conflict-index.ts`. A global-revision compare is too small because the maintained claim explicitly permits unrelated commits. |
| Watchers | The authority emits ordered semantic changes after each successful apply. Node Compatibility maps them to Node's deliberately platform-dependent `rename`/`change` interface. `watchFile` remains a Node adapter that compares stats. | **Merge** committed-watch and cache-invalidations into one bounded change feed. Node documents `fs.watch` as platform-dependent and `watchFile` as stat polling, so stronger VFS-specific event types are unnecessary ([Node watches](https://nodejs.org/api/fs.html#fswatchfilename-options-listener)). |
| Client caches and snapshots | A client may cache immutable read results tagged with the authority sequence. It consumes the same bounded change feed; on a gap it drops the cache. The cache is optional optimization, never an interface obligation. | **Delete** cache-specific authority concepts and names. Keep only `afterSequence -> changes | resync-required`. Do not ship a startup tree snapshot. |
| Async and sync access | One semantic handler executes all operations. Async RPC and the SharedArrayBuffer mailbox are transport adapters that encode the same request/result union. | **Keep both transports** because Node exposes synchronous and asynchronous forms and a worker cannot turn Promise I/O into a synchronous return. **Merge** duplicated operation/result codecs where practical; keep mailbox bounds, cancellation, epoch failure, fairness, and watchdog behavior. |
| Worker boundary | VFS protocol belongs to VFS; Worker Transport carries it. The Supervisor remains the only mutable realm. Execution Contexts hold handle IDs, cache entries, and adapter state, not filesystem state. | **Keep** the ADR-0003 seam; **collapse** relay/client variants that merely forward the same protocol once callers migrate. |
| Persistence | None in the maintained runtime today: reboot evidence expects an empty new epoch. If persistence becomes a claim, add one storage adapter that serializes/restores canonical inode state at the authority seam. | **Do not add** IndexedDB/OPFS now. OPFS is origin-private, quota-bound, cleared with site data, and offers synchronous file access only through `FileSystemSyncAccessHandle` in dedicated workers; the handle exclusively locks one file ([File System Standard](https://fs.spec.whatwg.org/#api-filesystemsyncaccesshandle), [MDN OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)). It does not supply Node inode, hard-link, symlink, or watch semantics for free. |
| Archives | ZIP/TAR/tree import and export are serialization adapters that convert to/from an atomic mutation batch. ZIP-as-filesystem is a read-only mount adapter selected explicitly by installation/module resolution, not an implicit `.zip/` pathname branch in namespace lookup. | **Move out of the authority implementation** while retaining public archive behavior and the installed `fflate`. Keep only codecs proven by archive and Yarn ZipFS claims. |
| Public/Node/WASI projections | Public `runtime.fs`, Node `fs`, and WASI expose their own errors, value shapes, lifecycle, and descriptor conventions over the VFS interface. | **Keep adapters; delete** VFS-owned Node-like `Stats`/`Dirent` behavior and redundant tier-specific client interfaces where structural subsets suffice. |

## Irreducible browser and Node machinery

The following complexity is earned by observable behavior or realm constraints:

1. **Inode identity separate from names.** Hard links and stable `Stats.ino` require it; Linux explicitly permits multiple dentries to reference one inode ([Linux VFS](https://docs.kernel.org/filesystems/vfs.html#the-inode-object)).
2. **Open file descriptions separate from descriptor numbers.** Offsets, flags, close lifecycle, and rename/unlink survival belong here; Linux calls the file object an open file description and stores it in the process descriptor table ([Linux VFS file object](https://docs.kernel.org/filesystems/vfs.html#the-file-object)).
3. **One synchronous cross-realm bridge.** Node's sync forms are observable, while ordinary browser storage and messaging are asynchronous. OPFS sync access is worker-only and file-exclusive, so it cannot replace the runtime-wide VFS protocol ([File System Standard](https://fs.spec.whatwg.org/#filesystemsyncaccesshandle)).
4. **Atomic package-install batches with conflict detection.** The maintained transaction claim requires isolation, no partial publication, unrelated-commit tolerance, and abnormal-exit fencing. This is more than Node promises generally: Node warns that Promise filesystem operations are not synchronized or threadsafe ([Node promises API](https://nodejs.org/api/fs.html#promises-api)).
5. **A bounded ordered change feed.** Cross-worker caches and watches need one recovery cursor. Bounded history plus explicit resync is the minimal fail-closed form; unbounded journals and mutable replicas are unnecessary.
6. **Node-shaped adapters.** Node error codes, callbacks, `Stats`, `Dirent`, streams, `FileHandle`, and watch quirks do not belong in the VFS authority, but compatibility requires them at the Node seam.

## What established browser runtimes do and do not buy us

Emscripten's default `MEMFS` is an in-memory synchronous filesystem, while persistence and worker-facing filesystems are optional mounts; its documentation explicitly notes the mismatch between synchronous compiled-code I/O and asynchronous browser persistence ([Emscripten Filesystem API](https://emscripten.org/docs/api_reference/Filesystem-API.html)). That validates memory-first authority with optional backing, but adopting Emscripten FS would not remove Mimic's Node adapters, Supervisor protocol, transaction semantics, committed watches, or package ZipFS behavior. No installed dependency owns the whole required responsibility, so adding one would create a wrapper rather than a deeper module.

OPFS is useful later as a byte-storage adapter, especially from the Supervisor worker, but its native hierarchy is not the canonical Mimic namespace: relying on it directly would couple authority to browser persistence availability and still require a metadata database for hard links, symlinks, Node inode identity, transactions, and watches. The present maintained evidence instead proves ephemeral authority.

## Deletion and naming candidates

These are target-architecture candidates, not implementation edits in this research ticket:

- Delete `conflict-index.ts` after inode and directory-entry versions live beside canonical state.
- Replace `VfsCommitJournal`, `VfsCommitInvalidation`, `CommittedWatch`, and cache-specific revision terms with one **VFS Change Feed**, one **VFS Sequence**, and semantic changes.
- Merge ordinary `commit` and transaction commit behind `apply`; a single operation is a one-item batch.
- Keep **VFS Transaction** only because a maintained claim and Package Installation caller exist. Do not generalize it into MVCC or a public transaction facility.
- Rename internal `FileContents` to **File Inode** and directory membership to **Directory Entries**. Avoid a separate **dentry cache**: Mimic has no backing filesystem lookup whose cache miss it would hide.
- Rename authority-side descriptor state **Open File Description**; reserve **File Descriptor** for per-context Node/WASI integer projections.
- Move archive codecs and explicit read-only ZIP mounting behind serialization/mount adapters; delete suffix-driven ZIP lookup from the namespace core after the Yarn ZipFS caller uses the explicit adapter.
- Collapse `AsyncVirtualFileSystemClient`, `ExecutionContextVirtualFileSystemClient`, transaction client, relay, and synchronous client surface duplication toward generated/structural views of one operation set. Preserve two transports, not two semantics.

## Verification and decision boundary

This recommendation was checked against the current VFS implementation and its direct Runtime Supervisor, Execution Context, Node Compatibility, Module Execution Engine, Shell Program, WASI, Package Installation, public filesystem, and maintained-test callers. It preserves every behavior named by the four focused maintained VFS claims and the archive/ZipFS callers, while treating reboot persistence, public transactions, general mount plugins, full POSIX permissions, device nodes, and operating-system page/dentry caches as unclaimed and therefore out of scope.

Before implementation tickets are cut, one focused compatibility gap should be made explicit: the current Node descriptor adapter stores a path, so maintained evidence should decide descriptor behavior across rename/unlink before moving handles into the authority. Linux/Node prior art strongly indicates inode-backed open descriptions, but the exact Mimic claim is not presently asserted by the focused filesystem test.
