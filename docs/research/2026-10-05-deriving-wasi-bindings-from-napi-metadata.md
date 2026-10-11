# Native dependencies: derive the WASI binding from `napi` metadata, keep a name-only map for the rest

**Snapshot:** 2026-10-05, `main` at 9093fb5
**Question:** Can the Browser Package Replacements (ADR-0021, four hand-written entries) be replaced by something the runtime derives on its own, and if a map must stay, how small can an entry be and which packages belong in it?

Implemented by [ADR-0028](../adr/0028-install-wasi-bindings-as-companions-from-napi-metadata.md), with `tests/e2e/mimic-napi-companion.spec.ts` as its evidence; the candidates in the tables below remain unproven. The findings come from the runtime source, the maintained e2e claims, the npm registry's metadata, and the published loaders of 30 packages unpacked from their registry tarballs (listed under Sources). Registry facts are as of this date.

## Recommendation

**Add one generic, metadata-driven mechanism, the napi companion, and shrink the hand-written map to package-name pairs.**

1. **napi companion (no map).** A package built with NAPI-RS carries a `napi` field in its `package.json`. When `napi.targets` names a `wasm32-wasi*` target, the publisher has published the WASI binding as `${napi.packageName ?? name}-wasm32-wasi` at the same version, and the package's own loader already tries to `require` it. After an install, for every installed package whose `napi.targets` has such a target, make that companion resolvable from the package when it is not already. No package name appears in runtime code. This is the rule `napi-postinstall` (the helper `unrs-resolver` ships) applies in WebContainers, moved into the Command Proxy where it runs once per install instead of at every `require`.
2. **Why now.** Publishers have stopped listing the WASI binding in `optionalDependencies`, which is the only thing that made npm install it for `cpu: wasm32` by itself. `rolldown` listed it through 1.2.1 and dropped it in 1.2.2; current Vite 8.3.2 pins `rolldown ~1.2.11` and current `@angular/build` 22.2.1 pins 1.2.8. `oxc-parser`, `oxc-transform`, `oxc-minify`, every `@node-rs/*` and most `@napi-rs/*` packages never listed it. On this runtime these packages fail with "Cannot find native binding" although the binding exists on the registry.
3. **Name-only map for siblings without a metadata link.** `rollup → @rollup/wasm-node`, `lightningcss → lightningcss-wasm`, `@parcel/watcher → @parcel/watcher-wasm` have no field connecting them; npm has no standard for it (confirmed again, see the 2026-06-16 note). Keep them as pairs and drop the `range` field: the range is "a version of the replacement is published in the same major line", which the registry answers.
4. **esbuild stays the one executable entry.** `ESBUILD_BINARY_PATH` and `--service=<version>` are facts about esbuild that no metadata exposes. The alternative, treating esbuild as a package-contents replacement by `esbuild-wasm`, removes the kind but runs Go's `wasm_exec` under a Node child process for every call; `@esbuild/wasi-preview1` is the faster artifact (ADR-0004).
5. **Do not change the platform identity and do not set `process.versions.webcontainer`.** Impersonating WebContainers would trigger the packages' own fallbacks, which shell out to `pnpm` into `/tmp` at `require` time (rolldown, Rspack), and gains nothing the companion rule does not give. ADR-0016 stands.

## What the runtime does today

`browser-package-replacements.ts` holds four entries. After a manager invocation that changed its install state, the Command Proxy walks `node_modules` (npm, pnpm `.pnpm`, Yarn node-modules linker, symlinked workspaces) and:

- `package-contents` (`rollup >=4 <5`, `lightningcss >=1 <2`, `@parcel/watcher >=2.3 <3`): removes the installed files and mounts the same-version replacement tarball, or the nearest published version; bundled dependencies the manager pruned are put back.
- `executable` (`esbuild`): the managers run with `ESBUILD_BINARY_PATH=/.mimic/bin/esbuild`, a launcher that materializes `@esbuild/wasi-preview1` of the calling version and replaces itself with it; an esbuild older than 0.22.0 is swapped for 0.22.0 after the install.

What works with no entry, because the runtime reports `process.arch === 'wasm32'`:

