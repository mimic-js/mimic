import { describe, expect, test } from 'vitest';

import { createNodeFileSystemBuiltins } from '../filesystem';
import type { VfsCommittedWatchEvent } from '../../virtual-file-system';
import { VirtualFileSystem } from '../../../../../tests/support/module-internals';

/* The slice of node:fs these witnesses call, in the shapes ordinary package code uses. */
type Stats = {
  readonly mode: number;
  readonly nlink: number;
  readonly uid: number;
  readonly size: number;
  readonly atime: Date;
  readonly birthtime: Date;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
};
type Callback<Value = void> = (error: unknown, value?: Value) => void;
type Dirent = { readonly name: string; readonly parentPath: string; isDirectory(): boolean };
type Writable = {
  end(chunk?: string): unknown;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  write(chunk: string, callback?: (error?: unknown) => void): boolean;
};
type Readable = {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
};
type FileSystemModule = {
  readonly constants: Record<string, number>;
  appendFileSync(path: string, data: string | Uint8Array, options?: unknown): void;
  chmod(path: string, mode: string | number, callback: Callback): void;
  chmodSync(path: string, mode: string | number): void;
  closeSync(descriptor: number): void;
  copyFileSync(source: string, destination: string, mode?: number): void;
  cpSync(source: string, destination: string, options?: unknown): void;
  createReadStream(path: string, options?: unknown): Readable;
  createWriteStream(path: string, options?: unknown): Writable;
  existsSync(path: string): boolean;
  ftruncateSync(descriptor: number, length?: number): void;
  lstatSync(path: string): Stats;
  mkdirSync(path: string, options?: unknown): void;
  mkdtempSync(prefix: string): string;
  openSync(path: string, flags?: string | number, mode?: string | number): number;
  opendirSync(path: string): { readSync(): Dirent | null; closeSync(): void };
  readFile(path: string, options: unknown, callback: Callback<string | Uint8Array>): void;
  readFileSync(path: string, options?: unknown): string | Uint8Array;
  readdirSync(path: string, options?: unknown): Array<string | Dirent>;
  readlinkSync(path: string): string;
  renameSync(oldPath: string, newPath: string): void;
  statSync(path: string): Stats;
  symlinkSync(target: string, path: string): void;
  truncateSync(path: string, length?: number): void;
  unlink(path: string, callback: Callback): void;
  unlinkSync(path: string): void;
  writeFile(path: string, data: string, options: unknown, callback: Callback): void;
  writeFileSync(path: string, data: string | ArrayBufferView, options?: unknown): void;
  writeSync(descriptor: number, data: string): number;
};
type FileSystemPromisesModule = {
  appendFile(path: string, data: string, options?: unknown): Promise<void>;
  chmod(path: string, mode: string | number): Promise<void>;
  copyFile(source: string, destination: string, mode?: number): Promise<void>;
  cp(source: string, destination: string, options?: unknown): Promise<void>;
  mkdtemp(prefix: string): Promise<string>;
  open(path: string, flags?: string | number, mode?: string | number): Promise<{ close(): Promise<void> }>;
  readFile(path: string, options?: unknown): Promise<string | Uint8Array>;
  readdir(path: string, options?: unknown): Promise<Array<string | Dirent>>;
  rmdir(path: string): Promise<void>;
  stat(path: string): Promise<Stats>;
  truncate(path: string, length?: number): Promise<void>;
  unlink(path: string): Promise<void>;
  watch(
    path: string,
    options?: { readonly recursive?: boolean; readonly signal?: AbortSignal }
  ): AsyncIterableIterator<{ readonly eventType: string; readonly filename: string }>;
  writeFile(path: string, data: string, options?: unknown): Promise<void>;
};

function createFileSystem() {
  const fileSystem = new VirtualFileSystem('/home/project');
  const builtins = createNodeFileSystemBuiltins({
    asynchronous: fileSystem,
    cwd: '/home/project',
    scheduler: globalThis,
    synchronous: fileSystem
  });
  return {
    fileSystem,
    fs: builtins.fs as FileSystemModule,
    promises: builtins.promises as FileSystemPromisesModule
  };
}

