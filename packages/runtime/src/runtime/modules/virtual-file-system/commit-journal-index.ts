import type { VfsCommitInvalidation, VfsCommitJournalResult } from './types';

/**
 * The committed-revision view a cache layered on the Virtual File System
 * reads: the authority's current revision and the VFS Commit Journal after one.
 */
export interface VfsCommitJournalSource {
  readonly revision: number;
  readCommitJournal(afterRevision: number): VfsCommitJournalResult;
}

/**
 * What a remembered answer depends on at one path. The journal's scopes mean
 * one thing each, as the Virtual File System emits them:
 *
 * - `path`: the content or metadata of the node already at that path changed
 *   (a write, an append, a truncation, `chmod`, `utimes`, a hard-link count).
 *   Nothing was created, removed or replaced there.
 * - `directory`: the listing of the directory at that path may have changed.
 *   Every `path` or `subtree` change also emits it for its parent directory.
 * - `subtree`: the node at that path was created, removed, renamed, or replaced
 *   (a symbolic link is retargeted by removing and recreating it), so anything
 *   at or beneath it may differ.
 *
 * Every dependency is invalidated by `subtree` at its path or above it. Beyond that:
 *
 * - `node`: the node at the path, invalidated by `path` there.
 * - `listing`: the node and its directory listing, invalidated by `path` or
 *   `directory` there.
 * - `ancestry`: the node and the content of every node above it, invalidated by
 *   `path` there or above. A path read through an archive
 *   (`/cache/a.zip/package.json`) changes when the archive is rewritten, which
 *   emits `path` for the archive alone.
 */
export type VfsCommitDependency = 'node' | 'listing' | 'ancestry';

export interface VfsCommitJournalReconciliation<Entry> {
  /** The journal no longer held the index's revision; every entry was forgotten. */
  readonly resynchronized: boolean;
  /** The entries the journal invalidated, each once, already forgotten. */
  readonly invalidated: readonly Entry[];
}

const CONTENT = 1;
const LISTING = 2;
const ANCESTORS = 4;

const DEPENDENCY_FLAGS: Readonly<Record<VfsCommitDependency, number>> = {
  node: CONTENT,
  listing: CONTENT | LISTING,
  ancestry: CONTENT | ANCESTORS
};

type IndexNode<Entry> = {
  readonly name: string;
  readonly parent: IndexNode<Entry> | undefined;
  children: Map<string, IndexNode<Entry>> | undefined;
  /** The entries that depend on this path, with the flags of their dependency. */
  entries: Map<Entry, number> | undefined;
};

/**
 * Remembers which entries depend on which paths and walks the VFS Commit
 * Journal to tell which of them a commit invalidated. Entries are indexed in a
 * path trie, so an invalidation visits only the entries it can affect.
 */
export class VfsCommitJournalIndex<Entry> {
  readonly #source: VfsCommitJournalSource;
  readonly #root: IndexNode<Entry> = { name: '', parent: undefined, children: undefined, entries: undefined };
  /** The nodes each entry is indexed under; one node is kept without an array. */
  readonly #entries = new Map<Entry, IndexNode<Entry> | IndexNode<Entry>[]>();
  /** How many (path, entry) pairs carry an `ancestry` dependency. */
  #ancestries = 0;
  #revision: number;

  constructor(source: VfsCommitJournalSource) {
    this.#source = source;
    this.#revision = source.revision;
  }

