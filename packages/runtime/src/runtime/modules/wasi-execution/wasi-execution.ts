const ERRNO = {
  SUCCESS: 0,
  ACCES: 2,
  AGAIN: 6,
  BADF: 8,
  BUSY: 10,
  EXIST: 20,
  FAULT: 21,
  INVAL: 28,
  IO: 29,
  ISDIR: 31,
  LOOP: 32,
  NOENT: 44,
  NOSYS: 52,
  NOTDIR: 54,
  NOTEMPTY: 55,
  NOTCAPABLE: 76,
  OVERFLOW: 61,
  PERM: 63
} as const;

/** `lookupflags`: follow a symbolic link that the path names last. */
const LOOKUP_SYMLINK_FOLLOW = 1;

const MAX_IOVECS = 1_024;
const MAX_IO_BYTES = 1024 * 1024;
const MAX_POLL_SUBSCRIPTIONS = 1_024;
const POLL_SUBSCRIPTION_SIZE = 48;
const POLL_EVENT_SIZE = 32;
let pollWaitWord: Int32Array | undefined;

const FD_FLAGS = {
  APPEND: 1,
  DSYNC: 2,
  NONBLOCK: 4,
  RSYNC: 8,
  SYNC: 16
} as const;
const KNOWN_FD_FLAGS =
  FD_FLAGS.APPEND |
  FD_FLAGS.DSYNC |
  FD_FLAGS.NONBLOCK |
  FD_FLAGS.RSYNC |
  FD_FLAGS.SYNC;
const UNSUPPORTED_SYNCHRONIZED_FD_FLAGS =
  FD_FLAGS.DSYNC | FD_FLAGS.RSYNC | FD_FLAGS.SYNC;

const POLL_EVENT_TYPES = {
  CLOCK: 0,
  FD_READ: 1,
  FD_WRITE: 2
} as const;
const SUBSCRIPTION_CLOCK_ABSTIME = 1;
const EVENT_FD_READWRITE_HANGUP = 1;

const RIGHTS = {
  FD_DATASYNC: 1n << 0n,
  FD_READ: 1n << 1n,
  FD_SEEK: 1n << 2n,
  FD_FDSTAT_SET_FLAGS: 1n << 3n,
  FD_SYNC: 1n << 4n,
  FD_TELL: 1n << 5n,
  FD_WRITE: 1n << 6n,
  FD_ADVISE: 1n << 7n,
  FD_ALLOCATE: 1n << 8n,
  PATH_CREATE_DIRECTORY: 1n << 9n,
  PATH_CREATE_FILE: 1n << 10n,
  PATH_LINK_SOURCE: 1n << 11n,
  PATH_LINK_TARGET: 1n << 12n,
  PATH_OPEN: 1n << 13n,
  FD_READDIR: 1n << 14n,
  PATH_READLINK: 1n << 15n,
  PATH_RENAME_SOURCE: 1n << 16n,
  PATH_RENAME_TARGET: 1n << 17n,
  PATH_FILESTAT_GET: 1n << 18n,
  PATH_FILESTAT_SET_SIZE: 1n << 19n,
  PATH_FILESTAT_SET_TIMES: 1n << 20n,
  FD_FILESTAT_GET: 1n << 21n,
  FD_FILESTAT_SET_SIZE: 1n << 22n,
  FD_FILESTAT_SET_TIMES: 1n << 23n,
  PATH_SYMLINK: 1n << 24n,
  PATH_REMOVE_DIRECTORY: 1n << 25n,
  PATH_UNLINK_FILE: 1n << 26n
} as const;

// The rights the runtime implements, by descriptor type. A descriptor holds
// those of them it was opened with; the operations below each check theirs.
const READABLE_FILE_RIGHTS =
  RIGHTS.FD_DATASYNC |
  RIGHTS.FD_READ |
  RIGHTS.FD_SEEK |
  RIGHTS.FD_FDSTAT_SET_FLAGS |
  RIGHTS.FD_SYNC |
  RIGHTS.FD_TELL |
  RIGHTS.FD_ADVISE |
  RIGHTS.FD_FILESTAT_GET |
  RIGHTS.FD_FILESTAT_SET_TIMES;
const READABLE_DIRECTORY_RIGHTS =
  RIGHTS.FD_FDSTAT_SET_FLAGS |
  RIGHTS.FD_SYNC |
  RIGHTS.FD_ADVISE |
  RIGHTS.PATH_OPEN |
  RIGHTS.FD_READDIR |
  RIGHTS.PATH_READLINK |
  RIGHTS.PATH_FILESTAT_GET |
  RIGHTS.FD_FILESTAT_GET |
  RIGHTS.FD_FILESTAT_SET_TIMES;
const WRITABLE_FILE_RIGHTS =
  READABLE_FILE_RIGHTS |
  RIGHTS.FD_WRITE |
  RIGHTS.FD_ALLOCATE |
  RIGHTS.FD_FILESTAT_SET_SIZE;
const WRITABLE_DIRECTORY_RIGHTS =
  READABLE_DIRECTORY_RIGHTS |
  RIGHTS.PATH_CREATE_DIRECTORY |
  RIGHTS.PATH_CREATE_FILE |
  RIGHTS.PATH_LINK_SOURCE |
  RIGHTS.PATH_LINK_TARGET |
  RIGHTS.PATH_RENAME_SOURCE |
  RIGHTS.PATH_RENAME_TARGET |
  RIGHTS.PATH_FILESTAT_SET_SIZE |
  RIGHTS.PATH_FILESTAT_SET_TIMES |
  RIGHTS.PATH_SYMLINK |
  RIGHTS.PATH_REMOVE_DIRECTORY |
  RIGHTS.PATH_UNLINK_FILE;
const PREVIEW1_DIRECTORY_BASE_RIGHTS = 0x0ffffeben;
const PREVIEW1_DIRECTORY_INHERITING_RIGHTS = 0x0fffffffn;
const KNOWN_RIGHTS = (1n << 30n) - 1n;

export interface WasiByteWriter {
  write(chunk: Uint8Array): void;
}

export interface WasiSynchronousVfsPort {
  readFileSync?(path: string): Uint8Array;
  readFileSliceSync?(path: string, offset: number, length: number): Uint8Array;
  readdirSync?(
    path: string,
    options: { readonly withFileTypes: true }
  ): readonly WasiVfsDirent[];
  readlinkSync?(path: string): string;
  realpathSync?(path: string): string;
  statSync?(path: string): WasiVfsStat;
  lstatSync?(path: string): WasiVfsStat;
  mkdirSync?(path: string, options?: { readonly recursive?: boolean }): void;
  rmSync?(path: string, options?: { readonly recursive?: boolean; readonly force?: boolean }): void;
  symlinkSync?(target: string, path: string): void;
  writeFileSync?(path: string, data: string | Uint8Array): void;
  renameSync?(oldPath: string, newPath: string): void;
  linkSync?(existingPath: string, newPath: string): void;
  utimesSync?(path: string, mtimeMs: number): void;
  isDirectory(path: string): boolean;
  isFile(path: string): boolean;
}

