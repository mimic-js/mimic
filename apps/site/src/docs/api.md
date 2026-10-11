# API reference

`Mimic` is the whole runtime API of `@mimic-js/runtime`: a virtual file system,
processes, and the URLs of the HTTP servers those processes start. The
build-time entry `@mimic-js/runtime/vite` adds a Vite plugin and the response
headers a page needs.

```ts
import { Mimic, MimicProcessCrashError } from '@mimic-js/runtime';
import type {
  BootOptions,
  EmbedderPolicy,
  ExportedFileSystemTree,
  FileSystemAPI,
  FileSystemTree,
  MimicProcess,
  PublishedEndpoint,
  PublishedEndpointCollection,
  SpawnOptions
} from '@mimic-js/runtime';
```

**One container runs per page at a time.** `Mimic.boot()` rejects while
another container of the page is booted or booting; call `teardown()` first.

## Mimic.boot()

```ts
static boot(options?: BootOptions): Promise<Mimic>

type BootOptions = {
  workdir?: string;
  embedderPolicy?: EmbedderPolicy;
  previewOrigin?: string;
};

type EmbedderPolicy = 'require-corp' | 'credentialless';
```

Starts the runtime and resolves with the container. It rejects with an error
naming the missing headers when the page is not cross-origin isolated (see
[Installation](/docs/installation#the-two-headers)); a failed boot tears down
what it started.

| Option | Default | Meaning |
| --- | --- | --- |
| `workdir` | `/home/project` | The working directory: where `fs.mount()` mounts, what relative paths resolve against, and the `cwd` of `spawn()`. It must be a canonical absolute POSIX path (no trailing slash, `.` or `..`), or `boot()` throws a `TypeError`. |
| `embedderPolicy` | `require-corp` | The `Cross-Origin-Embedder-Policy` your page is served with. Documents of Published Endpoints are served with the same policy, so that a preview may load what its page may. |
| `previewOrigin` | the page's origin | The origin Published Endpoints and the runtime are served from, such as `https://preview.example`, so that a project's code cannot reach your page's storage, cookies or DOM. A wildcard such as `https://*.preview.example` serves each endpoint from the root of an origin of its own. See [the preview origin](/docs/installation#running-the-container-on-a-preview-origin). |

A wildcard `previewOrigin` must be an http(s) origin whose first hostname
label is `*`; any other value that is not an origin without a path throws a
`TypeError`. A `previewOrigin` equal to the page's own origin is the same as
none.

## container.workdir

```ts
readonly workdir: string
```

The working directory the container was booted with.

## container.fs

```ts
readonly fs: FileSystemAPI
```

The container's virtual file system: one in-memory, POSIX-like file system
shared by every process, which lasts as long as the container. Every method is
asynchronous. A relative path resolves against `workdir`. A failed operation
rejects with an error whose `code` names the cause, such as `NOT_FOUND`. After
`teardown()`, every method rejects.

### fs.mount()

```ts
mount(
  input: FileSystemTree | Uint8Array | ArrayBuffer,
  options?: { mountPoint?: string }
): Promise<void>
```

Writes a [`FileSystemTree`](#filesystemtree), or a ZIP or TAR archive given as
bytes, into `mountPoint` (default: `workdir`), which is created if missing.
Existing files at the same paths are replaced; others are kept. An archive
that is neither, or holds an unsafe path, rejects with `INVALID_ARCHIVE`;
gzip-compressed archives must be decompressed first.

### fs.export()

```ts
export(path?: string, options?: { format?: 'json' }): Promise<ExportedFileSystemTree>
export(path: string | undefined, options: { format: 'zip' | 'tar' }): Promise<Uint8Array>
```

Returns the directory at `path` (default: `workdir`) as a JSON
[`FileSystemTree`](#filesystemtree), or as the bytes of a ZIP or TAR archive.
All three formats keep modification times, non-default modes and symlinks, and
each can be passed back to `mount()`.

### fs.readFile()

```ts
readFile(path: string, encoding: 'utf8'): Promise<string>
readFile(path: string, encoding?: null): Promise<Uint8Array>
```

Reads a file as text with `'utf8'`, or as bytes without an encoding.

### fs.writeFile()

```ts
writeFile(
  path: string,
  data: string | Uint8Array,
  options?: { append?: boolean; exclusive?: boolean; mode?: number }
): Promise<void>
```

Creates or replaces a file. `append` adds to an existing file instead;
`exclusive` fails when the path exists, atomically with the creation; `mode`
sets the permission bits of a file the write creates.

### fs.readdir()

```ts
readdir(path: string, options?: { withFileTypes?: boolean }): Promise<Array<string | DirentLike>>

type DirentLike = {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};
```

Lists a directory's entry names, or entries with their types when
`withFileTypes` is `true`.

### fs.mkdir()

```ts
mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
```

Creates a directory; `recursive` also creates missing parents and does not
fail when the directory exists.

### fs.rm()

```ts
rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
```

Removes a file, or a directory and its contents with `recursive`. `force`
ignores a path that does not exist.

### fs.rename()

```ts
rename(oldPath: string, newPath: string): Promise<void>
```

Moves a file or directory, atomically. Open file descriptors of programs
follow the file.

### fs.stat() and fs.lstat()

```ts
stat(path: string): Promise<FileStatLike>
lstat(path: string): Promise<FileStatLike>

type FileStatLike = {
  size: number;
  ino: number;
  mode?: number;   // file type and permission bits, as in st_mode
  nlink?: number;
  ctime: Date;
  mtime: Date;
  mtimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
};
```

`stat` follows symlinks; `lstat` describes the link itself.

### fs.exists() and fs.access()

```ts
exists(path: string): Promise<boolean>
access(path: string): Promise<void>
```

`exists` resolves whether the path exists; `access` resolves when it does and
rejects when it does not.

### fs.symlink(), fs.readlink() and fs.realpath()

```ts
symlink(target: string, path: string): Promise<void>
readlink(path: string): Promise<string>
realpath(path: string): Promise<string>
```

Creates a symbolic link at `path` pointing to `target`, reads a link's target,
and resolves a path with every symlink followed.

### fs.link()

```ts
link(existingPath: string, newPath: string): Promise<void>
```

Creates a hard link: a second name for the same file.

### fs.chmod() and fs.utimes()

```ts
chmod(path: string, mode: number): Promise<void>
utimes(path: string, mtimeMs: number): Promise<void>
```

Sets the permission bits, or the modification time in milliseconds since the
epoch.

### fs.revision

```ts
readonly revision: number
```

The latest revision of the file system the page has seen. Every committed
change increases it, and each call through `container.fs` updates it to the
revision that call saw. Programs change files without notifying the page, so
to notice their changes, make a cheap call such as `exists(workdir)` and
compare `revision` with its previous value.

## container.spawn()

```ts
spawn(command: string, args: string[], options?: SpawnOptions): Promise<MimicProcess>
spawn(command: string, options?: SpawnOptions): Promise<MimicProcess>

interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  output?: boolean;
  terminal?: { cols: number; rows: number };
}
```

Starts a program and resolves with its process once it has a process id. The
command is looked up as a shell would: `node`, `npm`, `npx`, `pnpm`, `yarn`,
`sh`, the shell's programs (`ls`, `cat`, `cp`, `mv`, `rm`, `mkdir`, …),
package bins on `PATH`, and scripts with a shebang. For a command line, use
`spawn('sh', ['-c', 'npm install && npm run dev'])`.

- `cwd` defaults to `workdir`; a relative one resolves against it.
- `env` is added to the default environment: `HOME=/home/browser`,
  `PATH=<workdir>/node_modules/.bin:/bin`, `PWD`, `SHELL=/bin/sh`,
  `TMPDIR=/tmp`, `USER` and `LOGNAME` (`browser`), and
  `PUPPETEER_SKIP_DOWNLOAD=1` and `CYPRESS_INSTALL_BINARY=0`, since no browser
  binary a package downloads could run.
- `output` and `terminal` are accepted and have no effect yet: programs see
  no terminal, and
  `output` is always available. Set `FORCE_COLOR=1` in `env` for coloured
  output.

## MimicProcess

```ts
type MimicProcess = {
  readonly pid: number;
  readonly input: WritableStream<Uint8Array>;   // the same stream as stdin
  readonly output: ReadableStream<Uint8Array>;  // stdout and stderr, interleaved
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exit: Promise<number>;
  kill(signal?: 'SIGTERM' | 'SIGKILL' | 'SIGINT'): void;
};
```

The streams carry bytes; decode text with `TextDecoder`, and write text with
`TextEncoder`. `output` interleaves stdout and stderr as a terminal shows them,
and keeps at most 64 KiB nobody has read, so a slow reader loses output rather
than holding the program back. Closing `input` ends the program's stdin.

`exit` resolves with the exit code; a signal that ends the process gives
`128 + n` (`130` for `SIGINT`, `137` for `SIGKILL`, `143` for `SIGTERM`).
`exit` rejects with a [`MimicProcessCrashError`](#mimicprocesscrasherror) when
the process crashed instead of exiting. `kill()` sends `SIGTERM` by default;
a program may handle the signal, as in Node.

There is no `resize()`: programs see no terminal.

```ts
const install = await container.spawn('npm', ['install']);
install.output.pipeTo(new WritableStream({
  write: (chunk) => console.log(new TextDecoder().decode(chunk))
}));
if ((await install.exit) !== 0) throw new Error('npm install failed');
```

## MimicProcessCrashError

```ts
class MimicProcessCrashError extends Error {
  readonly name: 'MimicProcessCrashError';
  readonly code: 'PROCESS_CRASH';
  readonly pid: number;
  readonly reason: string;
  readonly cause: unknown;
}
```

The error `exit` rejects with when a process crashed, for example when its
worker failed. `reason` says why, without the process id the message adds.

## container.endpoints

```ts
readonly endpoints: PublishedEndpointCollection

interface PublishedEndpointCollection {
  readonly current: readonly PublishedEndpoint[];
  on(type: 'published' | 'unpublished', listener: (endpoint: PublishedEndpoint) => void): () => void;
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
}

type PublishedEndpoint = {
  readonly routeId: string;
  readonly protocol: 'http' | 'https';
  readonly address: { readonly host: string; readonly port: number };
  readonly url: string;
};
```

When a program's HTTP or WebSocket server listens on a port, the port is
published as a URL that your page can load in an iframe or open in a tab.

- `current` lists the endpoints published now.
- `on('published', listener)` and `on('unpublished', listener)` call the
  listener as a server starts and stops listening; the function it returns
  removes the listener.
- `fetch(input, init)` requests an endpoint URL from the page, with `fetch`
  semantics (streaming bodies, redirects, `AbortSignal`). The page's own
  `fetch` does not reach an endpoint, which is served by a Service Worker
  outside the page's scope. Read the response before `teardown()`.

Of an endpoint, `address.port` is the port the program listened on and `url`
is where it is served: under the page's origin, the preview origin, or with a
wildcard preview origin `https://<epoch>--<port>.<domain>/`. `routeId`
identifies the listener serving the port.

```ts
container.endpoints.on('published', (endpoint) => {
  iframe.src = endpoint.url;
});
const response = await container.endpoints.fetch(new URL('/api/health', endpoint.url));
```

## container.teardown()

```ts
teardown(): Promise<void>
```

Stops every process, closes the workers, the Service Worker's endpoints and
the hidden frames, and frees the page to boot another container. The file
system goes with it; only the Compile Cache and the package-manager artifact
cache persist, in the origin private file system. After `teardown()`, the
methods of `fs` and `spawn()` reject and `endpoints` throws. Calling it again
returns the same promise.

## FileSystemTree

```ts
type FileSystemTree = {
  [name: string]: FileSystemTreeNode;
};

type FileSystemTreeNode = (
  | { file: { contents: string | Uint8Array | ArrayBuffer } }
  | { symlink: { target: string } }
  | { directory: FileSystemTree }
) & {
  readonly mtimeMs?: number;
  readonly mode?: number;
};

type ExportedFileSystemTree = FileSystemTree;
```

A directory as a nested object: each key is an entry name, and each value a
file, a symlink or a directory. `mtimeMs` is the modification time and `mode`
the permission bits, present in an export only when they differ from the
default for the kind (for example `0o755` for an executable file).

```ts
await container.fs.mount({
  'package.json': { file: { contents: '{ "type": "module" }' } },
  bin: { directory: { 'start.sh': { file: { contents: '#!/bin/sh\nnode index.js\n' }, mode: 0o755 } } },
  'latest.js': { symlink: { target: 'index.js' } },
  'index.js': { file: { contents: 'console.log("hello")' } }
});
```

## @mimic-js/runtime/vite

```ts
import { mimic, mimicHeaders, mimicHeadersFor, type EmbedderPolicy } from '@mimic-js/runtime/vite';
```

Build-time helpers for the server of the page. `vite` is an optional peer
dependency of the package.

### mimic()

```ts
function mimic(options?: {
  embedderPolicy?: EmbedderPolicy;
  previewOrigin?: string;
}): Plugin
```

The Vite plugin. It sends `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy` (`require-corp` unless `embedderPolicy` says
otherwise) from `vite dev` and `vite preview`, and keeps the package out of
the dependency optimizer, which would detach the entry from its assets. With
`previewOrigin` it adds `Cross-Origin-Resource-Policy: cross-origin`, and for
a wildcard `previewOrigin` also `Service-Worker-Allowed: /`. Pass the same
values to `Mimic.boot()`.

### mimicHeaders and mimicHeadersFor()

```ts
const mimicHeaders: {
  readonly 'Cross-Origin-Embedder-Policy': 'require-corp';
  readonly 'Cross-Origin-Opener-Policy': 'same-origin';
};

function mimicHeadersFor(
  embedderPolicy: EmbedderPolicy
): Readonly<Record<'Cross-Origin-Embedder-Policy' | 'Cross-Origin-Opener-Policy', string>>
```

The two headers that make the page cross-origin isolated, for servers written
in Node: `mimicHeaders` with `require-corp`, `mimicHeadersFor(policy)` with
either policy. A preview origin also needs the headers named under
[`mimic()`](#mimic).

### EmbedderPolicy

```ts
type EmbedderPolicy = 'require-corp' | 'credentialless';
```

`require-corp` loads a cross-origin resource only when its response allows
it; `credentialless` loads it without credentials instead, which spares the
page CORP headers on every CDN it uses. Chromium and Firefox support both;
Safari needs `require-corp`.
