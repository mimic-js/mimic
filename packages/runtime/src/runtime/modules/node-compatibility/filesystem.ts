import type {
  DirentLike,
  FileStatLike,
  VfsCommittedWatchEvent,
  VfsCommittedWatchOptions
} from '../virtual-file-system';
import { BrowserBuffer } from './buffer';
import { createNodeFileSystemDescriptorOperations, type NodeFileSystemStandardStreams } from './filesystem-descriptors';
import { globAsync, globSync, type GlobOptions } from './filesystem-glob';
import {
  errorCode,
  fileMode,
  type FileSystemPath,
  NODE_FS_CONSTANTS,
  nodeFileSystemErrorFromDomain,
  nodeFileSystemError,
  nodeStat,
  Stats,
  resolveFileSystemPath
} from './filesystem-shared';
import {
  createNodeFileSystemStreamConstructors,
  type ReadStreamOptions,
  type WriteStreamOptions
} from './filesystem-streams';
import {
  createNodeFileSystemWatchOperations,
  type NodeFileSystemWatchDiagnosticEvent,
  type NodeFileSystemWatchListener,
  type NodeFileSystemWatchOptions
} from './filesystem-watchers';

export interface NodeFileSystemWriteOptions {
  readonly append?: boolean;
  readonly exclusive?: boolean;
  readonly mode?: number;
}

export interface NodeFileSystemSynchronousPort {
  chmodSync(path: string, mode: number): void;
  closeFileSync(id: number): void;
  /** Answers existence without raising, when the port can do so more cheaply than a stat. */
  existsSync?(path: string): boolean;
  linkSync(existingPath: string, newPath: string): void;
  lstatSync(path: string): FileStatLike;
  mkdirSync(path: string, options?: { readonly recursive?: boolean; readonly mode?: number }): void;
  openFileSync(
    path: string,
    options: { readonly append: boolean; readonly readable: boolean; readonly writable: boolean }
  ): number;
  readOpenFileSync(id: number, length: number, position?: number): Uint8Array;
  readFileSync(path: string): Uint8Array;
  readdirSync(path: string, options?: { readonly withFileTypes?: boolean }): Array<string | DirentLike>;
  readlinkSync(path: string): string;
  realpathSync(path: string): string;
  renameSync(oldPath: string, newPath: string): void;
  rmSync(path: string, options?: { readonly recursive?: boolean; readonly force?: boolean }): void;
  statSync(path: string): FileStatLike;
  statOpenFileSync(id: number): FileStatLike;
  symlinkSync(target: string, path: string): void;
  utimesSync(path: string, mtimeMs: number): void;
  writeFileSync(path: string, data: string | Uint8Array, options?: NodeFileSystemWriteOptions): void;
  writeOpenFileSync(id: number, data: Uint8Array, position?: number): number;
}