  /** The revision every remembered entry is known to hold at. */
  get revision(): number {
    return this.#revision;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Records that `entry` has a `dependency` on each of `paths` (normalized, absolute). */
  remember(entry: Entry, paths: Iterable<string>, dependency: VfsCommitDependency): void {
    const flags = DEPENDENCY_FLAGS[dependency];
    for (const path of paths) {
      const node = this.#node(path, true);
      const entries = (node.entries ??= new Map());
      const prior = entries.get(entry);
      if (prior === undefined) this.#attach(entry, node);
      const merged = (prior ?? 0) | flags;
      if (merged & ANCESTORS && !((prior ?? 0) & ANCESTORS)) this.#ancestries += 1;
      entries.set(entry, merged);
    }
  }

  /** Stops tracking `entry`; returns whether it was tracked. */
  forget(entry: Entry): boolean {
    const nodes = this.#entries.get(entry);
    if (!nodes) return false;
    this.#entries.delete(entry);
    for (let node of Array.isArray(nodes) ? nodes : [nodes]) {
      const entries = node.entries;
      const flags = entries?.get(entry);
      if (!entries || flags === undefined) continue;
      if (flags & ANCESTORS) this.#ancestries -= 1;
      entries.delete(entry);
      if (entries.size === 0) node.entries = undefined;
      while (node.parent && !node.entries && !node.children?.size) {
        node.parent.children?.delete(node.name);
        node = node.parent;
      }
    }
    return true;
  }

  /** Forgets every entry; the revision is kept. */
  clear(): void {
    this.#entries.clear();
    this.#root.children = undefined;
    this.#root.entries = undefined;
    this.#ancestries = 0;
  }

  /**
   * Reads the journal up to `revision`, by default the source's current one,
   * and forgets the entries it invalidates. A read always reaches the source's
   * current revision, so with an explicit `revision` the journal is read once.
   * When the journal no longer holds the index's revision, every entry is
   * forgotten and the index moves to the current revision.
   */
  reconcile(revision?: number): VfsCommitJournalReconciliation<Entry> {
    let resynchronized = false;
    const invalidated: Entry[] = [];
    while (this.#revision !== (revision ?? this.#source.revision)) {
      const result = this.#source.readCommitJournal(this.#revision);
      if (result.status === 'resync-required') {
        this.clear();
        this.#revision = result.currentRevision;
        resynchronized = true;
      } else {
        for (const record of result.records) {
          for (const invalidation of record.invalidations) this.#invalidate(invalidation, invalidated);
        }
        if (result.toRevision === this.#revision) break;
        this.#revision = result.toRevision;
      }
      if (revision !== undefined) break;
    }
    return { resynchronized, invalidated };
  }

  #invalidate(invalidation: VfsCommitInvalidation, invalidated: Entry[]): void {
    const node = this.#node(invalidation.path, false);
    if (!node) return;
    const scope = invalidation.scope;
    const affected = new Set<Entry>();
    const collect = (current: IndexNode<Entry>, mask: number): void => {
      if (!current.entries) return;
      for (const [entry, flags] of current.entries) if (flags & mask) affected.add(entry);
    };
    collect(node, scope === 'subtree' ? ~0 : scope === 'path' ? CONTENT : LISTING);
    // Beneath the path, `subtree` reaches every entry and `path` the ancestry dependencies.
    const beneath = scope === 'subtree' ? ~0 : scope === 'path' && this.#ancestries > 0 ? ANCESTORS : 0;
    if (beneath !== 0 && node.children) {
      const pending = [...node.children.values()];
      for (let current = pending.pop(); current; current = pending.pop()) {
        collect(current, beneath);
        if (current.children) pending.push(...current.children.values());
      }
    }
    for (const entry of affected) {
      this.forget(entry);
      invalidated.push(entry);
    }
  }

  #attach(entry: Entry, node: IndexNode<Entry>): void {
    const nodes = this.#entries.get(entry);
    if (!nodes) this.#entries.set(entry, node);
    else if (Array.isArray(nodes)) nodes.push(node);
    else this.#entries.set(entry, [nodes, node]);
  }

  #node(path: string, create: true): IndexNode<Entry>;
  #node(path: string, create: false): IndexNode<Entry> | undefined;
  #node(path: string, create: boolean): IndexNode<Entry> | undefined {
    let node = this.#root;
    if (path === '/') return node;
    let start = 1;
    while (start <= path.length) {
      let end = path.indexOf('/', start);
      if (end === -1) end = path.length;
      const name = path.slice(start, end);
      let child = node.children?.get(name);
      if (!child) {
        if (!create) return undefined;
        child = { name, parent: node, children: undefined, entries: undefined };
        (node.children ??= new Map()).set(name, child);
      }
      node = child;
      start = end + 1;
    }
    return node;
  }
}