export interface WasiVfsDirent {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface WasiVfsStat {
  readonly size: number;
  readonly ino: number;
  readonly ctime: Date;
  readonly mtime: Date;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface WasiRuntimeProcess {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stderr?: unknown;
  readonly stdout?: unknown;
  exit(code: number): void;
}

/** Standard input of a WASI command. */
export interface WasiStandardInput {
  /**
   * The bytes a read would return at once: 0 while input may still arrive,
   * negative once it has ended and nothing is left.
   */
  available?(): number;
  /**
   * Blocks while `available()` still returns `observed`, at most
   * `timeoutMilliseconds` when given. It may return early.
   */
  wait?(observed: number, timeoutMilliseconds?: number): void;
  read(maximumBytes: number): Uint8Array | undefined;
}

export interface WasiCommandExecutionRuntime {
  readonly process: WasiRuntimeProcess;
  readonly stdin?: WasiStandardInput;
  readonly vfs: WasiSynchronousVfsPort;
  readonly randomBytes?: (length: number) => Uint8Array;
  readonly monotonicNowNs?: () => bigint;
  readonly realtimeNowNs?: () => bigint;
}

export interface WasiPreview1ExecutionOptions {
  readonly version: 'preview1';
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly preopens?: Readonly<Record<string, string>>;
  readonly exitMode?: 'return' | 'terminate';
}

export interface WasiExecutableInstance {
  readonly exports: Record<string, unknown>;
}

interface WasiPreview1Imports extends WebAssembly.ModuleImports {
  args_sizes_get(argc: number, argvBufferSize: number): number;
  args_get(argv: number, argvBuffer: number): number;
  environ_sizes_get(count: number, bufferSize: number): number;
  environ_get(environ: number, environBuffer: number): number;
  clock_time_get(clockId: number, precision: bigint, time: number): number;
  clock_res_get(clockId: number, resolution: number): number;
  random_get(buffer: number, length: number): number;
  sched_yield(): number;
  fd_prestat_get(fd: number, result: number): number;
  fd_prestat_dir_name(fd: number, path: number, length: number): number;
  fd_fdstat_get(fd: number, result: number): number;
  fd_fdstat_set_flags(fd: number, flags: number): number;
  fd_filestat_get(fd: number, result: number): number;
  fd_read(fd: number, iovs: number, iovsLength: number, read: number): number;
  fd_pread(fd: number, iovs: number, iovsLength: number, offset: bigint, read: number): number;
  fd_readdir(fd: number, buffer: number, bufferLength: number, cookie: bigint, used: number): number;
  fd_write(fd: number, iovs: number, iovsLength: number, written: number): number;
  fd_seek(fd: number, offset: bigint, whence: number, newOffset: number): number;
  fd_tell(fd: number, offset: number): number;
  fd_close(fd: number): number;
  fd_advise(fd: number, offset: bigint, length: bigint, advice: number): number;
  fd_allocate(fd: number, offset: bigint, length: bigint): number;
  fd_datasync(fd: number): number;
  fd_sync(fd: number): number;
  fd_filestat_set_size(fd: number, size: bigint): number;
  fd_filestat_set_times(fd: number, accessTime: bigint, modificationTime: bigint, flags: number): number;
  fd_pwrite(fd: number, iovs: number, iovsLength: number, offset: bigint, written: number): number;
  fd_renumber(from: number, to: number): number;
  path_create_directory(fd: number, path: number, pathLength: number): number;
  path_filestat_set_times(
    fd: number,
    flags: number,
    path: number,
    pathLength: number,
    accessTime: bigint,
    modificationTime: bigint,
    fstFlags: number
  ): number;
  path_link(
    oldFd: number,
    oldFlags: number,
    oldPath: number,
    oldPathLength: number,
    newFd: number,
    newPath: number,
    newPathLength: number
  ): number;
  path_rename(
    fd: number,
    oldPath: number,
    oldPathLength: number,
    newFd: number,
    newPath: number,
    newPathLength: number
  ): number;
  path_open(
    fd: number,
    dirflags: number,
    path: number,
    pathLength: number,
    oflags: number,
    rightsBase: bigint,
    rightsInheriting: bigint,
    fdflags: number,
    openedFd: number
  ): number;
  path_filestat_get(fd: number, flags: number, path: number, pathLength: number, result: number): number;
  path_readlink(
    fd: number,
    path: number,
    pathLength: number,
    buffer: number,
    bufferLength: number,
    used: number
  ): number;
  path_remove_directory(fd: number, path: number, pathLength: number): number;
  path_symlink(
    target: number,
    targetLength: number,
    fd: number,
    path: number,
    pathLength: number
  ): number;
  path_unlink_file(fd: number, path: number, pathLength: number): number;
  poll_oneoff(subscriptions: number, events: number, count: number, eventCount: number): number;
  sock_accept(fd: number, flags: number, acceptedFd: number): number;
  sock_shutdown(fd: number, how: number): number;
  sock_recv(fd: number, iovs: number, iovsLength: number, flags: number, received: number, outFlags: number): number;
  sock_send(fd: number, iovs: number, iovsLength: number, flags: number, sent: number): number;
  proc_exit(code: number): number;
  proc_raise(signal: number): number;
}

interface WasiPreview1Execution {
  readonly imports: WasiPreview1Imports;
  getImportObject(): WasiPreview1ImportObject;
  initialize(instance: WasiExecutableInstance): void;
  start(instance: WasiExecutableInstance): number | void;
}

type WasiPreview1ImportObject = WebAssembly.Imports & {
  readonly wasi_snapshot_preview1: WasiPreview1Imports;
};

type WasiPreview1ExecutionFactory = (
  options: WasiPreview1ExecutionOptions
) => WasiPreview1Execution;

export interface WasiNodeAdapter {
  readonly wasiImport: WebAssembly.ModuleImports;
  getImportObject(): WebAssembly.Imports;
  initialize(instance: WasiExecutableInstance): void;
  start(instance: WasiExecutableInstance): number | void;
}

export type WasiNodeAdapterFactory = (
  options: WasiPreview1ExecutionOptions
) => WasiNodeAdapter;

type WasiDescriptor =
  | {
      readonly kind: 'stdio';
      readonly writer?: WasiByteWriter;
      readonly rightsBase: bigint;
      readonly rightsInheriting: bigint;
      fdFlags: number;
    }
  | {
      readonly kind: 'preopen';
      readonly guestPath: string;
      readonly hostPath: string;
      readonly rightsBase: bigint;
      readonly rightsInheriting: bigint;
      fdFlags: number;
    }
  | {
      readonly kind: 'file';
      readonly path: string;
      readonly rightsBase: bigint;
      readonly rightsInheriting: bigint;
      fdFlags: number;
      offset: number;
    }
  | {
      readonly kind: 'directory';
      readonly path: string;
      readonly capabilityRoot: string;
      readonly rightsBase: bigint;
      readonly rightsInheriting: bigint;
      fdFlags: number;
    };

class WasiExit extends Error {
  constructor(readonly code: number) {
    super(`WASI process exited with code ${code}`);
  }
}

function createPreview1HostCore(
  runtime: WasiCommandExecutionRuntime,
  options: WasiPreview1ExecutionOptions
): WasiPreview1Execution {
  class Preview1WasiHost implements WasiPreview1Execution {
    readonly imports: WasiPreview1Imports;
    #descriptors = new Map<number, WasiDescriptor>();
    #initialized = false;
    #memory: WebAssembly.Memory | undefined;
    #nextDescriptor = 3;
    #returnOnExit: boolean;
    #args: readonly string[];
    #env: readonly string[];

    constructor() {
      if (!options || options.version === undefined) throw new TypeError('WASI option version is required.');
      if (options.version !== 'preview1') throw new RangeError('WASI only supports version preview1.');
      this.#returnOnExit = options.exitMode !== 'terminate';
      this.#args = options.args ?? runtime.process.argv;
      this.#env = Object.entries(options.env ?? runtime.process.env)
        .filter((entry): entry is [string, string] => entry[1] !== undefined)
        .map(([name, value]) => `${name}=${value}`);
      this.#descriptors.set(0, {
        kind: 'stdio',
        rightsBase: RIGHTS.FD_READ | RIGHTS.FD_FDSTAT_SET_FLAGS,
        rightsInheriting: 0n,
        fdFlags: 0
      });
      this.#descriptors.set(1, {
        kind: 'stdio',
        writer: byteWriter(runtime.process.stdout),
        rightsBase: RIGHTS.FD_WRITE | RIGHTS.FD_FDSTAT_SET_FLAGS,
        rightsInheriting: 0n,
        fdFlags: 0
      });
      this.#descriptors.set(2, {
        kind: 'stdio',
        writer: byteWriter(runtime.process.stderr),
        rightsBase: RIGHTS.FD_WRITE | RIGHTS.FD_FDSTAT_SET_FLAGS,
        rightsInheriting: 0n,
        fdFlags: 0
      });
      for (const [guestPath, hostPath] of Object.entries(options.preopens ?? {})) {
        const guest = absolutePath(guestPath);
        this.#descriptors.set(this.#nextDescriptor++, {
          kind: 'preopen',
          guestPath: guest,
          hostPath: absolutePath(hostPath),
          rightsBase: WRITABLE_DIRECTORY_RIGHTS,
          rightsInheriting: PREVIEW1_DIRECTORY_INHERITING_RIGHTS,
          fdFlags: 0
        });
      }
      this.imports = {
        args_sizes_get: (argc, argvBufferSize) => this.argsSizesGet(argc, argvBufferSize),
        args_get: (argv, argvBuffer) => this.argsGet(argv, argvBuffer),
        environ_sizes_get: (count, bufferSize) => this.environSizesGet(count, bufferSize),
        environ_get: (environ, environBuffer) => this.environGet(environ, environBuffer),
        clock_time_get: (clockId, _precision, time) => this.clockTimeGet(clockId, time),
        clock_res_get: (clockId, resolution) => this.clockResGet(clockId, resolution),
        random_get: (buffer, length) => this.randomGet(buffer, length),
        sched_yield: () => ERRNO.SUCCESS,
        fd_prestat_get: (fd, result) => this.fdPrestatGet(fd, result),
        fd_prestat_dir_name: (fd, path, length) => this.fdPrestatDirName(fd, path, length),
        fd_fdstat_get: (fd, result) => this.fdFdstatGet(fd, result),
        fd_fdstat_set_flags: (fd, flags) => this.fdFdstatSetFlags(fd, flags),
        fd_filestat_get: (fd, result) => this.fdFilestatGet(fd, result),
        fd_read: (fd, iovs, iovsLength, read) => this.fdRead(fd, iovs, iovsLength, read),
        fd_pread: (fd, iovs, iovsLength, offset, read) =>
          this.fdPread(fd, iovs, iovsLength, offset, read),
        fd_readdir: (fd, buffer, bufferLength, cookie, used) =>
          this.fdReaddir(fd, buffer, bufferLength, cookie, used),
        fd_write: (fd, iovs, iovsLength, written) => this.fdWrite(fd, iovs, iovsLength, written),
        fd_seek: (fd: number, offset: bigint, whence: number, newOffset: number) =>
          this.fdSeek(fd, offset, whence, newOffset),
        fd_tell: (fd, offset) => this.fdTell(fd, offset),
        fd_close: (fd) => this.fdClose(fd),
        fd_advise: (fd) => this.fdExists(fd),
        fd_allocate: (fd, offset, length) => this.fdResize(fd, offset + length, false),
        fd_datasync: (fd) => this.fdExists(fd),
        fd_sync: (fd) => this.fdExists(fd),
        fd_filestat_set_size: (fd, size) => this.fdResize(fd, size, true),
        fd_filestat_set_times: (fd, _accessTime, modificationTime, flags) =>
          this.fdFilestatSetTimes(fd, modificationTime, flags),
        fd_pwrite: (fd, iovs, iovsLength, offset, written) => this.fdPwrite(fd, iovs, iovsLength, offset, written),
        fd_renumber: (from, to) => this.fdRenumber(from, to),
        path_filestat_set_times: (fd, flags, path, pathLength, _accessTime, modificationTime, fstFlags) =>
          this.pathFilestatSetTimes(fd, flags, path, pathLength, modificationTime, fstFlags),
        path_link: (oldFd, oldFlags, oldPath, oldPathLength, newFd, newPath, newPathLength) =>
          this.pathLink(oldFd, oldFlags, oldPath, oldPathLength, newFd, newPath, newPathLength),
        path_rename: (fd, oldPath, oldPathLength, newFd, newPath, newPathLength) =>
          this.pathRename(fd, oldPath, oldPathLength, newFd, newPath, newPathLength),
        path_create_directory: (fd, path, pathLength) =>
          this.pathCreateDirectory(fd, path, pathLength),
        path_open: (fd, dirflags, path, pathLength, oflags, rightsBase, rightsInheriting, fdflags, openedFd) =>
          this.pathOpen(fd, dirflags, path, pathLength, oflags, rightsBase, rightsInheriting, fdflags, openedFd),
        path_filestat_get: (fd, flags, path, pathLength, result) =>
          this.pathFilestatGet(fd, flags, path, pathLength, result),
        path_readlink: (fd, path, pathLength, buffer, bufferLength, used) =>
          this.pathReadlink(fd, path, pathLength, buffer, bufferLength, used),
        path_remove_directory: (fd, path, pathLength) =>
          this.pathRemoveDirectory(fd, path, pathLength),
        path_symlink: (target, targetLength, fd, path, pathLength) =>
          this.pathSymlink(target, targetLength, fd, path, pathLength),
        path_unlink_file: (fd, path, pathLength) =>
          this.pathUnlinkFile(fd, path, pathLength),
        poll_oneoff: (subscriptions, events, count, eventCount) =>
          this.pollOneoff(subscriptions, events, count, eventCount),
        sock_accept: () => ERRNO.NOSYS,
        sock_shutdown: () => ERRNO.NOSYS,
        sock_recv: () => ERRNO.NOSYS,
        sock_send: () => ERRNO.NOSYS,
        proc_exit: (code) => this.procExit(code),
        proc_raise: () => ERRNO.NOSYS
      };
    }

    getImportObject(): WasiPreview1ImportObject {
      return { wasi_snapshot_preview1: this.imports };
    }

    initialize(instance: WasiExecutableInstance): void {
      this.bindInstance(instance, false);
      const initialize = instance.exports._initialize;
      if (typeof initialize === 'function') Reflect.apply(initialize, undefined, []);
    }

    start(instance: WasiExecutableInstance): number | void {
      this.bindInstance(instance, true);
      const start = instance.exports._start;
      if (typeof start !== 'function') throw new TypeError('WASI.start requires an instance exporting _start.');
      try {
        Reflect.apply(start, undefined, []);
      } catch (error) {
        if (error instanceof WasiExit && this.#returnOnExit) return error.code;
        throw error;
      }
    }

    private bindInstance(instance: WasiExecutableInstance, start: boolean): void {
      if (this.#initialized) throw new Error('WASI instance lifecycle may be initialized exactly once.');
      const memory = instance.exports.memory;
      if (!(memory instanceof WebAssembly.Memory)) {
        throw new TypeError(`WASI.${start ? 'start' : 'initialize'} requires an instance exporting memory.`);
      }
      if (start && typeof instance.exports._initialize === 'function') {
        throw new TypeError('WASI.start cannot initialize an instance exporting _initialize.');
      }
      if (!start && typeof instance.exports._start === 'function') {
        throw new TypeError('WASI.initialize cannot initialize an instance exporting _start.');
      }
      this.#memory = memory;
      this.#initialized = true;
    }

    private argsSizesGet(argc: number, bufferSize: number): number {
      return this.writeU32Pair(argc, this.#args.length, bufferSize, encodedLength(this.#args));
    }

    private argsGet(argv: number, argvBuffer: number): number {
      return this.writeStrings(argv, argvBuffer, this.#args);
    }

    private environSizesGet(count: number, bufferSize: number): number {
      return this.writeU32Pair(count, this.#env.length, bufferSize, encodedLength(this.#env));
    }

    private environGet(environ: number, environBuffer: number): number {
      return this.writeStrings(environ, environBuffer, this.#env);
    }

    private clockTimeGet(clockId: number, time: number): number {
      if (clockId === 2 || clockId === 3) return ERRNO.NOSYS;
      if (clockId !== 0 && clockId !== 1) return ERRNO.INVAL;
      const value = clockId === 0
        ? runtime.realtimeNowNs?.() ?? BigInt(Date.now()) * 1_000_000n
        : runtime.monotonicNowNs?.() ?? BigInt(Math.floor(globalThis.performance.now() * 1_000_000));
      return this.writeU64(time, value);
    }

    private clockResGet(clockId: number, resolution: number): number {
      if (clockId === 2 || clockId === 3) return ERRNO.NOSYS;
      if (clockId !== 0 && clockId !== 1) return ERRNO.INVAL;
      // Date.now() ticks in milliseconds, and a worker's performance.now() is
      // coarsened, by up to as much, depending on the browser and isolation.
      return this.writeU64(resolution, 1_000_000n);
    }

    private fdExists(fd: number): number {
      return this.#descriptors.has(fd) ? ERRNO.SUCCESS : ERRNO.BADF;
    }

    /**
     * `fd_filestat_set_size` (`exact`) and `fd_allocate`, which only grows a
     * file. Either writes the file, so it needs FD_WRITE besides its own
     * right, as a file opened read-only cannot be resized.
     */
    private fdResize(fd: number, size: bigint, exact: boolean): number {
      const descriptor = this.#descriptors.get(fd);
      if (!descriptor) return ERRNO.BADF;
      if (descriptor.kind !== 'file') return descriptor.kind === 'stdio' ? ERRNO.INVAL : ERRNO.ISDIR;
      const right = exact ? RIGHTS.FD_FILESTAT_SET_SIZE : RIGHTS.FD_ALLOCATE;
      if (!hasRights(descriptor, right | RIGHTS.FD_WRITE)) return ERRNO.NOTCAPABLE;
      if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) return ERRNO.INVAL;
      if (!runtime.vfs.readFileSync || !runtime.vfs.writeFileSync) return ERRNO.NOSYS;
      try {
        const current = runtime.vfs.readFileSync(descriptor.path);
        const length = Number(size);
        if (!exact && current.byteLength >= length) return ERRNO.SUCCESS;
        if (current.byteLength === length) return ERRNO.SUCCESS;
        const resized = new Uint8Array(length);
        resized.set(current.subarray(0, Math.min(length, current.byteLength)));
        runtime.vfs.writeFileSync(descriptor.path, resized);
        return ERRNO.SUCCESS;
      } catch (error) {
        return errno(error);
      }
    }

    private fdFilestatSetTimes(fd: number, modificationTime: bigint, flags: number): number {
      const descriptor = this.#descriptors.get(fd);
      if (!descriptor) return ERRNO.BADF;
      if (descriptor.kind === 'stdio') return ERRNO.SUCCESS;
      if (!hasRights(descriptor, RIGHTS.FD_FILESTAT_SET_TIMES)) return ERRNO.NOTCAPABLE;
      const path = descriptor.kind === 'preopen' ? descriptor.hostPath : descriptor.path;
      return this.setModificationTime(path, modificationTime, flags);
    }

    private pathFilestatSetTimes(
      fd: number,
      lookupFlags: number,
      path: number,
      pathLength: number,
      modificationTime: bigint,
      flags: number
    ): number {
      if ((lookupFlags & ~LOOKUP_SYMLINK_FOLLOW) !== 0) return ERRNO.INVAL;
      const follow = (lookupFlags & LOOKUP_SYMLINK_FOLLOW) !== 0;
      return this.mutatePath(
        fd,
        path,
        pathLength,
        RIGHTS.PATH_FILESTAT_SET_TIMES,
        (hostPath) => {
          if (!runtime.vfs.lstatSync) return ERRNO.NOSYS;
          // The times of a symbolic link itself are not kept (as `lutimes`
          // leaves them), and setting the file's would follow the link.
          if (!follow && runtime.vfs.lstatSync(hostPath).isSymbolicLink()) return ERRNO.SUCCESS;
          return this.setModificationTime(hostPath, modificationTime, flags);
        },
        { follow }
      );
    }

    /** The Virtual File System keeps one time, the modification time; an access time is accepted and dropped. */
    private setModificationTime(path: string, modificationTime: bigint, flags: number): number {
      const SET_MTIM = 4;
      const SET_MTIM_NOW = 8;
      if ((flags & (SET_MTIM | SET_MTIM_NOW)) === 0 || !runtime.vfs.utimesSync) return ERRNO.SUCCESS;
      try {
        const milliseconds = (flags & SET_MTIM_NOW) !== 0 ? Date.now() : Number(modificationTime / 1_000_000n);
        runtime.vfs.utimesSync(path, milliseconds);
        return ERRNO.SUCCESS;
      } catch (error) {
        return errno(error);
      }
    }

    private fdPwrite(fd: number, iovs: number, iovsLength: number, offset: bigint, written: number): number {
      const descriptor = this.#descriptors.get(fd);
      if (!descriptor) return ERRNO.BADF;
      if (descriptor.kind !== 'file') {
        return descriptor.kind === 'stdio' ? ERRNO.NOSYS : ERRNO.ISDIR;
      }
      if (!hasRights(descriptor, RIGHTS.FD_WRITE | RIGHTS.FD_SEEK)) return ERRNO.NOTCAPABLE;
      if (offset < 0n || offset > BigInt(Number.MAX_SAFE_INTEGER)) return ERRNO.INVAL;
      const memory = this.memory();
      if (!memory) return ERRNO.FAULT;
      const sources = this.iovecs(iovs, iovsLength, memory.buffer.byteLength);
      if (typeof sources === 'number') return sources;
      if (!this.validMemorySpan(written, 4)) return ERRNO.FAULT;
      let total = 0;
      for (const source of sources) {
        if (!inBounds(memory, source.pointer, source.length)) return ERRNO.FAULT;
        total += source.length;
      }
      if (!runtime.vfs.readFileSync || !runtime.vfs.writeFileSync) return ERRNO.NOSYS;
      try {
        const data = new Uint8Array(total);
        let position = 0;
        for (const source of sources) {
          copyMemoryBytesInto(memory, source.pointer, source.length, data, position);
          position += source.length;
        }
        // A positioned write leaves the descriptor's own offset where it was.
        runtime.vfs.writeFileSync(
          descriptor.path,
          replaceBytes(runtime.vfs.readFileSync(descriptor.path), data, Number(offset))
        );
      } catch (error) {
        return errno(error);
      }
      return this.writeU32(written, total);
    }

    private fdRenumber(from: number, to: number): number {
      const descriptor = this.#descriptors.get(from);
      if (!descriptor || !this.#descriptors.has(to)) return ERRNO.BADF;
      if (from === to) return ERRNO.SUCCESS;
      this.#descriptors.set(to, descriptor);
      this.#descriptors.delete(from);
      return ERRNO.SUCCESS;
    }

    /**
     * Resolves a second descriptor, which must hold `right`, and path, for
     * operations that name two; the path must not be the capability root,
     * which they would replace (`atRoot` is the error then).
     */
    private resolvePathAt(
      fd: number,
      path: number,
      pathLength: number,
      right: bigint,
      atRoot: number
    ): string | number {
      const descriptor = this.#descriptors.get(fd);
      if (!descriptor) return ERRNO.BADF;
      if (descriptor.kind !== 'preopen' && descriptor.kind !== 'directory') return ERRNO.NOTDIR;
      if (!hasRights(descriptor, right)) return ERRNO.NOTCAPABLE;
      const guestPath = this.readString(path, pathLength);
      if (typeof guestPath === 'number') return guestPath;
      try {
        const hostPath = resolveConfinedPath(runtime.vfs, descriptor, guestPath, false);
        if (!hostPath) return ERRNO.NOTCAPABLE;
        return hostPath === capabilityRootOf(descriptor) ? atRoot : hostPath;
      } catch (error) {
        return errno(error);
      }
    }

    private pathRename(
      fd: number,
      oldPath: number,
      oldPathLength: number,
      newFd: number,
      newPath: number,
      newPathLength: number
    ): number {
      // Linux refuses to rename `.` or onto it with EBUSY.
      const target = this.resolvePathAt(newFd, newPath, newPathLength, RIGHTS.PATH_RENAME_TARGET, ERRNO.BUSY);
      if (typeof target === 'number') return target;
      return this.mutatePath(
        fd,
        oldPath,
        oldPathLength,
        RIGHTS.PATH_RENAME_SOURCE,
        (source) => {
          if (!runtime.vfs.renameSync) return ERRNO.NOSYS;
          runtime.vfs.renameSync(source, target);
          return ERRNO.SUCCESS;
        },
        { atRoot: ERRNO.BUSY }
      );
    }

    /**
     * Links the file `oldPath` names, or, with LOOKUP_SYMLINK_FOLLOW, the file
     * a symbolic link there resolves to inside the capability root. The
     * Virtual File System cannot link a symbolic link itself, which is what
     * `linkat` without the flag does, so that is refused rather than followed.
     */
    private pathLink(
      oldFd: number,
      oldFlags: number,
      oldPath: number,
      oldPathLength: number,
      newFd: number,
      newPath: number,
      newPathLength: number
    ): number {
      if ((oldFlags & ~LOOKUP_SYMLINK_FOLLOW) !== 0) return ERRNO.INVAL;
      const follow = (oldFlags & LOOKUP_SYMLINK_FOLLOW) !== 0;
      const target = this.resolvePathAt(newFd, newPath, newPathLength, RIGHTS.PATH_LINK_TARGET, ERRNO.EXIST);
      if (typeof target === 'number') return target;
      return this.mutatePath(
        oldFd,
        oldPath,
        oldPathLength,
        RIGHTS.PATH_LINK_SOURCE,
        (source) => {
          if (!runtime.vfs.linkSync || !runtime.vfs.lstatSync) return ERRNO.NOSYS;
          if (!follow && runtime.vfs.lstatSync(source).isSymbolicLink()) return ERRNO.PERM;
          runtime.vfs.linkSync(source, target);
          return ERRNO.SUCCESS;
        },
        { follow }
      );
    }

    private randomGet(buffer: number, length: number): number {
      if (!this.validLength(length)) return ERRNO.INVAL;
      const random = runtime.randomBytes?.(length) ?? secureRandom(length);
      if (random.byteLength !== length) return ERRNO.IO;
      return this.writeBytes(buffer, random);
    }

    private fdPrestatGet(fd: number, result: number): number {
      const descriptor = this.#descriptors.get(fd);
      if (!descriptor || descriptor.kind !== 'preopen') return ERRNO.BADF;
      const path = encode(descriptor.guestPath);
      const memory = this.memory();
      if (!memory || !inBounds(memory, result, 8)) return ERRNO.FAULT;
      const view = new DataView(memory.buffer);
      view.setUint8(result, 0);
      view.setUint32(result + 4, path.byteLength, true);
      return ERRNO.SUCCESS;
    }

    private fdPrestatDirName(fd: number, path: number, length: number): number {
      const descriptor = this.#descriptors.get(fd);
      if (!descriptor || descriptor.kind !== 'preopen') return ERRNO.BADF;
      const bytes = encode(descriptor.guestPath);
      if (length < bytes.byteLength) return ERRNO.OVERFLOW;
      return this.writeBytes(path, bytes);
    }

    private fdFdstatGet(fd: number, result: number): number {
      const descriptor = this.#descriptors.get(fd);
      const memory = this.memory();
      if (!descriptor) return ERRNO.BADF;
      if (!memory || !inBounds(memory, result, 24)) return ERRNO.FAULT;
      new Uint8Array(memory.buffer, result, 24).fill(0);
      const view = new DataView(memory.buffer);
      view.setUint8(result, descriptorFiletype(descriptor));
      view.setUint16(result + 2, descriptor.fdFlags, true);
      view.setBigUint64(result + 8, descriptor.rightsBase, true);
      view.setBigUint64(result + 16, descriptor.rightsInheriting, true);
      return ERRNO.SUCCESS;
    }

    private fdFdstatSetFlags(fd: number, flags: number): number {
      if (
        !Number.isInteger(flags) ||
        flags < 0 ||
        (flags & ~KNOWN_FD_FLAGS) !== 0
      ) {
        return ERRNO.INVAL;
      }
      const descriptor = this.#descriptors.get(fd);
      if (!descriptor) return ERRNO.BADF;
      if (!hasRights(descriptor, RIGHTS.FD_FDSTAT_SET_FLAGS)) {
        return ERRNO.NOTCAPABLE;
      }
      if ((flags & UNSUPPORTED_SYNCHRONIZED_FD_FLAGS) !== 0) {
        return ERRNO.NOSYS;
      }
      if ((flags & FD_FLAGS.APPEND) !== 0 && descriptor.kind !== 'file') {
        return ERRNO.NOTCAPABLE;
      }
      descriptor.fdFlags = flags;
      return ERRNO.SUCCESS;
    }

    private fdFilestatGet(fd: number, result: number): number {
      const descriptor = this.#descriptors.get(fd);
      if (!descriptor) return ERRNO.BADF;
      const memory = this.memory();
      if (!memory || !inBounds(memory, result, 64)) return ERRNO.FAULT;
      if (descriptor.kind === 'stdio') {
        return this.writeFilestat(result, {
          filetype: 2,
          inode: 0,
          size: 0,
          ctimeMs: 0,
          mtimeMs: 0
        });
      }
      if (!hasRights(descriptor, RIGHTS.FD_FILESTAT_GET)) return ERRNO.NOTCAPABLE;
      if (!runtime.vfs.statSync) return ERRNO.NOSYS;
      try {
        const path = descriptor.kind === 'preopen' ? descriptor.hostPath : descriptor.path;
        return this.writeVfsFilestat(result, runtime.vfs.statSync(path));
      } catch (error) {
        return errno(error);
      }
    }

    private fdRead(fd: number, iovs: number, iovsLength: number, read: number): number {
      const descriptor = this.#descriptors.get(fd);
      if (!descriptor) return ERRNO.BADF;
      if (descriptor.kind === 'stdio') {
        if (fd !== 0 || !runtime.stdin) return ERRNO.NOSYS;
        const targets = this.iovecs(iovs, iovsLength);
        if (typeof targets === 'number') return targets;
        if (!this.validMemorySpan(read, 4)) return ERRNO.FAULT;
        for (const target of targets) {
          if (!this.validMemorySpan(target.pointer, target.length)) {
            return ERRNO.FAULT;
          }
        }
        const capacity = targets.reduce(
          (total, target) => total + target.length,
          0
        );
        if (
          capacity > 0 &&
          (descriptor.fdFlags & FD_FLAGS.NONBLOCK) !== 0 &&
          runtime.stdin.available?.() === 0
        ) {
          return ERRNO.AGAIN;
        }
        const bytes = capacity === 0
          ? new Uint8Array()
          : runtime.stdin.read(capacity) ?? new Uint8Array();
        let offset = 0;
        for (const target of targets) {
          const chunk = bytes.subarray(offset, offset + target.length);
          const result = this.writeBytes(target.pointer, chunk);
          if (result !== ERRNO.SUCCESS) return result;
          offset += chunk.byteLength;
          if (chunk.byteLength < target.length) break;
        }
        return this.writeU32(read, offset);
      }
      if (descriptor.kind !== 'file') {
        return descriptor.kind === 'preopen' || descriptor.kind === 'directory'
          ? ERRNO.ISDIR
          : ERRNO.NOSYS;
      }
      if (!hasRights(descriptor, RIGHTS.FD_READ)) return ERRNO.NOTCAPABLE;
      return this.readFromFile(descriptor, iovs, iovsLength, descriptor.offset, read, true);
    }

    private fdPread(
      fd: number,
      iovs: number,
      iovsLength: number,
      offset: bigint,
      read: number
    ): number {
      const descriptor = this.#descriptors.get(fd);
      if (!descriptor) return ERRNO.BADF;
      if (descriptor.kind !== 'file') {
        return descriptor.kind === 'preopen' || descriptor.kind === 'directory'
          ? ERRNO.ISDIR
          : ERRNO.NOSYS;
      }
      if (!hasRights(descriptor, RIGHTS.FD_READ | RIGHTS.FD_SEEK)) return ERRNO.NOTCAPABLE;
      if (offset < 0n || offset > BigInt(Number.MAX_SAFE_INTEGER)) return ERRNO.INVAL;
      return this.readFromFile(descriptor, iovs, iovsLength, Number(offset), read, false);
    }

    private readFromFile(
      descriptor: Extract<WasiDescriptor, { readonly kind: 'file' }>,
      iovs: number,
      iovsLength: number,
      offset: number,
      read: number,
      updateOffset: boolean
    ): number {
      const targets = this.iovecs(iovs, iovsLength, null);
      if (typeof targets === 'number') return targets;
      if (!this.validMemorySpan(read, 4)) return ERRNO.FAULT;
      for (const target of targets) {
        if (!this.validMemorySpan(target.pointer, target.length)) return ERRNO.FAULT;
      }
      if (!runtime.vfs.readFileSliceSync) return ERRNO.NOSYS;
      let bytes: Uint8Array;
      try {
        bytes = runtime.vfs.readFileSliceSync(
          descriptor.path,
          offset,
          MAX_IO_BYTES
        );
      } catch (error) {
        return errno(error);
      }
      let total = 0;
      for (const target of targets) {
        if (total === MAX_IO_BYTES) break;
        const boundedLength = Math.min(
          target.length,
          MAX_IO_BYTES - total
        );
        const available = bytes.subarray(total, total + boundedLength);
        const result = this.writeBytes(target.pointer, available);
        if (result !== ERRNO.SUCCESS) return result;
        offset += available.byteLength;
        total += available.byteLength;
        if (available.byteLength < boundedLength) break;
      }
      const result = this.writeU32(read, total);
      if (result === ERRNO.SUCCESS && updateOffset) descriptor.offset = offset;
      return result;
    }

    private fdWrite(fd: number, iovs: number, iovsLength: number, written: number): number {
      const descriptor = this.#descriptors.get(fd);
      if (!descriptor) return ERRNO.BADF;
      if (descriptor.kind === 'preopen' || descriptor.kind === 'directory') return ERRNO.ISDIR;
      if (!hasRights(descriptor, RIGHTS.FD_WRITE)) return ERRNO.NOTCAPABLE;
      const memory = this.memory();
      if (!memory) return ERRNO.FAULT;
      const sources = this.iovecs(iovs, iovsLength, memory.buffer.byteLength);
      if (typeof sources === 'number') return sources;
      if (!this.validMemorySpan(written, 4)) return ERRNO.FAULT;
      let total = 0;
      for (const source of sources) {
        if (!inBounds(memory, source.pointer, source.length)) return ERRNO.FAULT;
        total += source.length;
      }
      try {
        const data = new Uint8Array(total);
        let offset = 0;
        for (const source of sources) {
          copyMemoryBytesInto(memory, source.pointer, source.length, data, offset);
          offset += source.length;
        }
        if (descriptor.kind === 'stdio') {
          if (!descriptor.writer) return ERRNO.BADF;
          descriptor.writer.write(data);
        } else if (descriptor.kind === 'file') {
          if (!runtime.vfs.readFileSync || !runtime.vfs.writeFileSync) return ERRNO.NOSYS;
          const current = runtime.vfs.readFileSync(descriptor.path);
          const offset = (descriptor.fdFlags & FD_FLAGS.APPEND) !== 0
            ? current.byteLength
            : descriptor.offset;
          runtime.vfs.writeFileSync(
            descriptor.path,
            replaceBytes(current, data, offset)
          );
          descriptor.offset = offset + data.byteLength;
        }
      } catch (error) {
        return errno(error);
      }
      return this.writeU32(written, total);
    }

    private fdReaddir(
      fd: number,
      buffer: number,
      bufferLength: number,
      cookie: bigint,
      used: number
    ): number {
      const descriptor = this.#descriptors.get(fd);
      if (!descriptor) return ERRNO.BADF;
      if (descriptor.kind !== 'preopen' && descriptor.kind !== 'directory') return ERRNO.NOTDIR;
      if (!hasRights(descriptor, RIGHTS.FD_READDIR)) return ERRNO.NOTCAPABLE;
      if (!runtime.vfs.readdirSync || !runtime.vfs.lstatSync) return ERRNO.NOSYS;
      if (
        cookie < 0n ||
        cookie > BigInt(Number.MAX_SAFE_INTEGER) ||
        !this.validLength(bufferLength)
      ) return ERRNO.INVAL;
      if (!this.validMemorySpan(buffer, bufferLength) || !this.validMemorySpan(used, 4)) {
        return ERRNO.FAULT;
      }
      const memory = this.memory();
      if (!memory) return ERRNO.FAULT;
      const path = descriptor.kind === 'preopen' ? descriptor.hostPath : descriptor.path;
      try {
        const entries = runtime.vfs.readdirSync(path, { withFileTypes: true });
        let targetOffset = 0;
        for (let index = Number(cookie); index < entries.length && targetOffset < bufferLength; index += 1) {
          const entry = entries[index];
          const name = encode(entry.name);
          const stat = runtime.vfs.lstatSync(joinAbsolutePath(path, entry.name));
          const record = new Uint8Array(24 + name.byteLength);
          const recordView = new DataView(record.buffer);
          recordView.setBigUint64(0, BigInt(index + 1), true);
          recordView.setBigUint64(8, BigInt(stat.ino), true);
          recordView.setUint32(16, name.byteLength, true);
          recordView.setUint8(20, filetypeFromVfs(entry));
          record.set(name, 24);
          const available = Math.min(record.byteLength, bufferLength - targetOffset);
          copyBytesIntoMemory(memory, buffer + targetOffset, record.subarray(0, available));
          targetOffset += available;
          if (available < record.byteLength) break;
        }
        return this.writeU32(used, targetOffset);
      } catch (error) {
        return errno(error);
      }
    }

    private fdSeek(fd: number, offset: bigint, whence: number, result: number): number {
      const descriptor = this.#descriptors.get(fd);
      if (!descriptor || descriptor.kind !== 'file') return descriptor ? ERRNO.ISDIR : ERRNO.BADF;
      if (!hasRights(descriptor, RIGHTS.FD_SEEK)) return ERRNO.NOTCAPABLE;
      if (!this.validMemorySpan(result, 8)) return ERRNO.FAULT;
      let size = 0;
      try {
        if (!runtime.vfs.readFileSync) return ERRNO.NOSYS;
        size = runtime.vfs.readFileSync(descriptor.path).byteLength;
      } catch (error) {
        return errno(error);
      }
      const base = whence === 0 ? 0n : whence === 1 ? BigInt(descriptor.offset) : whence === 2 ? BigInt(size) : undefined;
      if (base === undefined) return ERRNO.INVAL;
      const next = base + offset;
      if (next < 0n || next > BigInt(Number.MAX_SAFE_INTEGER)) return ERRNO.INVAL;
      const writeResult = this.writeU64(result, next);
      if (writeResult === ERRNO.SUCCESS) descriptor.offset = Number(next);
      return writeResult;
    }

    private fdTell(fd: number, result: number): number {
      const descriptor = this.#descriptors.get(fd);
      if (!descriptor || descriptor.kind !== 'file') return descriptor ? ERRNO.ISDIR : ERRNO.BADF;
      if (!hasRights(descriptor, RIGHTS.FD_TELL)) return ERRNO.NOTCAPABLE;
      return this.writeU64(result, BigInt(descriptor.offset));
    }

    /** Closes any descriptor but standard input, output and error, wherever fd_renumber moved them. */
    private fdClose(fd: number): number {
      const descriptor = this.#descriptors.get(fd);
      if (!descriptor || descriptor.kind === 'stdio') return ERRNO.BADF;
      this.#descriptors.delete(fd);
      return ERRNO.SUCCESS;
    }

    private pathOpen(
      fd: number,
      dirflags: number,
      path: number,
      pathLength: number,
      oflags: number,
      rightsBase: bigint,
      rightsInheriting: bigint,
      fdflags: number,
      openedFd: number
    ): number {
      if (
        (dirflags & ~1) !== 0 ||
        (oflags & ~15) !== 0 ||
        (fdflags & ~KNOWN_FD_FLAGS) !== 0
      ) return ERRNO.INVAL;
      const create = (oflags & 1) !== 0;
      const directory = (oflags & 2) !== 0;
      const exclusive = (oflags & 4) !== 0;
      const truncate = (oflags & 8) !== 0;
      if ((exclusive && !create) || (directory && (create || truncate))) return ERRNO.INVAL;
      // Nothing here blocks, so NONBLOCK changes nothing and is kept as Node's
      // WASI keeps it; Rust's standard library opens every directory with it.
      if ((fdflags & ~(FD_FLAGS.APPEND | FD_FLAGS.NONBLOCK)) !== 0) return ERRNO.NOTCAPABLE;
      if (
        (fdflags & FD_FLAGS.APPEND) !== 0 &&
        (rightsBase & RIGHTS.FD_WRITE) === 0n
      ) return ERRNO.NOTCAPABLE;
      if (((rightsBase | rightsInheriting) & ~KNOWN_RIGHTS) !== 0n) return ERRNO.INVAL;
      const descriptor = this.#descriptors.get(fd);
      if (!descriptor) return ERRNO.BADF;
      if (descriptor.kind !== 'preopen' && descriptor.kind !== 'directory') return ERRNO.NOTDIR;
      if (!hasRights(descriptor, RIGHTS.PATH_OPEN)) return ERRNO.NOTCAPABLE;
      if ((rightsBase & ~descriptor.rightsInheriting) !== 0n || (rightsInheriting & ~descriptor.rightsInheriting) !== 0n) {
        return ERRNO.NOTCAPABLE;
      }
      if (!runtime.vfs.realpathSync || !runtime.vfs.lstatSync) return ERRNO.NOSYS;
      if (!this.validMemorySpan(openedFd, 4)) return ERRNO.FAULT;
      const guestPath = this.readString(path, pathLength);
      if (typeof guestPath === 'number') return guestPath;
      try {
        let hostPath = resolveConfinedPath(runtime.vfs, descriptor, guestPath, false);
        if (!hostPath) return ERRNO.NOTCAPABLE;
        let stat: WasiVfsStat | undefined;
        let created = false;
        try {
          stat = runtime.vfs.lstatSync(hostPath);
        } catch (error) {
          if (errno(error) !== ERRNO.NOENT || !create) return errno(error);
        }
        if (stat && exclusive && create) return ERRNO.EXIST;
        if (!stat) {
          if (directory) return ERRNO.NOENT;
          if (!hasRights(descriptor, RIGHTS.PATH_CREATE_FILE)) return ERRNO.NOTCAPABLE;
          if (!runtime.vfs.writeFileSync) return ERRNO.NOSYS;
          runtime.vfs.writeFileSync(hostPath, new Uint8Array());
          stat = runtime.vfs.lstatSync(hostPath);
          created = true;
        } else if (stat.isSymbolicLink()) {
          if (dirflags === 0) return ERRNO.LOOP;
          const followed = resolveConfinedPath(runtime.vfs, descriptor, guestPath, true);
          if (!followed) return ERRNO.NOTCAPABLE;
          hostPath = followed;
          stat = runtime.vfs.lstatSync(hostPath);
        }
        if (stat.isDirectory()) {
          if ((rightsBase & ~PREVIEW1_DIRECTORY_BASE_RIGHTS) !== 0n) {
            return ERRNO.NOTCAPABLE;
          }
          if ((rightsInheriting & ~PREVIEW1_DIRECTORY_INHERITING_RIGHTS) !== 0n) {
            return ERRNO.NOTCAPABLE;
          }
          const grantedBase = grantedPathOpenRights(rightsBase, WRITABLE_DIRECTORY_RIGHTS);
          const nextFd = this.#nextDescriptor++;
          this.#descriptors.set(nextFd, {
            kind: 'directory',
            path: hostPath,
            capabilityRoot:
              descriptor.kind === 'preopen'
                ? descriptor.hostPath
                : descriptor.capabilityRoot,
            rightsBase: grantedBase,
            rightsInheriting,
            fdFlags: fdflags
          });
          return this.writeU32(openedFd, nextFd);
        }
        if (directory) return ERRNO.NOTDIR;
        if (!stat.isFile()) return ERRNO.NOENT;
        const grantedBase = grantedPathOpenRights(rightsBase, WRITABLE_FILE_RIGHTS);
        if (truncate && !created) {
          if (
            !hasRights(descriptor, RIGHTS.PATH_FILESTAT_SET_SIZE) ||
            (rightsBase & RIGHTS.FD_WRITE) === 0n
          ) return ERRNO.NOTCAPABLE;
          if (!runtime.vfs.writeFileSync) return ERRNO.NOSYS;
          runtime.vfs.writeFileSync(hostPath, new Uint8Array());
        }
        const nextFd = this.#nextDescriptor++;
        this.#descriptors.set(nextFd, {
          kind: 'file',
          path: hostPath,
          rightsBase: grantedBase,
          rightsInheriting: 0n,
          fdFlags: fdflags,
          offset: 0
        });
        return this.writeU32(openedFd, nextFd);
      } catch (error) {
        return errno(error);
      }
    }

    private pathFilestatGet(
      fd: number,
      flags: number,
      path: number,
      pathLength: number,
      result: number
    ): number {
      if ((flags & ~1) !== 0) return ERRNO.INVAL;
      const descriptor = this.#descriptors.get(fd);
      if (!descriptor) return ERRNO.BADF;
      if (descriptor.kind !== 'preopen' && descriptor.kind !== 'directory') return ERRNO.NOTDIR;
      if (!hasRights(descriptor, RIGHTS.PATH_FILESTAT_GET)) return ERRNO.NOTCAPABLE;
      if (!this.validMemorySpan(result, 64)) return ERRNO.FAULT;
      const guestPath = this.readString(path, pathLength);
      if (typeof guestPath === 'number') return guestPath;
      const stat = flags === 1 ? runtime.vfs.statSync : runtime.vfs.lstatSync;
      if (!stat) return ERRNO.NOSYS;
      try {
        const hostPath = resolveConfinedPath(runtime.vfs, descriptor, guestPath, flags === 1);
        if (!hostPath) return ERRNO.NOTCAPABLE;
        return this.writeVfsFilestat(result, Reflect.apply(stat, runtime.vfs, [hostPath]));
      } catch (error) {
        return errno(error);
      }
    }

    private pathCreateDirectory(fd: number, path: number, pathLength: number): number {
      return this.mutatePath(
        fd,
        path,
        pathLength,
        RIGHTS.PATH_CREATE_DIRECTORY,
        (hostPath) => {
          if (!runtime.vfs.mkdirSync) return ERRNO.NOSYS;
          runtime.vfs.mkdirSync(hostPath);
          return ERRNO.SUCCESS;
        },
        { atRoot: ERRNO.EXIST }
      );
    }

    private pathReadlink(
      fd: number,
      path: number,
      pathLength: number,
      buffer: number,
      bufferLength: number,
      used: number
    ): number {
      const descriptor = this.#descriptors.get(fd);
      if (!descriptor) return ERRNO.BADF;
      if (descriptor.kind !== 'preopen' && descriptor.kind !== 'directory') return ERRNO.NOTDIR;
      if (!hasRights(descriptor, RIGHTS.PATH_READLINK)) return ERRNO.NOTCAPABLE;
      if (!this.validLength(bufferLength)) return ERRNO.INVAL;
      if (!runtime.vfs.readlinkSync) return ERRNO.NOSYS;
      if (!this.validMemorySpan(buffer, bufferLength) || !this.validMemorySpan(used, 4)) {
        return ERRNO.FAULT;
      }
      const guestPath = this.readString(path, pathLength);
      if (typeof guestPath === 'number') return guestPath;
      try {
        const hostPath = resolveConfinedPath(runtime.vfs, descriptor, guestPath, false);
        if (!hostPath) return ERRNO.NOTCAPABLE;
        const target = encode(runtime.vfs.readlinkSync(hostPath));
        const bytes = target.subarray(0, bufferLength);
        const result = this.writeBytes(buffer, bytes);
        return result === ERRNO.SUCCESS ? this.writeU32(used, bytes.byteLength) : result;
      } catch (error) {
        return errno(error);
      }
    }

    private pathRemoveDirectory(fd: number, path: number, pathLength: number): number {
      return this.mutatePath(
        fd,
        path,
        pathLength,
        RIGHTS.PATH_REMOVE_DIRECTORY,
        (hostPath) => {
          if (!runtime.vfs.lstatSync || !runtime.vfs.rmSync) return ERRNO.NOSYS;
          if (!runtime.vfs.lstatSync(hostPath).isDirectory()) return ERRNO.NOTDIR;
          runtime.vfs.rmSync(hostPath);
          return ERRNO.SUCCESS;
        },
        // `rmdir(".")` is EINVAL on Linux.
        { atRoot: ERRNO.INVAL }
      );
    }

    /** Creates the link inside the descriptor's directory; its target is stored as given. */
    private pathSymlink(
      target: number,
      targetLength: number,
      fd: number,
      path: number,
      pathLength: number
    ): number {
      return this.mutatePath(
        fd,
        path,
        pathLength,
        RIGHTS.PATH_SYMLINK,
        (hostPath) => {
          if (!runtime.vfs.symlinkSync) return ERRNO.NOSYS;
          const linkTarget = this.readString(target, targetLength);
          if (typeof linkTarget === 'number') return linkTarget;
          if (linkTarget === '') return ERRNO.NOENT;
          runtime.vfs.symlinkSync(linkTarget, hostPath);
          return ERRNO.SUCCESS;
        },
        { atRoot: ERRNO.EXIST }
      );
    }

    private pathUnlinkFile(fd: number, path: number, pathLength: number): number {
      return this.mutatePath(
        fd,
        path,
        pathLength,
        RIGHTS.PATH_UNLINK_FILE,
        (hostPath) => {
          if (!runtime.vfs.lstatSync || !runtime.vfs.rmSync) return ERRNO.NOSYS;
          if (runtime.vfs.lstatSync(hostPath).isDirectory()) return ERRNO.ISDIR;
          runtime.vfs.rmSync(hostPath);
          return ERRNO.SUCCESS;
        },
        { atRoot: ERRNO.ISDIR }
      );
    }

    /**
     * Runs `operation` on the host path `path` names under the directory
     * descriptor `fd`, which must hold `right`. The path's last component is
     * taken as it is unless `follow` asks for the file a symbolic link there
     * resolves to; either way the result stays inside the capability root.
     * An operation that would remove, replace or create the capability root
     * itself names the error it fails with as `atRoot`, as Linux fails the
     * same operation on `.`.
     */
    private mutatePath(
      fd: number,
      path: number,
      pathLength: number,
      right: bigint,
      operation: (hostPath: string) => number,
      options: { readonly follow?: boolean; readonly atRoot?: number } = {}
    ): number {
      const descriptor = this.#descriptors.get(fd);
      if (!descriptor) return ERRNO.BADF;
      if (descriptor.kind !== 'preopen' && descriptor.kind !== 'directory') return ERRNO.NOTDIR;
      if (!hasRights(descriptor, right)) return ERRNO.NOTCAPABLE;
      if (!runtime.vfs.realpathSync) return ERRNO.NOSYS;
      const guestPath = this.readString(path, pathLength);
      if (typeof guestPath === 'number') return guestPath;
      try {
        const hostPath = resolveConfinedPath(runtime.vfs, descriptor, guestPath, options.follow ?? false);
        if (!hostPath) return ERRNO.NOTCAPABLE;
        if (options.atRoot !== undefined && hostPath === capabilityRootOf(descriptor)) return options.atRoot;
        return operation(hostPath);
      } catch (error) {
        return errno(error);
      }
    }

    private pollOneoff(
      subscriptions: number,
      events: number,
      count: number,
      eventCount: number
    ): number {
      if (
        !Number.isInteger(count) ||
        count <= 0 ||
        count > MAX_POLL_SUBSCRIPTIONS
      ) {
        return ERRNO.INVAL;
      }
      const memory = this.memory();
      if (
        !memory ||
        !inBounds(memory, subscriptions, count * POLL_SUBSCRIPTION_SIZE) ||
        !inBounds(memory, events, count * POLL_EVENT_SIZE) ||
        !inBounds(memory, eventCount, 4)
      ) {
        return ERRNO.FAULT;
      }
      const view = new DataView(memory.buffer);
      view.setUint32(eventCount, 0, true);
      const pending: PollSubscription[] = [];
      // Reads of an empty standard input that would block until input arrives or ends.
      const pendingStdin: bigint[] = [];
      const immediate: PollEvent[] = [];
      for (let index = 0; index < count; index += 1) {
        const pointer = subscriptions + index * POLL_SUBSCRIPTION_SIZE;
        const userdata = view.getBigUint64(pointer, true);
        const type = view.getUint8(pointer + 8);
        if (type === POLL_EVENT_TYPES.CLOCK) {
          const clockId = view.getUint32(pointer + 16, true);
          const timeout = view.getBigUint64(pointer + 24, true);
          const flags = view.getUint16(pointer + 40, true);
          if (
            (flags & ~SUBSCRIPTION_CLOCK_ABSTIME) !== 0 ||
            (clockId !== 0 && clockId !== 1)
          ) {
            immediate.push({ userdata, error: ERRNO.INVAL, type, nbytes: 0n, flags: 0 });
            continue;
          }
          const now = clockId === 0
            ? runtime.realtimeNowNs?.() ?? BigInt(Date.now()) * 1_000_000n
            : runtime.monotonicNowNs?.() ?? monotonicNowNanoseconds();
          const remaining = (flags & SUBSCRIPTION_CLOCK_ABSTIME) === 0
            ? timeout
            : timeout > now
              ? timeout - now
              : 0n;
          const subscription = { userdata, type, remaining } as const;
          pending.push(subscription);
          if (remaining === 0n) immediate.push(pollClockEvent(subscription));
          continue;
        }
        if (type === POLL_EVENT_TYPES.FD_READ || type === POLL_EVENT_TYPES.FD_WRITE) {
          const fd = view.getUint32(pointer + 16, true);
          if (type === POLL_EVENT_TYPES.FD_READ && this.waitsForStdin(fd)) {
            const available = runtime.stdin!.available!();
            if (available === 0) pendingStdin.push(userdata);
            else immediate.push(stdinReadEvent(userdata, available));
            continue;
          }
          immediate.push(this.descriptorPollEvent(userdata, type, fd));
          continue;
        }
        immediate.push({ userdata, error: ERRNO.INVAL, type, nbytes: 0n, flags: 0 });
      }

      let occurred = immediate;
      if (occurred.length === 0) {
        const delay = pending.reduce<bigint | undefined>(
          (minimum, subscription) =>
            minimum === undefined || subscription.remaining < minimum
              ? subscription.remaining
              : minimum,
          undefined
        );
        if (pendingStdin.length > 0) {
          occurred = this.waitForStdin(pendingStdin, pending, delay);
        } else {
          if (delay === undefined) return ERRNO.INVAL;
          waitForPoll(delay);
          occurred = pending
            .filter((subscription) => subscription.remaining <= delay)
            .map(pollClockEvent);
        }
      }

      for (let index = 0; index < occurred.length; index += 1) {
        writePollEvent(view, events + index * POLL_EVENT_SIZE, occurred[index]);
      }
      view.setUint32(eventCount, occurred.length, true);
      return ERRNO.SUCCESS;
    }

    /** Whether a read poll of `fd` can wait for standard input instead of answering at once. */
    private waitsForStdin(fd: number): boolean {
      const descriptor = this.#descriptors.get(fd);
      return (
        fd === 0 &&
        descriptor?.kind === 'stdio' &&
        hasRights(descriptor, RIGHTS.FD_READ) &&
        runtime.stdin?.available !== undefined &&
        runtime.stdin.wait !== undefined
      );
    }

    /**
     * Blocks until standard input has bytes or has ended, or until the
     * earliest clock subscription is due, with no limit when there is none.
     * The wait is on the value just observed, so input that arrives between
     * the check and the wait ends it at once.
     */
    private waitForStdin(
      readers: readonly bigint[],
      clocks: readonly PollSubscription[],
      delay: bigint | undefined
    ): PollEvent[] {
      const stdin = runtime.stdin!;
      const started = monotonicNowNanoseconds();
      for (;;) {
        const available = stdin.available!();
        const elapsed = monotonicNowNanoseconds() - started;
        const due = clocks.filter((subscription) => subscription.remaining <= elapsed).map(pollClockEvent);
        if (available !== 0) return [...readers.map((userdata) => stdinReadEvent(userdata, available)), ...due];
        if (due.length > 0) return due;
        stdin.wait!(
          available,
          delay === undefined ? undefined : Math.min(Number(delay - elapsed) / 1_000_000, 2_147_483_647)
        );
      }
    }

    private descriptorPollEvent(
      userdata: bigint,
      type: typeof POLL_EVENT_TYPES.FD_READ | typeof POLL_EVENT_TYPES.FD_WRITE,
      fd: number
    ): PollEvent {
      const descriptor = this.#descriptors.get(fd);
      if (!descriptor) return { userdata, error: ERRNO.BADF, type, nbytes: 0n, flags: 0 };
      const right = type === POLL_EVENT_TYPES.FD_READ
        ? RIGHTS.FD_READ
        : RIGHTS.FD_WRITE;
      if (!hasRights(descriptor, right)) {
        return { userdata, error: ERRNO.NOTCAPABLE, type, nbytes: 0n, flags: 0 };
      }
      if (type === POLL_EVENT_TYPES.FD_WRITE) {
        return { userdata, error: ERRNO.SUCCESS, type, nbytes: 0n, flags: 0 };
      }
      if (descriptor.kind === 'stdio' && fd === 0 && runtime.stdin) {
        return stdinReadEvent(userdata, runtime.stdin.available?.() ?? 0);
      }
      if (descriptor.kind !== 'file') {
        return {
          userdata,
          error: descriptor.kind === 'preopen' || descriptor.kind === 'directory'
            ? ERRNO.SUCCESS
            : ERRNO.NOSYS,
          type,
          nbytes: 0n,
          flags: 0
        };
      }
      if (!runtime.vfs.readFileSync) {
        return { userdata, error: ERRNO.NOSYS, type, nbytes: 0n, flags: 0 };
      }
      try {
        const size = runtime.vfs.readFileSync(descriptor.path).byteLength;
        return {
          userdata,
          error: ERRNO.SUCCESS,
          type,
          nbytes: BigInt(Math.max(0, size - descriptor.offset)),
          flags: 0
        };
      } catch (error) {
        return { userdata, error: errno(error), type, nbytes: 0n, flags: 0 };
      }
    }

    private procExit(code: number): number {
      if (this.#returnOnExit) throw new WasiExit(code >>> 0);
      runtime.process.exit(code >>> 0);
      throw new WasiExit(code >>> 0);
    }

    private iovecs(
      pointer: number,
      count: number,
      maximumTotalBytes: number | null = MAX_IO_BYTES
    ): Array<{ readonly pointer: number; readonly length: number }> | number {
      if (!Number.isInteger(count) || count < 0 || count > MAX_IOVECS) return ERRNO.INVAL;
      const memory = this.memory();
      if (!memory || !inBounds(memory, pointer, count * 8)) return ERRNO.FAULT;
      const view = new DataView(memory.buffer);
      const iovecs: Array<{ readonly pointer: number; readonly length: number }> = [];
      let total = 0;
      for (let index = 0; index < count; index += 1) {
        const offset = pointer + index * 8;
        const item = { pointer: view.getUint32(offset, true), length: view.getUint32(offset + 4, true) };
        total += item.length;
        if (maximumTotalBytes !== null && total > maximumTotalBytes) return ERRNO.INVAL;
        iovecs.push(item);
      }
      return iovecs;
    }

    private writeStrings(pointers: number, bytes: number, strings: readonly string[]): number {
      const encoded = strings.map((value) => appendNul(encode(value)));
      const total = encodedLength(strings);
      const memory = this.memory();
      if (!memory || !inBounds(memory, pointers, strings.length * 4) || !inBounds(memory, bytes, total)) return ERRNO.FAULT;
      const view = new DataView(memory.buffer);
      let offset = bytes;
      for (const value of encoded) {
        view.setUint32(pointers, offset, true);
        copyBytesIntoMemory(memory, offset, value);
        pointers += 4;
        offset += value.byteLength;
      }
      return ERRNO.SUCCESS;
    }

    private writeU32Pair(firstPointer: number, first: number, secondPointer: number, second: number): number {
      const firstResult = this.writeU32(firstPointer, first);
      return firstResult === ERRNO.SUCCESS ? this.writeU32(secondPointer, second) : firstResult;
    }

    private writeU32(pointer: number, value: number): number {
      const memory = this.memory();
      if (!memory || !inBounds(memory, pointer, 4)) return ERRNO.FAULT;
      new DataView(memory.buffer).setUint32(pointer, value >>> 0, true);
      return ERRNO.SUCCESS;
    }

    private writeU64(pointer: number, value: bigint): number {
      const memory = this.memory();
      if (!memory || !inBounds(memory, pointer, 8)) return ERRNO.FAULT;
      new DataView(memory.buffer).setBigUint64(pointer, value, true);
      return ERRNO.SUCCESS;
    }

    private writeVfsFilestat(pointer: number, stat: WasiVfsStat): number {
      return this.writeFilestat(pointer, {
        filetype: filetypeFromVfs(stat),
        inode: stat.ino,
        size: stat.size,
        ctimeMs: stat.ctime.getTime(),
        mtimeMs: stat.mtime.getTime()
      });
    }

    private writeFilestat(
      pointer: number,
      stat: {
        readonly filetype: number;
        readonly inode: number;
        readonly size: number;
        readonly ctimeMs: number;
        readonly mtimeMs: number;
      }
    ): number {
      const memory = this.memory();
      if (!memory || !inBounds(memory, pointer, 64)) return ERRNO.FAULT;
      const view = new DataView(memory.buffer);
      new Uint8Array(memory.buffer, pointer, 64).fill(0);
      view.setBigUint64(pointer + 8, BigInt(stat.inode), true);
      view.setUint8(pointer + 16, stat.filetype);
      view.setBigUint64(pointer + 24, 1n, true);
      view.setBigUint64(pointer + 32, BigInt(stat.size), true);
      const modified = millisecondsToNanoseconds(stat.mtimeMs);
      view.setBigUint64(pointer + 40, modified, true);
      view.setBigUint64(pointer + 48, modified, true);
      view.setBigUint64(pointer + 56, millisecondsToNanoseconds(stat.ctimeMs), true);
      return ERRNO.SUCCESS;
    }

    private writeBytes(pointer: number, bytes: Uint8Array): number {
      const memory = this.memory();
      if (!memory || !inBounds(memory, pointer, bytes.byteLength)) return ERRNO.FAULT;
      copyBytesIntoMemory(memory, pointer, bytes);
      return ERRNO.SUCCESS;
    }

    private readString(pointer: number, length: number): string | number {
      if (!this.validLength(length)) return ERRNO.INVAL;
      const memory = this.memory();
      if (!memory || !inBounds(memory, pointer, length)) return ERRNO.FAULT;
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(copyMemoryBytes(memory, pointer, length));
      } catch {
        return ERRNO.INVAL;
      }
    }

    private memory(): WebAssembly.Memory | undefined {
      return this.#memory;
    }

    private validMemorySpan(pointer: number, length: number): boolean {
      const memory = this.memory();
      return memory !== undefined && inBounds(memory, pointer, length);
    }

    private validLength(length: number): boolean {
      return Number.isInteger(length) && length >= 0 && length <= MAX_IO_BYTES;
    }
  }

  return new Preview1WasiHost();
}

