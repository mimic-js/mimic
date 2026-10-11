# File system layers: keeping the result of a step across reloads

**Snapshot:** 2026-10-04, `main` at e46c9cf0
**Question:** How can the result of an expensive step, such as installing packages, survive a page reload, by a general mechanism rather than one written for `node_modules`, and without filling the origin's storage when one origin runs many applications?

Nothing was implemented. The measurements used the public API and temporary test tooling on the Angular 22.1.0 fixture in Chromium.

## Recommendation

**Build Docker's build cache, not its overlay file system: a layer is the recorded difference a step made to the file system, stored under a key derived from the step's inputs, and applied instead of running the step when the key matches.**

- **Layer:** everything a step added or changed, plus the paths it removed. The runtime does not know what the step was.
- **Step:** any command the host runs: an install, a build, a checkout.
- **Key:** as in a Dockerfile, the parent step's key, the command and its environment, the contents of the input files the host declares, and the runtime version. The host declares the inputs; the runtime does not guess what a command reads.
- **Hit:** the layer is applied and the command does not run. **Miss:** the command runs, and if it exits with 0 its difference is stored.
- **The Virtual File System stays one mutable in-memory state.** Applying a layer copies its files in. This keeps [ADR-0022](../adr/0022-remove-vfs-transactions.md), which removed copy-on-write layers from the Virtual File System, and [ADR-0021](../adr/0021-reduce-package-management-to-a-pinned-cli-and-a-replacement-map.md): the Command Proxy still forwards without interpreting, because what is cached is a step, whatever it runs.

Keeping storage bounded, as BuildKit's cache does:

1. One budget for all layers; the least recently used layer is evicted whole. Applying a chain marks every layer in it as used.
2. Layers are stored by key, so two applications with the same inputs share one layer.
3. A versioned directory, with other versions removed on open, as the Compile Cache does.
4. A storage failure never fails a step: quota errors are swallowed and an oversized layer is not stored, as the Package Artifact Cache does.
5. The host can list layers with size and last use, delete one, clear all, and set the budget.

Lazily mounting layers from storage, the overlay half of Docker, is a separate and later decision. The format below keeps it possible.

## What it gives

After a page reload, with the Compile Cache and storage persisted. Medians of three runs; an independent run agreed within 5%.

| Way to get `node_modules` back | In place after | Reload until the application renders |
| --- | --- | --- |
| `npm ci` again | 10.3 s | about 18.8 s |
| Restore an archive of `node_modules` | 1.0–1.3 s | about 7.2–8.0 s |

`npm ci` here is a best case: tarballs are served from local disk. A real reinstall also downloads about 33 MiB unless the browser's HTTP cache still holds them. That cache is also why storing tarballs ourselves would add little: what a layer saves is the install work.

## What a layer contains

Recorded for three steps:

| Step | Where | Files | MiB |
| --- | --- | --- | --- |
| `npm ci` | `node_modules` | 17,842 | 173.6 |
| | npm's cache under the home directory | 589 | 33.0 |
| | `/.mimic` (toolchain, launchers, replacements) | 1,945 | 30.9 |
| `npm install <one package>` on top | `node_modules` | 20, and 1 removal | 0.3 |
| | `package.json`, `package-lock.json`, the hidden lockfile | 3 | 0.5 |
| | npm's cache | 11 | 1.2 |
| First `npm run start` until rendered, then stopped | `.angular/cache` | 9 | 3.4 |

- `npm ci` wrote 597 entries that it then removed; the second step 320. A layer must hold the net difference.
- The second step changes existing files and removes a path, so a layer needs changed files and removal markers, not only additions.
- A dev server stopped by a signal does not exit with 0, so its cache is not stored under the "exit 0" rule. A host that wants it needs a way to store the difference since a marker without a command, as `docker commit` does.

**What to leave out.**

- `/.mimic`: the Command Proxy recreates it from the Package Artifact Cache whenever a manager runs.
- Paths the host names. npm's cache is the case that matters: including it adds 33 MiB that do not compress, and in return `npm install` on a restored tree answers "up to date" in 1.6 s with no requests. Without it, npm retries optional dependencies that had failed; with the registry refused in the test that took 71 s. Docker keeps manager caches out of layers with cache mounts; the equivalent here is an exclusion list, and a shared persistent directory for such caches could come later.

## Recording a step

Two ways were prototyped:

| | Cost | Result |
| --- | --- | --- |
| Hook every commit and note each target path | 0.1 s over 78,847 commits, 4.4 MiB | Missed 439 entries: directories created implicitly and parents whose time changed |
| Compare the node map before and after | 10 ms for 23,485 entries | Found everything; temporary files drop out by construction |

The comparison is cheaper and correct, so it is the choice. It must also notice a file rewritten with the same size and time; a revision stamp on each node at its last change gives that without hashing. The commit journal cannot serve: it keeps 1,024 commits and the install made 78,847.

