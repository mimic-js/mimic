import { describe, expect, test } from 'vitest';

import { type NodeFileSystemWatchPort } from '..';
import { BrowserBuffer } from '../buffer';
import { type NodeFileWatchLifecycle } from '../filesystem';
import { type NodeCompatibilityGlobals } from '../node-compatibility';
import { createNodeFileSystemBuiltins } from '../filesystem';
import { createNodeCompatibilityHarness } from './node-compatibility-harness';
import type { VfsCommittedWatchEvent } from '../../virtual-file-system';
import { VirtualFileSystem } from '../../../../../tests/support/module-internals';

type FileHandle = {
  close(): Promise<void>;
  read(
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number | null
  ): Promise<{ bytesRead: number; buffer: Uint8Array }>;
  stat(): Promise<FileSystemStats>;
  write(
    data: string | Uint8Array,
    offset?: number,
    length?: number,
    position?: number | null
  ): Promise<{ bytesWritten: number; buffer: string | Uint8Array }>;
};

type FileSystemStats = {
  readonly ino: number;
  readonly size: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
};

type FileSystemModule = {
  readonly default: FileSystemModule;
  readonly promises: FileSystemPromisesModule;
  readonly Stats: new () => FileSystemStats;
  appendFile(path: string, data: string, callback: (error?: unknown) => void): void;
  appendFileSync(path: string, data: string): void;
  closeSync(descriptor: number): void;
  createReadStream(path: string): {
    on(event: string, listener: (...args: unknown[]) => void): unknown;
    once(event: string, listener: (...args: unknown[]) => void): unknown;
  };
  createWriteStream(path: string): {
    end(chunk?: string | Uint8Array): unknown;
    once(event: string, listener: (...args: unknown[]) => void): unknown;
  };
  exists(path: string, callback: (exists: boolean) => void): void;
  existsSync(path: string): boolean;
  fstat(
    descriptor: number,
    callback: (error: unknown, value?: FileSystemStats) => void
  ): void;
  fstatSync(descriptor: number): FileSystemStats;
  lstat(
    path: string,
    callback: (error: unknown, value?: FileSystemStats) => void
  ): void;
  lstatSync(path: string): FileSystemStats;
  openSync(path: string, flags: string | number): number;
  readFile(
    path: string,
    callback: (error: unknown, value?: Uint8Array) => void
  ): void;
  readFileSync(path: string, encoding?: string): string | Uint8Array;
  readSync(
    descriptor: number,
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number | null
  ): number;
  stat(
    path: string,
    callback: (error: unknown, value?: FileSystemStats) => void
  ): void;
  statSync(path: string): FileSystemStats;
  writeFile(
    path: string,
    data: string | Uint8Array,
    callback: (error?: unknown) => void
  ): void;
  writeFileSync(path: string, data: string | Uint8Array): void;
  watch(
    path: string,
    options: { readonly recursive?: boolean },
    listener: (eventType: string, filename: string) => void
  ): FileWatcher;
  watch(path: string, listener: (eventType: string, filename: string) => void): FileWatcher;
  watchFile(path: string, listener: (current: unknown, previous: unknown) => void): FileWatcher;
  unwatchFile(path: string, listener?: (current: unknown, previous: unknown) => void): void;
  writeSync(
    descriptor: number,
    data: string | Uint8Array,
    offset?: number,
    length?: number,
    position?: number | null
  ): number;
};

type FileWatcher = {
  close(): void;
  on(event: 'change' | 'close', listener: (...args: unknown[]) => void): unknown;
  ref(): FileWatcher;
  unref(): FileWatcher;
};

type FileSystemPromisesModule = {
  readonly default: FileSystemPromisesModule;
  appendFile(path: string, data: string): Promise<void>;
  open(path: string, flags: string | number): Promise<FileHandle>;
  lstat(path: string): Promise<FileSystemStats>;
  readFile(path: string, options?: string): Promise<string | Uint8Array>;
  stat(path: string): Promise<FileSystemStats>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
};

