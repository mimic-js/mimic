import {
  bootRuntimeHost,
  MimicProcessCrashError as RuntimeProcessCrashError,
  normalizePath,
  normalizePreviewOrigin,
  type AsyncVirtualFileSystemClient,
  type PublishedEndpoint as RuntimePublishedEndpoint,
  type PublishedEndpointCollection as RuntimePublishedEndpointCollection,
  type RuntimeProgramProcess,
  type RuntimeHost
} from './modules/runtime-host';

// The public surface is declared in this file alone, so that the package's
// one declaration file is self-contained: no public signature names a type of
// an internal module. Adapters below map the internal objects onto it.

/**
 * The `Cross-Origin-Embedder-Policy` of the embedding page. `require-corp`
 * loads a cross-origin resource only when its response allows it;
 * `credentialless` loads it without credentials instead, which spares the
 * page CORP headers on every CDN it uses (Chromium and Firefox; Safari needs
 * `require-corp`). Pass the same value to the Vite plugin, if one is used.
 */
export type EmbedderPolicy = 'require-corp' | 'credentialless';

export type BootOptions = {
  /** The project directory: the default `cwd` of a spawn and mount point of a mount. `/home/project` when omitted. */
  workdir?: string;
  /**
   * The `Cross-Origin-Embedder-Policy` the embedding page is served with.
   * Published Endpoint documents are served with the same policy, so that a
   * preview may load what its page may. `require-corp` when omitted.
   */
  embedderPolicy?: EmbedderPolicy;
  /**
   * The origin Published Endpoints are served from, such as
   * `https://preview.example`, when the application serves this package's
   * assets from a second hostname too (ADR-0032). Documents a project's
   * server returns then run in that origin instead of the page's own, so
   * they cannot reach the page's storage, cookies or DOM. A wildcard such as
   * `https://*.preview.example` serves each endpoint from the root of an
   * origin of its own, `https://<id>--<port>.preview.example/`, so a
   * document sees the path its server sees, as a client-side router needs
   * (ADR-0044); the package's assets must be served from every hostname of
   * the wildcard, with `Service-Worker-Allowed: /`. Omitted, endpoints are
   * served from the page's origin, as a self-contained deployment needs.
   */
  previewOrigin?: string;
};

export interface SpawnOptions {
  /** The working directory, resolved against the workdir. The workdir when omitted. */
  cwd?: string;
  /** Variables added to, or replacing, the default environment. */
  env?: Record<string, string>;
}

/** A program started with `Mimic.spawn()`. */
export interface MimicProcess {
  readonly pid: number;
  /** The program's standard input. Closing it ends the input. */
  readonly stdin: WritableStream<Uint8Array>;
  /** The program's standard output. Once 64 KiB wait unread, the program's writes wait for a reader: read it, or `cancel()` it. */
  readonly stdout: ReadableStream<Uint8Array>;
  /** The program's standard error. Once 64 KiB wait unread, the program's writes wait for a reader: read it, or `cancel()` it. */
  readonly stderr: ReadableStream<Uint8Array>;
  /** The exit code; rejects with a `MimicProcessCrashError` when the runtime could not run the program to its end. */
  readonly exit: Promise<number>;
  /** Sends a signal, `SIGTERM` when omitted. */
  kill(signal?: 'SIGTERM' | 'SIGKILL' | 'SIGINT'): void;
}

/** The `code` of every `MimicProcessCrashError`. */
export type MimicProcessCrashErrorCode = 'PROCESS_CRASH';

/** Why `MimicProcess.exit` rejected: the runtime could not run the process to its end. */
export interface MimicProcessCrashError extends Error {
  readonly code: MimicProcessCrashErrorCode;
  readonly pid: number;
  /** Why the process crashed, without the process identity the message adds. */
  readonly reason: string;
  readonly cause: unknown;
}

export const MimicProcessCrashError: {
  new (pid: number, reason: string, cause?: unknown): MimicProcessCrashError;
  readonly prototype: MimicProcessCrashError;
} = RuntimeProcessCrashError;

/** An HTTP server a program listens with, as the page reaches it. */
export interface PublishedEndpoint {
  /** The port the program listened on. */
  readonly port: number;
  /** Where the page (an iframe, a link, `endpoints.fetch()`) reaches the server. */
  readonly url: string;
}