export interface NodeFileSystemAsynchronousPort {
  access(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  closeFile(id: number): Promise<void>;
  link(existingPath: string, newPath: string): Promise<void>;
  lstat(path: string): Promise<FileStatLike>;
  mkdir(path: string, options?: { readonly recursive?: boolean; readonly mode?: number }): Promise<void>;
  openFile(
    path: string,
    options: { readonly append: boolean; readonly readable: boolean; readonly writable: boolean }
  ): Promise<number>;
  readOpenFile(id: number, length: number, position?: number): Promise<Uint8Array>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  readFile(path: string, encoding?: null): Promise<Uint8Array>;
  readdir(path: string, options?: { readonly withFileTypes?: boolean }): Promise<Array<string | DirentLike>>;
  readlink(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
  rename(oldPath: string, newPath: string): Promise<void>;
  rm(path: string, options?: { readonly recursive?: boolean; readonly force?: boolean }): Promise<void>;
  stat(path: string): Promise<FileStatLike>;
  statOpenFile(id: number): Promise<FileStatLike>;
  symlink(target: string, path: string): Promise<void>;
  utimes(path: string, mtimeMs: number): Promise<void>;
  writeFile(path: string, data: string | Uint8Array, options?: NodeFileSystemWriteOptions): Promise<void>;
  writeOpenFile(id: number, data: Uint8Array, position?: number): Promise<number>;
}

export interface NodeFileSystemWatchPort {
  watchCommitted(
    listener: (event: VfsCommittedWatchEvent) => void,
    options?: VfsCommittedWatchOptions
  ): () => void;
}

export interface NodeFileWatchHandle {
  close(): void;
  ref(): void;
  unref(): void;
}

export interface NodeFileWatchLifecycle {
  open(cleanup: () => void): NodeFileWatchHandle;
}

export interface NodeFileSystemScheduler {
  queueMicrotask(callback: VoidFunction): void;
  setTimeout(callback: VoidFunction, delay?: number): unknown;
}

export interface NodeFileSystemBuiltinsOptions {
  readonly asynchronous: NodeFileSystemAsynchronousPort;
  readonly cwd: string;
  readonly fileWatchLifecycle?: NodeFileWatchLifecycle;
  readonly scheduler: NodeFileSystemScheduler;
  readonly standardStreams?: NodeFileSystemStandardStreams;
  readonly synchronous: NodeFileSystemSynchronousPort;
  readonly watch?: NodeFileSystemWatchPort;
  readonly watchDiagnostics?: (event: NodeFileSystemWatchDiagnosticEvent) => void;
}

export interface NodeFileSystemBuiltins {
  readonly fs: object;
  readonly promises: object;
}

type PathEncodingOption = string | { readonly encoding?: string | null } | null;
type ReadFileOptions = string | { readonly encoding?: string | null; readonly flag?: string } | null;
type WriteFileOptions =
  | string
  | {
      readonly encoding?: string | null;
      readonly flag?: string | null;
      readonly mode?: string | number | null;
    }
  | null;
type FileData = string | ArrayBufferView;
type MkdirOptions =
  | number
  | string
  | null
  | { readonly recursive?: boolean; readonly mode?: string | number | null };
type ReaddirOptions =
  | string
  | { readonly withFileTypes?: boolean; readonly recursive?: boolean; readonly encoding?: string | null }
  | null;
type CopyOptions = {
  readonly errorOnExist?: boolean;
  readonly force?: boolean;
  readonly recursive?: boolean;
};
type NodeDirent = DirentLike & {
  readonly parentPath: string;
  readonly path: string;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
};

export function createNodeFileSystemBuiltins(inputOptions: NodeFileSystemBuiltinsOptions): NodeFileSystemBuiltins {
  const options: NodeFileSystemBuiltinsOptions = {
    ...inputOptions,
    // Read through, so relative paths follow `process.chdir()`.
    get cwd() {
      return inputOptions.cwd;
    },
    asynchronous: adaptVirtualFileSystemPort(inputOptions.asynchronous),
    synchronous: adaptVirtualFileSystemPort(inputOptions.synchronous)
  };
  const descriptorOperations = createNodeFileSystemDescriptorOperations(options);
  const { ReadStream, WriteStream } = createNodeFileSystemStreamConstructors(options);
  const watchOperations = createNodeFileSystemWatchOperations(options);

  const promisesBuiltin: Record<PropertyKey, unknown> = {
    constants: NODE_FS_CONSTANTS,
    access: (path: FileSystemPath) => options.asynchronous.access(resolveFileSystemPath(path, options.cwd)),
    appendFile: async (path: FileSystemPath, data: FileData | PromiseFileData, writeOptions?: WriteFileOptions) =>
      writeFileAsync(path, await collectedFileData(data, fileEncoding(writeOptions)), writeOptions, 'a'),
    chmod: (path: FileSystemPath, mode: string | number) =>
      options.asynchronous.chmod(resolveFileSystemPath(path, options.cwd), requiredMode(mode)),
    chown: (path: FileSystemPath) => changeOwnerAsync(path, 'stat'),
    copyFile: (source: FileSystemPath, destination: FileSystemPath, mode = 0) =>
      copyFileAsync(source, destination, mode),
    cp: (source: FileSystemPath, destination: FileSystemPath, copyOptions?: CopyOptions) =>
      copyAsync(
        resolveFileSystemPath(source, options.cwd),
        resolveFileSystemPath(destination, options.cwd),
        copyOptions
      ),
    glob: (pattern: string | readonly string[], globOptions?: GlobOptions) =>
      asyncValues(globMatchesAsync(pattern, globOptions)),
    lchown: (path: FileSystemPath) => changeOwnerAsync(path, 'lstat'),
    link: (existingPath: FileSystemPath, newPath: FileSystemPath) =>
      options.asynchronous.link(resolveFileSystemPath(existingPath, options.cwd), resolveFileSystemPath(newPath, options.cwd)),
    lutimes: (path: FileSystemPath, atime: string | number | Date, mtime: string | number | Date) =>
      linkTimesAsync(path, atime, mtime),
    lstat: async (path: FileSystemPath, statOptions?: { readonly bigint?: boolean }) =>
      nodeStat(await options.asynchronous.lstat(resolveFileSystemPath(path, options.cwd)), statOptions?.bigint === true),
    mkdir: async (path: FileSystemPath, mkdirOptions?: MkdirOptions) => {
      const normalized = resolveFileSystemPath(path, options.cwd);
      const existed = await existsAsync(normalized);
      await options.asynchronous.mkdir(normalized, mkdirSettings(mkdirOptions));
      return existed ? undefined : normalized;
    },
    mkdtemp: (prefix: string) => makeTemporaryDirectoryAsync(prefix),
    open: async (path: FileSystemPath, flags?: string | number, mode?: string | number) =>
      fileHandle(await descriptorOperations.open(path, flags, mode)),
    opendir: async (path: FileSystemPath) => {
      const normalized = resolveFileSystemPath(path, options.cwd);
      return createDirectoryHandle(normalized, await readDirectoryAsync(normalized, { withFileTypes: true }));
    },
    readFile: (path: FileSystemPath, readOptions?: ReadFileOptions) => readFileAsync(path, readOptions),
    readdir: (path: FileSystemPath, readdirOptions?: ReaddirOptions) =>
      readDirectoryAsync(resolveFileSystemPath(path, options.cwd), readdirOptions),
    readlink: async (path: FileSystemPath, readOptions?: PathEncodingOption) =>
      encodePathResult(
        await options.asynchronous.readlink(resolveFileSystemPath(path, options.cwd)),
        pathEncoding(readOptions)
      ),
    realpath: async (path: FileSystemPath, readOptions?: PathEncodingOption) =>
      encodePathResult(
        await options.asynchronous.realpath(resolveFileSystemPath(path, options.cwd)),
        pathEncoding(readOptions)
      ),
    rename: (oldPath: FileSystemPath, newPath: FileSystemPath) =>
      options.asynchronous.rename(resolveFileSystemPath(oldPath, options.cwd), resolveFileSystemPath(newPath, options.cwd)),
    rm: (path: FileSystemPath, rmOptions?: { readonly recursive?: boolean; readonly force?: boolean }) =>
      options.asynchronous.rm(resolveFileSystemPath(path, options.cwd), rmOptions),
    rmdir: (path: FileSystemPath) => removeDirectoryAsync(path),
    stat: async (path: FileSystemPath, statOptions?: { readonly bigint?: boolean }) =>
      nodeStat(await options.asynchronous.stat(resolveFileSystemPath(path, options.cwd)), statOptions?.bigint === true),
    statfs: async (_path: FileSystemPath) => fileSystemStatistics(),
    symlink: (target: string, path: FileSystemPath) =>
      options.asynchronous.symlink(target, resolveFileSystemPath(path, options.cwd)),
    utimes: (
      path: FileSystemPath,
      _atime: string | number | Date,
      mtime: string | number | Date
    ) =>
      options.asynchronous.utimes(
        resolveFileSystemPath(path, options.cwd),
        fileTimeMilliseconds(mtime)
      ),
    truncate: (path: FileSystemPath, length = 0) =>
      truncateAsync(resolveFileSystemPath(path, options.cwd), length),
    unlink: (path: FileSystemPath) => unlinkAsync(path),
    watch: (
      path: FileSystemPath,
      watchOptions?: { readonly recursive?: boolean; readonly signal?: AbortSignal }
    ) => watchEvents(path, watchOptions),
    writeFile: async (path: FileSystemPath, data: FileData | PromiseFileData, writeOptions?: WriteFileOptions) =>
      writeFileAsync(path, await collectedFileData(data, fileEncoding(writeOptions)), writeOptions, 'w')
  };
  promisesBuiltin.default = promisesBuiltin;

  const realpathSync = Object.assign(
    (path: FileSystemPath, readOptions?: PathEncodingOption) =>
      encodePathResult(
        options.synchronous.realpathSync(resolveFileSystemPath(path, options.cwd)),
        pathEncoding(readOptions)
      ),
    { native: undefined as unknown }
  );
  realpathSync.native = realpathSync;

  const realpath = Object.assign(
    (
      path: FileSystemPath,
      optionsOrCallback?:
        | PathEncodingOption
        | ((error: unknown, value?: string | Uint8Array) => void),
      callback?: (error: unknown, value?: string | Uint8Array) => void
    ) => {
      const callbackFunction = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
      const encoding = typeof optionsOrCallback === 'function' ? undefined : pathEncoding(optionsOrCallback);
      callbackPromise(
        callbackFunction,
        async () =>
          encodePathResult(
            await options.asynchronous.realpath(resolveFileSystemPath(path, options.cwd)),
            encoding
          )
      );
    },
    { native: undefined as unknown }
  );
  realpath.native = realpath;

  const fsBuiltin: Record<PropertyKey, unknown> = {
    constants: NODE_FS_CONSTANTS,
    promises: promisesBuiltin,
    ReadStream,
    Stats,
    WriteStream,
    access: (
      path: FileSystemPath,
      modeOrCallback?: number | ((error?: unknown) => void),
      callback?: (error?: unknown) => void
    ) => {
      const callbackFunction = typeof modeOrCallback === 'function' ? modeOrCallback : callback;
      callbackPromise(callbackFunction, () => options.asynchronous.access(resolveFileSystemPath(path, options.cwd)));
    },
    accessSync: (path: FileSystemPath, _mode?: number) => {
      options.synchronous.statSync(resolveFileSystemPath(path, options.cwd));
    },
    appendFile: (
      path: FileSystemPath,
      data: FileData,
      optionsOrCallback?: WriteFileOptions | ((error?: unknown) => void),
      callback?: (error?: unknown) => void
    ) => {
      const callbackFunction = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
      const writeOptions = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
      callbackPromise(callbackFunction, () => writeFileAsync(path, data, writeOptions, 'a'));
    },
    appendFileSync: (path: FileSystemPath, data: FileData, writeOptions?: WriteFileOptions) => {
      writeFileSync(path, data, writeOptions, 'a');
    },
    chmod: (path: FileSystemPath, mode: string | number, callback?: (error?: unknown) => void) => {
      callbackPromise(callback, () =>
        options.asynchronous.chmod(resolveFileSystemPath(path, options.cwd), requiredMode(mode))
      );
    },
    chmodSync: (path: FileSystemPath, mode: string | number) => {
      options.synchronous.chmodSync(resolveFileSystemPath(path, options.cwd), requiredMode(mode));
    },
    // The Virtual File System keeps no owners: every entry belongs to the
    // process's own user, so a change of owner only checks that the entry exists.
    chown: (path: FileSystemPath, _uid: number, _gid: number, callback?: (error?: unknown) => void) => {
      callbackPromise(callback, () => changeOwnerAsync(path, 'stat'));
    },
    chownSync: (path: FileSystemPath) => {
      options.synchronous.statSync(resolveFileSystemPath(path, options.cwd));
    },
    close: (descriptor: number, callback?: (error?: unknown) => void) => {
      // Node made the callback optional; a failure without one is thrown, as Node's default does.
      callbackPromise(callback ?? throwCloseError, () => descriptorOperations.close(descriptor));
    },
    closeSync: descriptorOperations.closeSync,
    copyFile: (
      source: FileSystemPath,
      destination: FileSystemPath,
      modeOrCallback?: number | ((error?: unknown) => void),
      callback?: (error?: unknown) => void
    ) => {
      const mode = typeof modeOrCallback === 'number' ? modeOrCallback : 0;
      const callbackFunction = typeof modeOrCallback === 'function' ? modeOrCallback : callback;
      callbackPromise(callbackFunction, () => copyFileAsync(source, destination, mode));
    },
    copyFileSync: (source: FileSystemPath, destination: FileSystemPath, mode = 0) => {
      copyFileSync(
        resolveFileSystemPath(source, options.cwd),
        resolveFileSystemPath(destination, options.cwd),
        mode
      );
    },
    cp: (
      source: FileSystemPath,
      destination: FileSystemPath,
      optionsOrCallback?: CopyOptions | ((error?: unknown) => void),
      callback?: (error?: unknown) => void
    ) => {
      const callbackFunction = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
      const copyOptions = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
      callbackPromise(callbackFunction, () =>
        copyAsync(
          resolveFileSystemPath(source, options.cwd),
          resolveFileSystemPath(destination, options.cwd),
          copyOptions
        )
      );
    },
    cpSync: (source: FileSystemPath, destination: FileSystemPath, copyOptions?: CopyOptions) => {
      copySync(
        resolveFileSystemPath(source, options.cwd),
        resolveFileSystemPath(destination, options.cwd),
        copyOptions
      );
    },
    createReadStream: (path: FileSystemPath, streamOptions?: ReadStreamOptions) =>
      new ReadStream(path, streamOptions),
    createWriteStream: (path: FileSystemPath, streamOptions?: WriteStreamOptions) =>
      new WriteStream(path, streamOptions),
    exists: (path: FileSystemPath, callback: (exists: boolean) => void) => {
      options.scheduler.queueMicrotask(() => {
        if (path === '') {
          callback(false);
          return;
        }
        void existsAsync(resolveFileSystemPath(path, options.cwd)).then(callback, () => callback(false));
      });
    },
    existsSync: (path: FileSystemPath) => path === '' ? false : existsSync(resolveFileSystemPath(path, options.cwd)),
    fstat: (
      descriptor: number,
      optionsOrCallback?:
        | { readonly bigint?: boolean }
        | ((error: unknown, value?: unknown) => void),
      callback?: (error: unknown, value?: unknown) => void
    ) => {
      const callbackFunction = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
      const statOptions = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
      callbackPromise(callbackFunction, () => descriptorOperations.stat(descriptor, statOptions));
    },
    fstatSync: (
      descriptor: number,
      statOptions?: { readonly bigint?: boolean }
    ) => descriptorOperations.statSync(descriptor, statOptions),
    fchmod: (descriptor: number, mode: string | number, callback?: (error?: unknown) => void) => {
      callbackPromise(callback, () =>
        options.asynchronous.chmod(descriptorOperations.pathOf(descriptor, 'fchmod'), requiredMode(mode))
      );
    },
    fchmodSync: (descriptor: number, mode: string | number) => {
      options.synchronous.chmodSync(descriptorOperations.pathOf(descriptor, 'fchmod'), requiredMode(mode));
    },
    fchown: (descriptor: number, _uid: number, _gid: number, callback?: (error?: unknown) => void) => {
      callbackPromise(callback, async () => {
        await descriptorOperations.stat(descriptor);
      });
    },
    fchownSync: (descriptor: number) => {
      descriptorOperations.statSync(descriptor);
    },
    fdatasync: (descriptor: number, callback?: (error?: unknown) => void) => {
      callbackPromise(callback, () => descriptorOperations.sync(descriptor));
    },
    fdatasyncSync: descriptorOperations.syncSync,
    fsync: (descriptor: number, callback?: (error?: unknown) => void) => {
      callbackPromise(callback, () => descriptorOperations.sync(descriptor));
    },
    fsyncSync: descriptorOperations.syncSync,
    ftruncate: (
      descriptor: number,
      lengthOrCallback?: number | ((error?: unknown) => void),
      callback?: (error?: unknown) => void
    ) => {
      const callbackFunction = typeof lengthOrCallback === 'function' ? lengthOrCallback : callback;
      const length = typeof lengthOrCallback === 'number' ? lengthOrCallback : 0;
      callbackPromise(callbackFunction, async () => {
        await descriptorOperations.sync(descriptor);
        await truncateAsync(descriptorOperations.pathOf(descriptor, 'ftruncate'), length);
      });
    },
    ftruncateSync: (descriptor: number, length = 0) => {
      truncateSync(descriptorOperations.pathOf(descriptor, 'ftruncate'), length);
    },
    futimes: (
      descriptor: number,
      _atime: string | number | Date,
      _mtime: string | number | Date,
      callback?: (error?: unknown) => void
    ) => {
      callbackPromise(callback, () => descriptorOperations.sync(descriptor));
    },
    futimesSync: (descriptor: number, _atime: string | number | Date, _mtime: string | number | Date) => {
      descriptorOperations.syncSync(descriptor);
    },
    glob: (
      pattern: string | readonly string[],
      optionsOrCallback?: GlobOptions | ((error: unknown, matches?: Array<string | DirentLike>) => void),
      callback?: (error: unknown, matches?: Array<string | DirentLike>) => void
    ) => {
      const callbackFunction = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
      const globOptions = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
      callbackPromise(callbackFunction, () => globMatchesAsync(pattern, globOptions));
    },
    globSync: (pattern: string | readonly string[], globOptions?: GlobOptions) =>
      globSync(pattern, globCwd(globOptions), globOptions ?? {}, (path) => directoryEntriesSync(path), globDirent),
    lchown: (path: FileSystemPath, _uid: number, _gid: number, callback?: (error?: unknown) => void) => {
      callbackPromise(callback, () => changeOwnerAsync(path, 'lstat'));
    },
    lchownSync: (path: FileSystemPath) => {
      options.synchronous.lstatSync(resolveFileSystemPath(path, options.cwd));
    },
    lutimes: (
      path: FileSystemPath,
      atime: string | number | Date,
      mtime: string | number | Date,
      callback?: (error?: unknown) => void
    ) => {
      callbackPromise(callback, () => linkTimesAsync(path, atime, mtime));
    },
    lutimesSync: (path: FileSystemPath, _atime: string | number | Date, mtime: string | number | Date) => {
      const normalized = resolveFileSystemPath(path, options.cwd);
      // The times of a symbolic link itself are not kept; a link's own are left as they are.
      if (options.synchronous.lstatSync(normalized).isSymbolicLink()) return;
      options.synchronous.utimesSync(normalized, fileTimeMilliseconds(mtime));
    },
    link: (
      existingPath: FileSystemPath,
      newPath: FileSystemPath,
      callback?: (error?: unknown) => void
    ) => {
      callbackPromise(callback, () =>
        options.asynchronous.link(
          resolveFileSystemPath(existingPath, options.cwd),
          resolveFileSystemPath(newPath, options.cwd)
        )
      );
    },
    linkSync: (existingPath: FileSystemPath, newPath: FileSystemPath) => {
      options.synchronous.linkSync(
        resolveFileSystemPath(existingPath, options.cwd),
        resolveFileSystemPath(newPath, options.cwd)
      );
    },
    lstat: (
      path: FileSystemPath,
      optionsOrCallback?:
        | { readonly bigint?: boolean }
        | ((error: unknown, value?: unknown) => void),
      callback?: (error: unknown, value?: unknown) => void
    ) => {
      const callbackFunction = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
      const statOptions = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
      callbackPromise(callbackFunction, async () =>
        nodeStat(
          await options.asynchronous.lstat(resolveFileSystemPath(path, options.cwd)),
          statOptions?.bigint === true
        )
      );
    },
    lstatSync: (
      path: FileSystemPath,
      statOptions?: { readonly throwIfNoEntry?: boolean; readonly bigint?: boolean }
    ) => {
      const normalized = resolveFileSystemPath(path, options.cwd);
      try {
        return nodeStat(options.synchronous.lstatSync(normalized), statOptions?.bigint === true);
      } catch (error) {
        if (statOptions?.throwIfNoEntry === false && errorCode(error) === 'ENOENT') return undefined;
        throw error;
      }
    },
    mkdir: (
      path: FileSystemPath,
      optionsOrCallback?: MkdirOptions | ((error: unknown, value?: string) => void),
      callback?: (error: unknown, value?: string) => void
    ) => {
      const callbackFunction = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
      const mkdirOptions = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
      callbackPromise<string | undefined>(callbackFunction, async () => {
        const normalized = resolveFileSystemPath(path, options.cwd);
        const existed = await existsAsync(normalized);
        await options.asynchronous.mkdir(normalized, mkdirSettings(mkdirOptions));
        return existed ? undefined : normalized;
      });
    },
    mkdirSync: (path: FileSystemPath, mkdirOptions?: MkdirOptions) => {
      options.synchronous.mkdirSync(resolveFileSystemPath(path, options.cwd), mkdirSettings(mkdirOptions));
    },
    mkdtemp: (
      prefix: string,
      optionsOrCallback?: PathEncodingOption | ((error: unknown, value?: string) => void),
      callback?: (error: unknown, value?: string) => void
    ) => {
      const callbackFunction = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
      callbackPromise(callbackFunction, () => makeTemporaryDirectoryAsync(prefix));
    },
    mkdtempSync: (prefix: string) => {
      const path = temporaryDirectoryPath(prefix);
      options.synchronous.mkdirSync(path);
      return path;
    },
    open: (
      path: FileSystemPath,
      flagsOrCallback?: string | number | ((error: unknown, descriptor?: number) => void),
      modeOrCallback?: string | number | ((error: unknown, descriptor?: number) => void),
      callback?: (error: unknown, descriptor?: number) => void
    ) => {
      const callbackFunction =
        typeof flagsOrCallback === 'function'
          ? flagsOrCallback
          : typeof modeOrCallback === 'function'
            ? modeOrCallback
            : callback;
      callbackPromise(callbackFunction, () =>
        descriptorOperations.open(
          path,
          typeof flagsOrCallback === 'function' ? undefined : flagsOrCallback,
          typeof modeOrCallback === 'function' ? undefined : modeOrCallback
        )
      );
    },
    opendir: (
      path: FileSystemPath,
      optionsOrCallback?:
        | { readonly encoding?: string | null }
        | ((error: unknown, value?: unknown) => void),
      callback?: (error: unknown, value?: unknown) => void
    ) => {
      const callbackFunction = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
      callbackPromise(callbackFunction, async () => {
        const normalized = resolveFileSystemPath(path, options.cwd);
        return createDirectoryHandle(normalized, await readDirectoryAsync(normalized, { withFileTypes: true }));
      });
    },
    opendirSync: (path: FileSystemPath) => {
      const normalized = resolveFileSystemPath(path, options.cwd);
      return createDirectoryHandle(normalized, readDirectorySync(normalized, { withFileTypes: true }));
    },
    openAsBlob: async (path: FileSystemPath, blobOptions?: { readonly type?: string }) =>
      new Blob([Uint8Array.from(await options.asynchronous.readFile(resolveFileSystemPath(path, options.cwd)))], {
        type: blobOptions?.type ?? ''
      }),
    openSync: descriptorOperations.openSync,
    read: (
      descriptor: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null,
      callback: (error: unknown, bytesRead?: number, value?: Uint8Array) => void
    ) => {
      callbackPromise<number, Uint8Array>(callback, async () => {
        const bytesRead = await descriptorOperations.read(descriptor, buffer, offset, length, position);
        return callbackValues(bytesRead, buffer);
      });
    },
    readFile: (
      path: FileSystemPath,
      optionsOrCallback?: ReadFileOptions | ((error: unknown, value?: string | Uint8Array) => void),
      callback?: (error: unknown, value?: string | Uint8Array) => void
    ) => {
      const callbackFunction = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
      const readOptions = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
      callbackPromise<string | Uint8Array>(callbackFunction, () => readFileAsync(path, readOptions));
    },
    readFileSync: (path: FileSystemPath, readOptions?: ReadFileOptions) =>
      decodeFile(
        options.synchronous.readFileSync(resolveFileSystemPath(path, options.cwd)),
        fileEncoding(readOptions)
      ),
    readdir: (
      path: FileSystemPath,
      optionsOrCallback?:
        | ReaddirOptions
        | ((error: unknown, value?: Array<string | DirentLike>) => void),
      callback?: (error: unknown, value?: Array<string | DirentLike>) => void
    ) => {
      const callbackFunction = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
      const readdirOptions = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
      callbackPromise(callbackFunction, () =>
        readDirectoryAsync(resolveFileSystemPath(path, options.cwd), readdirOptions)
      );
    },
    readdirSync: (path: FileSystemPath, readdirOptions?: ReaddirOptions) =>
      readDirectorySync(resolveFileSystemPath(path, options.cwd), readdirOptions),
    readlink: (
      path: FileSystemPath,
      optionsOrCallback?:
        | PathEncodingOption
        | ((error: unknown, value?: string | Uint8Array) => void),
      callback?: (error: unknown, value?: string | Uint8Array) => void
    ) => {
      const callbackFunction = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
      const encoding = typeof optionsOrCallback === 'function' ? undefined : pathEncoding(optionsOrCallback);
      callbackPromise(callbackFunction, async () =>
        encodePathResult(
          await options.asynchronous.readlink(resolveFileSystemPath(path, options.cwd)),
          encoding
        )
      );
    },
    readlinkSync: (path: FileSystemPath, readOptions?: PathEncodingOption) =>
      encodePathResult(
        options.synchronous.readlinkSync(resolveFileSystemPath(path, options.cwd)),
        pathEncoding(readOptions)
      ),
    readSync: descriptorOperations.readSync,
    readv: (
      descriptor: number,
      buffers: readonly ArrayBufferView[],
      positionOrCallback?: number | null | ((error: unknown, bytesRead?: number, value?: readonly ArrayBufferView[]) => void),
      callback?: (error: unknown, bytesRead?: number, value?: readonly ArrayBufferView[]) => void
    ) => {
      const callbackFunction = typeof positionOrCallback === 'function' ? positionOrCallback : callback;
      const position = typeof positionOrCallback === 'function' ? undefined : positionOrCallback;
      callbackPromise<number, readonly ArrayBufferView[]>(callbackFunction, async () =>
        callbackValues(await readVectorAsync(descriptor, buffers, position), buffers)
      );
    },
    readvSync: (descriptor: number, buffers: readonly ArrayBufferView[], position?: number | null) => {
      let total = 0;
      for (const view of buffers) {
        const bytes = viewBytes(view);
        const read = descriptorOperations.readSync(
          descriptor,
          bytes,
          0,
          bytes.byteLength,
          typeof position === 'number' ? position + total : null
        );
        total += read;
        if (read < bytes.byteLength) break;
      }
      return total;
    },
    realpath,
    realpathSync,
    rename: (
      oldPath: FileSystemPath,
      newPath: FileSystemPath,
      callback?: (error?: unknown) => void
    ) => {
      callbackPromise(callback, () =>
        options.asynchronous.rename(
          resolveFileSystemPath(oldPath, options.cwd),
          resolveFileSystemPath(newPath, options.cwd)
        )
      );
    },
    renameSync: (oldPath: FileSystemPath, newPath: FileSystemPath) => {
      options.synchronous.renameSync(
        resolveFileSystemPath(oldPath, options.cwd),
        resolveFileSystemPath(newPath, options.cwd)
      );
    },
    rm: (
      path: FileSystemPath,
      optionsOrCallback?:
        | { readonly recursive?: boolean; readonly force?: boolean }
        | ((error?: unknown) => void),
      callback?: (error?: unknown) => void
    ) => {
      const callbackFunction = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
      const rmOptions = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
      callbackPromise(callbackFunction, () =>
        options.asynchronous.rm(resolveFileSystemPath(path, options.cwd), rmOptions)
      );
    },
    rmSync: (
      path: FileSystemPath,
      rmOptions?: { readonly recursive?: boolean; readonly force?: boolean }
    ) => {
      options.synchronous.rmSync(resolveFileSystemPath(path, options.cwd), rmOptions);
    },
    rmdir: (
      path: FileSystemPath,
      optionsOrCallback?: { readonly recursive?: boolean } | ((error?: unknown) => void),
      callback?: (error?: unknown) => void
    ) => {
      const callbackFunction = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
      callbackPromise(callbackFunction, () => removeDirectoryAsync(path));
    },
    rmdirSync: (path: FileSystemPath) => {
      const normalized = resolveFileSystemPath(path, options.cwd);
      if (!options.synchronous.statSync(normalized).isDirectory()) {
        throw nodeFileSystemError('ENOTDIR', `not a directory, rmdir '${normalized}'`, normalized, 'rmdir');
      }
      options.synchronous.rmSync(normalized);
    },
    stat: (
      path: FileSystemPath,
      optionsOrCallback?:
        | { readonly bigint?: boolean }
        | ((error: unknown, value?: unknown) => void),
      callback?: (error: unknown, value?: unknown) => void
    ) => {
      const callbackFunction = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
      const statOptions = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
      callbackPromise(callbackFunction, async () =>
        nodeStat(
          await options.asynchronous.stat(resolveFileSystemPath(path, options.cwd)),
          statOptions?.bigint === true
        )
      );
    },
    statSync: (
      path: FileSystemPath,
      statOptions?: { readonly throwIfNoEntry?: boolean; readonly bigint?: boolean }
    ) => {
      const normalized = resolveFileSystemPath(path, options.cwd);
      try {
        return nodeStat(options.synchronous.statSync(normalized), statOptions?.bigint === true);
      } catch (error) {
        if (statOptions?.throwIfNoEntry === false && errorCode(error) === 'ENOENT') return undefined;
        throw error;
      }
    },
    statfs: (
      _path: FileSystemPath,
      optionsOrCallback?: { readonly bigint?: boolean } | ((error: unknown, value?: unknown) => void),
      callback?: (error: unknown, value?: unknown) => void
    ) => {
      const callbackFunction = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
      callbackPromise(callbackFunction, () => fileSystemStatistics());
    },
    statfsSync: (_path: FileSystemPath) => fileSystemStatistics(),
    symlink: (
      target: string,
      path: FileSystemPath,
      typeOrCallback?: string | ((error?: unknown) => void),
      callback?: (error?: unknown) => void
    ) => {
      const callbackFunction = typeof typeOrCallback === 'function' ? typeOrCallback : callback;
      callbackPromise(callbackFunction, () =>
        options.asynchronous.symlink(target, resolveFileSystemPath(path, options.cwd))
      );
    },
    symlinkSync: (target: string, path: FileSystemPath) => {
      options.synchronous.symlinkSync(target, resolveFileSystemPath(path, options.cwd));
    },
    utimes: (
      path: FileSystemPath,
      _atime: string | number | Date,
      mtime: string | number | Date,
      callback?: (error?: unknown) => void
    ) => {
      callbackPromise(callback, () =>
        options.asynchronous.utimes(
          resolveFileSystemPath(path, options.cwd),
          fileTimeMilliseconds(mtime)
        )
      );
    },
    utimesSync: (
      path: FileSystemPath,
      _atime: string | number | Date,
      mtime: string | number | Date
    ) => {
      options.synchronous.utimesSync(
        resolveFileSystemPath(path, options.cwd),
        fileTimeMilliseconds(mtime)
      );
    },
    truncate: (
      path: FileSystemPath,
      lengthOrCallback?: number | ((error?: unknown) => void),
      callback?: (error?: unknown) => void
    ) => {
      const callbackFunction = typeof lengthOrCallback === 'function' ? lengthOrCallback : callback;
      const length = typeof lengthOrCallback === 'number' ? lengthOrCallback : 0;
      callbackPromise(callbackFunction, () =>
        truncateAsync(resolveFileSystemPath(path, options.cwd), length)
      );
    },
    truncateSync: (path: FileSystemPath, length = 0) => {
      truncateSync(resolveFileSystemPath(path, options.cwd), length);
    },
    unlink: (path: FileSystemPath, callback?: (error?: unknown) => void) => {
      callbackPromise(callback, () => unlinkAsync(path));
    },
    unlinkSync: (path: FileSystemPath) => {
      const normalized = resolveFileSystemPath(path, options.cwd);
      // lstat keeps the operation on the link itself, so a symlink to a
      // directory or to nothing is removed rather than followed.
      if (options.synchronous.lstatSync(normalized).isDirectory()) throw unlinkDirectoryError(normalized);
      options.synchronous.rmSync(normalized);
    },
    unwatchFile: (path: FileSystemPath, listener?: (current: unknown, previous: unknown) => void) => {
      watchOperations.unwatchFile(path, listener);
    },
    watch: (
      path: FileSystemPath,
      optionsOrListener?: NodeFileSystemWatchOptions | string | NodeFileSystemWatchListener,
      listener?: NodeFileSystemWatchListener
    ) => watchOperations.watch(path, optionsOrListener, listener),
    watchFile: (
      path: FileSystemPath,
      optionsOrListener?:
        | { readonly interval?: number }
        | ((current: unknown, previous: unknown) => void),
      listener?: (current: unknown, previous: unknown) => void
    ) => watchOperations.watchFile(path, optionsOrListener, listener),
    // `write(fd, buffer[, offset[, length[, position]]], callback)` and
    // `write(fd, string[, position[, encoding]], callback)`: the callback is
    // the first function, wherever the optional arguments end.
    write: (descriptor: number, data: string | Uint8Array, ...rest: unknown[]) => {
      const callbackIndex = rest.findIndex((value) => typeof value === 'function');
      const callbackFunction = (callbackIndex === -1 ? undefined : rest[callbackIndex]) as
        | ((error: unknown, written?: number, value?: string | Uint8Array) => void)
        | undefined;
      const [offsetOrPosition, lengthOrEncoding, position] = (callbackIndex === -1 ? rest : rest.slice(0, callbackIndex)) as [
        number | null | undefined,
        number | string | undefined,
        number | null | undefined
      ];
      callbackPromise<number, string | Uint8Array>(callbackFunction, async () => {
        const written = await descriptorOperations.write(
          descriptor,
          data,
          offsetOrPosition,
          lengthOrEncoding,
          typeof position === 'number' || position === null ? position : undefined
        );
        return callbackValues(written, data);
      });
    },
    writeFile: (
      path: FileSystemPath,
      data: FileData,
      optionsOrCallback?: WriteFileOptions | ((error?: unknown) => void),
      callback?: (error?: unknown) => void
    ) => {
      const callbackFunction = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
      const writeOptions = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
      callbackPromise(callbackFunction, () => writeFileAsync(path, data, writeOptions, 'w'));
    },
    writeFileSync: (path: FileSystemPath, data: FileData, writeOptions?: WriteFileOptions) => {
      writeFileSync(path, data, writeOptions, 'w');
    },
    writeSync: descriptorOperations.writeSync,
    writev: (
      descriptor: number,
      buffers: readonly ArrayBufferView[],
      positionOrCallback?: number | null | ((error: unknown, written?: number, value?: readonly ArrayBufferView[]) => void),
      callback?: (error: unknown, written?: number, value?: readonly ArrayBufferView[]) => void
    ) => {
      const callbackFunction = typeof positionOrCallback === 'function' ? positionOrCallback : callback;
      const position = typeof positionOrCallback === 'function' ? undefined : positionOrCallback;
      callbackPromise<number, readonly ArrayBufferView[]>(callbackFunction, async () =>
        callbackValues(await writeVectorAsync(descriptor, buffers, position), buffers)
      );
    },
    writevSync: (descriptor: number, buffers: readonly ArrayBufferView[], position?: number | null) => {
      let total = 0;
      for (const view of buffers) {
        total += descriptorOperations.writeSync(
          descriptor,
          viewBytes(view),
          0,
          view.byteLength,
          typeof position === 'number' ? position + total : null
        );
      }
      return total;
    }
  };
  fsBuiltin.default = fsBuiltin;
  // `exists` calls back with the answer alone, so `util.promisify` takes this form, as Node's does.
  Object.defineProperty(fsBuiltin.exists as object, Symbol.for('nodejs.util.promisify.custom'), {
    configurable: true,
    value: (path: FileSystemPath) =>
      new Promise<boolean>((resolve) => (fsBuiltin.exists as (path: FileSystemPath, callback: (exists: boolean) => void) => void)(path, resolve))
  });

  return { fs: fsBuiltin, promises: promisesBuiltin };

  function callbackPromise<Value, Extra = never>(
    callback: ((error: unknown, value?: Value, extra?: Extra) => void) | undefined,
    operation: () =>
      | CallbackValues<Value, Extra>
      | Promise<CallbackValues<Value, Extra> | Value>
      | Value
  ): void {
    if (!callback) throw nodeFileSystemError('ERR_INVALID_ARG_TYPE', 'A callback function is required.');
    options.scheduler.queueMicrotask(() => {
      void Promise.resolve()
        .then(operation)
        .then(
          (value) => {
            if (isCallbackValues<Value, Extra>(value)) callback(null, value.value, value.extra);
            else callback(null, value);
          },
          (error: unknown) => callback(error)
        );
    });
  }

  function decodeFile(bytes: Uint8Array, encoding: string | null | undefined): string | Uint8Array {
    if (encoding === undefined || encoding === null || encoding === 'buffer') {
      // The port hands over bytes this call owns, so the Buffer can wrap them in place.
      return bytes.buffer instanceof ArrayBuffer
        ? BrowserBuffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : BrowserBuffer.from(bytes);
    }
    if (isUtf8(encoding)) return new TextDecoder().decode(bytes);
    return BrowserBuffer.from(bytes).toString(encoding);
  }

  async function readFileAsync(
    path: FileSystemPath,
    readOptions?: ReadFileOptions
  ): Promise<string | Uint8Array> {
    const encoding = fileEncoding(readOptions);
    const normalized = resolveFileSystemPath(path, options.cwd);
    if (isUtf8(encoding)) return options.asynchronous.readFile(normalized, 'utf8');
    return decodeFile(await options.asynchronous.readFile(normalized), encoding);
  }

  function writeFileSync(
    path: FileSystemPath,
    data: FileData,
    writeOptions: WriteFileOptions | undefined,
    defaultFlag: string
  ): void {
    const normalized = resolveFileSystemPath(path, options.cwd);
    const write = writeSettings(writeOptions, defaultFlag);
    if (write.requireExisting) options.synchronous.statSync(normalized);
    options.synchronous.writeFileSync(normalized, fileData(data, write.encoding), write.options);
  }

  async function writeFileAsync(
    path: FileSystemPath,
    data: FileData,
    writeOptions: WriteFileOptions | undefined,
    defaultFlag: string
  ): Promise<void> {
    const normalized = resolveFileSystemPath(path, options.cwd);
    const write = writeSettings(writeOptions, defaultFlag);
    if (write.requireExisting) await options.asynchronous.stat(normalized);
    await options.asynchronous.writeFile(normalized, fileData(data, write.encoding), write.options);
  }

  function copyFileSync(source: string, destination: string, mode: number): void {
    const permissions = options.synchronous.statSync(source).mode;
    try {
      options.synchronous.writeFileSync(destination, options.synchronous.readFileSync(source), {
        exclusive: (mode & NODE_FS_CONSTANTS.COPYFILE_EXCL) !== 0,
        mode: permissions === undefined ? undefined : permissions & 0o7777
      });
    } catch (error) {
      throw copyFileError(error, source, destination);
    }
  }

  async function copyFileAsync(
    source: FileSystemPath,
    destination: FileSystemPath,
    mode: number
  ): Promise<void> {
    const normalizedSource = resolveFileSystemPath(source, options.cwd);
    const normalizedDestination = resolveFileSystemPath(destination, options.cwd);
    const permissions = (await options.asynchronous.stat(normalizedSource)).mode;
    try {
      await options.asynchronous.writeFile(
        normalizedDestination,
        await options.asynchronous.readFile(normalizedSource),
        {
          exclusive: (mode & NODE_FS_CONSTANTS.COPYFILE_EXCL) !== 0,
          mode: permissions === undefined ? undefined : permissions & 0o7777
        }
      );
    } catch (error) {
      throw copyFileError(error, normalizedSource, normalizedDestination);
    }
  }

  function copySync(source: string, destination: string, copyOptions?: CopyOptions): void {
    const stat = options.synchronous.lstatSync(source);
    if (stat.isSymbolicLink()) {
      if (existsSync(destination)) options.synchronous.rmSync(destination, { recursive: true, force: true });
      options.synchronous.symlinkSync(options.synchronous.readlinkSync(source), destination);
      return;
    }
    if (!stat.isDirectory()) {
      const exists = existsSync(destination);
      if (exists && copyOptions?.errorOnExist && copyOptions.force === false) {
        throw copyExistsError(source, destination);
      }
      if (exists && copyOptions?.force === false) return;
      copyFileSync(source, destination, 0);
      return;
    }
    if (!copyOptions?.recursive) throw copyDirectoryError(source);
    options.synchronous.mkdirSync(destination, { recursive: true });
    for (const name of options.synchronous.readdirSync(source)) {
      if (typeof name !== 'string') continue;
      copySync(`${source}/${name}`, `${destination}/${name}`, copyOptions);
    }
  }

  async function copyAsync(source: string, destination: string, copyOptions?: CopyOptions): Promise<void> {
    const stat = await options.asynchronous.lstat(source);
    if (stat.isSymbolicLink()) {
      if (await existsAsync(destination)) {
        await options.asynchronous.rm(destination, { recursive: true, force: true });
      }
      await options.asynchronous.symlink(await options.asynchronous.readlink(source), destination);
      return;
    }
    if (!stat.isDirectory()) {
      const exists = await existsAsync(destination);
      if (exists && copyOptions?.errorOnExist && copyOptions.force === false) {
        throw copyExistsError(source, destination);
      }
      if (exists && copyOptions?.force === false) return;
      await copyFileAsync(source, destination, 0);
      return;
    }
    if (!copyOptions?.recursive) throw copyDirectoryError(source);
    await options.asynchronous.mkdir(destination, { recursive: true });
    for (const name of await options.asynchronous.readdir(source)) {
      if (typeof name !== 'string') continue;
      await copyAsync(`${source}/${name}`, `${destination}/${name}`, copyOptions);
    }
  }

  function readDirectorySync(path: string, readdirOptions?: ReaddirOptions): Array<string | DirentLike> {
    const settings = readdirSettings(readdirOptions);
    if (!settings.recursive) {
      const entries = options.synchronous.readdirSync(path, { withFileTypes: settings.withFileTypes });
      return settings.withFileTypes ? entries.map((entry) => nodeDirent(entry, path)) : entries;
    }
    const collected: Array<string | DirentLike> = [];
    const pending = [path];
    for (let directory = pending.shift(); directory !== undefined; directory = pending.shift()) {
      for (const entry of options.synchronous.readdirSync(directory, { withFileTypes: true })) {
        if (typeof entry === 'string') continue;
        const child = `${directory === '/' ? '' : directory}/${entry.name}`;
        collected.push(settings.withFileTypes ? nodeDirent(entry, directory) : child.slice(path.length + 1));
        if (entry.isDirectory()) pending.push(child);
      }
    }
    return collected;
  }

  async function readDirectoryAsync(
    path: string,
    readdirOptions?: ReaddirOptions
  ): Promise<Array<string | DirentLike>> {
    const settings = readdirSettings(readdirOptions);
    if (!settings.recursive) {
      const entries = await options.asynchronous.readdir(path, { withFileTypes: settings.withFileTypes });
      return settings.withFileTypes ? entries.map((entry) => nodeDirent(entry, path)) : entries;
    }
    const collected: Array<string | DirentLike> = [];
    const pending = [path];
    for (let directory = pending.shift(); directory !== undefined; directory = pending.shift()) {
      for (const entry of await options.asynchronous.readdir(directory, { withFileTypes: true })) {
        if (typeof entry === 'string') continue;
        const child = `${directory === '/' ? '' : directory}/${entry.name}`;
        collected.push(settings.withFileTypes ? nodeDirent(entry, directory) : child.slice(path.length + 1));
        if (entry.isDirectory()) pending.push(child);
      }
    }
    return collected;
  }

  function truncateSync(path: string, length: number): void {
    options.synchronous.writeFileSync(path, resized(options.synchronous.readFileSync(path), length));
  }

  async function truncateAsync(path: string, length: number): Promise<void> {
    await options.asynchronous.writeFile(path, resized(await options.asynchronous.readFile(path), length));
  }

  async function unlinkAsync(path: FileSystemPath): Promise<void> {
    const normalized = resolveFileSystemPath(path, options.cwd);
    if ((await options.asynchronous.lstat(normalized)).isDirectory()) throw unlinkDirectoryError(normalized);
    await options.asynchronous.rm(normalized);
  }

  async function removeDirectoryAsync(path: FileSystemPath): Promise<void> {
    const normalized = resolveFileSystemPath(path, options.cwd);
    if (!(await options.asynchronous.stat(normalized)).isDirectory()) {
      throw nodeFileSystemError('ENOTDIR', `not a directory, rmdir '${normalized}'`, normalized, 'rmdir');
    }
    await options.asynchronous.rm(normalized);
  }

  function temporaryDirectoryPath(prefix: string): string {
    const suffix = Array.from({ length: 6 }, () =>
      TEMPORARY_NAME_ALPHABET[Math.floor(Math.random() * TEMPORARY_NAME_ALPHABET.length)]
    ).join('');
    return resolveFileSystemPath(`${prefix}${suffix}`, options.cwd);
  }

  async function makeTemporaryDirectoryAsync(prefix: string): Promise<string> {
    const path = temporaryDirectoryPath(prefix);
    await options.asynchronous.mkdir(path);
    return path;
  }

  /** Yields committed changes under a path until the caller stops iterating or aborts. */
  function watchEvents(
    path: FileSystemPath,
    watchOptions?: { readonly recursive?: boolean; readonly signal?: AbortSignal }
  ): AsyncIterableIterator<{ readonly eventType: string; readonly filename: string }> {
    const events: Array<{ readonly eventType: string; readonly filename: string }> = [];
    let wake: (() => void) | undefined;
    let closed = false;
    const watcher = watchOperations.watch(
      path,
      { recursive: watchOptions?.recursive },
      (eventType, filename) => {
        events.push({ eventType, filename: String(filename) });
        wake?.();
      }
    ) as { close?(): void };
    const close = (): void => {
      if (closed) return;
      closed = true;
      watcher.close?.();
      wake?.();
    };
    watchOptions?.signal?.addEventListener('abort', close, { once: true });
    if (watchOptions?.signal?.aborted) close();
    const iterator: AsyncIterableIterator<{ readonly eventType: string; readonly filename: string }> = {
      [Symbol.asyncIterator]: () => iterator,
      async next() {
        while (events.length === 0 && !closed) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
        }
        const value = events.shift();
        return value ? { done: false, value } : { done: true, value: undefined };
      },
      async return() {
        close();
        return { done: true, value: undefined };
      }
    };
    return iterator;
  }

  async function changeOwnerAsync(path: FileSystemPath, follow: 'stat' | 'lstat'): Promise<void> {
    await options.asynchronous[follow](resolveFileSystemPath(path, options.cwd));
  }

  async function linkTimesAsync(
    path: FileSystemPath,
    _atime: string | number | Date,
    mtime: string | number | Date
  ): Promise<void> {
    const normalized = resolveFileSystemPath(path, options.cwd);
    if ((await options.asynchronous.lstat(normalized)).isSymbolicLink()) return;
    await options.asynchronous.utimes(normalized, fileTimeMilliseconds(mtime));
  }

  function globCwd(globOptions?: GlobOptions): string {
    const cwd = globOptions?.cwd;
    if (cwd === undefined) return options.cwd;
    return resolveFileSystemPath(cwd, options.cwd);
  }

  function globMatchesAsync(
    pattern: string | readonly string[],
    globOptions?: GlobOptions
  ): Promise<Array<string | DirentLike>> {
    return globAsync(
      pattern,
      globCwd(globOptions),
      globOptions ?? {},
      async (path) => directoryEntries(await options.asynchronous.readdir(path, { withFileTypes: true })),
      globDirent
    );
  }

  function directoryEntriesSync(path: string): DirentLike[] {
    return directoryEntries(options.synchronous.readdirSync(path, { withFileTypes: true }));
  }

  async function readVectorAsync(
    descriptor: number,
    buffers: readonly ArrayBufferView[],
    position: number | null | undefined
  ): Promise<number> {
    let total = 0;
    for (const view of buffers) {
      const bytes = viewBytes(view);
      const read = await descriptorOperations.read(
        descriptor,
        bytes,
        0,
        bytes.byteLength,
        typeof position === 'number' ? position + total : null
      );
      total += read;
      if (read < bytes.byteLength) break;
    }
    return total;
  }

  async function writeVectorAsync(
    descriptor: number,
    buffers: readonly ArrayBufferView[],
    position: number | null | undefined
  ): Promise<number> {
    let total = 0;
    for (const view of buffers) {
      total += await descriptorOperations.write(
        descriptor,
        viewBytes(view),
        0,
        view.byteLength,
        typeof position === 'number' ? position + total : null
      );
    }
    return total;
  }

  /** A `FileHandle` of `fs/promises`: the descriptor's own operations and the path-based ones on the file it opened. */
  function fileHandle(descriptor: number): object {
    const path = () => descriptorOperations.pathOf(descriptor, 'fstat');
    const writeAll = async (data: FileData | PromiseFileData, writeOptions?: WriteFileOptions) => {
      const bytes = fileData(await collectedFileData(data, fileEncoding(writeOptions)), fileEncoding(writeOptions));
      await descriptorOperations.write(
        descriptor,
        typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes,
        0,
        undefined,
        null
      );
    };
    return Object.assign(descriptorOperations.createFileHandle(descriptor), {
      appendFile: writeAll,
      chmod: (mode: string | number) => options.asynchronous.chmod(path(), requiredMode(mode)),
      chown: async () => {
        await descriptorOperations.stat(descriptor);
      },
      createReadStream: (streamOptions?: ReadStreamOptions) => new ReadStream(path(), streamOptions),
      createWriteStream: (streamOptions?: WriteStreamOptions) =>
        new WriteStream(path(), { flags: 'r+', ...(streamOptions as object) } as WriteStreamOptions),
      datasync: () => descriptorOperations.sync(descriptor),
      getAsyncId: () => descriptor,
      readFile: async (readOptions?: ReadFileOptions) => {
        // From the descriptor's current position to the end, as Node reads it.
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const chunk = new Uint8Array(64 * 1024);
          const read = await descriptorOperations.read(descriptor, chunk, 0, chunk.byteLength, null);
          if (read === 0) break;
          chunks.push(chunk.subarray(0, read));
          size += read;
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return decodeFile(bytes, fileEncoding(readOptions));
      },
      readv: async (buffers: readonly ArrayBufferView[], position?: number | null) => ({
        buffers,
        bytesRead: await readVectorAsync(descriptor, buffers, position)
      }),
      truncate: async (length = 0) => {
        await descriptorOperations.sync(descriptor);
        await truncateAsync(path(), length);
      },
      utimes: (_atime: string | number | Date, mtime: string | number | Date) =>
        options.asynchronous.utimes(path(), fileTimeMilliseconds(mtime)),
      writeFile: writeAll,
      writev: async (buffers: readonly ArrayBufferView[], position?: number | null) => ({
        buffers,
        bytesWritten: await writeVectorAsync(descriptor, buffers, position)
      })
    });
  }

  function existsSync(path: string): boolean {
    if (options.synchronous.existsSync) return options.synchronous.existsSync(path);
    try {
      options.synchronous.statSync(path);
      return true;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    }
  }

  async function existsAsync(path: string): Promise<boolean> {
    try {
      await options.asynchronous.access(path);
      return true;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    }
  }
}

function adaptVirtualFileSystemPort<Port extends object>(port: Port): Port {
  return new Proxy(port, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        try {
          const result = Reflect.apply(value as (...callArgs: unknown[]) => unknown, target, args);
          return isPromiseLike(result)
            ? result.catch((error: unknown) => {
                throw nodeFileSystemErrorFromDomain(error);
              })
            : result;
        } catch (error) {
          throw nodeFileSystemErrorFromDomain(error);
        }
      };
    }
  });
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return value !== null &&
    value !== undefined &&
    (typeof value === 'object' || typeof value === 'function') &&
    'then' in value;
}

