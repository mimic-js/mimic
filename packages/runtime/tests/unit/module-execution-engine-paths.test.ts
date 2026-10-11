import { describe, expect, test } from 'vitest';

import {
  dirnameWithoutNormalising,
  joinPathWithoutNormalising,
  nodeModulePaths,
  resolveDirectory
} from '../../src/runtime/modules/module-execution-engine/module-execution-engine';
import { dirname, joinPath, normalizePath } from '../../src/runtime/modules/virtual-file-system';
import { extname } from '../../src/runtime/modules/virtual-file-system/path';

/*
 * Pinned outputs of the path helpers the Module Execution Engine had before
 * ADR-0029 slice 7: `module-resolution-path.ts` (`normalizeModulePath`,
 * `modulePathDirectory`, `modulePathExtension`, `joinModulePath`) and the
 * engine's private `resolveDirectory`, `dirname` and `joinPath`. Every value
 * below was captured from those implementations; the engine now reaches them
 * through the Virtual File System helpers or the two non-normalising wrappers.
 */

// [input, cwd '/', cwd '/home/project', cwd 'rel']
const normalized: readonly (readonly [string, string, string, string])[] = [
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
  ['/a/b/.', '/a/b', '/a/b', '/a/b'],
  ['data:text/javascript,x/y', '/data:text/javascript,x/y', '/home/project/data:text/javascript,x/y', '/rel/data:text/javascript,x/y']
];

describe('Module Execution Engine paths', () => {
  test('resolution normalises a path as normalizeModulePath did', () => {
    for (const [input, root, project, relative] of normalized) {
      expect(normalizePath(input), input).toBe(root);
      expect(normalizePath(input, '/'), input).toBe(root);
      expect(normalizePath(input, '/home/project'), input).toBe(project);
      expect(normalizePath(input, 'rel'), input).toBe(relative);
      expect(normalizePath(input, ''), input).toBe(root);
    }
    expect(normalizePath(new URL('file:///a/b'), '/cwd')).toBe('/a/b');
    expect(normalizePath(new URL('file:///a%20b/c%2Fd'), '/cwd')).toBe('/a b/c/d');
    expect(normalizePath(new URL('file:///a//b/../c/'), '/cwd')).toBe('/a/c');
    expect(normalizePath(new URL('file:///C:/x'), '/cwd')).toBe('/C:/x');
    expect(normalizePath(new URL('http://x/a'), '/cwd')).toBe('/cwd/http:/x/a');
  });

  test('resolution takes directories, extensions and joins as modulePathDirectory, modulePathExtension and joinModulePath did', () => {
    const directories: readonly (readonly [string, string])[] = [
      ['/a/b/../c', '/a'], ['a/./b', '/a'], ['//x//y/', '/x'], ['/', '/'], ['', '/'], ['.', '/'],
      ['..', '/'], ['/../x', '/'], ['file:///a/b', '/file:/a'], ['C:/x', '/C:'], ['/a/b/', '/a'],
      ['/a/b//', '/a'], ['/a//b', '/a'], ['/a.b/c', '/a.b'], ['data:text/javascript,x/y', '/data:text/javascript,x']
    ];
    for (const [input, expected] of directories) expect(dirname(input), input).toBe(expected);

    const extensions: readonly (readonly [string, string])[] = [
      ['/a/b.js', '.js'], ['/a/.bashrc', ''], ['/a/b.c.d', '.d'], ['/a.b/c', ''], ['x.', '.'],
      ['/', ''], ['', ''], ['.', ''], ['..', ''], ['/a/b/.', ''], ['/a/b.js/', '.js']
    ];
    for (const [input, expected] of extensions) expect(extname(input), input).toBe(expected);

    expect(joinPath('/a', 'b')).toBe('/a/b');
    expect(joinPath('/', 'x')).toBe('/x');
    expect(joinPath('/a/', '../b')).toBe('/b');
    expect(joinPath('a', './b')).toBe('/a/b');
    expect(joinPath('', '')).toBe('/');
    expect(joinPath('/a', '/b')).toBe('/a/b');
    expect(joinPath('/a', 'b/', 'c//')).toBe('/a/b/c');
    expect(joinPath()).toBe('/');
  });

  test('resolveDirectory normalises against its cwd and still rejects a non-string directory', () => {
    for (const [input, root, project, relative] of normalized) {
      expect(resolveDirectory(input, '/'), input).toBe(root);
      expect(resolveDirectory(input, '/home/project'), input).toBe(project);
      expect(resolveDirectory(input, 'rel'), input).toBe(relative);
      expect(resolveDirectory(input, ''), input).toBe(root);
    }
    expect(() => resolveDirectory(new URL('file:///a') as unknown as string, '/')).toThrow(
      new TypeError('directory.startsWith is not a function')
    );
    expect(() => resolveDirectory(1 as unknown as string, '/')).toThrow(TypeError);
    expect(() => resolveDirectory(undefined as unknown as string, '/')).toThrow(TypeError);
  });

  test('module ids keep their unnormalised directory and node_modules lookup paths', () => {
    const directories: readonly (readonly [string, string])[] = [
      ['/a/b/../c', '/a/b/..'], ['a/./b', 'a/.'], ['//x//y/', '//x/'], ['/', '/'], ['', '/'], ['.', '/'],
      ['..', '/'], ['/..', '/'], ['/../x', '/..'], ['../../x', '../..'], ['file:///a/b', 'file:///a'],
      ['C:/x', 'C:'], ['/a/b/', '/a'], ['/a/b//', '/a'], ['a/b', 'a'], ['/a//b', '/a/'], ['/a/./b', '/a/.'],
      ['/a/b/.', '/a/b'], ['data:text/javascript,x/y', 'data:text/javascript,x'], ['x.', '/']
    ];
    for (const [input, expected] of directories) expect(dirnameWithoutNormalising(input), input).toBe(expected);

    expect(joinPathWithoutNormalising('/', 'node_modules')).toBe('/node_modules');
    expect(joinPathWithoutNormalising('/a', 'node_modules')).toBe('/a/node_modules');
    expect(joinPathWithoutNormalising('/a/', 'node_modules')).toBe('/a//node_modules');
    expect(joinPathWithoutNormalising('a', 'node_modules')).toBe('a/node_modules');
    expect(joinPathWithoutNormalising('', 'node_modules')).toBe('/node_modules');

    expect(nodeModulePaths('/a/b')).toEqual(['/a/b/node_modules', '/a/node_modules', '/node_modules']);
    expect(nodeModulePaths('/')).toEqual(['/node_modules']);
    expect(nodeModulePaths('a/b')).toEqual(['a/b/node_modules', 'a/node_modules', '/node_modules']);
    expect(nodeModulePaths('/a//b/')).toEqual(['/a//b//node_modules', '/a//node_modules', '/node_modules']);
    expect(nodeModulePaths('data:text/javascript,x')).toEqual([
      'data:text/javascript,x/node_modules',
      'data:text/node_modules',
      '/node_modules'
    ]);
  });
});