| Package | Why it works | Evidence |
| --- | --- | --- |
| `rolldown` 1.0.0-rc.4, 1.1.5, 1.2.0 | lists `@rolldown/binding-wasm32-wasi` (`cpu: ["wasm32"]`) in `optionalDependencies`; npm installs it; the loader finds it | `tests/e2e/mimic-rolldown-wasi.spec.ts` |
| `oxc-parser` 0.139.0, 0.142.0 | same | `mimic-oxc-parser-wasi.spec.ts` |
| `@rspack/binding` 2.1.3 | same | `mimic-rspack-wasi.spec.ts` |
| `nx` | ships `nx.wasi.cjs` and `nx.wasm32-wasi.wasm` inside the `nx` package; the loader tries them before any sibling | stack scenarios |

## Finding 1: a NAPI-RS loader tries the WASI binding whenever the native one is missing

The loader NAPI-RS generates (`binding.js`, `index.js` or `src-js/bindings.js`, read from `@tailwindcss/oxide` 4.3.3, `rolldown` 1.2.0 and 1.2.12, `@rspack/binding` 2.2.8, `oxc-parser` 0.153.0, `@node-rs/argon2` 2.2.1, `unrs-resolver` 1.12.2, `nx` 23.2.1, `@swc/core` 1.16.13) runs in this order:

1. `NAPI_RS_NATIVE_LIBRARY_PATH`, then a `switch` on `process.platform`; an unknown platform such as `browser` pushes `Unsupported OS` into `loadErrors` and continues.
2. `if (!nativeBinding || NAPI_RS_FORCE_WASI)`: `require('./<binaryName>.wasi.cjs')` (a binding bundled in the package, as `nx` does), then `require('<packageName>-wasm32-wasi')`. The newest template (oxc-parser 0.153.0) also tries `./<binaryName>.wasip1.cjs` and `<packageName>-wasm32-wasip1`, a single-threaded variant.
3. Only if nothing loaded and `process.versions.webcontainer` is set: a `webcontainer-fallback.cjs` that runs `pnpm i <packageName>-wasm32-wasi@<version>` into `/tmp/<name>-<version>` and requires it from there. `unrs-resolver` delegates this step to `napi-postinstall/fallback`, which runs `npm install --cpu=wasm32 --force` instead.
4. Otherwise it throws `Cannot find native binding`.

So no environment variable and no `webcontainer` key are needed: the WASI binding is loaded as soon as it is resolvable from the package. The only thing the runtime has to provide is the package.

## Finding 2: the WASI binding is leaving `optionalDependencies`

Registry metadata of the latest versions:

| Package | Latest | `napi.targets` has `wasm32-wasi*` | `<derived>-wasm32-wasi` published at that version | listed in `optionalDependencies` |
| --- | --- | --- | --- | --- |
| `rolldown` | 1.2.12 | yes (`wasm32-wasip1-threads`) | yes | **no** (last listed: 1.2.1) |
| `oxc-parser` | 0.153.0 | yes | yes | **no** |
| `oxc-transform` | 0.153.0 | yes | yes | **no** |
| `oxc-minify` | 0.153.0 | yes | yes | **no** |
| `oxc-resolver` | 11.24.2 | yes | yes | yes |
| `@oxc-node/core` | 0.1.3 | yes | yes | **no** |
| `@rspack/binding` | 2.2.8 | no (`napi.targets` omits it; the loader still names the binding) | yes | yes |
| `@rspack/resolver` | 0.6.0 | yes | yes | yes |
| `@tailwindcss/oxide` | 4.3.3 | yes | yes | yes |
| `unrs-resolver` | 1.12.2 | yes | yes | yes |
| `@node-rs/argon2`, `bcrypt`, `crc32`, `jieba`, `jsonwebtoken`, `xxhash` | current | yes | yes (6/6) | **no** |
| `@napi-rs/image`, `lzma`, `tar`, `pinyin`, `ed25519`, `woff-build`, `wasm-tools` | current | yes | yes (7/7) | only `lzma`, `tar`, `ed25519`, `woff-build`, `wasm-tools` |
| `snappy` 7.4.3 (`napi.packageName: @napi-rs/snappy`) | 7.4.3 | yes | yes | **no** |
| `@solidjs/compiler`, `@dom-expressions/compiler`, `@pandacss/compiler`, `@plumeria/compiler`, `@csslit/transform`, `@vue-jsx-vapor/compiler-rs`, `@svg-rs/svgo`, `@gorules/zen-engine`, `@toeverything/file-type`, `fast-magic-string`, `lightningdts` | current | yes | yes (11/11) | mixed |

