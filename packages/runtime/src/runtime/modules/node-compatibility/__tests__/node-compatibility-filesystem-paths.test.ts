import { describe, expect, test } from 'vitest';

import { resolveFileSystemPath } from '../filesystem-shared';
import { basename, dirname } from '../../virtual-file-system';

/*
 * Pinned outputs of the path helpers `filesystem-shared.ts` had before
 * ADR-0029 slice 7: `resolveFileSystemPath` and its non-normalising `dirname`
 * and `basename`. Every value below was captured from those implementations.
 */

// [input, cwd '/', cwd '/home/project', cwd 'rel']
const resolved: readonly (readonly [string, string, string, string])[] = [
  ['/a/b/../c', '/a/c', '/a/c', '/a/c'],
  ['a/./b', '/a/b', '/home/project/a/b', '/rel/a/b'],
  ['//x//y/', '/x/y', '/x/y', '/x/y'],
  ['/', '/', '/', '/'],
  ['', '/', '/home/project', '/rel'],
  ['.', '/', '/home/project', '/rel'],
  ['..', '/', '/home', '/'],
  ['/..', '/', '/', '/'],
  ['/../x', '/x', '/x', '/x'],
  ['../../x', '/x', '/x', '/x'],
  ['file:///a/b', '/file:/a/b', '/home/project/file:/a/b', '/rel/file:/a/b'],
  ['C:/x', '/C:/x', '/home/project/C:/x', '/rel/C:/x'],
  ['/a/b/', '/a/b', '/a/b', '/a/b'],
  ['/a/b//', '/a/b', '/a/b', '/a/b'],
  ['/a//b', '/a/b', '/a/b', '/a/b'],
  ['/a/./b', '/a/b', '/a/b', '/a/b'],
  ['/a/b/.', '/a/b', '/a/b', '/a/b']
];

describe('Node Compatibility filesystem paths', () => {
  test('resolveFileSystemPath normalises strings and file URLs against the cwd', () => {
    for (const [input, root, project, relative] of resolved) {
      expect(resolveFileSystemPath(input, '/'), input).toBe(root);
      expect(resolveFileSystemPath(input, '/home/project'), input).toBe(project);
      expect(resolveFileSystemPath(input, 'rel'), input).toBe(relative);
      expect(resolveFileSystemPath(input, ''), input).toBe(root);
    }
    expect(resolveFileSystemPath(new URL('file:///a/b'), '/cwd')).toBe('/a/b');
    expect(resolveFileSystemPath(new URL('file:///a%20b/c%2Fd'), '/cwd')).toBe('/a b/c/d');
    expect(resolveFileSystemPath(new URL('file:///a//b/../c/'), '/cwd')).toBe('/a/c');
    expect(resolveFileSystemPath(new URL('file:///C:/x'), '/cwd')).toBe('/C:/x');
  });

  test('resolveFileSystemPath rejects non-file URLs with EINVAL and non-string paths with a TypeError', () => {
    expect(() => resolveFileSystemPath(new URL('http://x/a'), '/cwd')).toThrow(
      expect.objectContaining({ code: 'EINVAL', message: 'Unsupported filesystem URL protocol: http:' })
    );
    const buffer = new Uint8Array([47, 97]) as unknown as string;
    expect(() => resolveFileSystemPath(buffer, '/')).toThrow(new TypeError('path.startsWith is not a function'));
    expect(() => resolveFileSystemPath(3 as unknown as string, '/')).toThrow(
      new TypeError('path.startsWith is not a function')
    );
    expect(() => resolveFileSystemPath(undefined as unknown as string, '/')).toThrow(TypeError);
  });

  test('dirname and basename agree with the old helpers on the resolved paths their callers pass', () => {
    // node:sqlite's `path.dirname` sees SQLite full pathnames (from
    // resolveFileSystemPath) and the watchers' `basename` sees VFS commit
    // paths: both always normalised and absolute.
    const paths: readonly (readonly [string, string, string])[] = [
      ['/', '/', '/'],
      ['/a', '/', 'a'],
      ['/a/b', '/a', 'b'],
      ['/home/project/db.sqlite-journal', '/home/project', 'db.sqlite-journal'],
      ['/a/.bashrc', '/a', '.bashrc']
    ];
    for (const [input, directory, name] of paths) {
      expect(dirname(input), input).toBe(directory);
      expect(basename(input), input).toBe(name);
    }
  });
});
