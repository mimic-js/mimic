import { describe, expect, test } from 'vitest';

import { createShellHarness } from '../support/shell-harness';

describe('core utility Runtime Programs (#645)', () => {
  test('rm refuses directories without -r, ignores missing paths with -f, and removes trees', async () => {
    const shell = createShellHarness({
      files: { '/home/project/dist/a/b.js': '', '/home/project/keep.txt': '' }
    });

    expect(await shell.run(['-c', 'rm dist'])).toMatchObject({
      code: 1,
      stderr: "rm: cannot remove 'dist': Is a directory\n"
    });
    expect(await shell.run(['-c', 'rm missing'])).toMatchObject({
      code: 1,
      stderr: "rm: cannot remove 'missing': No such file or directory\n"
    });
    expect(await shell.run(['-c', 'rm -f missing && rm -rf dist missing'])).toMatchObject({ code: 0, stderr: '' });
    expect([...shell.memory.entries.keys()].filter((path) => path.startsWith('/home/project/'))).toEqual([
      '/home/project/keep.txt'
    ]);
  });

  test('mkdir reports existing and parentless directories unless -p is given', async () => {
    const shell = createShellHarness({ files: { '/home/project/out': null } });

    expect(await shell.run(['-c', 'mkdir out'])).toMatchObject({
      code: 1,
      stderr: "mkdir: cannot create directory 'out': File exists\n"
    });
    expect(await shell.run(['-c', 'mkdir a/b'])).toMatchObject({
      code: 1,
      stderr: "mkdir: cannot create directory 'a/b': No such file or directory\n"
    });
    expect(await shell.run(['-c', 'mkdir -p out a/b && mkdir c'])).toMatchObject({ code: 0 });
    expect(shell.memory.entries.get('/home/project/a/b')).toBeNull();
    expect(shell.memory.entries.get('/home/project/c')).toBeNull();
  });

  test('cp copies files and trees, and mv renames into directories', async () => {
    const shell = createShellHarness({
      files: {
        '/home/project/src/index.ts': 'index',
        '/home/project/src/lib/util.ts': 'util',
        '/home/project/README.md': 'readme',
        '/home/project/out': null
      }
    });

    expect(await shell.run(['-c', 'cp src copy'])).toMatchObject({
      code: 1,
      stderr: "cp: -r not specified; omitting directory 'src'\n"
    });
    expect(await shell.run(['-c', 'cp -r src copy && cp README.md out && cp README.md NOTES.md'])).toMatchObject({
      code: 0,
      stderr: ''
    });
    expect(shell.memory.text('/home/project/copy/lib/util.ts')).toBe('util');
    expect(shell.memory.text('/home/project/out/README.md')).toBe('readme');
    expect(shell.memory.text('/home/project/NOTES.md')).toBe('readme');

    expect(await shell.run(['-c', 'mv NOTES.md CHANGES.md && mv copy README.md out'])).toMatchObject({ code: 0 });
    expect(shell.memory.text('/home/project/CHANGES.md')).toBe('readme');
    expect(shell.memory.text('/home/project/out/copy/index.ts')).toBe('index');
    expect(shell.memory.entries.has('/home/project/copy')).toBe(false);
    expect(await shell.run(['-c', 'mv a b c'])).toMatchObject({
      code: 1,
      stderr: "mv: target 'c' is not a directory\n"
    });
  });

  test('cat concatenates files and standard input, and numbers lines with -n', async () => {
    const shell = createShellHarness({ files: { '/home/project/a.txt': 'one\ntwo\n', '/home/project/b.txt': 'three\n' } });

    expect((await shell.run(['-c', 'cat a.txt b.txt'])).stdout).toBe('one\ntwo\nthree\n');
    expect((await shell.run(['-c', 'echo piped | cat b.txt -'])).stdout).toBe('three\npiped\n');
    expect((await shell.run(['-c', 'cat -n a.txt'])).stdout).toBe('     1\tone\n     2\ttwo\n');
    expect(await shell.run(['-c', 'cat missing a.txt'])).toMatchObject({
      code: 1,
      stdout: 'one\ntwo\n',
      stderr: 'cat: missing: No such file or directory\n'
    });
  });

  test('ls lists sorted entries, hides dotfiles by default, and marks directories with -F', async () => {
    const shell = createShellHarness({
      files: { '/home/project/b.txt': '', '/home/project/a': null, '/home/project/.env': '', '/home/project/a/x': '' }
    });

    expect((await shell.run(['-c', 'ls'])).stdout).toBe('a\nb.txt\n');
    expect((await shell.run(['-c', 'ls -AF'])).stdout).toBe('.env\na/\nb.txt\n');
    expect((await shell.run(['-c', 'ls b.txt a'])).stdout).toBe('b.txt\n\na:\nx\n');
    expect((await shell.run(['-c', 'ls -l b.txt'])).stdout).toMatch(/^-rw-r--r-- 1 user user +0 \w{3} [ \d]\d \d\d:\d\d b\.txt\n$/);
    expect(await shell.run(['-c', 'ls nope'])).toMatchObject({
      code: 2,
      stderr: "ls: cannot access 'nope': No such file or directory\n"
    });
  });

  test('touch creates missing files and leaves existing contents alone', async () => {
    const shell = createShellHarness({ files: { '/home/project/kept.txt': 'data' } });

    expect(await shell.run(['-c', 'touch new.txt kept.txt && touch -c absent.txt'])).toMatchObject({ code: 0 });
    expect(shell.memory.text('/home/project/new.txt')).toBe('');
    expect(shell.memory.text('/home/project/kept.txt')).toBe('data');
    expect(shell.memory.entries.has('/home/project/absent.txt')).toBe(false);
  });

  test('env prints, clears and extends the environment', async () => {
    const shell = createShellHarness();

    expect((await shell.run(['-c', 'env -i A=1 B="two words"'])).stdout).toBe('A=1\nB=two words\n');
    expect((await shell.run(['-c', 'env -u HOME | cat'], { env: { ONLY: 'x' } })).stdout).toBe(
      'PATH=/usr/bin\nONLY=x\nPWD=/home/project\n'
    );
    expect(await shell.run(['-c', 'env --bogus'])).toMatchObject({ code: 2 });
  });

  test('unknown options are rejected instead of being treated as paths', async () => {
    const shell = createShellHarness();

    expect(await shell.run(['-c', 'rm -z file'])).toMatchObject({ code: 2, stderr: "rm: invalid option -- 'z'\n" });
    expect(await shell.run(['-c', 'mkdir'])).toMatchObject({ code: 2, stderr: 'mkdir: missing operand\n' });
  });
});