type CallbackValues<Value, Extra> = {
  readonly kind: 'callback-values';
  readonly value: Value;
  readonly extra: Extra;
};

function callbackValues<Value, Extra>(value: Value, extra: Extra): CallbackValues<Value, Extra> {
  return { extra, kind: 'callback-values', value };
}

function isCallbackValues<Value, Extra>(value: unknown): value is CallbackValues<Value, Extra> {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'callback-values';
}

function pathEncoding(options?: PathEncodingOption): string | null | undefined {
  return typeof options === 'string' ? options : options?.encoding;
}

const TEMPORARY_NAME_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function fileEncoding(options?: ReadFileOptions | WriteFileOptions): string | null | undefined {
  return typeof options === 'string' ? options : options?.encoding;
}

function throwCloseError(error?: unknown): void {
  if (error !== null && error !== undefined) throw error;
}

/** What the promise API also writes, as Node 22's does: the chunks of an iterable or a stream. */
type PromiseFileData = Iterable<FileData> | AsyncIterable<FileData>;

/**
 * The data a promise-API write is given, with an iterable's or a stream's
 * chunks gathered into one buffer (create-expo-app writes each template file
 * from the stream of its tar entry).
 */
async function collectedFileData(
  data: FileData | PromiseFileData,
  encoding: string | null | undefined
): Promise<FileData> {
  if (typeof data === 'string' || ArrayBuffer.isView(data)) return data;
  const iterable = data as Partial<PromiseFileData> | null;
  if (
    iterable === null ||
    typeof iterable !== 'object' ||
    (typeof (iterable as AsyncIterable<unknown>)[Symbol.asyncIterator] !== 'function' &&
      typeof (iterable as Iterable<unknown>)[Symbol.iterator] !== 'function')
  ) {
    return data as FileData;
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of iterable as AsyncIterable<FileData>) {
    const bytes = fileData(chunk, encoding);
    chunks.push(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes.slice());
  }
  return BrowserBuffer.concat(chunks);
}