describe('Node Compatibility filesystem adapters', () => {
  test('does not resolve an empty existence path to the current directory', async () => {
    const fileSystem = new VirtualFileSystem('/home/project');
    const builtins = createNodeFileSystemBuiltins({
      asynchronous: fileSystem,
      cwd: '/home/project',
      scheduler: globalThis,
      synchronous: fileSystem
    });
    const fs = builtins.fs as FileSystemModule;

    const exists = await new Promise<boolean>((resolve) => fs.exists('', resolve));

    expect(fs.existsSync('')).toBe(false);
    expect(exists).toBe(false);
    expect(fs.existsSync('.')).toBe(true);
  });

  test('preserves fs/promises identity through the engine-owned builtin provider', () => {
    const fileSystem = new VirtualFileSystem('/home/project');
    const compatibility = createNodeCompatibilityHarness({
      fileSystem,
      global: Object.create(globalThis) as typeof globalThis,
      globals: nodeCompatibilityGlobals()
    });

    const fsResult = compatibility.builtinModuleProvider.load('node:fs');
    const promisesResult = compatibility.builtinModuleProvider.load('node:fs/promises');
    if (!fsResult.found || !promisesResult.found) throw new Error('Expected filesystem builtins.');
    const fs = fsResult.module as { readonly promises: unknown };

    expect(fs.promises).toBe(promisesResult.module);
  });

  test('projects the stat family through one Node-compatible Stats identity', async () => {
    const fileSystem = new VirtualFileSystem('/home/project');
    fileSystem.writeFileSync('/home/project/payload.txt', 'stats');
    fileSystem.symlinkSync('payload.txt', '/home/project/payload-link');
    const builtins = createNodeFileSystemBuiltins({
      asynchronous: fileSystem,
      cwd: '/home/project',
      scheduler: globalThis,
      synchronous: fileSystem,
      watch: fileSystem
    });
    const fs = builtins.fs as FileSystemModule;
    const promises = builtins.promises as FileSystemPromisesModule;
    const descriptor = fs.openSync('payload.txt', 'r');
    const handle = await promises.open('payload.txt', 'r');

    const callbackStat = await callbackValue<FileSystemStats>((callback) => fs.stat('payload.txt', callback));
    const callbackLstat = await callbackValue<FileSystemStats>((callback) => fs.lstat('payload-link', callback));
    const callbackFstat = await callbackValue<FileSystemStats>((callback) => fs.fstat(descriptor, callback));
    const results = [
      fs.statSync('payload.txt'),
      callbackStat,
      await promises.stat('payload.txt'),
      fs.lstatSync('payload-link'),
      callbackLstat,
      await promises.lstat('payload-link'),
      fs.fstatSync(descriptor),
      callbackFstat,
      await handle.stat()
    ];

    expect(results.every((stat) => stat instanceof fs.Stats)).toBe(true);
    expect(results.slice(0, 3).every((stat) => stat.size === 5 && stat.isFile())).toBe(true);
    expect(results.slice(3, 6).every((stat) => stat.isSymbolicLink())).toBe(true);
    expect(results.slice(6).every((stat) => stat.ino > 0 && stat.isFile())).toBe(true);

    fs.closeSync(descriptor);
    await handle.close();
  });

  test('keeps sync, callback, and promise families on one VFS authority', async () => {
    const fileSystem = new VirtualFileSystem('/home/project');
    const builtins = createNodeFileSystemBuiltins({
      asynchronous: fileSystem,
      cwd: '/home/project',
      scheduler: globalThis,
      synchronous: fileSystem,
      watch: fileSystem
    });
    const fs = builtins.fs as FileSystemModule;
    const promises = builtins.promises as FileSystemPromisesModule;

    expect(fs.default).toBe(fs);
    expect(fs.promises).toBe(promises);
    expect(promises.default).toBe(promises);

    fs.writeFileSync('shared.txt', 'sync');
    expect(await promises.readFile('shared.txt', 'utf8')).toBe('sync');

    let callbackWasDeferred = false;
    const callbackWrite = new Promise<void>((resolve, reject) => {
      fs.writeFile('shared.txt', 'callback', (error) => {
        callbackWasDeferred = true;
        if (error) reject(error);
        else resolve();
      });
      expect(callbackWasDeferred).toBe(false);
    });
    await callbackWrite;
    expect(fs.readFileSync('shared.txt', 'utf8')).toBe('callback');

    await promises.writeFile('shared.txt', 'promise');
    fs.appendFileSync('shared.txt', '-sync-append');
    await new Promise<void>((resolve, reject) => {
      fs.appendFile('shared.txt', '-callback-append', (error) => error ? reject(error) : resolve());
    });
    await promises.appendFile('shared.txt', '-promise-append');
    expect(await promises.readFile('shared.txt', 'utf8')).toBe(
      'promise-sync-append-callback-append-promise-append'
    );
    const callbackBytes = await new Promise<Uint8Array>((resolve, reject) => {
      fs.readFile('shared.txt', (error, value) => {
        if (error) reject(error);
        else if (value) resolve(value);
        else reject(new Error('readFile callback returned no bytes'));
      });
    });
    expect(new TextDecoder().decode(callbackBytes)).toBe(
      'promise-sync-append-callback-append-promise-append'
    );
  });

  test('publishes descriptor writes immediately instead of buffering a second file authority', async () => {
    const fileSystem = new VirtualFileSystem('/home/project');
    const builtins = createNodeFileSystemBuiltins({
      asynchronous: fileSystem,
      cwd: '/home/project',
      scheduler: globalThis,
      synchronous: fileSystem,
      watch: fileSystem
    });
    const fs = builtins.fs as FileSystemModule;
    const promises = builtins.promises as FileSystemPromisesModule;
    fs.writeFileSync('descriptor.bin', new Uint8Array([1, 2, 3]));

    const descriptor = fs.openSync('descriptor.bin', 'r+');
    expect(fs.writeSync(descriptor, new Uint8Array([9]), 0, 1, 1)).toBe(1);
    expect([...(await fileSystem.readFile('/home/project/descriptor.bin'))]).toEqual([1, 9, 3]);

    const handle = await promises.open('descriptor.bin', 'r+');
    const written = await handle.write(new Uint8Array([8]), 0, 1, 2);
    expect(written.bytesWritten).toBe(1);
    expect([...(fs.readFileSync('descriptor.bin') as Uint8Array)]).toEqual([1, 9, 8]);

    const buffer = new Uint8Array(3);
    expect(fs.readSync(descriptor, buffer, 0, 3, 0)).toBe(3);
    expect([...buffer]).toEqual([1, 9, 8]);
    fs.closeSync(descriptor);
    await handle.close();
    await expect(handle.read(new Uint8Array(1))).rejects.toMatchObject({ code: 'EBADF' });
  });

  test('stores its own copy of written Buffer bytes, so reusing the Buffer does not rewrite the file', async () => {
    const fileSystem = new VirtualFileSystem('/home/project');
    const builtins = createNodeFileSystemBuiltins({
      asynchronous: fileSystem,
      cwd: '/home/project',
      scheduler: globalThis,
      synchronous: fileSystem,
      watch: fileSystem
    });
    const fs = builtins.fs as FileSystemModule;
    const reused = BrowserBuffer.from('first');

    fs.writeFileSync('whole.bin', reused.subarray(1));
    const descriptor = fs.openSync('partial.bin', 'w');
    expect(fs.writeSync(descriptor, reused, 1, 3, 0)).toBe(3);
    fs.closeSync(descriptor);
    reused.fill(0x2a);

    expect(new TextDecoder().decode(await fileSystem.readFile('/home/project/whole.bin'))).toBe('irst');
    expect(new TextDecoder().decode(await fileSystem.readFile('/home/project/partial.bin'))).toBe('irs');
  });

  test('keeps promise descriptor open on the asynchronous port', async () => {
    const fileSystem = new VirtualFileSystem('/home/project');
    await fileSystem.writeFile('/home/project/async-only.txt', 'content');
    const builtins = createNodeFileSystemBuiltins({
      asynchronous: fileSystem,
      cwd: '/home/project',
      scheduler: globalThis,
      synchronous: new ForbiddenSynchronousStatFileSystem('/home/project')
    });
    const promises = builtins.promises as FileSystemPromisesModule;

    const handle = await promises.open('async-only.txt', 'a');
    await handle.close();
  });

  test('does not create missing parent directories while opening descriptors', async () => {
    const fileSystem = new VirtualFileSystem('/home/project');
    const builtins = createNodeFileSystemBuiltins({
      asynchronous: fileSystem,
      cwd: '/home/project',
      scheduler: globalThis,
      synchronous: fileSystem
    });
    const fs = builtins.fs as FileSystemModule;
    const promises = builtins.promises as FileSystemPromisesModule;

    for (const flag of ['w', 'a'] as const) {
      const syncParent = `missing-sync-${flag}`;
      const asyncParent = `missing-async-${flag}`;
      expect(() => fs.openSync(`${syncParent}/file.txt`, flag)).toThrowError(
        expect.objectContaining({ code: 'ENOENT' })
      );
      await expect(promises.open(`${asyncParent}/file.txt`, flag)).rejects.toMatchObject({
        code: 'ENOENT'
      });
      expect(() => fileSystem.statSync(`/home/project/${syncParent}`)).toThrowError(
        expect.objectContaining({ code: 'NOT_FOUND' })
      );
      await expect(fileSystem.stat(`/home/project/${asyncParent}`)).rejects.toMatchObject({
        code: 'NOT_FOUND'
      });
    }
  });

  test('streams read and write through the asynchronous VFS client', async () => {
    const fileSystem = new VirtualFileSystem('/home/project');
    const builtins = createNodeFileSystemBuiltins({
      asynchronous: fileSystem,
      cwd: '/home/project',
      scheduler: globalThis,
      synchronous: fileSystem,
      watch: fileSystem
    });
    const fs = builtins.fs as FileSystemModule;

    const writer = fs.createWriteStream('stream.txt');
    const writerLifecycle: string[] = [];
    writer.once('finish', () => writerLifecycle.push('finish'));
    writer.once('close', () => writerLifecycle.push('close'));
    const finished = once(writer, 'finish');
    const writerClosed = once(writer, 'close');
    writer.end('streamed');
    await Promise.all([finished, writerClosed]);

    const chunks: Uint8Array[] = [];
    const reader = fs.createReadStream('stream.txt');
    const readerLifecycle: string[] = [];
    reader.once('end', () => readerLifecycle.push('end'));
    reader.once('close', () => readerLifecycle.push('close'));
    reader.on('data', (chunk) => {
      if (chunk instanceof Uint8Array) chunks.push(chunk);
    });
    await Promise.all([once(reader, 'end'), once(reader, 'close')]);

    expect(new TextDecoder().decode(concatenate(chunks))).toBe('streamed');
    expect(writerLifecycle).toEqual(['finish', 'close']);
    expect(readerLifecycle).toEqual(['end', 'close']);

    const missing = fs.createReadStream('missing.txt');
    const missingLifecycle: string[] = [];
    missing.once('error', () => missingLifecycle.push('error'));
    missing.once('close', () => missingLifecycle.push('close'));
    missing.on('data', () => undefined);
    await new Promise<void>((resolve) => missing.once('close', resolve));
    expect(missingLifecycle).toEqual(['error', 'close']);

    const failedWriter = fs.createWriteStream('missing-directory/stream.txt');
    const failedWriterLifecycle: string[] = [];
    failedWriter.once('error', () => failedWriterLifecycle.push('error'));
    failedWriter.once('close', () => failedWriterLifecycle.push('close'));
    failedWriter.end('streamed');
    await new Promise<void>((resolve) => failedWriter.once('close', resolve));
    expect(failedWriterLifecycle).toEqual(['error', 'close']);
  });

  test('returns Buffers from path APIs asked for the buffer encoding', async () => {
    const fileSystem = new VirtualFileSystem('/home/project');
    fileSystem.writeFileSync('/home/project/target.txt', 'target');
    fileSystem.symlinkSync('target.txt', '/home/project/link.txt');
    const builtins = createNodeFileSystemBuiltins({
      asynchronous: fileSystem,
      cwd: '/home/project',
      scheduler: globalThis,
      synchronous: fileSystem
    });
    const fs = builtins.fs as {
      realpathSync(path: string, options: { encoding: 'buffer' }): Uint8Array;
      readlinkSync(path: string, options: { encoding: 'buffer' }): Uint8Array;
    };
    const promises = builtins.promises as {
      realpath(path: string, options: { encoding: 'buffer' }): Promise<Uint8Array>;
      readlink(path: string, options: { encoding: 'buffer' }): Promise<Uint8Array>;
    };

    expect(fs.realpathSync('.', { encoding: 'buffer' })).toBeInstanceOf(BrowserBuffer);
    expect(fs.readlinkSync('link.txt', { encoding: 'buffer' })).toBeInstanceOf(BrowserBuffer);
    await expect(promises.realpath('.', { encoding: 'buffer' })).resolves.toBeInstanceOf(BrowserBuffer);
    await expect(promises.readlink('link.txt', { encoding: 'buffer' })).resolves.toBeInstanceOf(BrowserBuffer);
  });

  test('opens a directory for reading, as a native binding that walks a tree with descriptors does', () => {
    const fileSystem = new VirtualFileSystem('/home/project');
    fileSystem.mkdirSync('/home/project/tree');
    fileSystem.writeFileSync('/home/project/tree/file.txt', 'file');
    fileSystem.symlinkSync('file.txt', '/home/project/tree/link.txt');
    const fs = createNodeFileSystemBuiltins({
      asynchronous: fileSystem,
      cwd: '/home/project',
      scheduler: globalThis,
      synchronous: fileSystem
    }).fs as {
      openSync(path: string, flags?: string | number): number;
      fstatSync(descriptor: number, options?: { bigint?: boolean }): { isDirectory(): boolean; size: number | bigint };
      readSync(descriptor: number, buffer: Uint8Array): number;
      closeSync(descriptor: number): void;
      readdirSync(path: string, options: { withFileTypes: true }): Array<Record<string, () => boolean> & { name: string }>;
      statSync(path: string): unknown;
    };

    const descriptor = fs.openSync('tree', 0);
    expect(fs.fstatSync(descriptor).isDirectory()).toBe(true);
    expect(fs.fstatSync(descriptor, { bigint: true }).isDirectory()).toBe(true);
    expect(() => fs.readSync(descriptor, new Uint8Array(4))).toThrowError(
      expect.objectContaining({ code: 'EISDIR', errno: -21 })
    );
    fs.closeSync(descriptor);
    expect(() => fs.fstatSync(descriptor)).toThrowError(expect.objectContaining({ code: 'EBADF', errno: -9 }));
    expect(() => fs.openSync('tree', 'w')).toThrowError(expect.objectContaining({ code: 'EISDIR' }));
    expect(() => fs.statSync('tree/missing')).toThrowError(expect.objectContaining({ code: 'ENOENT', errno: -2 }));

    // Every type predicate of a Dirent answers; only three kinds of entry exist here.
    expect(
      fs.readdirSync('tree', { withFileTypes: true }).map((entry) => [
        entry.name,
        ['isFile', 'isDirectory', 'isSymbolicLink', 'isBlockDevice', 'isCharacterDevice', 'isFIFO', 'isSocket'].filter(
          (predicate) => entry[predicate]!()
        )
      ])
    ).toEqual([
      ['file.txt', ['isFile']],
      ['link.txt', ['isSymbolicLink']]
    ]);
  });

  test('reports watched filenames as Buffers when asked for the buffer encoding', () => {
    const fileSystem = new VirtualFileSystem('/home/project');
    const committed = committedWatchPort();
    const fs = createNodeFileSystemBuiltins({
      asynchronous: fileSystem,
      cwd: '/home/project',
      scheduler: globalThis,
      synchronous: fileSystem,
      watch: committed.port
    }).fs as {
      watch(path: string, options: { encoding: string } | string, listener: (event: string, name: unknown) => void): unknown;
    };
    const asOption: unknown[] = [];
    const asString: unknown[] = [];
    fs.watch('watched', { encoding: 'buffer' }, (_event, filename) => asOption.push(filename));
    fs.watch('watched', 'buffer', (_event, filename) => asString.push(filename));

    committed.emit({
      kind: 'commit',
      revision: 7,
      invalidations: [{ path: '/home/project/watched/direct.ts', scope: 'path' }]
    });

    for (const [filename] of [asOption, asString]) {
      expect(filename).toBeInstanceOf(BrowserBuffer);
      expect(String(filename)).toBe('direct.ts');
    }
  });

  test('selects revision-ordered recursive committed changes without observing unrelated paths', () => {
    const fileSystem = new VirtualFileSystem('/home/project');
    const committed = committedWatchPort();
    const fs = createNodeFileSystemBuiltins({
      asynchronous: fileSystem,
      cwd: '/home/project',
      scheduler: globalThis,
      synchronous: fileSystem,
      watch: committed.port
    }).fs as FileSystemModule;
    const observed: Array<[eventType: string, filename: string]> = [];
    const nonRecursive: Array<[eventType: string, filename: string]> = [];
    const exact: Array<[eventType: string, filename: string]> = [];

    fs.watch('watched', { recursive: true }, (eventType, filename) => observed.push([eventType, filename]));
    fs.watch('watched', (eventType, filename) => nonRecursive.push([eventType, filename]));
    fs.watch('watched/nested/changed.ts', (eventType, filename) => exact.push([eventType, filename]));
    committed.emit({
      kind: 'commit',
      revision: 7,
      invalidations: [
        { path: '/home/project/watched/direct.ts', scope: 'path' },
        { path: '/home/project/watched/nested/changed.ts', scope: 'path' },
        { path: '/home/project/watched/nested/created.ts', scope: 'subtree' },
        { path: '/home/project/unrelated/ignored.ts', scope: 'path' }
      ]
    });
    committed.emit({
      kind: 'commit',
      revision: 8,
      invalidations: [
        { path: '/home/project/watched/nested/removed.ts', scope: 'subtree' },
        { path: '/home/project/watched/nested/renamed-from.ts', scope: 'subtree' },
        { path: '/home/project/watched/nested/renamed-to.ts', scope: 'subtree' }
      ]
    });

    expect(observed).toEqual([
      ['change', 'direct.ts'],
      ['change', 'nested/changed.ts'],
      ['rename', 'nested/created.ts'],
      ['rename', 'nested/removed.ts'],
      ['rename', 'nested/renamed-from.ts'],
      ['rename', 'nested/renamed-to.ts']
    ]);
    expect(nonRecursive).toEqual([['change', 'direct.ts']]);
    expect(exact).toEqual([['change', 'changed.ts']]);
  });

  test('preserves the invalidation order of one commit and exposes one resynchronization notification at the watched root', () => {
    const fileSystem = new VirtualFileSystem('/home/project');
    const committed = committedWatchPort();
    const fs = createNodeFileSystemBuiltins({
      asynchronous: fileSystem,
      cwd: '/home/project',
      scheduler: globalThis,
      synchronous: fileSystem,
      watch: committed.port
    }).fs as FileSystemModule;
    const observed: Array<[eventType: string, filename: string]> = [];

    fs.watch('/home/project/watched', { recursive: true }, (eventType, filename) => observed.push([eventType, filename]));
    committed.emit({
      kind: 'commit',
      revision: 12,
      invalidations: [
        { path: '/home/project/watched/batch/first.ts', scope: 'path' },
        { path: '/home/project/watched/batch/second.ts', scope: 'path' }
      ]
    });
    committed.emit({
      kind: 'resync-required',
      afterRevision: 12,
      currentRevision: 20,
      oldestRetainedRevision: 18,
      reason: 'subscriber-backpressure'
    });

    expect(observed).toEqual([
      ['change', 'batch/first.ts'],
      ['change', 'batch/second.ts'],
      ['rename', 'watched']
    ]);
  });

  test('reports file creation and removal as rename events from the committed state', () => {
    const fileSystem = new VirtualFileSystem('/home/project');
    fileSystem.mkdirSync('/home/project/watched');
    fileSystem.writeFileSync('/home/project/watched/existing.ts', 'before');
    const committed = committedWatchPort();
    const fs = createNodeFileSystemBuiltins({
      asynchronous: fileSystem,
      cwd: '/home/project',
      scheduler: globalThis,
      synchronous: fileSystem,
      watch: committed.port
    }).fs as FileSystemModule;
    const observed: Array<[eventType: string, filename: string]> = [];
    fs.watch('watched', (eventType, filename) => observed.push([eventType, filename]));

    fileSystem.writeFileSync('/home/project/watched/existing.ts', 'after');
    committed.emit({
      kind: 'commit',
      revision: 1,
      invalidations: [{ path: '/home/project/watched/existing.ts', scope: 'path' }]
    });
    fileSystem.writeFileSync('/home/project/watched/created.ts', 'created');
    committed.emit({
      kind: 'commit',
      revision: 2,
      invalidations: [
        { path: '/home/project/watched/created.ts', scope: 'subtree' }
      ]
    });
    fileSystem.rmSync('/home/project/watched/existing.ts');
    committed.emit({
      kind: 'commit',
      revision: 3,
      invalidations: [
        { path: '/home/project/watched/existing.ts', scope: 'subtree' }
      ]
    });

    expect(observed).toEqual([
      ['change', 'existing.ts'],
      ['rename', 'created.ts'],
      ['rename', 'existing.ts']
    ]);
  });

  test('reports package-neutral committed-watch registration and delivery diagnostics', () => {
    const fileSystem = new VirtualFileSystem('/home/project');
    fileSystem.mkdirSync('/home/project/watched');
    const committed = committedWatchPort();
    const diagnostics: unknown[] = [];
    const fs = createNodeFileSystemBuiltins({
      asynchronous: fileSystem,
      cwd: '/home/project',
      scheduler: globalThis,
      synchronous: fileSystem,
      watch: committed.port,
      watchDiagnostics: (event) => diagnostics.push(event)
    }).fs as FileSystemModule;

    fs.watch('watched', { recursive: true }, () => undefined);
    committed.emit({
      kind: 'commit',
      revision: 8,
      invalidations: [{ path: '/home/project/unrelated.txt', scope: 'path' }]
    });
    committed.emit({
      kind: 'commit',
      revision: 9,
      invalidations: [{ path: '/home/project/watched/changed.ts', scope: 'path' }]
    });
    committed.emit({
      kind: 'resync-required',
      afterRevision: 9,
      currentRevision: 12,
      oldestRetainedRevision: 11,
      reason: 'journal-expired'
    });

    expect(diagnostics).toEqual([
      {
        kind: 'registered',
        watchId: 1,
        watchedPath: '/home/project/watched',
        recursive: true,
        registrationRevision: 7,
        cursor: 7
      },
      {
        kind: 'delivered',
        watchId: 1,
        watchedPath: '/home/project/watched',
        recursive: true,
        revision: 8,
        invalidations: [{ path: '/home/project/unrelated.txt', scope: 'path' }],
        projectedPaths: []
      },
      {
        kind: 'delivered',
        watchId: 1,
        watchedPath: '/home/project/watched',
        recursive: true,
        revision: 9,
        invalidations: [{ path: '/home/project/watched/changed.ts', scope: 'path' }],
        projectedPaths: ['/home/project/watched/changed.ts']
      },
      {
        kind: 'resync-required',
        watchId: 1,
        watchedPath: '/home/project/watched',
        recursive: true,
        currentRevision: 12,
        reason: 'journal-expired'
      }
    ]);
  });

  test('shares one committed journal subscription across file watchers', () => {
    const fileSystem = new VirtualFileSystem('/home/project');
    const committed = committedWatchPort();
    const fs = createNodeFileSystemBuiltins({
      asynchronous: fileSystem,
      cwd: '/home/project',
      scheduler: globalThis,
      synchronous: fileSystem,
      watch: committed.port
    }).fs as FileSystemModule;
    const observed: string[] = [];
    const watchers = Array.from({ length: 40 }, (_, index) =>
      fs.watch(`watched-${index}`, (_eventType, filename) => observed.push(filename))
    );

    expect(committed.subscriptions).toBe(1);
    committed.emit({
      kind: 'commit',
      revision: 8,
      invalidations: [{ path: '/home/project/watched-39/changed.ts', scope: 'path' }]
    });
    expect(observed).toEqual(['changed.ts']);

    for (const watcher of watchers) watcher.close();
    expect(committed.subscriptions).toBe(0);
  });

  test('closes committed and stat watchers through their lifecycle handles', () => {
    const fileSystem = new VirtualFileSystem('/home/project');
    fileSystem.writeFileSync('/home/project/watched.txt', 'before');
    const committed = committedWatchPort();
    const lifecycle = fileWatchLifecycle();
    const fs = createNodeFileSystemBuiltins({
      asynchronous: fileSystem,
      cwd: '/home/project',
      fileWatchLifecycle: lifecycle.port,
      scheduler: globalThis,
      synchronous: fileSystem,
      watch: committed.port
    }).fs as FileSystemModule;
    const events: string[] = [];
    const watcher = fs.watch('watched.txt', { recursive: false }, (_eventType, filename) => events.push(filename));
    watcher.unref();
    watcher.ref();
    watcher.close();
    committed.emit({
      kind: 'commit',
      revision: 2,
      invalidations: [{ path: '/home/project/watched.txt', scope: 'path' }]
    });

    const statWatcher = fs.watchFile('watched.txt', () => undefined);
    fs.unwatchFile('watched.txt');

    expect(events).toEqual([]);
    expect(lifecycle.closed).toBe(2);
    expect(lifecycle.unrefed).toBe(1);
    expect(lifecycle.refed).toBe(1);
    expect(statWatcher).toBeDefined();
  });
});

