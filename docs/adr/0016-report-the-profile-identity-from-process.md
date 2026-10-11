---
status: superseded
superseded-by: ADR-0039 (the operating system is reported as linux)
---

# Report the Runtime Platform Profile identity from `process`

`process.platform` reports `browser` and `process.arch` reports `wasm32`, the operating system and architecture of the Runtime Platform Profile ([ADR-0010](./0010-use-one-attested-runtime-platform-profile.md)). `os.platform()` and `os.arch()` report the same pair. Mimic does not present itself as `linux`/`x64`.

The identity a program reads has to be the identity its packages were installed for. Package Installation selects optional and replacement packages for `browser`/`wasm32`: the Browser Package Replacement Catalog applies only to that pair, and Exact Graph Compatibility Claims attest it as their virtual platform. A program that read `linux`/`x64` at run time would look for native bindings that Package Installation never installs and that a browser could not load. Reading `wasm32` is what leads binding loaders to the publisher WASM and WASI packages the Catalog installs.

One identity also keeps the profile attested in one place. A second, Node-facing identity would need its own evidence and would let installation and execution disagree without any check noticing.

The cost is that `browser` is not a value Node itself ever reports. A package that accepts only a fixed list of platforms rejects it, and a package that branches on `win32` versus everything else takes its POSIX path, which matches the runtime's POSIX paths and separators. A package that needs a platform Node recognises is a compatibility gap to close with a package-neutral runtime capability or a Catalog relationship, not by changing the reported identity for that package.

`process.versions` carries the `v8`, `uv`, and `modules` values of the Node release the profile names, because tools read them to choose prebuilt artifacts and feature paths for that release. They describe the Node `22.22.3` contract Mimic implements, not the browser engine underneath.
