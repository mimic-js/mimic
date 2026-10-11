import {
  connectSynchronousRpc,
  synchronousChannelWords,
  type SynchronousRemote,
  type SynchronousRpcConnection
} from '../worker-transport';
import { VirtualFileSystemError } from './errors';
import {
  AUTHORITY_REVISION_WORD,
  type MailboxCommitResult,
  type SynchronousVfsCommitOperation,
  type SynchronousVfsCommitRequest,
  type SynchronousVirtualFileSystemMailboxApi,
  type SynchronousVirtualFileSystemMailboxDescriptor
} from './mailbox';
import {
  SynchronousClientCache,
  type SynchronousClientCacheKind
} from './mailbox-client-cache';
import { normalizePath } from './path';
import { direntFromData, statFromData } from './projections';
import type {
  DirentLike,
  FileStatLike,
  VfsCommitJournalResult,
  VfsCommitResult,
  VfsDirentData,
  VfsDomainError,
  VfsStatData,
  VfsWriteFileOptions
} from './types';

export interface SynchronousVirtualFileSystemDiagnostics {
  readonly cacheBytes: number;
  readonly cacheHits: number;
  readonly invalidations: number;
  /** Mailbox round trips, each one a blocking exchange with the Runtime Host. */
  readonly requests: number;
  readonly resynchronizations: number;
  readonly requestChunks: number;
  readonly responseChunks: number;
}

export interface SynchronousVirtualFileSystemClient {
  readonly diagnostics: SynchronousVirtualFileSystemDiagnostics;
  readonly revision: number;
  accessSync(path: string): void;
  closeFileSync(id: number): void;
  close(): void;
  commit(request: SynchronousVfsCommitRequest): Extract<VfsCommitResult, { readonly status: 'committed' }>;
  existsSync(path: string): boolean;
  lstatSync(path: string): FileStatLike;
  chmodSync(path: string, mode: number): void;
  mkdirSync(path: string, options?: { readonly recursive?: boolean; readonly mode?: number }): void;
  openFileSync(
    path: string,
    options: { readonly append: boolean; readonly readable: boolean; readonly writable: boolean }
  ): number;
  readOpenFileSync(id: number, length: number, position?: number): Uint8Array;
  /** Reads the VFS Commit Journal after `afterRevision` for a cache layered on this client. */
  readCommitJournalSync(afterRevision: number): VfsCommitJournalResult;
  /** Calls another Runtime Host service and blocks until it answers. */
  callSync(service: string, payload: unknown): unknown;
  readFileSync(path: string, encoding: 'utf8'): string;
  readFileSync(path: string, encoding?: null): Uint8Array;
  readFileSliceSync(path: string, offset: number, length: number): Uint8Array;
  readdirSync(path: string, options?: { readonly withFileTypes?: boolean }): Array<string | DirentLike>;
  readlinkSync(path: string): string;
  realpathSync(path: string): string;
  renameSync(oldPath: string, newPath: string): void;
  rmSync(path: string, options?: { readonly recursive?: boolean; readonly force?: boolean }): void;
  statSync(path: string): FileStatLike;
  statOpenFileSync(id: number): FileStatLike;
  symlinkSync(target: string, path: string): void;
  linkSync(existingPath: string, newPath: string): void;
  utimesSync(path: string, mtimeMs: number): void;
  writeFileSync(path: string, data: string | Uint8Array, options?: VfsWriteFileOptions): void;
  writeOpenFileSync(id: number, data: Uint8Array, position?: number): number;
}

export interface SynchronousVirtualFileSystemClientOptions {
  /** Byte budget of the response cache; least recently used entries are evicted beyond it. */
  readonly cacheMaxBytes?: number;
}

const DEFAULT_CACHE_MAX_BYTES = 32 * 1024 * 1024;

const textDecoder = new TextDecoder();

type Rejected = { readonly status: 'rejected'; readonly revision: number; readonly error: VfsDomainError };
type PathResult = { readonly status: string; readonly revision: number; readonly dependencies?: readonly string[] };
type Mailbox = SynchronousRemote<SynchronousVirtualFileSystemMailboxApi>;

/** The VFS names for the ways a synchronous channel call can fail. */
const CHANNEL_ERROR_CODES: Readonly<Record<string, string>> = {
  SYNCHRONOUS_RPC_CLOSED: 'VFS_MAILBOX_CLOSED',
  SYNCHRONOUS_RPC_FAILED: 'VFS_EPOCH_FAILED',
  SYNCHRONOUS_RPC_TIMEOUT: 'VFS_MAILBOX_TIMEOUT',
  SYNCHRONOUS_RPC_MESSAGE_TOO_LARGE: 'VFS_PAYLOAD_TOO_LARGE'
};