export function createWasiPreview1ExecutionFactory(
  runtime: WasiCommandExecutionRuntime
): WasiPreview1ExecutionFactory {
  return (options) => createPreview1HostCore(runtime, options);
}

export function createWasiNodeAdapterFactory(
  runtime: WasiCommandExecutionRuntime
): WasiNodeAdapterFactory {
  const createExecution = createWasiPreview1ExecutionFactory(runtime);
  return (options) => {
    const execution = createExecution(options);
    return {
      wasiImport: execution.imports,
      getImportObject: () => execution.getImportObject(),
      initialize: (instance) => execution.initialize(instance),
      start: (instance) => execution.start(instance)
    };
  };
}

function absolutePath(path: string): string {
  if (!path.startsWith('/')) throw new TypeError(`WASI preopen path must be absolute: ${path}`);
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') throw new TypeError(`WASI preopen path must not traverse: ${path}`);
    segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

function resolveContainedPath(preopen: Extract<WasiDescriptor, { readonly kind: 'preopen' }>, guestPath: string): string | undefined {
  const segments = containedSegments(guestPath);
  if (!segments) return undefined;
  if (guestPath.startsWith('/')) {
    const normalizedGuest = `/${segments.join('/')}`;
    if (normalizedGuest === preopen.guestPath) return preopen.hostPath;
    if (!normalizedGuest.startsWith(`${preopen.guestPath}/`)) return undefined;
    return `${preopen.hostPath}${normalizedGuest.slice(preopen.guestPath.length)}`;
  }
  return segments.length === 0 ? preopen.hostPath : `${preopen.hostPath}/${segments.join('/')}`;
}

/** The host directory a directory descriptor's paths are confined to: its preopen's. */
function capabilityRootOf(
  descriptor: Extract<WasiDescriptor, { readonly kind: 'preopen' | 'directory' }>
): string {
  return descriptor.kind === 'preopen' ? descriptor.hostPath : descriptor.capabilityRoot;
}

function resolveConfinedPath(
  vfs: WasiSynchronousVfsPort,
  descriptor: Extract<WasiDescriptor, { readonly kind: 'preopen' | 'directory' }>,
  guestPath: string,
  followFinal: boolean
): string | undefined {
  const root = capabilityRootOf(descriptor);
  const candidate = descriptor.kind === 'preopen'
    ? resolveContainedPath(descriptor, guestPath)
    : resolveRelativePath(descriptor.path, guestPath, descriptor.capabilityRoot);
  if (!candidate) return undefined;
  if (!vfs.realpathSync) return undefined;
  // The capability root itself (`.`) is inside it, though its parent is not.
  if (candidate === root) return root;
  if (followFinal) {
    const resolved = vfs.realpathSync(candidate);
    return isContainedHostPath(root, resolved) ? resolved : undefined;
  }
  const parent = parentPath(candidate);
  const resolvedParent = vfs.realpathSync(parent);
  if (!isContainedHostPath(root, resolvedParent)) return undefined;
  return joinAbsolutePath(resolvedParent, baseName(candidate));
}

function resolveRelativePath(
  base: string,
  guestPath: string,
  capabilityRoot: string
): string | undefined {
  if (guestPath.startsWith('/')) return undefined;
  const rootSegments = absoluteSegments(capabilityRoot);
  const segments = absoluteSegments(base);
  if (
    segments.length < rootSegments.length ||
    !rootSegments.every((segment, index) => segments[index] === segment)
  ) {
    return undefined;
  }
  for (const segment of guestPath.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === rootSegments.length) return undefined;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return `/${segments.join('/')}`;
}

function absoluteSegments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function containedSegments(path: string): string[] | undefined {
  const result: string[] = [];
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') return undefined;
    result.push(segment);
  }
  return result;
}