export interface PublishedEndpointCollection {
  /** The endpoints published now, in the order they were published. */
  readonly current: readonly PublishedEndpoint[];
  /** Calls `listener` when a server starts or stops listening; returns the unsubscribe function. */
  on(
    type: 'published' | 'unpublished',
    listener: (endpoint: PublishedEndpoint) => void
  ): () => void;
  /**
   * Requests a Published Endpoint URL from the embedding page, as `fetch`
   * would from a document served by the endpoint. The page itself is outside
   * the Service Worker's scope, so its own `fetch` does not reach an endpoint.
   * The response belongs to the container's epoch: read it before `teardown()`.
   */
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
}

/** A directory as `fs.mount()` takes it and `fs.export()` returns it, by entry name. */
export type FileSystemTree = {
  [name: string]: FileSystemTreeNode;
};

export type FileSystemTreeNode = (
  | { file: { contents: string | Uint8Array | ArrayBuffer } }
  | { symlink: { target: string } }
  | { directory: FileSystemTree }
) & {
  /** Modification time, kept by exports and archives. */
  readonly mtimeMs?: number;
  /**
   * Permission bits of a file or directory, present in an export only when
   * they differ from the default for its kind. Symbolic links ignore it.
   */
  readonly mode?: number;
};

export type FileStatLike = {
  size: number;
  ino: number;
  /** File type and permission bits, as in `st_mode`. */
  mode?: number;
  nlink?: number;
  ctime: Date;
  mtime: Date;
  mtimeMs: number;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isFile(): boolean;
  isDirectory(): boolean;
  isSocket(): boolean;
  isSymbolicLink(): boolean;
};