Who pins what today: `vite@8.3.2` depends on `rolldown ~1.2.11`, `@angular/build@22.2.1` on `rolldown 1.2.8`. Both land on versions without the optional dependency, so a fresh `npm ci` of a current Vite 8 or Angular 22.2 project installs no rolldown binding at all here. The maintained claims pin 1.0.0-rc.4, 1.1.5 and 1.2.0, which is why they still pass.

## Finding 3: the companion name derives from `napi` metadata, 32 of 32 times

Rule: `companion = (napi.packageName ?? name) + '-wasm32-wasi'`, at the source package's exact version. Checked against the registry for the 32 packages above whose `napi.targets` includes a `wasm32-wasi*` target: every derived name is published at that version. `napi.packageName` is set when the binding packages live in another scope (`rolldown → @rolldown/binding`, `unrs-resolver → @unrs/resolver-binding`, `snappy → @napi-rs/snappy`); when it is absent the NAPI-RS CLI uses the package's own name, which the 23 unscoped cases confirm.

Negative controls: `@swc/core` (`napi.targets` has no wasm32 entry; `@swc/core-wasm32-wasi` does not exist), `nx` (`@nx/nx-wasm32-wasi` does not exist; the binding is bundled instead), `oxlint` (`@oxlint/binding-wasm32-wasi` does not exist), `@napi-rs/canvas`, `@resvg/resvg-js`, `@parcel/rust`, `@biomejs/biome` (no wasm32 target). The rule correctly does nothing for all of them.

What a companion brings: the binding package depends on `@napi-rs/wasm-runtime`, `@emnapi/core`, `@emnapi/runtime`, and in some versions `@tybys/wasm-util`, `@emnapi/wasi-threads`, `tslib`. None of these are in a project's lockfile when the binding was not an optional dependency, so the companion is a small dependency graph, not one tarball.

## Design of the napi companion

Where it runs: in `applyBrowserPackageReplacements`, which already walks every installed package after a state-changing install. The walk reads each `package.json`; the new check is `napi.targets?.some(t => t.startsWith('wasm32-wasi'))`.

What it does for a match whose companion is not already resolvable from the package directory:

1. Materialize `companion@version` with its dependencies once per version under `/.mimic/replacements/napi/<companion>/<version>/`, by running the pinned npm as a child Runtime Process: `npm install --no-save --no-package-lock --ignore-scripts --cpu=wasm32 <companion>@<version>` in that directory. This reuses the manager's resolver and fetcher (ADR-0021: no second solver in the runtime) and is what `napi-postinstall` and `@swc/core`'s own postinstall do. npm's tarball bytes land in npm's cache in the Virtual File System, not in the Package Artifact Cache; this is acceptable for a first slice, and `--cache /.mimic/npm-cache` keeps it in one place.
2. Create the symlink `<package dir>/node_modules/<companion>` → the materialized directory. Resolution from the package finds it first; the companion's own dependencies resolve from its real path; one materialization serves every installed copy (nested, in `.pnpm`, in workspaces).
3. A manager prunes a nested `node_modules` it did not create on the next install; the Command Proxy re-applies after every state change, as it does for package-contents replacements today, and recreating a symlink is cheap.

What it does not do:

- **No nearest-version fallback.** The binding and the JavaScript glue are generated together; a different version is an ABI mismatch, and the loader's own version check (`NAPI_RS_ENFORCE_VERSION_CHECK`) exists because of it. When the exact version is unpublished, report it on stderr the way Plug'n'Play is reported today and leave the package alone.
- **No `process.versions.webcontainer`, no `NAPI_RS_FORCE_WASI`.** Both are unnecessary once the companion resolves (Finding 1).
- **Prefer `-wasm32-wasi` over `-wasm32-wasip1`.** The threaded variant is what the maintained claims execute; the single-threaded one is a second candidate for a package that publishes only it.
- Yarn Plug'n'Play: packages stay in archives; keep the existing stderr statement.

Subsumes the current zero-entry case: when the binding was installed as an optional dependency it is already resolvable, and the rule does nothing.

## The map that remains, and how small an entry can be