function descriptorFiletype(descriptor: WasiDescriptor): number {
  return descriptor.kind === 'stdio'
    ? 2
    : descriptor.kind === 'preopen' || descriptor.kind === 'directory'
      ? 3
      : 4;
}

function hasRights(descriptor: WasiDescriptor, required: bigint): boolean {
  return (descriptor.rightsBase & required) === required;
}

/**
 * The rights a descriptor `path_open` creates is given: those requested that
 * the runtime implements for its type. A right it does not implement is left
 * out rather than refused, as Node's WASI does and as Preview1 permits; the
 * opening descriptor's inheriting rights have already bounded the request.
 * Rust's standard library and wasi-libc each ask for their own broad masks.
 */
function grantedPathOpenRights(requested: bigint, supported: bigint): bigint {
  return requested & supported;
}

function isContainedHostPath(root: string, path: string): boolean {
  return root === '/' ? path.startsWith('/') : path === root || path.startsWith(`${root}/`);
}

function filetypeFromVfs(value: {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): number {
  return value.isDirectory() ? 3 : value.isFile() ? 4 : value.isSymbolicLink() ? 7 : 0;
}

function parentPath(path: string): string {
  const separator = path.lastIndexOf('/');
  return separator <= 0 ? '/' : path.slice(0, separator);
}

function baseName(path: string): string {
  const separator = path.lastIndexOf('/');
  return path.slice(separator + 1);
}

function joinAbsolutePath(parent: string, child: string): string {
  return parent === '/' ? `/${child}` : `${parent}/${child}`;
}

function replaceBytes(current: Uint8Array, insertion: Uint8Array, offset: number): Uint8Array {
  const length = Math.max(current.byteLength, offset + insertion.byteLength);
  const result = new Uint8Array(length);
  result.set(current);
  result.set(insertion, offset);
  return result;
}

function millisecondsToNanoseconds(milliseconds: number): bigint {
  return BigInt(Math.max(0, Math.floor(milliseconds * 1_000_000)));
}

function copyBytesIntoMemory(memory: WebAssembly.Memory, pointer: number, bytes: Uint8Array): void {
  const target = new Uint8Array(memory.buffer, pointer, bytes.byteLength);
  if (!isSharedMemoryBuffer(memory.buffer)) {
    target.set(bytes);
    return;
  }
  for (let index = 0; index < bytes.byteLength; index += 1) Atomics.store(target, index, bytes[index]);
}

function copyMemoryBytes(memory: WebAssembly.Memory, pointer: number, length: number): Uint8Array {
  const result = new Uint8Array(length);
  copyMemoryBytesInto(memory, pointer, length, result, 0);
  return result;
}

function copyMemoryBytesInto(
  memory: WebAssembly.Memory,
  pointer: number,
  length: number,
  target: Uint8Array,
  targetOffset: number
): void {
  const source = new Uint8Array(memory.buffer, pointer, length);
  if (!isSharedMemoryBuffer(memory.buffer)) {
    target.set(source, targetOffset);
    return;
  }
  for (let index = 0; index < source.byteLength; index += 1) {
    target[targetOffset + index] = Atomics.load(source, index);
  }
}

function isSharedMemoryBuffer(buffer: ArrayBufferLike): buffer is SharedArrayBuffer {
  return Object.prototype.toString.call(buffer) === '[object SharedArrayBuffer]';
}

function inBounds(memory: WebAssembly.Memory, pointer: number, length: number): boolean {
  return Number.isInteger(pointer) && Number.isInteger(length) && pointer >= 0 && length >= 0 && pointer <= memory.buffer.byteLength - length;
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function appendNul(value: Uint8Array): Uint8Array {
  const result = new Uint8Array(value.byteLength + 1);
  result.set(value);
  return result;
}

function encodedLength(values: readonly string[]): number {
  return values.reduce((total, value) => total + encode(value).byteLength + 1, 0);
}

function secureRandom(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let offset = 0; offset < length; offset += 65_536) {
    globalThis.crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65_536, length)));
  }
  return bytes;
}