function fileData(
  data: FileData,
  encoding: string | null | undefined
): string | Uint8Array {
  if (typeof data === 'string') {
    return encoding === undefined || encoding === null || isUtf8(encoding)
      ? data
      : BrowserBuffer.from(data, encoding);
  }
  // A plain view, never the caller's Buffer: the file system port copies with
  // `slice()`, which on a Buffer would only alias the caller's memory.
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw nodeFileSystemError(
    'ERR_INVALID_ARG_TYPE',
    'The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView.'
  );
}

function writeSettings(
  writeOptions: WriteFileOptions | undefined,
  defaultFlag: string
): {
  readonly encoding: string | null | undefined;
  readonly options: NodeFileSystemWriteOptions;
  readonly requireExisting: boolean;
} {
  const settings = typeof writeOptions === 'string' || !writeOptions ? {} : writeOptions;
  const flag = settings.flag ?? defaultFlag;
  if (!/^(?:[wa]x?\+?|[wa]\+x|r\+|[ar]s\+?)$/.test(flag)) {
    throw nodeFileSystemError('ERR_INVALID_ARG_VALUE', `The argument 'flags' is invalid. Received '${flag}'`);
  }
  return {
    encoding: fileEncoding(writeOptions),
    options: {
      append: flag.startsWith('a') || undefined,
      exclusive: flag.includes('x') || undefined,
      mode: fileMode(settings.mode)
    },
    // 'r+' writes only to a file that already exists.
    requireExisting: flag.startsWith('r')
  };
}