## Is an applied layer the same file system?

After a reload, with the project mounted and the layer applied, the whole file system was compared with the state right after the step (23,485 entries), then again for the chain of two layers:

- Paths, kinds, link targets, modes, sizes and content hashes: no difference. Executable bits survive, and the removal was applied. The tar and zip export lost them at the time of the measurement (7,656 files); the change that accompanies this note makes export and mount keep permission bits.
- One empty directory was missing, from the recorder that was later rejected.
- 475 modification times differ: the root directories created at boot, the project files mounted after the reload, and directories recreated implicitly.

## The layer format

For the `npm ci` layer (23,031 entries, 237.4 MiB of file data, cache and toolchain included), written to and read from the origin private file system in a worker:

| Format | Stored | Encode | Restore all | Read one file |
| --- | --- | --- | --- | --- |
| tar, one gzip stream | 79.4 MiB | 5.2 s | 0.58 s | 0.8–2.5 s |
| zip, deflate per file | 89–90 MiB | 6.5–9.7 s | 2.0–5.3 s | 12–58 ms |
| Index and independently gzip-compressed chunks of 1–4 MiB | 79.8 MiB | 4.1 s | 0.45–0.52 s | 11–29 ms |
| Uncompressed with an index | 240.1 MiB | 0.1 s | 0.05–0.13 s | 7–12 ms |

**Choice: an index and gzip chunks.** It stores the same bytes as one gzip stream, restores as fast, and reads a single file in milliseconds, which a later lazy mount needs. The index carries modes, sub-second times, link targets and removal markers as plain fields. Compression uses the browser's native stream.

A layer of `node_modules` alone compresses to about 36 MiB; with npm's cache, about 69 MiB.

## What storage allows

| Layout for the Angular tree | Write | Read |
| --- | --- | --- |
| One file | 0.04–0.37 s | 0.02–0.07 s |
| One file per package (309) | 0.54–0.58 s | 0.20–0.25 s |
| One file per installed file (18,055) | 20–37 s | 9.4–9.6 s |

Each stored entry costs 0.5–2 ms, so a layer is one file, never a mirrored tree.

- `navigator.storage.estimate()` reported a quota of about 10.9 GB. At a forced 300 MB quota, writes fail with `QuotaExceededError`.
- From documentation, not measured: Chromium and Firefox evict an origin's best-effort storage under disk pressure; Safari deletes script-written storage after seven days of browser use without interaction with the site (whether that covers the origin private file system was not verified). A layer is therefore a cache that may vanish, never the only copy of anything.

## Why layers and not a shared package store

Computed offline from the 46 tracked fixtures with an npm lockfile:

| Mix | Sum of packed bytes | Unique packed bytes |
| --- | --- | --- |
| 3 applications (Angular 22, React 19 + Vite 7, Vue 3 + Vite 8) | 46 MiB | 39 MiB |
| 10 applications | 109 MiB | 75 MiB |

Applications share bytes almost only when they are on the same toolchain version: Angular 21 and 22 share 18%, React 18 + Vite 6 and React 19 + Vite 8 share 1%. Deduplicating below the layer would save 21% for three applications and 37% for ten, and needs manifests, reference tracking and a restore that redoes the manager's linking. Docker shares whole layers only, for the same reason. The fixtures are deliberately version-diverse; a site whose users start from one template would share more, and would then also hit the same layer keys.

With a 256 MiB budget beside the Package Artifact Cache and the Compile Cache (256 MiB each), the ceiling is 768 MiB per origin, under 10% of the measured quota. 256 MiB holds about seven Angular-sized install layers, or three with npm's cache included.

## Lazy mounting, sized

What mounting a layer without copying it into memory would save:

- The installed tree costs about 208–241 MiB of buffer memory in the Runtime Host.
- Across a cold start, an HMR edit and a warm restart, processes read 9% of the files in `node_modules`, 23.5% of its bytes. The ahead-of-time compile walk, which only runs after an install, would read another 39% of the files; that figure is computed from its rule, not observed.

So a lazy mount would keep roughly half to three quarters of the tree out of memory and make a restore nearly instant. It needs layered lookup inside the Virtual File System, which ADR-0022 removed, so it would be a new decision with its own evidence.

## Not verified

- Applying a layer inside the Runtime Host end to end. The prototype pushed 237 MiB through a message channel and took 7 s; the host's own commit time was 0.44 s, and reading and decompressing took about 0.5 s, so about 1 s is an estimate.
- Format timings come from two runs, and the apply-and-compare from one.
- A reinstall and `npm install` on a restored tree with a real network.
- pnpm and Yarn, whose install state lives elsewhere.
- Tools started without the Command Proxy after a restore, when `/.mimic` is left out of the layer.
- Firefox and WebKit.
- A side observation: after a real `npm ci` the Runtime Host held 426 MiB of buffers, against 241 MiB for the same tree applied from a layer. The cause is unknown.