/**
 * The most bytes of a file's contents one synchronous request or response
 * carries: half the channel's limit, which leaves room for what the encoding
 * adds. A larger file is written and read in parts of this size.
 */
function filePartBytes(channel: { readonly maxMessageBytes: number }): number {
  return Math.max(1, Math.floor(channel.maxMessageBytes / 2));
}

export class SynchronousVirtualFileSystemError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SynchronousVirtualFileSystemError';
    this.code = code;
  }
}

export function createSynchronousVirtualFileSystemClient(
  descriptor: SynchronousVirtualFileSystemMailboxDescriptor,
  options: SynchronousVirtualFileSystemClientOptions = {}
): SynchronousVirtualFileSystemClient {
  return new SynchronousVirtualFileSystemClientImplementation(descriptor, options);
}

class SynchronousVirtualFileSystemClientImplementation implements SynchronousVirtualFileSystemClient {
  readonly #cache: SynchronousClientCache;
  readonly #connection: SynchronousRpcConnection<SynchronousVirtualFileSystemMailboxApi>;
  readonly #words: Int32Array;
  readonly #descriptor: SynchronousVirtualFileSystemMailboxDescriptor;
  #closed = false;
  #cacheHits = 0;
  #invalidations = 0;
  #resynchronizations = 0;