interface PollSubscription {
  readonly userdata: bigint;
  readonly type: typeof POLL_EVENT_TYPES.CLOCK;
  readonly remaining: bigint;
}

interface PollEvent {
  readonly userdata: bigint;
  readonly error: number;
  readonly type: number;
  readonly nbytes: bigint;
  readonly flags: number;
}

/** A readable standard input: the bytes held, or end of input, which reads return at once. */
function stdinReadEvent(userdata: bigint, available: number): PollEvent {
  return {
    userdata,
    error: ERRNO.SUCCESS,
    type: POLL_EVENT_TYPES.FD_READ,
    nbytes: BigInt(Math.max(available, 0)),
    flags: available < 0 ? EVENT_FD_READWRITE_HANGUP : 0
  };
}

function pollClockEvent(subscription: PollSubscription): PollEvent {
  return {
    userdata: subscription.userdata,
    error: ERRNO.SUCCESS,
    type: subscription.type,
    nbytes: 0n,
    flags: 0
  };
}

function writePollEvent(view: DataView, pointer: number, event: PollEvent): void {
  new Uint8Array(view.buffer, pointer, POLL_EVENT_SIZE).fill(0);
  view.setBigUint64(pointer, event.userdata, true);
  view.setUint16(pointer + 8, event.error, true);
  view.setUint8(pointer + 10, event.type);
  view.setBigUint64(pointer + 16, event.nbytes, true);
  view.setUint16(pointer + 24, event.flags, true);
}

