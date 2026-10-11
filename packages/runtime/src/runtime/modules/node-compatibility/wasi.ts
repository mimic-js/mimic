import {
  createWasiNodeAdapterFactory,
  type WasiByteWriter,
  type WasiCommandExecutionRuntime,
  type WasiExecutableInstance,
  type WasiNodeAdapter,
  type WasiRuntimeProcess,
  type WasiSynchronousVfsPort
} from '../wasi-execution';
import type { DirentLike, FileStatLike } from '../virtual-file-system';

export type {
  WasiByteWriter,
  WasiRuntimeProcess,
  WasiSynchronousVfsPort
};

/** The synchronous Virtual File System calls a WASI command makes. */
export interface WasiVfsPortSource {
  readFileSync(path: string): Uint8Array;
  readFileSliceSync(path: string, offset: number, length: number): Uint8Array;
  readdirSync(path: string, options: { readonly withFileTypes: true }): Array<string | DirentLike>;
  readlinkSync(path: string): string;
  realpathSync(path: string): string;
  statSync(path: string): FileStatLike;
  lstatSync(path: string): FileStatLike;
  mkdirSync(path: string, options?: { readonly recursive?: boolean }): void;
  rmSync(path: string, options?: { readonly recursive?: boolean; readonly force?: boolean }): void;
  symlinkSync(target: string, path: string): void;
  writeFileSync(path: string, data: string | Uint8Array): void;
  renameSync?(oldPath: string, newPath: string): void;
  linkSync?(existingPath: string, newPath: string): void;
  utimesSync?(path: string, mtimeMs: number): void;
  /** When absent, the port asks `statSync`, and a path it cannot stat is neither. */
  isDirectory?(path: string): boolean;
  isFile?(path: string): boolean;
}

/**
 * The one adapter from a synchronous Virtual File System client to the WASI
 * preview1 file-system port, for `node:wasi` and for the WASI Runtime Process.
 */
export function wasiVfsPort(fileSystem: WasiVfsPortSource): WasiSynchronousVfsPort {
  const statKind = (path: string, kind: 'directory' | 'file'): boolean => {
    try {
      const stat = fileSystem.statSync(path);
      return kind === 'directory' ? stat.isDirectory() : stat.isFile();
    } catch {
      return false;
    }
  };
  return {
    readFileSync: (path) => fileSystem.readFileSync(path),
    readFileSliceSync: (path, offset, length) =>
      fileSystem.readFileSliceSync(path, offset, length),
    readdirSync: (path) =>
      fileSystem.readdirSync(path, { withFileTypes: true }).map((entry) => {
        if (typeof entry === 'string') {
          throw new TypeError('WASI directory reads require typed VFS entries.');
        }
        return entry;
      }),
    readlinkSync: (path) => fileSystem.readlinkSync(path),
    realpathSync: (path) => fileSystem.realpathSync(path),
    statSync: (path) => fileSystem.statSync(path),
    lstatSync: (path) => fileSystem.lstatSync(path),
    mkdirSync: (path, options) => fileSystem.mkdirSync(path, options),
    rmSync: (path, options) => fileSystem.rmSync(path, options),
    symlinkSync: (target, path) => fileSystem.symlinkSync(target, path),
    writeFileSync: (path, data) => fileSystem.writeFileSync(path, data),
    ...(fileSystem.renameSync && { renameSync: (oldPath: string, newPath: string) => fileSystem.renameSync!(oldPath, newPath) }),
    ...(fileSystem.linkSync && { linkSync: (existingPath: string, newPath: string) => fileSystem.linkSync!(existingPath, newPath) }),
    ...(fileSystem.utimesSync && { utimesSync: (path: string, mtimeMs: number) => fileSystem.utimesSync!(path, mtimeMs) }),
    isDirectory: (path) =>
      fileSystem.isDirectory ? fileSystem.isDirectory(path) : statKind(path, 'directory'),
    isFile: (path) => fileSystem.isFile ? fileSystem.isFile(path) : statKind(path, 'file')
  };
}

export type WasiBuiltinOptions = WasiCommandExecutionRuntime;
export type WasiInstance = WasiExecutableInstance;

export interface WasiOptions {
  readonly version: 'preview1';
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly preopens?: Readonly<Record<string, string>>;
  readonly stdin?: number;
  readonly stdout?: number;
  readonly stderr?: number;
  readonly returnOnExit?: boolean;
}

export interface Wasi {
  readonly wasiImport: WebAssembly.ModuleImports;
  getImportObject(): WebAssembly.Imports;
  initialize(instance: WasiInstance): void;
  start(instance: WasiInstance): number | void;
}

export interface WasiConstructor {
  new (options: WasiOptions): Wasi;
}

export interface WasiBuiltin {
  readonly WASI: WasiConstructor;
  readonly default: WasiBuiltin;
}

export function createWasiBuiltin(runtime: WasiBuiltinOptions): WasiBuiltin {
  const createAdapter = createWasiNodeAdapterFactory(runtime);

  class Preview1Wasi implements Wasi {
    readonly #adapter: WasiNodeAdapter;
    readonly wasiImport: WebAssembly.ModuleImports;

    constructor(options: WasiOptions) {
      if (!options || options.version === undefined) throw new TypeError('WASI option version is required.');
      if (options.version !== 'preview1') throw new RangeError('WASI only supports version preview1.');
      validateStdioOptions(options);
      this.#adapter = createAdapter({
        version: options.version,
        args: options.args,
        env: options.env,
        preopens: options.preopens,
        exitMode: options.returnOnExit === false ? 'terminate' : 'return'
      });
      this.wasiImport = this.#adapter.wasiImport;
    }

    getImportObject(): WebAssembly.Imports {
      return this.#adapter.getImportObject();
    }

    initialize(instance: WasiInstance): void {
      this.#adapter.initialize(instance);
    }

    start(instance: WasiInstance): number | void {
      return this.#adapter.start(instance);
    }
  }

  const builtin = { WASI: Preview1Wasi as WasiConstructor } as WasiBuiltin;
  return Object.assign(builtin, { default: builtin });
}

function validateStdioOptions(options: WasiOptions): void {
  const requested = [
    ['stdin', options.stdin, 0],
    ['stdout', options.stdout, 1],
    ['stderr', options.stderr, 2]
  ] as const;
  for (const [name, actual, expected] of requested) {
    if (actual !== undefined && actual !== expected) {
      throw new RangeError(`WASI ${name} only supports descriptor ${expected}.`);
    }
  }
}