function requiredMode(mode: string | number): number {
  const parsed = fileMode(mode);
  if (parsed === undefined) {
    throw nodeFileSystemError('ERR_INVALID_ARG_TYPE', 'The "mode" argument must be of type number or string.');
  }
  return parsed;
}

function mkdirSettings(
  mkdirOptions?: MkdirOptions
): { readonly recursive?: boolean; readonly mode?: number } | undefined {
  if (mkdirOptions === undefined || mkdirOptions === null) return undefined;
  if (typeof mkdirOptions !== 'object') return { mode: fileMode(mkdirOptions) };
  return { recursive: mkdirOptions.recursive, mode: fileMode(mkdirOptions.mode) };
}

function readdirSettings(readdirOptions?: ReaddirOptions): {
  readonly recursive: boolean;
  readonly withFileTypes: boolean;
} {
  const settings = typeof readdirOptions === 'string' || !readdirOptions ? {} : readdirOptions;
  return { recursive: settings.recursive === true, withFileTypes: settings.withFileTypes === true };
}

function nodeDirent(entry: string | DirentLike, parentPath: string): string | NodeDirent {
  if (typeof entry === 'string') return entry;
  return {
    name: entry.name,
    parentPath,
    path: parentPath,
    isFile: () => entry.isFile(),
    isDirectory: () => entry.isDirectory(),
    isSymbolicLink: () => entry.isSymbolicLink(),
    // The Virtual File System holds files, directories and symbolic links only.
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false
  };
}