function monotonicNowNanoseconds(): bigint {
  return BigInt(Math.floor(globalThis.performance.now() * 1_000_000));
}

function waitForPoll(timeoutNanoseconds: bigint): 'timed-out' {
  const timeoutMilliseconds = Math.min(
    Number(timeoutNanoseconds) / 1_000_000,
    2_147_483_647
  );
  const word = pollWaitWord ??= new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(word, 0, 0, timeoutMilliseconds);
  return 'timed-out';
}

function byteWriter(stream: unknown): WasiByteWriter | undefined {
  if ((typeof stream !== 'object' && typeof stream !== 'function') || stream === null) return undefined;
  const write = Reflect.get(stream, 'write');
  if (typeof write !== 'function') return undefined;
  return {
    write(chunk) {
      Reflect.apply(write, stream, [chunk]);
    }
  };
}

function errno(error: unknown): number {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 'ENOENT' || code === 'NOT_FOUND') return ERRNO.NOENT;
  if (code === 'ENOTDIR' || code === 'NOT_DIRECTORY') return ERRNO.NOTDIR;
  if (code === 'ENOTEMPTY' || code === 'DIRECTORY_NOT_EMPTY') return ERRNO.NOTEMPTY;
  if (code === 'EISDIR' || code === 'IS_DIRECTORY') return ERRNO.ISDIR;
  if (code === 'EINVAL' || code === 'INVALID_ARGUMENT') return ERRNO.INVAL;
  if (code === 'ELOOP' || code === 'SYMBOLIC_LINK_LOOP') return ERRNO.LOOP;
  if (code === 'EEXIST' || code === 'ALREADY_EXISTS') return ERRNO.EXIST;
  if (code === 'EACCES' || code === 'EPERM' || code === 'OPERATION_NOT_PERMITTED') return ERRNO.ACCES;
  return ERRNO.IO;
}