| Entry | Replacement | Replacement published for | Why a name pair is unavoidable | Fields that can go |
| --- | --- | --- | --- | --- |
| `rollup` | `@rollup/wasm-node` | 4.0.0 … 4.64.0 (212 versions) | rollup's `native.js` requires `@rollup/rollup-<platform>-<arch>` and knows no wasm sibling | `range`: replace when the replacement is published in the same major line, else nearest in that line, else leave installed |
| `lightningcss` | `lightningcss-wasm` | 1.14.0 … 1.33.0 | loader builds `lightningcss-<platform>-<arch>`; `CSS_TRANSFORMER_WASM` points at a dev-only `../pkg` | `range` |
| `@parcel/watcher` | `@parcel/watcher-wasm` | 2.3.0 … 2.6.0 | loader builds `@parcel/watcher-<platform>-<arch>` | `range` |
| `esbuild` | `@esbuild/wasi-preview1` | 0.22.0 … 0.28.2 | binary path through `ESBUILD_BINARY_PATH`, version through `--service=` | none; keep the executable kind |

Candidates that need a browser proof before admission (ADR-0007: positive claims only):

| Source | Candidate | Mechanism | What is known | What must be proven |
| --- | --- | --- | --- | --- |
| `@swc/core` (via `@vitejs/plugin-react-swc`, Next) | `@swc/wasm` same version (816 versions, aligned) | upstream's own: `index.js` falls back to `require('@swc/wasm')`; `postinstall.js` runs `npm install --no-save @swc/wasm@<version>` under `INIT_CWD/node_modules` when `./binding.js` fails | may already work with no entry | that the postinstall's `npm install` succeeds in a child process here (`INIT_CWD` under npm; pnpm sets it too), and the API subset plugin-react-swc uses; if it fails, a `companion` entry `@swc/core → @swc/wasm` resolvable from the source |
| `sharp` | `@img/sharp-wasm32` same version | npm installs `@img/sharp-webcontainers-wasm32` (`cpu: wasm32`), which depends on `@img/sharp-wasm32`; `sharp.cjs` ends with `require('@img/sharp-wasm32/sharp.node')`, which `exports` maps to `index.cjs`, an emscripten/emnapi JavaScript module, so the runtime's `.node` handler is never reached | plausibly works with no entry | emnapi runtime support, worker threads, and sharp's documented WASM limits (single-threaded, no text rendering, no tiles) |
| `sass-embedded` (Vite, Angular list it optionally next to `sass`) | `sass` same version (1.x aligned) | same JavaScript API | `sass` depends on `chokidar` and `source-map-js`, which `sass-embedded` does not: a package-contents replacement would lack them; needs the companion-style side install, aliased under the source name | that an alias is acceptable to consumers reading `package.json#name`; in practice Vite and Angular already prefer `sass` when both are installed, so the value is low |
| `next` | `@next/swc-wasm-nodejs` same version | Next's `loadWasm` falls back to it and can download it itself | unverified | a Next claim, out of scope here |

Not replaceable today (surveyed; keep out of the map, document the failure):