function createDirectoryHandle(path: string, entries: Array<string | DirentLike>): object {
  const remaining = entries.filter((entry): entry is DirentLike => typeof entry !== 'string');
  let closed = false;
  const read = (): DirentLike | null => {
    if (closed) throw nodeFileSystemError('ERR_DIR_CLOSED', 'Directory handle was closed');
    return remaining.shift() ?? null;
  };
  const close = (): void => {
    closed = true;
  };
  return {
    path,
    read: async () => read(),
    readSync: read,
    close: async () => close(),
    closeSync: close,
    async *[Symbol.asyncIterator]() {
      try {
        for (let entry = read(); entry; entry = read()) yield entry;
      } finally {
        close();
      }
    }
  };
}

function resized(bytes: Uint8Array, length: number): Uint8Array {
  if (!Number.isInteger(length) || length < 0) {
    throw nodeFileSystemError('ERR_OUT_OF_RANGE', `The value of "len" is out of range. Received ${length}`);
  }
  if (length <= bytes.byteLength) return bytes.subarray(0, length);
  const grown = new Uint8Array(length);
  grown.set(bytes);
  return grown;
}

function viewBytes(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function directoryEntries(entries: Array<string | DirentLike>): DirentLike[] {
  return entries.filter((entry): entry is DirentLike => typeof entry !== 'string');
}

function globDirent(entry: DirentLike, parentPath: string): DirentLike {
  return nodeDirent(entry, parentPath) as DirentLike;
}

/** An async iterator over values a promise settles to, as `fs.promises.glob` returns. */
function asyncValues<Value>(values: Promise<readonly Value[]>): AsyncIterableIterator<Value> {
  let pending: Value[] | undefined;
  const iterator: AsyncIterableIterator<Value> = {
    [Symbol.asyncIterator]: () => iterator,
    async next() {
      pending ??= [...(await values)];
      return pending.length > 0 ? { done: false, value: pending.shift()! } : { done: true, value: undefined };
    }
  };
  return iterator;
}

function fileSystemStatistics(): object {
  // The VFS lives in memory and reports no quota; these values only keep callers that size buffers working.
  return { type: 0, bsize: 4_096, blocks: 0, bfree: 0, bavail: 0, files: 0, ffree: 0 };
}

function unlinkDirectoryError(path: string): Error {
  return nodeFileSystemError('EISDIR', `illegal operation on a directory, unlink '${path}'`, path, 'unlink');
}

function copyFileError(error: unknown, source: string, destination: string): unknown {
  return errorCode(error) === 'EEXIST'
    ? nodeFileSystemError(
        'EEXIST',
        `file already exists, copyfile '${source}' -> '${destination}'`,
        destination,
        'copyfile'
      )
    : error;
}

function copyExistsError(source: string, destination: string): Error {
  return nodeFileSystemError(
    'ERR_FS_CP_EEXIST',
    `Target already exists: cp returned EEXIST (${destination} already exists), cp '${source}' -> '${destination}'`,
    destination,
    'cp'
  );
}

function copyDirectoryError(source: string): Error {
  return nodeFileSystemError(
    'ERR_FS_EISDIR',
    `Recursive option not enabled, cannot copy a directory: cp returned EISDIR (${source} is a directory)`,
    source,
    'cp'
  );
}

function fileTimeMilliseconds(value: string | number | Date): number {
  const seconds =
    value instanceof Date
      ? value.getTime() / 1_000
      : typeof value === 'string'
        ? Number(value)
        : value;
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw nodeFileSystemError('EINVAL', `Invalid file time: ${String(value)}`);
  }
  return seconds * 1_000;
}

function encodePathResult(
  value: string,
  encoding: string | null | undefined
): string | Uint8Array {
  if (encoding === undefined || encoding === null || isUtf8(encoding)) return value;
  if (encoding === 'buffer') return BrowserBuffer.from(value);
  throw nodeFileSystemError('ENOTSUP', `Unsupported path encoding: ${encoding}`);
}

function isUtf8(encoding: string | null | undefined): boolean {
  return encoding === 'utf8' || encoding === 'utf-8';
}
