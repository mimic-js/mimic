import { VfsCommitJournalIndex, type VfsCommitJournalSource } from './commit-journal-index';
import type { VfsDomainError } from './types';

export type SynchronousClientCacheKind =
  | 'read-file'
  | 'readdir'
  | 'readlink'
  | 'realpath'
  | 'stat'
  | 'lstat'
  | 'access';

export interface SynchronousClientCacheEntry {
  readonly key: string;
  readonly kind: SynchronousClientCacheKind;
  /** The successful response, or undefined when the path was not found. */
  readonly value: unknown;
  /** The NOT_FOUND rejection, when the entry records an absent path. */
  readonly error: VfsDomainError | undefined;
  /** Every path whose change invalidates this entry, the requested path first. */
  readonly paths: readonly string[];
  readonly bytes: number;
}

const ENTRY_OVERHEAD_BYTES = 96;

/**
 * A NOT_FOUND message names the path it was asked for. An absent entry keeps
 * its code and the text before the path, shared by every entry with the same
 * text, and rebuilds the message from the path its key holds.
 */
type Absence = Readonly<{ code: string; prefix: string }>;
const absences = new Map<string, Absence>();
/** Distinct message prefixes shared; any beyond these are kept whole. */
const MAX_ABSENCES = 64;

function absence(error: VfsDomainError, path: string): Absence | undefined {
  if (Object.keys(error).length !== 2 || !error.message.endsWith(path)) return undefined;
  const prefix = error.message.slice(0, error.message.length - path.length);
  const id = `${error.code}\u0000${prefix}`;
  let shared = absences.get(id);
  if (!shared && absences.size < MAX_ABSENCES) absences.set(id, (shared = { code: error.code, prefix }));
  return shared;
}

/**
 * One cached answer. The requested path is not stored apart from the key
 * when the key ends with it, and an absent path's error is rebuilt on a hit.
 */
class CacheEntry implements SynchronousClientCacheEntry {
  constructor(
    readonly key: string,
    readonly kind: SynchronousClientCacheKind,
    readonly value: unknown,
    readonly bytes: number,
    /** Where the requested path starts in the key, or the path when the key does not end with it. */
    private readonly path: number | string,
    private readonly dependencies: readonly string[],
    private readonly rejection: VfsDomainError | Absence | undefined
  ) {}

  get paths(): readonly string[] {
    return [this.requestedPath, ...this.dependencies];
  }

  get error(): VfsDomainError | undefined {
    const rejection = this.rejection;
    if (!rejection || 'message' in rejection) return rejection;
    return { code: rejection.code, message: `${rejection.prefix}${this.requestedPath}` };
  }

  private get requestedPath(): string {
    return typeof this.path === 'string' ? this.path : this.key.slice(this.path);
  }
}

/**
 * The synchronous client's response cache. Entries are indexed by every path
 * they depend on, a directory listing also by its listing, so a commit drops
 * only the entries it affects; the least recently used entries are evicted
 * once the byte budget is spent.
 */
export class SynchronousClientCache {
  readonly #entries = new Map<string, SynchronousClientCacheEntry>();
  readonly #maxBytes: number;
  readonly #index: VfsCommitJournalIndex<SynchronousClientCacheEntry>;
  #bytes = 0;

  constructor(maxBytes: number, journal: VfsCommitJournalSource) {
    this.#maxBytes = maxBytes;
    this.#index = new VfsCommitJournalIndex(journal);
  }

  get bytes(): number {
    return this.#bytes;
  }

  /** The committed revision every cached answer holds at. */
  get revision(): number {
    return this.#index.revision;
  }

  get(key: string): SynchronousClientCacheEntry | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    // Re-inserting keeps the map ordered from least to most recently used.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry;
  }

  /**
   * Remembers an answer for `path`, invalidated by a change to it or to one
   * of `dependencies`. `payloadBytes` sizes a value; an error is sized here.
   * Returns false when the entry is too large to be worth a share of the budget.
   */
  set(
    key: string,
    kind: SynchronousClientCacheKind,
    path: string,
    dependencies: readonly string[],
    payloadBytes: number,
    value: unknown,
    error: VfsDomainError | undefined
  ): boolean {
    const inKey = key.endsWith(path);
    const shared = error && absence(error, path);
    let bytes = ENTRY_OVERHEAD_BYTES + payloadBytes + key.length * 2;
    if (!inKey) bytes += path.length * 2;
    for (const dependency of dependencies) bytes += dependency.length * 2;
    if (error && !shared) bytes += error.message.length * 2;
    if (bytes > this.#maxBytes / 4) return false;
    const existing = this.#entries.get(key);
    if (existing) this.#remove(existing);
    const entry = new CacheEntry(
      key,
      kind,
      value,
      bytes,
      inKey ? key.length - path.length : path,
      dependencies,
      shared ?? error
    );
    this.#entries.set(key, entry);
    this.#bytes += bytes;
    this.#index.remember(entry, entry.paths, kind === 'readdir' ? 'listing' : 'node');
    while (this.#bytes > this.#maxBytes) {
      const oldest = this.#entries.values().next();
      if (oldest.done) break;
      this.#remove(oldest.value);
    }
    return true;
  }

  delete(key: string): void {
    const entry = this.#entries.get(key);
    if (entry) this.#remove(entry);
  }

  /**
   * Reads the VFS Commit Journal up to `revision` (by default the current one)
   * and drops the entries it invalidates, or every entry when the journal
   * requires a resynchronization.
   */
  reconcile(revision?: number): { readonly resynchronized: boolean; readonly invalidated: number } {
    const { resynchronized, invalidated } = this.#index.reconcile(revision);
    let removed = 0;
    for (const entry of invalidated) {
      if (this.#entries.get(entry.key) !== entry) continue;
      this.#entries.delete(entry.key);
      this.#bytes -= entry.bytes;
      removed += 1;
    }
    if (resynchronized) this.clear();
    return { resynchronized, invalidated: removed };
  }

  clear(): void {
    this.#entries.clear();
    this.#index.clear();
    this.#bytes = 0;
  }

  #remove(entry: SynchronousClientCacheEntry): void {
    this.#entries.delete(entry.key);
    this.#bytes -= entry.bytes;
    this.#index.forget(entry);
  }
}
