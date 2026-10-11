import { normalizePath, type FileStatLike } from '../virtual-file-system';
import { nodeErrorCodeFromDomain } from './domain-errors';

export type FileSystemPath = string | URL;

export const NODE_FS_CONSTANTS = Object.freeze({
  F_OK: 0,
  R_OK: 4,
  W_OK: 2,
  X_OK: 1,
  COPYFILE_EXCL: 1,
  COPYFILE_FICLONE: 2,
  COPYFILE_FICLONE_FORCE: 4,
  UV_FS_COPYFILE_EXCL: 1,
  UV_FS_COPYFILE_FICLONE: 2,
  UV_FS_COPYFILE_FICLONE_FORCE: 4,
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  O_CREAT: 64,
  O_EXCL: 128,
  O_TRUNC: 512,
  O_APPEND: 1_024,
  S_IFMT: 61_440,
  S_IFREG: 32_768,
  S_IFDIR: 16_384,
  S_IFCHR: 8_192,
  S_IFBLK: 24_576,
  S_IFIFO: 4_096,
  S_IFLNK: 40_960,
  S_IFSOCK: 49_152,
  S_IRWXU: 448,
  S_IRUSR: 256,
  S_IWUSR: 128,
  S_IXUSR: 64,
  S_IRWXG: 56,
  S_IRGRP: 32,
  S_IWGRP: 16,
  S_IXGRP: 8,
  S_IRWXO: 7,
  S_IROTH: 4,
  S_IWOTH: 2,
  S_IXOTH: 1
});

/**
 * Node's filesystem path argument: a `file:` URL is decoded, anything else
 * must be a string. Calling `startsWith` keeps the TypeError a Buffer or other
 * non-string path has always thrown here, rather than normalising its
 * `String()` form.
 */
export function resolveFileSystemPath(path: FileSystemPath, cwd: string): string {
  if (path instanceof URL) {
    if (path.protocol !== 'file:') {
      throw nodeFileSystemError('EINVAL', `Unsupported filesystem URL protocol: ${path.protocol}`);
    }
    return normalizePath(path, cwd);
  }
  return normalizePath(path.startsWith('/') ? path : `${cwd}/${path}`);
}

export function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

export function nodeFileSystemErrorFromDomain(error: unknown): unknown {
  const code = errorCode(error);
  const nodeCode = code ? nodeErrorCodeFromDomain('virtual-file-system', code) : undefined;
  if (!nodeCode) return error;
  const record = error as { readonly message?: unknown; readonly path?: unknown; readonly syscall?: unknown };
  return nodeFileSystemError(
    nodeCode,
    typeof record.message === 'string' ? record.message : nodeCode,
    typeof record.path === 'string' ? record.path : undefined,
    typeof record.syscall === 'string' ? record.syscall : undefined
  );
}

/** The number libuv reports for each error code a file system operation fails with, as on Linux. */
const NODE_FS_ERRNO: Readonly<Record<string, number>> = Object.freeze({
  EPERM: -1,
  ENOENT: -2,
  EIO: -5,
  EBADF: -9,
  EACCES: -13,
  EEXIST: -17,
  EXDEV: -18,
  ENOTDIR: -20,
  EISDIR: -21,
  EINVAL: -22,
  EMFILE: -24,
  ENOSPC: -28,
  EROFS: -30,
  ENOTEMPTY: -39,
  ELOOP: -40
});

export function nodeFileSystemError(
  code: string,
  message: string,
  path?: string,
  syscall?: string
): Error & { readonly code: string; readonly errno?: number; readonly path?: string; readonly syscall?: string } {
  return Object.assign(new Error(message), {
    code,
    errno: NODE_FS_ERRNO[code],
    name: 'NodeFileSystemAdapterError',
    path,
    syscall
  });
}

const BLOCK_SIZE = 4_096;

export class Stats {
  readonly atime: Date;
  readonly atimeMs: number;
  readonly birthtime: Date;
  readonly birthtimeMs: number;
  readonly blksize = BLOCK_SIZE;
  readonly blocks: number;
  readonly ctime: Date;
  readonly ctimeMs: number;
  readonly dev = 0;
  readonly gid = 0;
  readonly ino: number;
  readonly mode: number;
  readonly mtime: Date;
  readonly mtimeMs: number;
  readonly nlink: number;
  readonly rdev = 0;
  readonly size: number;
  readonly uid = 0;
  readonly #type: StatType;

