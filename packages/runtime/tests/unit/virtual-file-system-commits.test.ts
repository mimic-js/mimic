import { describe, expect, test } from 'vitest';

import {
  type FileSystemTree,
  type VfsCommitOperation
} from '../../src/runtime/modules/virtual-file-system/index';
import {
  createVirtualFileSystemAuthority
} from '../../src/runtime/modules/virtual-file-system/authority';

const decoder = new TextDecoder();

function commit(
  authority: ReturnType<typeof createVirtualFileSystemAuthority>,
  ...operations: VfsCommitOperation[]
) {
  const result = authority.commit({ origin: 'commit-test', operations });
  if (result.status !== 'committed') throw new Error(result.error.message);
  return result;
}

function text(authority: ReturnType<typeof createVirtualFileSystemAuthority>, path: string): string {
  const result = authority.readFile(path);
  if (result.status !== 'ok') throw new Error(result.error.message);
  return decoder.decode(result.data);
}

describe('Virtual File System commits', () => {
  test('applies 20,000 single-file commits in place with flat per-commit cost', () => {
    const authority = createVirtualFileSystemAuthority('/home/project');
    const batch = 2_000;
    const timings: number[] = [];
    for (let start = 0; start < 20_000; start += batch) {
      const began = performance.now();
      for (let index = start; index < start + batch; index += 1) {
        commit(authority, {
          type: 'write-file',
          path: `/home/project/file-${index % 500}.txt`,
          data: `revision ${index}`
        });
      }
      timings.push(performance.now() - began);
    }

    expect(authority.revision).toBe(20_000);
    expect(authority.stat('/home/project/file-499.txt', true)).toMatchObject({ status: 'ok' });
    expect(text(authority, '/home/project/file-499.txt')).toBe('revision 19999');
    // Layered lookups made the last batch more than ten times slower than the first.
    expect(timings.at(-1)!).toBeLessThan(timings[0] * 4 + 50);
  });

  test('restores every earlier operation of a commit that fails part way', () => {
    const authority = createVirtualFileSystemAuthority('/home/project');
    commit(
      authority,
      { type: 'mkdir', path: '/home/project/src' },
      { type: 'write-file', path: '/home/project/src/keep.txt', data: 'keep' },
      { type: 'link', existingPath: '/home/project/src/keep.txt', newPath: '/home/project/src/alias.txt' }
    );
    const before = {
      tree: authority.exportTree('/home/project'),
      directory: authority.stat('/home/project/src', true),
      file: authority.stat('/home/project/src/keep.txt', true),
      journal: authority.readCommitJournal(0)
    };

    const rejected = authority.commit({
      origin: 'commit-test',
      operations: [
        { type: 'write-file', path: '/home/project/src/keep.txt', data: 'overwritten' },
        { type: 'write-file', path: '/home/project/src/added.txt', data: 'added' },
        { type: 'rename', oldPath: '/home/project/src/alias.txt', newPath: '/home/project/moved.txt' },
        { type: 'rm', path: '/home/project/src', options: { recursive: true } },
        { type: 'chmod', path: '/home/project/missing.txt', mode: 0o600 }
      ]
    });

    expect(rejected).toMatchObject({
      status: 'rejected',
      revision: 1,
      error: { code: 'NOT_FOUND', operationIndex: 4, operationType: 'chmod' }
    });
    expect(authority.exportTree('/home/project')).toEqual(before.tree);
    expect(authority.stat('/home/project/src', true)).toEqual(before.directory);
    expect(authority.stat('/home/project/src/keep.txt', true)).toEqual(before.file);
    expect(authority.readCommitJournal(0)).toEqual(before.journal);
    expect(text(authority, '/home/project/src/alias.txt')).toBe('keep');
  });

  test('derives hard-link invalidations from the one application of a commit', () => {
    const authority = createVirtualFileSystemAuthority('/home/project');
    commit(
      authority,
      { type: 'write-file', path: '/home/project/source.txt', data: 'one' },
      { type: 'link', existingPath: '/home/project/source.txt', newPath: '/home/project/alias.txt' }
    );
    commit(authority, { type: 'write-file', path: '/home/project/alias.txt', data: 'two' });

    expect(authority.readCommitJournal(1)).toMatchObject({
      records: [
        {
          revision: 2,
          invalidations: [
            { path: '/home/project/source.txt', scope: 'path' },
            { path: '/home/project/alias.txt', scope: 'path' },
            { path: '/home/project', scope: 'directory' }
          ]
        }
      ]
    });
    expect(text(authority, '/home/project/source.txt')).toBe('two');
    expect(authority.stat('/home/project/source.txt', true)).toMatchObject({ stat: { nlink: 2 } });

    commit(authority, { type: 'rename', oldPath: '/home/project/alias.txt', newPath: '/home/project/moved.txt' });
    commit(authority, { type: 'write-file', path: '/home/project/source.txt', data: 'three' });
    expect(text(authority, '/home/project/moved.txt')).toBe('three');

    commit(authority, { type: 'rm', path: '/home/project/source.txt' });
    expect(text(authority, '/home/project/moved.txt')).toBe('three');
    expect(authority.stat('/home/project/moved.txt', true)).toMatchObject({ stat: { nlink: 1 } });
  });

  test('keeps single-path mutations independent of the size of the tree', () => {
    const authority = createVirtualFileSystemAuthority('/home/project');
    commit(authority, { type: 'mount', tree: wideTree(40, 500) });
    commit(authority, { type: 'write-file', path: '/home/project/target.txt', data: 'seed' });

    const began = performance.now();
    for (let index = 0; index < 2_000; index += 1) {
      commit(authority, { type: 'write-file', path: '/home/project/target.txt', data: `value ${index}` });
      commit(authority, { type: 'rename', oldPath: '/home/project/target.txt', newPath: '/home/project/renamed.txt' });
      commit(authority, { type: 'utimes', path: '/home/project/renamed.txt', mtimeMs: index });
      commit(authority, { type: 'rename', oldPath: '/home/project/renamed.txt', newPath: '/home/project/target.txt' });
      commit(authority, { type: 'rm', path: '/home/project/target.txt' });
    }
    // Scanning 20,000 nodes per mutation took well over ten seconds here.
    expect(performance.now() - began).toBeLessThan(2_000);
  });

  test('mounts a tree in time linear in its size', () => {
    const measure = (directories: number): number => {
      const authority = createVirtualFileSystemAuthority('/home/project');
      const tree = wideTree(directories, 200);
      const began = performance.now();
      commit(authority, { type: 'mount', tree });
      return performance.now() - began;
    };
    measure(5);
    const small = measure(20);
    const large = measure(80);
    expect(large).toBeLessThan(small * 10 + 50);
  });

  test('appends without rewriting earlier bytes and without leaking into an older read', () => {
    const authority = createVirtualFileSystemAuthority('/home/project');
    commit(authority, { type: 'write-file', path: '/home/project/log.txt', data: 'abc', append: true });
    commit(authority, { type: 'write-file', path: '/home/project/log.txt', data: 'def', append: true });
    const earlier = authority.readFileView('/home/project/log.txt');

    const chunk = new TextEncoder().encode('0123456789'.repeat(10));
    const began = performance.now();
    for (let index = 0; index < 20_000; index += 1) {
      commit(authority, { type: 'write-file', path: '/home/project/log.txt', data: chunk, append: true });
    }
    // Reading and rewriting the whole file on each append copies 20 GB here.
    expect(performance.now() - began).toBeLessThan(3_000);

    expect(earlier.status === 'ok' && decoder.decode(earlier.data)).toBe('abcdef');
    const committed = authority.readFile('/home/project/log.txt');
    expect(committed.status === 'ok' && committed.data.byteLength).toBe(6 + 20_000 * chunk.byteLength);
    expect(text(authority, '/home/project/log.txt').slice(0, 16)).toBe('abcdef0123456789');
  });

  test('creates exclusively in one atomic commit and stores the requested mode', () => {
    const authority = createVirtualFileSystemAuthority('/home/project');
    commit(authority, {
      type: 'write-file',
      path: '/home/project/lock',
      data: 'owner',
      exclusive: true,
      mode: 0o755
    });
    expect(
      authority.commit({
        origin: 'commit-test',
        operations: [{ type: 'write-file', path: '/home/project/lock', data: 'intruder', exclusive: true }]
      })
    ).toMatchObject({ status: 'rejected', error: { code: 'ALREADY_EXISTS' } });
    expect(text(authority, '/home/project/lock')).toBe('owner');
    expect(authority.stat('/home/project/lock', true)).toMatchObject({ stat: { mode: 0o100755 } });

    commit(authority, { type: 'chmod', path: '/home/project/lock', mode: 0o600 });
    expect(authority.stat('/home/project/lock', true)).toMatchObject({ stat: { mode: 0o100600 } });
  });
});

function wideTree(directories: number, filesPerDirectory: number): FileSystemTree {
  const tree: FileSystemTree = {};
  for (let directory = 0; directory < directories; directory += 1) {
    const files: FileSystemTree = {};
    for (let file = 0; file < filesPerDirectory; file += 1) {
      files[`file-${file}.txt`] = { file: { contents: `${directory}:${file}` }, mtimeMs: 1_000 + file };
    }
    tree[`dir-${directory}`] = { directory: files };
  }
  return tree;
}