function committedWatchPort(): {
  readonly port: NodeFileSystemWatchPort;
  readonly subscriptions: number;
  emit(event: VfsCommittedWatchEvent): void;
} {
  const listeners = new Set<(event: VfsCommittedWatchEvent) => void>();
  return {
    port: {
      watchCommitted(listener, options) {
        options?.onRegistered?.({ registrationRevision: 7, cursor: 7 });
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    },
    emit(event) {
      for (const listener of listeners) listener(event);
    },
    get subscriptions() {
      return listeners.size;
    }
  };
}

function fileWatchLifecycle(): {
  readonly port: NodeFileWatchLifecycle;
  readonly closed: number;
  readonly refed: number;
  readonly unrefed: number;
} {
  let closed = 0;
  let refed = 0;
  let unrefed = 0;
  return {
    port: {
      open(cleanup) {
        let isClosed = false;
        return {
          close() {
            if (isClosed) return;
            isClosed = true;
            closed += 1;
            cleanup();
          },
          ref() {
            refed += 1;
          },
          unref() {
            unrefed += 1;
          }
        };
      }
    },
    get closed() {
      return closed;
    },
    get refed() {
      return refed;
    },
    get unrefed() {
      return unrefed;
    }
  };
}

class ForbiddenSynchronousStatFileSystem extends VirtualFileSystem {
  override statSync(_path: string): never {
    throw new Error('The promise descriptor path must not touch statSync.');
  }
}

function once(
  emitter: { once(event: string, listener: (...args: unknown[]) => void): unknown },
  event: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    emitter.once('error', reject);
    emitter.once(event, () => resolve());
  });
}

function callbackValue<Value>(
  operation: (callback: (error: unknown, value?: Value) => void) => void
): Promise<Value> {
  return new Promise((resolve, reject) => {
    operation((error, value) => {
      if (error) reject(error);
      else if (value === undefined) reject(new Error('Expected a callback value.'));
      else resolve(value);
    });
  });
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function nodeCompatibilityGlobals(): NodeCompatibilityGlobals {
  return {
    process: {
      arch: 'wasm32',
      platform: 'browser',
      version: 'v22.22.3',
      versions: { node: '22.22.3' },
      release: {
        name: 'node',
        lts: 'Jod',
        sourceUrl: 'https://nodejs.org/download/release/v22.22.3/node-v22.22.3.tar.gz',
        headersUrl: 'https://nodejs.org/download/release/v22.22.3/node-v22.22.3-headers.tar.gz'
      }
    },
    console,
    Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    WebSocket,
    MessageChannel,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
    queueMicrotask
  };
}