export type DirentLike = {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

/** The container's file system, as the page reads and writes it. Paths are absolute or relative to the workdir. */
export interface FileSystemAPI {
  /**
   * A number that changes whenever the file system changed; cheap to read,
   * for polling a file tree. It is current as of this object's latest call:
   * call any method, such as `exists()`, before reading it.
   */
  readonly revision: number;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  readFile(path: string, encoding?: null): Promise<Uint8Array>;
  writeFile(
    path: string,
    data: string | Uint8Array,
    options?: { append?: boolean; exclusive?: boolean; mode?: number }
  ): Promise<void>;
  readdir(path: string, options?: { withFileTypes?: boolean }): Promise<Array<string | DirentLike>>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  stat(path: string): Promise<FileStatLike>;
  lstat(path: string): Promise<FileStatLike>;
  exists(path: string): Promise<boolean>;
  symlink(target: string, path: string): Promise<void>;
  readlink(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
  /** Writes a tree, or the entries of a zip or tar archive, under `mountPoint` (the workdir when omitted). */
  mount(
    input: FileSystemTree | Uint8Array | ArrayBuffer,
    options?: { mountPoint?: string }
  ): Promise<void>;
  /** Reads `path` (the workdir when omitted) as a tree, or as a zip or tar archive. */
  export(path?: string, options?: { format?: 'json' }): Promise<FileSystemTree>;
  export(
    path: string | undefined,
    options: { format: 'zip' | 'tar' }
  ): Promise<Uint8Array>;
  export(
    path?: string,
    options?: { format?: 'json' | 'zip' | 'tar' }
  ): Promise<FileSystemTree | Uint8Array>;
}

/** A container: a file system, the processes that run in it, and the HTTP servers they listen with. */
export class Mimic {
  /** The project directory, `/home/project` unless `boot()` named another. */
  readonly workdir: string;
  readonly fs: FileSystemAPI;

  private publicEndpoints: PublishedEndpointCollection | undefined;
  private host: RuntimeHost | undefined;
  private tornDown = false;
  private teardownPromise: Promise<void> | undefined;
  private readonly embedderPolicy: EmbedderPolicy;
  private readonly previewOrigin: string | undefined;

  private constructor(workdir: string, embedderPolicy: EmbedderPolicy, previewOrigin: string | undefined) {
    this.workdir = workdir;
    this.embedderPolicy = embedderPolicy;
    this.previewOrigin = previewOrigin;
    this.fs = new MimicFileSystem(
      () => this.runtimeHost().fs,
      workdir,
      () => this.assertAvailable()
    );
  }

  /** The HTTP servers the container's programs listen with. */
  get endpoints(): PublishedEndpointCollection {
    this.assertAvailable();
    this.runtimeHost();
    if (!this.publicEndpoints) {
      throw new Error('Mimic endpoints are not initialized.');
    }
    return this.publicEndpoints;
  }

  /** Starts a container. The page must be cross-origin isolated. */
  static async boot(options: BootOptions = {}): Promise<Mimic> {
    const workdir = options.workdir ?? '/home/project';
    assertCanonicalWorkdir(workdir);
    const embedderPolicy = options.embedderPolicy ?? 'require-corp';
    if (embedderPolicy !== 'require-corp' && embedderPolicy !== 'credentialless') {
      throw new TypeError(
        `embedderPolicy must be "require-corp" or "credentialless", not ${JSON.stringify(embedderPolicy)}.`
      );
    }
    const previewOrigin = normalizePreviewOrigin(options.previewOrigin);
    const container = new Mimic(workdir, embedderPolicy, previewOrigin);
    try {
      await container.initialize();
      return container;
    } catch (error) {
      await container.teardown();
      throw error;
    }
  }

  private async initialize(): Promise<void> {
    const host = await bootRuntimeHost(
      this.workdir,
      () => this.onHostFailure(),
      { embedderPolicy: this.embedderPolicy, previewOrigin: this.previewOrigin }
    );
    this.host = host;
    this.publicEndpoints = new ReadonlyPublishedEndpointCollection(
      host.endpoints,
      () => this.assertAvailable()
    );
    this.assertAvailable();
  }

  /** Starts a program: `node`, a package manager, a binary of `node_modules/.bin`, or `sh`. */
  async spawn(
    command: string,
    args: string[],
    options?: SpawnOptions
  ): Promise<MimicProcess>;
  async spawn(
    command: string,
    options?: SpawnOptions
  ): Promise<MimicProcess>;
  async spawn(
    command: string,
    argsOrOptions: string[] | SpawnOptions = [],
    options: SpawnOptions = {}
  ): Promise<MimicProcess> {
    this.assertAvailable();
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    const spawnOptions = Array.isArray(argsOrOptions) ? options : argsOrOptions;
    const cwd = normalizePath(
      spawnOptions.cwd ?? this.workdir,
      this.workdir
    );
    const env = {
      HOME: '/home/browser',
      LOGNAME: 'browser',
      PATH: `${this.workdir}/node_modules/.bin:/bin`,
      PWD: cwd,
      SHELL: '/bin/sh',
      TMPDIR: '/tmp',
      USER: 'browser',
      // No browser binary a package downloads at install could run here, and
      // the downloads themselves fail (puppeteer's Chromium comes from a host
      // a browser fetch cannot reach; Cypress's installer refuses wasm32).
      // Both packages document these variables for skipping the download.
      PUPPETEER_SKIP_DOWNLOAD: '1',
      CYPRESS_INSTALL_BINARY: '0',
      ...spawnOptions.env
    };

    return publicProcess(
      await this.runtimeHost().spawn({
        command,
        args,
        cwd,
        env,
        parentPid: 0
      })
    );
  }

  /** Stops every process and releases the container. Calling it again returns the same promise. */
  teardown(): Promise<void> {
    if (this.teardownPromise) return this.teardownPromise;
    this.tornDown = true;
    this.teardownPromise = this.shutdown();
    return this.teardownPromise;
  }

  private async shutdown(): Promise<void> {
    await this.host?.teardown();
  }

  private assertAvailable(): void {
    if (this.tornDown) {
      throw new Error('Mimic runtime is tearing down');
    }
  }

  private onHostFailure(): void {
    if (this.tornDown) return;
    this.tornDown = true;
    this.teardownPromise = this.host?.teardown() ?? Promise.resolve();
    void this.teardownPromise.catch(() => undefined);
  }

  private runtimeHost(): RuntimeHost {
    if (!this.host) {
      throw new Error('The Runtime Host is not initialized.');
    }
    return this.host;
  }
}

class MimicFileSystem implements FileSystemAPI {
  constructor(
    private readonly source: () => AsyncVirtualFileSystemClient,
    private readonly workdir: string,
    private readonly assertAvailable: () => void
  ) {}

  get revision(): number {
    return this.runtimeFileSystem().revision;
  }

  async exists(path: string): Promise<boolean> {
    return this.runtimeFileSystem().exists(path);
  }

  async lstat(path: string): Promise<FileStatLike> {
    return this.runtimeFileSystem().lstat(path);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    return this.runtimeFileSystem().mkdir(path, options);
  }

  readFile(path: string, encoding: 'utf8'): Promise<string>;
  readFile(path: string, encoding?: null): Promise<Uint8Array>;
  async readFile(
    path: string,
    encoding?: 'utf8' | null
  ): Promise<string | Uint8Array> {
    const fileSystem = this.runtimeFileSystem();
    return encoding === 'utf8'
      ? fileSystem.readFile(path, 'utf8')
      : fileSystem.readFile(path, null);
  }

  async readdir(
    path: string,
    options?: { withFileTypes?: boolean }
  ): Promise<Array<string | DirentLike>> {
    return this.runtimeFileSystem().readdir(path, options);
  }

  async readlink(path: string): Promise<string> {
    return this.runtimeFileSystem().readlink(path);
  }

  async realpath(path: string): Promise<string> {
    return this.runtimeFileSystem().realpath(path);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    return this.runtimeFileSystem().rename(oldPath, newPath);
  }

  async rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean }
  ): Promise<void> {
    return this.runtimeFileSystem().rm(path, options);
  }

  async stat(path: string): Promise<FileStatLike> {
    return this.runtimeFileSystem().stat(path);
  }

  async symlink(target: string, path: string): Promise<void> {
    return this.runtimeFileSystem().symlink(target, path);
  }

  async writeFile(
    path: string,
    data: string | Uint8Array,
    options?: { append?: boolean; exclusive?: boolean; mode?: number }
  ): Promise<void> {
    return this.runtimeFileSystem().writeFile(path, data, options);
  }

  async mount(
    input: FileSystemTree | Uint8Array | ArrayBuffer,
    options: { mountPoint?: string } = {}
  ): Promise<void> {
    const fs = this.runtimeFileSystem();
    const mountPoint = normalizePath(
      options.mountPoint ?? this.workdir,
      this.workdir
    );
    if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
      await fs.mountArchive(
        input instanceof Uint8Array ? input : new Uint8Array(input),
        mountPoint
      );
      return;
    }
    await fs.mount(input, mountPoint);
  }

  async export(
    path?: string,
    options?: { format?: 'json' }
  ): Promise<FileSystemTree>;
  async export(
    path: string | undefined,
    options: { format: 'zip' | 'tar' }
  ): Promise<Uint8Array>;
  async export(
    path?: string,
    options?: { format?: 'json' | 'zip' | 'tar' }
  ): Promise<FileSystemTree | Uint8Array>;
  async export(
    path = this.workdir,
    options: { format?: 'json' | 'zip' | 'tar' } = {}
  ): Promise<FileSystemTree | Uint8Array> {
    const fs = this.runtimeFileSystem();
    const resolvedPath = normalizePath(path, this.workdir);
    const format = options.format ?? 'json';
    if (format === 'json') return fs.exportTree(resolvedPath);
    if (format === 'zip' || format === 'tar') {
      return fs.exportArchive(resolvedPath, format);
    }
    throw new Error(
      `Unsupported filesystem export format: ${String(format)}`
    );
  }

  private runtimeFileSystem(): AsyncVirtualFileSystemClient {
    this.assertAvailable();
    return this.source();
  }
}