  constructor(
    descriptor: SynchronousVirtualFileSystemMailboxDescriptor,
    options: SynchronousVirtualFileSystemClientOptions
  ) {
    this.#descriptor = descriptor;
    this.#connection = connectSynchronousRpc<SynchronousVirtualFileSystemMailboxApi>(descriptor.channel);
    const words = (this.#words = synchronousChannelWords(descriptor.channel));
    this.#cache = new SynchronousClientCache(options.cacheMaxBytes ?? DEFAULT_CACHE_MAX_BYTES, {
      get revision() {
        return Atomics.load(words, AUTHORITY_REVISION_WORD);
      },
      readCommitJournal: (afterRevision) => this.readCommitJournalSync(afterRevision)
    });
  }

  get revision(): number {
    return Atomics.load(this.#words, AUTHORITY_REVISION_WORD);
  }

  get diagnostics(): SynchronousVirtualFileSystemDiagnostics {
    const channel = this.#connection.diagnostics;
    return {
      cacheBytes: this.#cache.bytes,
      cacheHits: this.#cacheHits,
      invalidations: this.#invalidations,
      requests: channel.calls,
      resynchronizations: this.#resynchronizations,
      requestChunks: channel.requestChunks,
      responseChunks: channel.responseChunks
    };
  }

  readFileSync(path: string, encoding: 'utf8'): string;
  readFileSync(path: string, encoding?: null): Uint8Array;
  readFileSync(path: string, encoding?: 'utf8' | null): string | Uint8Array {
    let probe;
    try {
      probe = this.#probe(
        'read-file',
        `read-file:${this.#normalize(path)}`,
        path,
        (mailbox) => mailbox.readFile(path),
        (result) => result.data.byteLength
      );
    } catch (error) {
      // A file larger than a response carries is read in parts.
      if (!(error instanceof SynchronousVirtualFileSystemError) || error.code !== 'VFS_PAYLOAD_TOO_LARGE') throw error;
      const data = this.#readFileInParts(path);
      return encoding === 'utf8' ? textDecoder.decode(data) : data;
    }
    const { data } = unwrap(probe.result);
    if (encoding === 'utf8') return textDecoder.decode(data);
    // The cache keeps the received bytes; a caller that may mutate them gets its own copy.
    return probe.shared ? data.slice() : data;
  }

  readFileSliceSync(path: string, offset: number, length: number): Uint8Array {
    return unwrap(this.#call((mailbox) => mailbox.readFileSlice(path, offset, length))).data;
  }

  openFileSync(
    path: string,
    options: { readonly append: boolean; readonly readable: boolean; readonly writable: boolean }
  ): number {
    const { append, readable, writable } = options;
    return unwrap(this.#call((mailbox) => mailbox.openFile(path, { append, readable, writable }))).id;
  }

  closeFileSync(id: number): void {
    unwrap(this.#call((mailbox) => mailbox.closeFile(id)));
  }

  readOpenFileSync(id: number, length: number, position?: number): Uint8Array {
    return unwrap(this.#call((mailbox) => mailbox.readOpenFile(id, length, position))).data;
  }

  writeOpenFileSync(id: number, data: Uint8Array, position?: number): number {
    const result = this.#call((mailbox) => mailbox.writeOpenFile(id, data, position));
    if (result.status === 'rejected') throw new VirtualFileSystemError(result.error);
    return data.byteLength;
  }

  statOpenFileSync(id: number): FileStatLike {
    return statFromData(unwrap(this.#call((mailbox) => mailbox.statOpenFile(id))).stat);
  }

  writeFileSync(path: string, data: string | Uint8Array, options?: VfsWriteFileOptions): void {
    // Yarn writes its install cache in one call; a file larger than a request
    // carries is written in parts, each appended to the one before.
    const part = filePartBytes(this.#descriptor.channel);
    const bytes = typeof data === 'string' && data.length * 3 > part ? new TextEncoder().encode(data) : data;
    if (typeof bytes !== 'string' && bytes.byteLength > part) {
      for (let offset = 0; offset < bytes.byteLength; offset += part) {
        this.#commitOne({
          type: 'write-file',
          path,
          data: bytes.subarray(offset, offset + part),
          append: offset === 0 ? options?.append : true,
          exclusive: offset === 0 ? options?.exclusive : undefined,
          mode: options?.mode
        });
      }
      return;
    }
    this.#commitOne({
      type: 'write-file',
      path,
      data,
      append: options?.append,
      exclusive: options?.exclusive,
      mode: options?.mode
    });
  }

  readdirSync(path: string, options?: { readonly withFileTypes?: boolean }): Array<string | DirentLike> {
    const withFileTypes = options?.withFileTypes === true;
    const { entries } = unwrap(
      this.#probe(
        'readdir',
        `readdir:${withFileTypes}:${this.#normalize(path)}`,
        path,
        (mailbox) => mailbox.readdir(path, withFileTypes),
        (result) => directoryBytes(result.entries)
      ).result
    );
    return entries.map((entry) => (typeof entry === 'string' ? entry : direntFromData(entry)));
  }

  mkdirSync(path: string, options?: { readonly recursive?: boolean; readonly mode?: number }): void {
    this.#commitOne({ type: 'mkdir', path, options });
  }

  rmSync(path: string, options?: { readonly recursive?: boolean; readonly force?: boolean }): void {
    this.#commitOne({ type: 'rm', path, options });
  }

  renameSync(oldPath: string, newPath: string): void {
    this.#commitOne({ type: 'rename', oldPath, newPath });
  }

  symlinkSync(target: string, path: string): void {
    this.#commitOne({ type: 'symlink', target, path });
  }

  linkSync(existingPath: string, newPath: string): void {
    this.#commitOne({ type: 'link', existingPath, newPath });
  }

  utimesSync(path: string, mtimeMs: number): void {
    this.#commitOne({ type: 'utimes', path, mtimeMs });
  }

  chmodSync(path: string, mode: number): void {
    this.#commitOne({ type: 'chmod', path, mode });
  }

  readlinkSync(path: string): string {
    return unwrap(
      this.#probe(
        'readlink',
        `readlink:${this.#normalize(path)}`,
        path,
        (mailbox) => mailbox.readlink(path),
        (result) => result.target.length * 2
      ).result
    ).target;
  }

  statSync(path: string): FileStatLike {
    return statFromData(this.#readStat(path, true));
  }

  lstatSync(path: string): FileStatLike {
    return statFromData(this.#readStat(path, false));
  }

  accessSync(path: string): void {
    unwrap(this.#access(path));
  }

  existsSync(path: string): boolean {
    const result = this.#access(path);
    if (result.status !== 'rejected') return true;
    if (result.error.code === 'NOT_FOUND') return false;
    throw new VirtualFileSystemError(result.error);
  }

  realpathSync(path: string): string {
    return unwrap(
      this.#probe(
        'realpath',
        `realpath:${this.#normalize(path)}`,
        path,
        (mailbox) => mailbox.realpath(path),
        (result) => result.path.length * 2
      ).result
    ).path;
  }

  commit(request: SynchronousVfsCommitRequest): Extract<VfsCommitResult, { readonly status: 'committed' }> {
    const result: MailboxCommitResult = this.#call((mailbox) => mailbox.commit(request));
    if (result.status === 'rejected') throw new VirtualFileSystemError(result.error);
    return { ...result, operations: request.operations };
  }

  callSync(service: string, payload: unknown): unknown {
    return this.#call((mailbox) => mailbox.call(service, payload));
  }

  readCommitJournalSync(afterRevision: number): VfsCommitJournalResult {
    return this.#call((mailbox) => mailbox.readCommitJournal(afterRevision));
  }

  close(): void {
    this.#closed = true;
    this.#cache.clear();
  }

  #access(path: string): ReturnType<Mailbox['access']> {
    return this.#probe(
      'access',
      `access:${this.#normalize(path)}`,
      path,
      (mailbox) => mailbox.access(path),
      () => 0
    ).result;
  }

  #readStat(path: string, followFinal: boolean): VfsStatData {
    const kind = followFinal ? 'stat' : 'lstat';
    return unwrap(
      this.#probe(
        kind,
        `${kind}:${this.#normalize(path)}`,
        path,
        (mailbox) => mailbox.stat(path, followFinal),
        () => 64
      ).result
    ).stat;
  }

  #readFileInParts(path: string): Uint8Array {
    const part = filePartBytes(this.#descriptor.channel);
    const size = this.statSync(path).size;
    const data = new Uint8Array(size);
    for (let offset = 0; offset < size; offset += part) {
      data.set(this.readFileSliceSync(path, offset, Math.min(part, size - offset)), offset);
    }
    return data;
  }

  #commitOne(operation: SynchronousVfsCommitOperation): void {
    this.commit({ origin: this.#descriptor.contextId, operations: [operation] });
  }

  /**
   * Answers a path query from the cache when the authority has not committed
   * anything that affects it. Successful answers and NOT_FOUND rejections are
   * both remembered; `shared` tells the caller that the cache holds the value.
   */
  #probe<Result extends PathResult>(
    kind: SynchronousClientCacheKind,
    key: string,
    path: string,
    send: (mailbox: Mailbox) => Result | (Rejected & { readonly dependencies?: readonly string[] }),
    payloadBytes: (result: Exclude<Result, Rejected>) => number
  ): { readonly result: Result | Rejected; readonly shared: boolean } {
    this.#reconcileCache();
    const cached = this.#cache.get(key);
    if (cached) {
      this.#cacheHits += 1;
      return {
        result: cached.error
          ? { status: 'rejected', revision: this.#cache.revision, error: cached.error }
          : (cached.value as Result),
        shared: true
      };
    }
    const result = this.#call(send);
    const rejected = isRejected(result);
    if (rejected && result.error.code !== 'NOT_FOUND') return { result, shared: false };
    this.#reconcileCache(result.revision);
    if (this.#cache.revision !== result.revision || this.revision !== result.revision) {
      return { result, shared: false };
    }
    const shared = this.#cache.set(
      key,
      kind,
      this.#normalize(path),
      result.dependencies ?? [],
      rejected ? 0 : payloadBytes(result as Exclude<Result, Rejected>),
      rejected ? undefined : result,
      rejected ? result.error : undefined
    );
    if (shared && this.revision !== result.revision) {
      this.#cache.delete(key);
      return { result, shared: false };
    }
    return { result, shared };
  }

  /** Drops the cached answers the commits up to `revision` (by default the current one) invalidated. */
  #reconcileCache(revision?: number): void {
    const { resynchronized, invalidated } = this.#cache.reconcile(revision);
    this.#invalidations += invalidated;
    if (resynchronized) this.#resynchronizations += 1;
  }

  /** One blocking exchange with the Runtime Host, its channel failures named as VFS errors. */
  #call<Result>(operation: (mailbox: Mailbox) => Result): Result {
    if (this.#closed) {
      throw new SynchronousVirtualFileSystemError('VFS_MAILBOX_CLOSED', 'The synchronous VFS client is closed.');
    }
    try {
      return operation(this.#connection.remote);
    } catch (error) {
      const code = (error as { readonly code?: unknown }).code;
      const mapped = typeof code === 'string' ? CHANNEL_ERROR_CODES[code] : undefined;
      if (!mapped) throw error;
      if (mapped === 'VFS_MAILBOX_CLOSED' || mapped === 'VFS_EPOCH_FAILED') this.#closed = true;
      throw new SynchronousVirtualFileSystemError(mapped, (error as Error).message);
    }
  }

  #normalize(path: string): string {
    return normalizePath(path, this.#descriptor.workdir);
  }
}

function unwrap<Result extends { readonly status: string }>(
  result: Result | Rejected
): Exclude<Result, Rejected> {
  if (isRejected(result)) throw new VirtualFileSystemError(result.error);
  return result as Exclude<Result, Rejected>;
}

function isRejected(result: { readonly status: string }): result is Rejected {
  return result.status === 'rejected';
}

function directoryBytes(entries: readonly (string | VfsDirentData)[]): number {
  let bytes = 0;
  for (const entry of entries) bytes += 16 + (typeof entry === 'string' ? entry : entry.name).length * 2;
  return bytes;
}