function callback<Value = void>(run: (done: Callback<Value>) => void): Promise<Value> {
  return new Promise((resolve, reject) => {
    run((error, value) => (error ? reject(error) : resolve(value as Value)));
  });
}

function code(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe('Node Compatibility filesystem option handling', () => {
  test('reads with an options object and every standard encoding', async () => {
    const { fs, promises } = createFileSystem();
    fs.writeFileSync('text.txt', 'héllo');

    expect(fs.readFileSync('text.txt', { encoding: 'utf8' })).toBe('héllo');
    expect(fs.readFileSync('text.txt', { encoding: 'utf-8', flag: 'r' })).toBe('héllo');
    expect(fs.readFileSync('text.txt', 'latin1')).toBe('hÃ©llo');
    expect(fs.readFileSync('text.txt', { encoding: 'hex' })).toBe('68c3a96c6c6f');
    expect(fs.readFileSync('text.txt', 'base64')).toBe('aMOpbGxv');
    expect(fs.readFileSync('text.txt', { encoding: null })).toBeInstanceOf(Uint8Array);
    expect(fs.readFileSync('text.txt', {})).toBeInstanceOf(Uint8Array);

    await expect(promises.readFile('text.txt', { encoding: 'utf8' })).resolves.toBe('héllo');
    await expect(promises.readFile('text.txt', { encoding: 'hex' })).resolves.toBe('68c3a96c6c6f');
    await expect(
      callback<string | Uint8Array>((done) => fs.readFile('text.txt', { encoding: 'base64' }, done))
    ).resolves.toBe('aMOpbGxv');
    await expect(
      callback<string | Uint8Array>((done) => fs.readFile('text.txt', 'utf8', done))
    ).resolves.toBe('héllo');
  });

  test('honours flag, mode, and encoding when writing and appending', async () => {
    const { fs, promises } = createFileSystem();

    fs.writeFileSync('log.txt', 'one', { mode: 0o600 });
    fs.writeFileSync('log.txt', '-two', { flag: 'a' });
    fs.appendFileSync('log.txt', '-three');
    await promises.writeFile('log.txt', '-four', { flag: 'a' });
    await promises.appendFile('log.txt', '-five');
    await callback((done) => fs.writeFile('log.txt', '-six', { flag: 'a' }, done));
    expect(fs.readFileSync('log.txt', 'utf8')).toBe('one-two-three-four-five-six');
    expect(fs.statSync('log.txt').mode & 0o777).toBe(0o600);

    expect(code(() => fs.writeFileSync('log.txt', 'again', { flag: 'wx' }))).toBe('EEXIST');
    await expect(promises.writeFile('log.txt', 'again', { flag: 'wx' })).rejects.toMatchObject({
      code: 'EEXIST'
    });
    expect(fs.readFileSync('log.txt', 'utf8')).toBe('one-two-three-four-five-six');
    expect(code(() => fs.writeFileSync('absent.txt', 'x', { flag: 'r+' }))).toBe('ENOENT');

    // Packages pass explicit nulls where Node documents optional values.
    fs.writeFileSync('nullish.txt', 'nullish', { encoding: null, flag: null, mode: null });
    fs.mkdirSync('nullish-directory', { recursive: true, mode: null });
    fs.closeSync(fs.openSync('nullish.txt', 'r', null as unknown as undefined));
    expect(fs.readFileSync('nullish.txt', 'utf8')).toBe('nullish');

    fs.writeFileSync('encoded.bin', '68c3a96c6c6f', 'hex');
    expect(fs.readFileSync('encoded.bin', 'utf8')).toBe('héllo');
    fs.writeFileSync('view.bin', new Uint16Array([0x6968]));
    expect(fs.readFileSync('view.bin', 'utf8')).toBe('hi');
    fs.appendFileSync('created-by-append.txt', 'fresh', { mode: '755' });
    expect(fs.statSync('created-by-append.txt').mode & 0o777).toBe(0o755);
  });

  test('unlinks the link itself rather than what it points to', async () => {
    const { fs, promises } = createFileSystem();
    fs.mkdirSync('directory');
    fs.writeFileSync('directory/kept.txt', 'kept');
    fs.symlinkSync('directory', 'directory-link');
    fs.symlinkSync('nowhere', 'dangling-link');
    fs.symlinkSync('directory', 'second-directory-link');
    fs.symlinkSync('nowhere', 'second-dangling-link');
    fs.symlinkSync('nowhere', 'third-dangling-link');

    fs.unlinkSync('directory-link');
    fs.unlinkSync('dangling-link');
    await promises.unlink('second-directory-link');
    await promises.unlink('second-dangling-link');
    await callback((done) => fs.unlink('third-dangling-link', done));

    expect(fs.readdirSync('.')).toEqual(['directory']);
    expect(fs.readFileSync('directory/kept.txt', 'utf8')).toBe('kept');
    expect(code(() => fs.unlinkSync('directory'))).toBe('EISDIR');
    expect(code(() => fs.unlinkSync('missing'))).toBe('ENOENT');
  });

  test('stores the file mode, reports it through stat, and changes it with chmod', async () => {
    const { fs, promises } = createFileSystem();
    fs.writeFileSync('script.sh', '#!/bin/sh\n');
    fs.mkdirSync('directory', { mode: 0o700 });
    fs.symlinkSync('script.sh', 'script-link');

    const created = fs.statSync('script.sh');
    expect(created.mode).toBe(fs.constants.S_IFREG | 0o644);
    expect(created.nlink).toBe(1);
    expect(created.uid).toBe(0);
    expect(created.atime).toBeInstanceOf(Date);
    expect(created.birthtime).toBeInstanceOf(Date);
    expect(fs.statSync('directory').mode).toBe(fs.constants.S_IFDIR | 0o700);
    expect(fs.lstatSync('script-link').mode & fs.constants.S_IFMT).toBe(fs.constants.S_IFLNK);

    fs.chmodSync('script.sh', 0o755);
    expect(fs.statSync('script.sh').mode & fs.constants.S_IXUSR).toBe(fs.constants.S_IXUSR);
    await promises.chmod('script-link', '700');
    expect((await promises.stat('script.sh')).mode & 0o777).toBe(0o700);
    await callback((done) => fs.chmod('script.sh', 0o640, done));
    expect(fs.statSync('script.sh').mode & 0o777).toBe(0o640);
    expect(code(() => fs.chmodSync('missing.sh', 0o755))).toBe('ENOENT');

    fs.chmodSync('script.sh', 0o755);
    fs.writeFileSync('script.sh', 'rewritten');
    expect(fs.statSync('script.sh').mode & 0o777).toBe(0o755);
    fs.copyFileSync('script.sh', 'copy.sh');
    expect(fs.statSync('copy.sh').mode & 0o777).toBe(0o755);
  });

  test('creates exclusively in the authority, so only one opener wins', async () => {
    const { fs, promises, fileSystem } = createFileSystem();
    const writes: unknown[][] = [];
    const writeFile = fileSystem.writeFile.bind(fileSystem);
    fileSystem.writeFile = async (...args: Parameters<typeof writeFile>) => {
      writes.push(args);
      return writeFile(...args);
    };

    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, () => promises.open('lock', 'wx', 0o600))
    );
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(
      outcomes.every(
        (outcome) => outcome.status === 'fulfilled' || (outcome.reason as { code?: string }).code === 'EEXIST'
      )
    ).toBe(true);
    // The exclusive create is one authority write, never a check followed by a write.
    expect(writes).toHaveLength(8);
    expect(writes.every(([, , options]) => (options as { exclusive?: boolean }).exclusive === true)).toBe(true);

    expect(code(() => fs.openSync('lock', 'wx'))).toBe('EEXIST');
    expect(
      code(() => fs.openSync('lock', fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY))
    ).toBe('EEXIST');
    expect(fs.statSync('lock').mode & 0o777).toBe(0o600);
    fs.copyFileSync('lock', 'lock-copy');
    expect(code(() => fs.copyFileSync('lock', 'lock-copy', fs.constants.COPYFILE_EXCL))).toBe('EEXIST');
    await expect(promises.copyFile('lock', 'lock-copy', fs.constants.COPYFILE_EXCL)).rejects.toMatchObject({
      code: 'EEXIST'
    });

    const appended = fs.openSync('existing.txt', 'a');
    fs.writeSync(appended, 'kept');
    fs.closeSync(appended);
    fs.closeSync(fs.openSync('existing.txt', 'a'));
    expect(fs.readFileSync('existing.txt', 'utf8')).toBe('kept');
    fs.closeSync(fs.openSync('existing.txt', 'w'));
    expect(fs.readFileSync('existing.txt', 'utf8')).toBe('');
  });

  test('streams a file in chunks and writes a stream as it is written', async () => {
    const { fs } = createFileSystem();
    fs.writeFileSync('large.bin', new Uint8Array(200_000).fill(7));

    const sizes: number[] = [];
    const reader = fs.createReadStream('large.bin', { start: 10, end: 150_009 });
    reader.on('data', (chunk) => sizes.push((chunk as Uint8Array).byteLength));
    await new Promise((resolve) => reader.once('close', resolve));
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(64 * 1024);
    expect(sizes.reduce((total, size) => total + size, 0)).toBe(150_000);

    fs.writeFileSync('stream.log', 'kept:');
    const writer = fs.createWriteStream('stream.log', { flags: 'a' });
    await callback((done) => writer.write('first', done));
    expect(fs.readFileSync('stream.log', 'utf8')).toBe('kept:first');
    const finished = new Promise((resolve) => writer.once('finish', resolve));
    writer.end(',second');
    await finished;
    expect(fs.readFileSync('stream.log', 'utf8')).toBe('kept:first,second');

    const truncating = fs.createWriteStream('stream.log');
    const truncated = new Promise((resolve) => truncating.once('finish', resolve));
    truncating.end('replaced');
    await truncated;
    expect(fs.readFileSync('stream.log', 'utf8')).toBe('replaced');

    // `close()` ends a write stream and calls back once it closed, as Next.js's download cache does.
    const closing = fs.createWriteStream('closed.log') as Writable & { close(callback: () => void): void };
    closing.write('written');
    await callback((done) => closing.close(() => done()));
    expect(fs.readFileSync('closed.log', 'utf8')).toBe('written');

    // A stream writes through the file it opened, as Node does through its descriptor:
    // Next.js 13 renames its download while the last chunks are still being written.
    const moving = fs.createWriteStream('download.temp');
    await callback((done) => moving.write('first,', done));
    fs.renameSync('download.temp', 'download.tgz');
    const moved = new Promise((resolve) => moving.once('close', resolve));
    moving.end('second');
    await moved;
    expect(fs.readFileSync('download.tgz', 'utf8')).toBe('first,second');
    expect(fs.existsSync('download.temp')).toBe(false);
  });

  test('writes the chunks a stream buffered during a write as one write, as fs.writev does', async () => {
    const fileSystem = new VirtualFileSystem('/home/project');
    let writes = 0;
    const asynchronous = Object.create(fileSystem) as VirtualFileSystem;
    asynchronous.writeOpenFile = (id, data, position) => {
      writes += 1;
      return fileSystem.writeOpenFile(id, data, position);
    };
    const fs = createNodeFileSystemBuiltins({
      asynchronous,
      cwd: '/home/project',
      scheduler: globalThis,
      synchronous: fileSystem
    }).fs as FileSystemModule;

    const writer = fs.createWriteStream('chunks.bin');
    for (let index = 0; index < 100; index++) writer.write(`${index},`);
    const closed = new Promise((resolve) => writer.once('close', resolve));
    writer.end('end');
    await closed;

    expect(fs.readFileSync('chunks.bin', 'utf8')).toBe(`${Array.from({ length: 100 }, (_, index) => `${index},`).join('')}end`);
    expect(writes).toBe(2);
  });

  test('provides the directory, copy, temporary, and truncate calls packages rely on', async () => {
    const { fs, promises } = createFileSystem();
    fs.mkdirSync('tree/nested/deep', { recursive: true });
    fs.writeFileSync('tree/root.txt', 'root');
    fs.writeFileSync('tree/nested/deep/leaf.txt', 'leaf');
    fs.symlinkSync('root.txt', 'tree/link');

    expect([...fs.readdirSync('tree', { recursive: true })].sort()).toEqual([
      'link',
      'nested',
      'nested/deep',
      'nested/deep/leaf.txt',
      'root.txt'
    ]);
    const typed = (await promises.readdir('tree', { recursive: true, withFileTypes: true })) as Dirent[];
    expect(typed.find((entry) => entry.name === 'leaf.txt')?.parentPath).toBe(
      '/home/project/tree/nested/deep'
    );

    fs.cpSync('tree', 'copied', { recursive: true });
    await promises.cp('tree', 'copied-async', { recursive: true });
    for (const destination of ['copied', 'copied-async']) {
      expect(fs.readFileSync(`${destination}/nested/deep/leaf.txt`, 'utf8')).toBe('leaf');
      expect(fs.readlinkSync(`${destination}/link`)).toBe('root.txt');
    }
    expect(code(() => fs.cpSync('tree', 'not-recursive'))).toBe('ERR_FS_EISDIR');

    const directory = fs.opendirSync('tree');
    const names: string[] = [];
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) names.push(entry.name);
    directory.closeSync();
    expect(names).toEqual(['link', 'nested', 'root.txt']);

    const temporary = fs.mkdtempSync('/tmp/build-');
    const temporaryAsync = await promises.mkdtemp('/tmp/build-');
    expect(temporary).toMatch(/^\/tmp\/build-[A-Za-z0-9]{6}$/);
    expect(temporaryAsync).not.toBe(temporary);
    expect(fs.statSync(temporary).isDirectory()).toBe(true);
    await promises.rmdir(temporaryAsync);
    expect(fs.existsSync(temporaryAsync)).toBe(false);

    fs.truncateSync('tree/root.txt', 2);
    expect(fs.readFileSync('tree/root.txt', 'utf8')).toBe('ro');
    await promises.truncate('tree/root.txt', 4);
    expect([...(fs.readFileSync('tree/root.txt') as Uint8Array)]).toEqual([114, 111, 0, 0]);
    const descriptor = fs.openSync('tree/root.txt', 'r+');
    fs.ftruncateSync(descriptor);
    fs.closeSync(descriptor);
    expect(fs.statSync('tree/root.txt').size).toBe(0);
  });

  test('iterates committed changes through fs/promises watch until aborted', async () => {
    const fileSystem = new VirtualFileSystem('/home/project');
    const listeners = new Set<(event: VfsCommittedWatchEvent) => void>();
    const builtins = createNodeFileSystemBuiltins({
      asynchronous: fileSystem,
      cwd: '/home/project',
      scheduler: globalThis,
      synchronous: fileSystem,
      watch: {
        watchCommitted(listener, options) {
          options?.onRegistered?.({ registrationRevision: 0, cursor: 0 });
          listeners.add(listener);
          return () => listeners.delete(listener);
        }
      }
    });
    const promises = builtins.promises as FileSystemPromisesModule;
    const abort = new AbortController();
    const events = promises.watch('.', { recursive: true, signal: abort.signal });

    const first = events.next();
    for (const listener of listeners) {
      listener({
        kind: 'commit',
        revision: 1,
        invalidations: [{ path: '/home/project/src/index.ts', scope: 'path' }]
      });
    }
    await expect(first).resolves.toEqual({
      done: false,
      value: { eventType: 'change', filename: 'src/index.ts' }
    });

    const pending = events.next();
    abort.abort();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(listeners.size).toBe(0);
  });
});