| Class | Packages | Why |
| --- | --- | --- |
| napi-rs without a wasm32 target | `@napi-rs/canvas`, `@resvg/resvg-js` (`@resvg/resvg-wasm` has another API), `@parcel/rust`, `@swc/html`, `@swc/css`, `node-datachannel` | publisher ships no WASI build |
| CLI binaries | `@biomejs/biome` (`@biomejs/wasm-nodejs` is a library), `oxlint`, `turbo`, `@vscode/ripgrep`, `@prisma/engines` | no WASI executable published |
| node-gyp / prebuild addons | `better-sqlite3`, `sqlite3`, `bcrypt`, `argon2`, `canvas`, `node-pty`, `lmdb` (Angular's cache; it degrades without it), `classic-level`, `re2`, `keytar`, `isolated-vm`, `sodium-native`, `@mongodb-js/zstd`, `kerberos`, `@discordjs/opus`, `serialport`, `usb`, `@tensorflow/tfjs-node`, `onnxruntime-node`, `@sentry/profiling-node` | `.node` is machine code; API-different alternatives exist (`node:sqlite` from ADR-0017, `bcryptjs`, `hash-wasm`, `onnxruntime-web`) but are not drop-ins and would be runtime package-name dispatch |
| optional accelerators with a JavaScript fallback | `bufferutil`, `utf-8-validate`, `cpu-features`, `msgpackr-extract`, `cbor-extract`, `@napi-rs/nice`, `fsevents` (`os: darwin`, never installed) | nothing to do; their consumers catch the load failure |

## On the reported identity

`process.platform === 'browser'`, `process.arch === 'wasm32'` (ADR-0016). WebContainers report `linux`/`wasm32` with `process.versions.webcontainer` set, which is visible in sharp's `case "linux-wasm32"` and in `@img/sharp-webcontainers-wasm32`. Reasons not to follow:

- sharp's `linux-wasm32` branch only re-exports `@img/sharp-wasm32/sharp.node`, which the unconditional last fallback already reaches from `browser-wasm32`.
- The NAPI-RS `webcontainer-fallback.cjs` shells out to `pnpm i` into `/tmp`; pnpm cannot fetch here (ADR-0021 consequences), so impersonation would turn a clear "binding missing" into a slow failure inside `require`. `napi-postinstall`'s variant uses npm and would work, but it does per-process what the Command Proxy can do once per install.
- `linux` makes `detect-libc` run `ldd`, and biome's `bin` would try to spawn `@biomejs/cli-linux-x64/biome`.

## Proposed shape

```ts
type BrowserPackageReplacement =
  | { kind: 'package-contents'; source: string; replacement: string }   // rollup, lightningcss, @parcel/watcher
  | { kind: 'companion'; source: string; companion: string }            // candidates such as @swc/core → @swc/wasm
  | { kind: 'executable'; source: 'esbuild'; /* unchanged */ };
// plus the rule-based napi companion, which has no entries.
```

`package-contents` keeps the current version logic minus `range`. `companion` is the same side install and symlink the napi rule performs, with the name supplied instead of derived; it also covers a future sibling whose dependencies the source lacks.

## Evidence to produce (in order)

1. **Rolldown 1.2.12 Exact Graph** (Vite 8.3.2 or `@angular/build` 22.2.1): `npm ci` installs no rolldown binding; after the companion, `rolldown` parses through `@rolldown/binding-wasm32-wasi@1.2.12`; `npm install` of an added package keeps it working. This is the slice that fixes current Vite 8 and Angular.
2. **oxc-parser 0.153.0** and **`@node-rs/argon2` 2.2.1**: two publishers, one with `napi.packageName`, one without, both never in `optionalDependencies`.
3. **Negative guard**: `@swc/core` and `nx` receive no companion.
4. **Field removal**: the three package-contents claims pass with `range` gone.
5. Only then the candidates: `@swc/core` through `@vitejs/plugin-react-swc`, then `sharp`.

## Sources

Runtime: `packages/runtime/src/runtime/modules/process-execution/package-manager/browser-package-replacements.ts`, `package-manager-command-proxies.ts`, `node-compatibility/process.ts` (`RUNTIME_VERSIONS`, `dlopen`), `module-execution-engine/runtime-artifact-compiler/commonjs.ts` (`.node`), `runtime-platform-profile.ts`; ADR-0004, ADR-0012, ADR-0014, ADR-0016, ADR-0021; `tests/e2e/mimic-rolldown-wasi.spec.ts`, `mimic-oxc-parser-wasi.spec.ts`, `mimic-rspack-wasi.spec.ts`; the 2026-06-16 and 2026-07-11 research notes.

Registry (`https://registry.npmjs.org/<name>`, abbreviated and `/latest` documents, 2026-10-05): the packages in the tables above; `https://registry.npmjs.org/-/v1/search?text=wasm32-wasi&size=250` for the sweep of published `*-wasm32-wasi` bindings.

Tarballs unpacked and read: `@tailwindcss/oxide@4.3.3`, `rolldown@1.2.0`, `rolldown@1.2.12`, `oxc-parser@0.153.0`, `@rspack/binding@2.2.8`, `@node-rs/argon2@2.2.1`, `unrs-resolver@1.12.2`, `napi-postinstall@0.3.4`, `nx@23.2.1`, `@swc/core@1.16.13`, `sharp@0.35.5`, `@img/sharp-wasm32@0.35.5`, `@img/sharp-webcontainers-wasm32@0.35.5`, `@napi-rs/canvas@1.0.10`, `@resvg/resvg-js@2.6.2`, `lightningcss@1.30.1`, `@parcel/watcher@2.5.1`, `esbuild@0.25.12`, `esbuild-wasm@0.25.12`, `sass-embedded@1.105.1`, `@biomejs/biome@2.5.15`.