  constructor(stat?: FileStatLike) {
    this.ctime = stat?.ctime ?? new Date(0);
    this.ctimeMs = this.ctime.getTime();
    this.ino = stat?.ino ?? 0;
    this.mtime = stat?.mtime ?? new Date(0);
    this.mtimeMs = stat?.mtimeMs ?? 0;
    // Access and creation times are not tracked; the nearest recorded times stand in.
    this.atime = this.mtime;
    this.atimeMs = this.mtimeMs;
    this.birthtime = this.ctime;
    this.birthtimeMs = this.ctimeMs;
    this.size = stat?.size ?? 0;
    this.blocks = Math.ceil(this.size / 512);
    this.#type = statType(stat);
    this.mode = stat?.mode ?? defaultMode(this.#type);
    this.nlink = stat?.nlink ?? 1;
  }

  isBlockDevice(): boolean { return this.#type.blockDevice; }
  isCharacterDevice(): boolean { return this.#type.characterDevice; }
  isFIFO(): boolean { return this.#type.fifo; }
  isFile(): boolean { return this.#type.file; }
  isDirectory(): boolean { return this.#type.directory; }
  isSocket(): boolean { return this.#type.socket; }
  isSymbolicLink(): boolean { return this.#type.symbolicLink; }
}

class BigIntStats {
  readonly atime: Date;
  readonly atimeMs: bigint;
  readonly atimeNs: bigint;
  readonly birthtime: Date;
  readonly birthtimeMs: bigint;
  readonly birthtimeNs: bigint;
  readonly blksize = BigInt(BLOCK_SIZE);
  readonly blocks: bigint;
  readonly ctime: Date;
  readonly ctimeMs: bigint;
  readonly ctimeNs: bigint;
  readonly dev = 0n;
  readonly gid = 0n;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly mtime: Date;
  readonly mtimeMs: bigint;
  readonly mtimeNs: bigint;
  readonly nlink: bigint;
  readonly rdev = 0n;
  readonly size: bigint;
  readonly uid = 0n;
  readonly #type: StatType;

  constructor(stat: FileStatLike) {
    this.ctime = stat.ctime;
    this.ctimeMs = BigInt(Math.max(0, Math.floor(stat.ctime.getTime())));
    this.ctimeNs = this.ctimeMs * 1_000_000n;
    this.ino = BigInt(stat.ino);
    this.mtime = stat.mtime;
    this.mtimeMs = BigInt(Math.max(0, Math.floor(stat.mtimeMs)));
    this.mtimeNs = BigInt(Math.max(0, Math.floor(stat.mtimeMs * 1_000_000)));
    this.atime = this.mtime;
    this.atimeMs = this.mtimeMs;
    this.atimeNs = this.mtimeNs;
    this.birthtime = this.ctime;
    this.birthtimeMs = this.ctimeMs;
    this.birthtimeNs = this.ctimeNs;
    this.size = BigInt(stat.size);
    this.blocks = BigInt(Math.ceil(stat.size / 512));
    this.#type = statType(stat);
    this.mode = BigInt(stat.mode ?? defaultMode(this.#type));
    this.nlink = BigInt(stat.nlink ?? 1);
  }

  isBlockDevice(): boolean { return this.#type.blockDevice; }
  isCharacterDevice(): boolean { return this.#type.characterDevice; }
  isFIFO(): boolean { return this.#type.fifo; }
  isFile(): boolean { return this.#type.file; }
  isDirectory(): boolean { return this.#type.directory; }
  isSocket(): boolean { return this.#type.socket; }
  isSymbolicLink(): boolean { return this.#type.symbolicLink; }
}

type StatType = {
  readonly blockDevice: boolean;
  readonly characterDevice: boolean;
  readonly directory: boolean;
  readonly fifo: boolean;
  readonly file: boolean;
  readonly socket: boolean;
  readonly symbolicLink: boolean;
};

export function nodeStat(stat: FileStatLike, bigint: boolean): Stats | BigIntStats {
  return bigint ? new BigIntStats(stat) : new Stats(stat);
}

function statType(stat?: FileStatLike): StatType {
  return {
    blockDevice: stat?.isBlockDevice() ?? false,
    characterDevice: stat?.isCharacterDevice() ?? false,
    directory: stat?.isDirectory() ?? false,
    fifo: stat?.isFIFO() ?? false,
    file: stat?.isFile() ?? false,
    socket: stat?.isSocket() ?? false,
    symbolicLink: stat?.isSymbolicLink() ?? false
  };
}

function defaultMode(type: StatType): number {
  if (type.directory) return NODE_FS_CONSTANTS.S_IFDIR | 0o755;
  if (type.symbolicLink) return NODE_FS_CONSTANTS.S_IFLNK | 0o777;
  return NODE_FS_CONSTANTS.S_IFREG | 0o644;
}

export function fileMode(mode: string | number | null | undefined): number | undefined {
  // Node treats a null mode like an omitted one.
  if (mode === undefined || mode === null) return undefined;
  const parsed = typeof mode === 'string' ? Number.parseInt(mode, 8) : mode;
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw nodeFileSystemError('ERR_INVALID_ARG_VALUE', `The argument 'mode' is invalid. Received ${String(mode)}`);
  }
  return parsed & 0o7777;
}
