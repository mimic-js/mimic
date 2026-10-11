import { VfsCommitJournalIndex, type VfsCommitJournalSource } from '../virtual-file-system';

/**
 * The committed-revision view a module resolver needs to keep cached answers
 * honest: the authority's current revision and the invalidations since one.
 */
export type ModuleResolutionCommitJournal = VfsCommitJournalSource;

type CacheEntry = {
  readonly key: string;
  readonly value: unknown;
  /** Every path whose change invalidates this entry. */
  readonly paths: readonly string[];
};

const DEFAULT_MAX_ENTRIES = 50_000;

/**
 * Answers derived from the file system (parsed manifests, package scopes,
 * resolved specifiers), each remembered with the paths it was derived from and
 * dropped when the VFS Commit Journal reports a change at or above one of them.
 *
 * Each path is an `ancestry` dependency: a resolver reads through archives
 * (`.yarn/cache/a.zip/node_modules/a/package.json`), and rewriting an archive
 * is a `path` change of the archive alone. A replaced directory or a
 * retargeted symbolic link is a `subtree` change, which reaches every
 * dependency beneath it. A `directory` change alone affects nothing here: an
 * entry that was added or removed carries its own `subtree` change.
 */
export class ModuleResolutionCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly index: VfsCommitJournalIndex<CacheEntry>;
  private readonly recordings: Set<string>[] = [];

  constructor(
    private readonly journal: ModuleResolutionCommitJournal,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES
  ) {
    this.index = new VfsCommitJournalIndex(journal);
  }

  /** Notes that the answer being computed depends on `path`. */
  depend(path: string): void {
    this.recordings.at(-1)?.add(path);
  }

  /**
   * Returns the remembered answer for `key`, or computes it while recording
   * the paths it depends on. A failed computation is not remembered.
   */
  remember<Value>(key: string, compute: () => Value): Value {
    this.reconcile();
    const cached = this.entries.get(key);
    if (cached) {
      const outer = this.recordings.at(-1);
      if (outer) for (const path of cached.paths) outer.add(path);
      return cached.value as Value;
    }
    const startRevision = this.index.revision;
    const paths = new Set<string>();
    this.recordings.push(paths);
    let value: Value;
    try {
      value = compute();
    } finally {
      this.recordings.pop();
    }
    const outer = this.recordings.at(-1);
    if (outer) for (const path of paths) outer.add(path);
    // A commit during the computation may already have outdated the answer.
    if (this.journal.revision !== startRevision) return value;
    if (this.entries.size >= this.maxEntries) this.clear();
    const entry: CacheEntry = { key, value, paths: [...paths] };
    this.entries.set(key, entry);
    this.index.remember(entry, entry.paths, 'ancestry');
    return value;
  }

  private reconcile(): void {
    const { resynchronized, invalidated } = this.index.reconcile();
    if (resynchronized) this.entries.clear();
    for (const entry of invalidated) {
      if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    }
  }

  private clear(): void {
    this.entries.clear();
    this.index.clear();
  }
}
