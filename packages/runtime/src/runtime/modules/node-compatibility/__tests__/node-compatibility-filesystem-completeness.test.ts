import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';

import { createNodeFileSystemBuiltins } from '../filesystem';
import { VirtualFileSystem } from '../../../../../tests/support/module-internals';

/* The builtins are untyped objects; the tests reach them as Node's own shapes. */
type AnyFunction = (...args: any[]) => any;
type Module = Record<string, AnyFunction> & { readonly promises: Record<string, AnyFunction> };

function fileSystemModule(): { readonly fs: Module; readonly vfs: VirtualFileSystem } {
  const vfs = new VirtualFileSystem('/home/project');
  vfs.mkdirSync('/home/project/src/nested', { recursive: true });
  vfs.mkdirSync('/home/project/.hidden', { recursive: true });
  vfs.writeFileSync('/home/project/package.json', '{}');
  vfs.writeFileSync('/home/project/src/a.ts', 'a');
  vfs.writeFileSync('/home/project/src/b.js', 'b');
  vfs.writeFileSync('/home/project/src/nested/c.ts', 'c');
  vfs.writeFileSync('/home/project/src/.d.ts', 'd');
  vfs.writeFileSync('/home/project/.hidden/e.ts', 'e');
  const builtins = createNodeFileSystemBuiltins({
    asynchronous: vfs,
    cwd: '/home/project',
    scheduler: globalThis,
    synchronous: vfs
  });
  return { fs: builtins.fs as Module, vfs };
}

