import { describe, expect, test } from 'vitest';

import {
  VfsCommitJournalIndex,
  type VfsCommitInvalidation,
  type VfsCommitJournalSource
} from '../../src/runtime/modules/virtual-file-system/index';

describe('VFS Commit Journal index', () => {
  test('gives the path, directory, and subtree scopes one meaning for every dependency', () => {
    const journal = createJournal();
    const index = new VfsCommitJournalIndex<string>(journal);
    const rememberAll = () => {
      index.remember('file', ['/app/a.js'], 'node');
      index.remember('directory-stat', ['/app'], 'node');
      index.remember('listing', ['/app'], 'listing');
      index.remember('archived', ['/cache/pkg.zip/package.json'], 'ancestry');
      index.remember('beneath-file', ['/app/a.js/missing'], 'node');
      index.remember('elsewhere', ['/other/b.js'], 'node');
    };
    rememberAll();

    // `path` reaches dependencies on that exact path, and ancestry dependencies beneath it.
    journal.commit({ path: '/app/a.js', scope: 'path' }, { path: '/cache/pkg.zip', scope: 'path' });
    expect(sorted(index.reconcile().invalidated)).toEqual(['archived', 'file']);

    // `directory` reaches only listings of that directory.
    journal.commit({ path: '/app', scope: 'directory' }, { path: '/cache', scope: 'directory' });
    expect(index.reconcile()).toEqual({ resynchronized: false, invalidated: ['listing'] });

    // `subtree` reaches everything at or beneath the path.
    index.clear();
    rememberAll();
    journal.commit({ path: '/app', scope: 'subtree' });
    expect(sorted(index.reconcile().invalidated)).toEqual(['beneath-file', 'directory-stat', 'file', 'listing']);
    expect(index.size).toBe(2);
    expect(index.revision).toBe(journal.revision);

    // An entry depending on several paths, in several ways, is reported once and forgotten everywhere.
    index.remember('many', ['/x/one', '/x/two'], 'node');
    index.remember('many', ['/x'], 'listing');
    journal.commit({ path: '/x/one', scope: 'path' }, { path: '/x', scope: 'directory' });
    expect(index.reconcile().invalidated).toEqual(['many']);
    journal.commit({ path: '/x', scope: 'subtree' });
    expect(index.reconcile().invalidated).toEqual([]);

    expect(index.forget('elsewhere')).toBe(true);
    expect(index.forget('elsewhere')).toBe(false);
  });

  test('forgets every entry and moves to the current revision when the journal requires a resynchronization', () => {
    const journal = createJournal();
    const index = new VfsCommitJournalIndex<string>(journal);
    index.remember('kept-until-resync', ['/app/a.js'], 'node');

    journal.commit({ path: '/unrelated', scope: 'path' });
    journal.expire();
    const result = index.reconcile();

    expect(result).toEqual({ resynchronized: true, invalidated: [] });
    expect(index.size).toBe(0);
    expect(index.revision).toBe(journal.revision);
    expect(journal.reads).toBe(1);

    // An explicit revision reads the journal once, even when it has moved past it.
    journal.commit({ path: '/app/a.js', scope: 'path' });
    const target = journal.revision;
    journal.commit({ path: '/app/a.js', scope: 'path' });
    index.reconcile(target);
    expect(journal.reads).toBe(2);
    expect(index.revision).toBe(journal.revision);
    expect(index.reconcile(index.revision)).toEqual({ resynchronized: false, invalidated: [] });
    expect(journal.reads).toBe(2);
  });
});

function sorted(entries: readonly string[]): string[] {
  return [...entries].sort();
}

function createJournal() {
  const records: { revision: number; invalidations: VfsCommitInvalidation[] }[] = [];
  let revision = 0;
  let oldestRetained = 0;
  let reads = 0;
  const source: VfsCommitJournalSource & {
    readonly reads: number;
    commit(...invalidations: VfsCommitInvalidation[]): void;
    expire(): void;
  } = {
    get revision() {
      return revision;
    },
    get reads() {
      return reads;
    },
    readCommitJournal(afterRevision) {
      reads += 1;
      if (afterRevision < oldestRetained) {
        return { status: 'resync-required', currentRevision: revision, oldestRetainedRevision: oldestRetained };
      }
      return {
        status: 'delta',
        fromRevision: afterRevision,
        toRevision: revision,
        records: records.filter((record) => record.revision > afterRevision)
      };
    },
    commit(...invalidations) {
      revision += 1;
      records.push({ revision, invalidations });
    },
    expire() {
      records.length = 0;
      oldestRetained = revision;
    }
  };
  return source;
}
