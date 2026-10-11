import { describe, expect, test } from 'vitest';

import { createCoreUtilities, type CoreUtilityContext, type CoreUtilityFileSystem } from './core-utilities';

describe('core utilities for package-manager bin shims', () => {
  test('dirname and basename follow POSIX for absolute, relative and bare operands', async () => {
    expect(await run('dirname', ['/home/project/node_modules/.bin/tool'])).toEqual({ code: 0, stdout: '/home/project/node_modules/.bin\n' });
    expect(await run('dirname', ['tool', '/', 'a/b/', '/a'])).toEqual({ code: 0, stdout: '.\n/\na\n/\n' });
    expect(await run('basename', ['/home/project/tool.js', '.js'])).toEqual({ code: 0, stdout: 'tool\n' });
    expect(await run('basename', ['-a', '-s', '.js', 'a.js', 'b/c.js'])).toEqual({ code: 0, stdout: 'a\nc\n' });
    expect(await run('basename', [])).toMatchObject({ code: 2 });
  });

  test('node-gyp reports that the package stays without its native addon, and succeeds', async () => {
    expect(await run('node-gyp', ['--version'])).toEqual({ code: 0, stdout: 'v11.0.0\n' });
    expect(await run('node-gyp', ['rebuild'])).toMatchObject({ code: 0 });
  });

  test('node-gyp makes and removes the build directory as node-gyp does, so node-pre-gyp can move it', async () => {
    const fileSystem = memoryFileSystem({ '/home/project/package.json': '{"name":"bcrypt","version":"5.1.1"}' });

    expect(await run('node-gyp', ['configure'], '', fileSystem)).toMatchObject({ code: 0 });
    expect(fileSystem.text('/home/project/build/config.gypi')).toContain('no native toolchain');
    expect(await run('node-gyp', ['clean'], '', fileSystem)).toMatchObject({ code: 0 });
    expect(fileSystem.text('/home/project/build/config.gypi')).toBe('');
    expect(await run('node-gyp', ['clean'], '', fileSystem)).toMatchObject({ code: 0 });
  });

  test('node-gyp takes its command past option values and builds in the directory -C or --directory names', async () => {
    const fileSystem = memoryFileSystem({
      '/home/project/build/keep.txt': 'project',
      '/home/project/addon/package.json': '{"name":"addon","version":"1.0.0"}'
    });

    expect(await run('node-gyp', ['--arch', 'x64', 'configure'], '', fileSystem)).toMatchObject({ code: 0 });
    expect(fileSystem.text('/home/project/build/config.gypi')).toContain('no native toolchain');
    expect(await run('node-gyp', ['-C', 'addon', 'rebuild'], '', fileSystem)).toMatchObject({ code: 0 });
    expect(fileSystem.text('/home/project/addon/build/config.gypi')).toContain('no native toolchain');
    expect(fileSystem.text('/home/project/build/keep.txt')).toBe('project');
    // A directory named like a command is the option's value, not the command.
    expect(await run('node-gyp', ['--directory', 'build', 'configure'], '', fileSystem)).toMatchObject({ code: 0 });
    expect(fileSystem.text('/home/project/build/build/config.gypi')).toContain('no native toolchain');
    expect(await run('node-gyp', ['--directory=addon', 'clean'], '', fileSystem)).toMatchObject({ code: 0 });
    expect(fileSystem.text('/home/project/addon/build/config.gypi')).toBe('');
    expect(fileSystem.text('/home/project/build/keep.txt')).toBe('project');
  });

  test('uname reports the one runtime identity', async () => {
    expect(await run('uname', [])).toEqual({ code: 0, stdout: 'Linux\n' });
    expect(await run('uname', ['-m'])).toEqual({ code: 0, stdout: 'wasm32\n' });
    expect(await run('uname', ['-a'])).toEqual({
      code: 0,
      stdout: 'Linux mimic 0.0.0 #1 Mimic wasm32 GNU/Linux\n'
    });
  });

  test('getconf answers the word size of wasm32, as arch reads it on Linux', async () => {
    expect(await run('getconf', ['LONG_BIT'])).toEqual({ code: 0, stdout: '32\n' });
    expect(await run('getconf', ['_NPROCESSORS_ONLN'])).toMatchObject({ code: 0, stdout: expect.stringMatching(/^\d+\n$/) });
    expect(await run('getconf', ['NO_SUCH_VARIABLE'])).toEqual({ code: 1, stdout: '' });
    expect(await run('getconf', [])).toMatchObject({ code: 2 });
  });

  test('sed substitutes with any delimiter, flags, groups and addresses over stdin and files', async () => {
    expect(await run('sed', ['-e', 's,\\\\,/,g'], 'a\\b\\c\n')).toEqual({ code: 0, stdout: 'a/b/c\n' });
    expect(await run('sed', ['s/o/0/'], 'foo boo\n')).toEqual({ code: 0, stdout: 'f0o boo\n' });
    expect(await run('sed', ['s/o/0/g'], 'foo boo\n')).toEqual({ code: 0, stdout: 'f00 b00\n' });
    expect(await run('sed', ['-E', 's/(f)(o+)/\\2\\1&/'], 'foo\n')).toEqual({ code: 0, stdout: 'ooffoo\n' });
    expect(await run('sed', ['s/\\(a\\)\\(b\\)/\\2\\1/'], 'ab\n')).toEqual({ code: 0, stdout: 'ba\n' });
    expect(await run('sed', ['-n', '2p'], 'one\ntwo\nthree\n')).toEqual({ code: 0, stdout: 'two\n' });
    expect(await run('sed', ['/two/d'], 'one\ntwo\nthree\n')).toEqual({ code: 0, stdout: 'one\nthree\n' });
    expect(await run('sed', ['$d;1s/^/> /'], 'one\ntwo\nthree\n')).toEqual({ code: 0, stdout: '> one\ntwo\n' });
    expect(await run('sed', ['2q'], 'one\ntwo\nthree\n')).toEqual({ code: 0, stdout: 'one\ntwo\n' });
    expect(await run('sed', ['s/x/y/'], 'no newline')).toEqual({ code: 0, stdout: 'no newline\n' });
    expect(await run('sed', ['s/x/y'], '')).toMatchObject({ code: 1 });
  });

  test('sed edits a file in place, keeping a backup when a suffix is given', async () => {
    const fileSystem = memoryFileSystem({ '/home/project/config.txt': 'host=old\nport=1\n' });

    expect(await run('sed', ['-i.bak', 's/old/new/', 'config.txt'], '', fileSystem)).toEqual({ code: 0, stdout: '' });
    expect(fileSystem.text('/home/project/config.txt')).toBe('host=new\nport=1\n');
    expect(fileSystem.text('/home/project/config.txt.bak')).toBe('host=old\nport=1\n');
    expect(await run('sed', ['-i', 's/x/y/', 'missing.txt'], '', fileSystem)).toMatchObject({ code: 2 });
  });
});