/** The public face of a Runtime Program Process: its streams, exit and `kill`. */
function publicProcess(process: RuntimeProgramProcess): MimicProcess {
  return Object.freeze({
    pid: process.pid,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    exit: process.exit,
    kill: (signal?: 'SIGTERM' | 'SIGKILL' | 'SIGINT') => process.kill(signal)
  });
}

class ReadonlyPublishedEndpointCollection
  implements PublishedEndpointCollection
{
  // One public object per published endpoint, so that `current` and the
  // listeners hand out the same object for the same endpoint.
  readonly #public = new WeakMap<RuntimePublishedEndpoint, PublishedEndpoint>();

  constructor(
    private readonly source: RuntimePublishedEndpointCollection,
    private readonly assertAvailable: () => void
  ) {}

  get current(): readonly PublishedEndpoint[] {
    this.assertAvailable();
    return this.source.current.map((endpoint) => this.publicEndpoint(endpoint));
  }

  on(
    type: 'published' | 'unpublished',
    listener: (endpoint: PublishedEndpoint) => void
  ): () => void {
    this.assertAvailable();
    return this.source.on(type, (endpoint) => listener(this.publicEndpoint(endpoint)));
  }

  fetch(input: string | URL, init?: RequestInit): Promise<Response> {
    this.assertAvailable();
    return this.source.fetch(input, init);
  }

  private publicEndpoint(endpoint: RuntimePublishedEndpoint): PublishedEndpoint {
    let mapped = this.#public.get(endpoint);
    if (!mapped) {
      mapped = Object.freeze({ port: endpoint.address.port, url: endpoint.url });
      this.#public.set(endpoint, mapped);
    }
    return mapped;
  }
}

function assertCanonicalWorkdir(workdir: string): void {
  const segments = workdir.split('/');
  const isCanonical =
    workdir === '/' ||
    (workdir.startsWith('/') &&
      !workdir.endsWith('/') &&
      !workdir.includes('\0') &&
      segments.slice(1).every((segment) =>
        segment.length > 0 && segment !== '.' && segment !== '..'
      ));
  if (!isCanonical) {
    throw new TypeError(
      'Mimic boot workdir must be a canonical absolute POSIX path.'
    );
  }
}