describe('Node Compatibility filesystem completeness', () => {
  test('changes of owner succeed for an existing entry and fail for a missing one, in every form', async () => {
    const { fs } = fileSystemModule();
    const descriptor = fs.openSync('package.json', 'r');

    // `util.promisify` of each function is what packages such as `atomically` do at load.
    for (const name of ['chown', 'lchown', 'fchown', 'fchmod', 'fdatasync', 'lutimes']) {
      expect(() => promisify(fs[name]!)).not.toThrow();
    }
    fs.chownSync('package.json', 1000, 1000);
    fs.lchownSync('package.json', 1000, 1000);
    fs.fchownSync(descriptor, 1000, 1000);
    await promisify(fs.chown!)('package.json', 1000, 1000);
    await fs.promises.chown!('package.json', 1000, 1000);
    await fs.promises.lchown!('package.json', 1000, 1000);

    expect(() => fs.chownSync('missing.json', 0, 0)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
    await expect(promisify(fs.chown!)('missing.json', 0, 0)).rejects.toMatchObject({ code: 'ENOENT' });
    fs.closeSync(descriptor);
  });

  test('fchmod changes the mode of the open file, and fdatasync settles its writes', async () => {
    const { fs } = fileSystemModule();
    const descriptor = fs.openSync('package.json', 'r+');

    fs.fchmodSync(descriptor, 0o600);
    expect(fs.statSync('package.json').mode & 0o777).toBe(0o600);
    await promisify(fs.fchmod!)(descriptor, '644');
    expect(fs.statSync('package.json').mode & 0o777).toBe(0o644);
    fs.writeSync(descriptor, 'x');
    fs.fdatasyncSync(descriptor);
    await promisify(fs.fdatasync!)(descriptor);
    expect(fs.readFileSync('package.json', 'utf8')).toBe('x}');
    fs.closeSync(descriptor);
  });

  test('glob matches *, ** and braces, leaves dot entries to patterns that name them, and honours cwd and exclude', async () => {
    const { fs } = fileSystemModule();

    expect(fs.globSync('src/*.ts').sort()).toEqual(['src/a.ts']);
    expect(fs.globSync('**/*.ts').sort()).toEqual(['src/a.ts', 'src/nested/c.ts']);
    expect(fs.globSync('src/{a,b}.*').sort()).toEqual(['src/a.ts', 'src/b.js']);
    expect(fs.globSync('src/.*').sort()).toEqual(['src/.d.ts']);
    expect(fs.globSync('*.ts', { cwd: 'src' }).sort()).toEqual(['a.ts']);
    expect(fs.globSync('**/*.ts', { exclude: (path: string) => path.includes('nested') })).toEqual(['src/a.ts']);
    expect(fs.globSync('/home/project/src/*.js')).toEqual(['/home/project/src/b.js']);
    const [dirent] = fs.globSync('src/b.js', { withFileTypes: true }) as Array<{
      name: string;
      parentPath: string;
      isFile(): boolean;
    }>;
    expect(dirent).toMatchObject({ name: 'b.js', parentPath: '/home/project/src' });
    expect(dirent!.isFile()).toBe(true);

    const fromCallback = await promisify(fs.glob!)('src/**');
    expect((fromCallback as string[]).sort()).toEqual(['src', 'src/a.ts', 'src/b.js', 'src/nested', 'src/nested/c.ts']);
    expect(fs.globSync('src/*/')).toEqual(['src/nested']);
    const fromPromises: string[] = [];
    for await (const match of fs.promises.glob!('src/*.{ts,js}')) fromPromises.push(match as string);
    expect(fromPromises.sort()).toEqual(['src/a.ts', 'src/b.js']);
  });

  test('glob exclude leaves an excluded directory unwalked, and a pattern goes up and down as Node resolves it', () => {
    const { fs, vfs } = fileSystemModule();
    vfs.mkdirSync('/home/project/node_modules/x', { recursive: true });
    vfs.mkdirSync('/home/project/src/node_modules', { recursive: true });
    vfs.writeFileSync('/home/project/node_modules/x/b.js', '');
    vfs.writeFileSync('/home/project/node_modules/y.js', '');
    vfs.writeFileSync('/home/project/src/node_modules/z.js', '');
    const asked: string[] = [];

    // A function is asked for entry names under `**` and for the paths of directories to enter.
    expect(fs.globSync('**/*.js', {
      exclude: (path: string) => {
        asked.push(path);
        return path === 'node_modules';
      }
    })).toEqual(['src/b.js']);
    expect(asked).toEqual(expect.arrayContaining(['node_modules', 'src', 'nested', 'src/nested']));
    expect(asked.filter((path) => /^(x|y\.js|z\.js)$|node_modules\//.test(path))).toEqual([]);
    expect((fs.globSync('**/*.js', {
      withFileTypes: true,
      exclude: (entry: { name: string }) => entry.name === 'node_modules'
    }) as Array<{ name: string }>).map((entry) => entry.name)).toEqual(['b.js']);
    // Patterns are resolved against cwd: `node_modules` is the top one only.
    expect(fs.globSync('**/*.js', { exclude: ['node_modules'] }).sort()).toEqual(['src/b.js', 'src/node_modules/z.js']);
    expect(fs.globSync('**/*.{js,ts}', { exclude: ['src/*.js', '**/nested'] }).sort()).toEqual([
      'node_modules/x/b.js',
      'node_modules/y.js',
      'src/a.ts',
      'src/node_modules/z.js'
    ]);
    expect(fs.globSync('**', { exclude: ['src/**'] }).sort()).toEqual([
      '.',
      'node_modules',
      'node_modules/x',
      'node_modules/x/b.js',
      'node_modules/y.js',
      'package.json'
    ]);

    expect(fs.globSync('src/../package.json')).toEqual(['package.json']);
    expect(fs.globSync('src/nested/../a.ts')).toEqual(['src/a.ts']);
    expect(fs.globSync('*/../package.json')).toEqual(['package.json']);
    expect(fs.globSync('../project/src/a.ts')).toEqual(['../project/src/a.ts']);
    expect(fs.globSync('../*/src/a.ts')).toEqual(['../project/src/a.ts']);
  });

  test('a FileHandle reads and writes whole files, vectors, and changes the file it opened', async () => {
    const { fs } = fileSystemModule();
    const handle = await fs.promises.open!('src/a.ts', 'r+');

    expect(await handle.readFile('utf8')).toBe('a');
    await handle.truncate(0);
    // Truncation leaves the position after the byte read, as in Node: the write leaves a hole.
    await handle.writeFile('first ', 'utf8');
    await handle.appendFile(new TextEncoder().encode('second'));
    await handle.datasync();
    await handle.chmod(0o640);
    await handle.chown(0, 0);
    expect(fs.readFileSync('src/a.ts', 'utf8')).toBe('\0first second');
    expect(fs.statSync('src/a.ts').mode & 0o777).toBe(0o640);

    const head = new Uint8Array(6);
    const tail = new Uint8Array(7);
    const { bytesRead } = await handle.readv([head, tail], 0);
    expect(bytesRead).toBe(13);
    expect(new TextDecoder().decode(head) + new TextDecoder().decode(tail)).toBe('\0first second');
    await handle.close();

    const reopened = await fs.promises.open!('src/a.ts', 'r');
    const contents = await reopened.readFile();
    expect(contents).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(contents)).toBe('\0first second');
    await reopened.close();
  });

  test('readv and writev move through a list of buffers', async () => {
    const { fs } = fileSystemModule();
    const descriptor = fs.openSync('src/b.js', 'w+');

    expect(fs.writevSync(descriptor, [new TextEncoder().encode('ab'), new TextEncoder().encode('cd')], 0)).toBe(4);
    const first = new Uint8Array(1);
    const rest = new Uint8Array(3);
    expect(fs.readvSync(descriptor, [first, rest], 0)).toBe(4);
    expect(new TextDecoder().decode(rest)).toBe('bcd');
    const written = await new Promise<number>((resolve, reject) =>
      fs.writev!(descriptor, [new TextEncoder().encode('ef')], 4, (error: unknown, count: number) =>
        error ? reject(error) : resolve(count)
      )
    );
    expect(written).toBe(2);
    expect(fs.readFileSync('src/b.js', 'utf8')).toBe('abcdef');
    fs.closeSync(descriptor);
  });

  test('the promise API writes the chunks of an iterable or a stream, as Node 22 does', async () => {
    const { fs } = fileSystemModule();
    async function* chunks() {
      yield 'tem';
      yield new TextEncoder().encode('plate');
    }

    await fs.promises.writeFile!('src/from-stream.txt', chunks());
    await fs.promises.appendFile!('src/from-stream.txt', [' file', new TextEncoder().encode('s')]);
    const handle = await fs.promises.open!('src/handle.txt', 'w');
    await handle.writeFile(chunks());
    await handle.close();

    expect(fs.readFileSync('src/from-stream.txt', 'utf8')).toBe('template files');
    expect(fs.readFileSync('src/handle.txt', 'utf8')).toBe('template');
    await expect(fs.promises.writeFile!('src/bad.txt', 42)).rejects.toMatchObject({ code: 'ERR_INVALID_ARG_TYPE' });
  });

  test('promisified exists resolves with the answer, as Node\'s custom form does', async () => {
    const { fs } = fileSystemModule();
    const exists = promisify(fs.exists!) as (path: string) => Promise<boolean>;

    await expect(exists('package.json')).resolves.toBe(true);
    await expect(exists('missing.json')).resolves.toBe(false);
  });

  test('close takes no callback, as Node\'s has since 15.9', async () => {
    const { fs } = fileSystemModule();
    const descriptor = fs.openSync('package.json', 'r');

    expect(() => fs.close(descriptor)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(() => fs.fstatSync(descriptor)).toThrow(expect.objectContaining({ code: 'EBADF' }));
  });

  test('write takes its callback after a string alone, as Expo\'s event log writes', async () => {
    const { fs } = fileSystemModule();
    const descriptor = fs.openSync('src/events.log', 'w');

    const written = await new Promise<number>((resolve, reject) =>
      fs.write(descriptor, '{"event":1}\n', (error: unknown, count: number) => (error ? reject(error) : resolve(count)))
    );
    await new Promise<void>((resolve, reject) =>
      fs.write(descriptor, '{"event":2}\n', null, 'utf8', (error: unknown) => (error ? reject(error) : resolve()))
    );
    fs.closeSync(descriptor);

    expect(written).toBe(12);
    expect(fs.readFileSync('src/events.log', 'utf8')).toBe('{"event":1}\n{"event":2}\n');
  });

  test('openAsBlob and promises.statfs answer as Node does', async () => {
    const { fs } = fileSystemModule();

    const blob = (await fs.openAsBlob!('src/a.ts')) as Blob;
    expect(await blob.text()).toBe('a');
    expect(await fs.promises.statfs!('/')).toMatchObject({ bsize: expect.any(Number) });
  });
});