async function run(
  command: string,
  args: readonly string[],
  stdin = '',
  fileSystem: CoreUtilityFileSystem & { text(path: string): string } = memoryFileSystem({})
): Promise<{ code: number; stdout: string }> {
  const utility = createCoreUtilities().find((candidate) => candidate.commands.includes(command));
  if (!utility) throw new Error(`No core utility owns ${command}`);
  const output: string[] = [];
  const errors: string[] = [];
  let input: Uint8Array | undefined = stdin === '' ? undefined : new TextEncoder().encode(stdin);
  const context: CoreUtilityContext = {
    cwd: '/home/project',
    env: { PATH: '/bin' },
    stdin: {
      async read() {
        const chunk = input;
        input = undefined;
        return chunk;
      }
    },
    stdout: { write: (chunk) => void output.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)) },
    stderr: { write: (chunk) => void errors.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)) },
    fileSystem
  };
  const code = await utility.run(args, context);
  return { code, stdout: output.join('') };
}

function memoryFileSystem(initial: Record<string, string>): CoreUtilityFileSystem & { text(path: string): string } {
  const files = new Map(Object.entries(initial).map(([path, text]) => [path, new TextEncoder().encode(text)]));
  const missing = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  return {
    text: (path) => new TextDecoder().decode(files.get(path) ?? new Uint8Array()),
    stat: (path) => {
      const data = files.get(path);
      return data ? { kind: 'file', size: data.byteLength, mtimeMs: 0, mode: 0o644 } : undefined;
    },
    readFile: (path) => {
      const data = files.get(path);
      if (!data) throw missing(path);
      return data;
    },
    writeFile: (path, data) => void files.set(path, data),
    readDirectory: () => [],
    makeDirectory: () => undefined,
    remove: (path) => {
      for (const file of [...files.keys()]) if (file === path || file.startsWith(`${path}/`)) files.delete(file);
    },
    rename: () => undefined,
    setModifiedTime: () => undefined,
    readLink: (path) => { throw missing(path); },
    symlink: () => undefined
  };
}
