---
status: accepted
---

# Back `node:sqlite` with SQLite WebAssembly

Node Compatibility keeps the `node:sqlite` builtin and runs it on a real SQLite: the publisher WebAssembly build shipped by `node-sqlite3-wasm`, pinned to an exact version. Database files live on the Virtual File System in SQLite's own file format. This replaces the regular-expression interpreter over a JSON document, which accepted a handful of statement shapes and wrote files no SQLite could open.

Removing the builtin was the alternative. It is rejected because pnpm keeps its store index in `node:sqlite`, so `require('node:sqlite')` failing would regress pnpm installs that work today.

`require('node:sqlite')` and `new DatabaseSync(path)` are synchronous, and the builtin table loads builtins synchronously, so the engine has to compile, instantiate, and open a file without yielding. The official `@sqlite.org/sqlite-wasm` build and `sql.js` initialise only through a promise, which a synchronous constructor cannot wait for. `node-sqlite3-wasm` compiles its module synchronously, exposes a synchronous API, and implements its SQLite VFS over Node's synchronous `fs` functions, which the runtime's `node:fs` already provides over the Virtual File System. A self-compiled SQLite would give full control of the exported C API, but the repository would then own a C toolchain, a build pipeline, and SQLite security updates; following [ADR-0004](./0004-prefer-publisher-wasi-executables.md), a publisher artifact is preferred while one fits.

The publisher's glue is a Node CommonJS file. It is not bundled as a module, because a browser build stubs the Node builtins it requires. Node Compatibility carries its source as text and evaluates it on the first opened database through the Module Execution Engine's script evaluator, inside a module wrapper whose `require` serves the Execution Context's own `node:fs`, a path resolver bound to the working directory, and Web Crypto randomness. The 1.3 MB SQLite binary is a separate package asset rather than part of the worker bundle every process loads. A worker fetches it once, on first use, with a synchronous `XMLHttpRequest`.

The engine exports a fixed subset of the SQLite C API, and `node:sqlite` is projected only as far as that subset is exact. The projection relies on two internals of the pinned version: a connection subclass keeps the result code the package otherwise reduces to a message, and number binding is redirected to `sqlite3_bind_double` because Node binds every JavaScript number as a REAL. Named, bare, numbered, and anonymous parameters follow Node's rules, with parameter names read from the compiled statement's source because `sqlite3_bind_parameter_name` is not exported. Everything the subset cannot express throws `ENOTSUP` rather than approximating: `expandedSQL`, `columns()`, `setReturnArrays()`, user-defined and aggregate functions, sessions and changesets, extensions, `backup()`, and the double-quoted string literal option.

Known limits:

- `errcode` is SQLite's primary result code. Node reports the extended code, for example 2067 where this reports 19 for a `UNIQUE` violation; `errstr` and the message match.
- Locking is the package's: a `<database>.lock` directory held for the duration of each lock, with no shared and exclusive levels. Connections in separate processes exclude one another, readers included, and a process killed while it holds the lock leaves the directory behind, after which the database reports `database is locked` until the directory is removed.
- The VFS has no shared-memory methods, so `PRAGMA journal_mode = WAL` leaves the rollback journal in place. Temporary tables and indexes stay in memory.
- Each page read and write is one synchronous Virtual File System call, and every commit creates and deletes a journal file. Batching writes in a transaction matters more here than on a native file system.
- The projection must be re-verified when the pinned version changes; it refuses to start if the internals it relies on are gone.
