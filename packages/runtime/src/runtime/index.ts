import {
  bootRuntimeHost,
  normalizePath,
  normalizePreviewOrigin,
  type AsyncVirtualFileSystemClient,
  type DirentLike,
  type ExportedFileSystemTree,
  type FileStatLike,
  type FileSystemTree,
  type PublishedEndpoint,
  type PublishedEndpointCollection,
  type PublishedEndpointLifecycleEvent,
  type RevisionedFileSystemAPI,
  type RuntimeProgramProcess,
  type RuntimeHost
} from './modules/runtime-host';

export { MimicProcessCrashError } from './modules/runtime-host';
export type {
  ExportedFileSystemTree,
  FileSystemTree,
  PublishedEndpoint,
  PublishedEndpointCollection
} from './modules/runtime-host';

export type BootOptions = {
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

export type EmbedderPolicy = 'require-corp' | 'credentialless';

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  output?: boolean;
  terminal?: {
    cols: number;
    rows: number;
  };
}

export type MimicProcess = Omit<RuntimeProgramProcess, 'crash' | 'termination'>;

export interface FileSystemAPI extends RevisionedFileSystemAPI {
  mount(
    input: FileSystemTree | Uint8Array | ArrayBuffer,
    options?: { mountPoint?: string }
  ): Promise<void>;
  export(path?: string, options?: { format?: 'json' }): Promise<ExportedFileSystemTree>;
  export(
    path: string | undefined,
    options: { format: 'zip' | 'tar' }
  ): Promise<Uint8Array>;
  export(
    path?: string,
    options?: { format?: 'json' | 'zip' | 'tar' }
  ): Promise<ExportedFileSystemTree | Uint8Array>;
}

export class Mimic {
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

  get endpoints(): PublishedEndpointCollection {
    this.assertAvailable();
    this.runtimeHost();
    if (!this.publicEndpoints) {
      throw new Error('Mimic endpoints are not initialized.');
    }
    return this.publicEndpoints;
  }

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

    return this.runtimeHost().spawn({
      command,
      args,
      cwd,
      env,
      parentPid: 0
    });
  }

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

  async access(path: string): Promise<void> {
    return this.runtimeFileSystem().access(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.runtimeFileSystem().exists(path);
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    return this.runtimeFileSystem().link(existingPath, newPath);
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

  async utimes(path: string, mtimeMs: number): Promise<void> {
    return this.runtimeFileSystem().utimes(path, mtimeMs);
  }

  async writeFile(
    path: string,
    data: string | Uint8Array,
    options?: { append?: boolean; exclusive?: boolean; mode?: number }
  ): Promise<void> {
    return this.runtimeFileSystem().writeFile(path, data, options);
  }

  async chmod(path: string, mode: number): Promise<void> {
    return this.runtimeFileSystem().chmod(path, mode);
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
  ): Promise<ExportedFileSystemTree>;
  async export(
    path: string | undefined,
    options: { format: 'zip' | 'tar' }
  ): Promise<Uint8Array>;
  async export(
    path?: string,
    options?: { format?: 'json' | 'zip' | 'tar' }
  ): Promise<ExportedFileSystemTree | Uint8Array>;
  async export(
    path = this.workdir,
    options: { format?: 'json' | 'zip' | 'tar' } = {}
  ): Promise<ExportedFileSystemTree | Uint8Array> {
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

class ReadonlyPublishedEndpointCollection
  implements PublishedEndpointCollection
{
  constructor(
    private readonly source: PublishedEndpointCollection,
    private readonly assertAvailable: () => void
  ) {}

  get current(): readonly PublishedEndpoint[] {
    this.assertAvailable();
    return this.source.current;
  }

  on<Type extends PublishedEndpointLifecycleEvent['type']>(
    type: Type,
    listener: (endpoint: PublishedEndpoint) => void
  ): () => void {
    this.assertAvailable();
    return this.source.on(type, listener);
  }

  fetch(input: string | URL, init?: RequestInit): Promise<Response> {
    this.assertAvailable();
    return this.source.fetch(input, init);
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
