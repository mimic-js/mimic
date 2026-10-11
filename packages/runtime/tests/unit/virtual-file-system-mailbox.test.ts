import { Worker } from 'node:worker_threads';

import { afterEach, describe, expect, test } from 'vitest';

import {
  createSynchronousVirtualFileSystemClient,
  type SynchronousVirtualFileSystemClient,
  type SynchronousVirtualFileSystemMailboxDescriptor,
  type SynchronousVirtualFileSystemMailboxOptions,
  type VfsCommitOperation
} from '../../src/runtime/modules/virtual-file-system/index';
import { encodeFileSystemArchive } from '../../src/runtime/modules/virtual-file-system/archive';

// The host fixture is TypeScript, so its worker thread registers the loader before importing it.
const TYPESCRIPT_WORKER_BOOTSTRAP = `
  import('tsx/esm/api').then(({ register }) => {
    register();
    return import(require('node:worker_threads').workerData.fixture);
  });
`;

const workers: Worker[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
});

async function createMailboxHarness(workdir = '/home/mailbox') {
  const worker = new Worker(TYPESCRIPT_WORKER_BOOTSTRAP, {
    eval: true,
    workerData: {
      fixture: new URL('../fixtures/vfs-mailbox-host-worker.ts', import.meta.url).href,
      workdir
    }
  });
  workers.push(worker);
  let nextId = 0;
  const call = <Reply>(command: Record<string, unknown>): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const onMessage = (message: Reply & { readonly id: number }) => {
        if (message.id !== id) return;
        worker.off('message', onMessage);
        worker.off('error', reject);
        resolve(message);
      };
      worker.on('message', onMessage);
      worker.once('error', reject);
      worker.postMessage({ ...command, id });
    });
  return {
    async open(
      contextId: string,
      options?: SynchronousVirtualFileSystemMailboxOptions,
      cacheMaxBytes?: number
    ): Promise<SynchronousVirtualFileSystemClient> {
      const { descriptor } = await call<{ descriptor: SynchronousVirtualFileSystemMailboxDescriptor }>({
        type: 'open',
        contextId,
        options
      });
      return createSynchronousVirtualFileSystemClient(descriptor, { cacheMaxBytes });
    },
    /** Commits from outside the mailbox, as another Runtime Process would. */
    async commit(...operations: VfsCommitOperation[]): Promise<void> {
      const result = await call<{ status: string }>({
        type: 'commit',
        request: { origin: 'unrelated-writer', operations }
      });
      if (result.status !== 'committed') throw new Error('The fixture commit was rejected.');
    },
    stall: (milliseconds: number) => call({ type: 'stall', milliseconds }),
    /** Ends a context from the host side, as the end of its Runtime Process does. */
    close: (contextId: string) => call({ type: 'close', contextId }),
    async usage(): Promise<{ openFileDescriptions: number; inodes: number }> {
      return (await call<{ usage: { openFileDescriptions: number; inodes: number } }>({ type: 'usage' }))
        .usage;
    }
  };
}

function code(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

function rejection(run: () => unknown): { code?: string; message: string } | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return { code: (error as { code?: string }).code, message: (error as Error).message };
  }
}

describe('Synchronous VFS mailbox client cache', () => {
  test('answers a repeated probe sequence from the cache while an unrelated path is written', async () => {
    const harness = await createMailboxHarness();
    await harness.commit(
      { type: 'mkdir', path: '/home/mailbox/node_modules/pkg', options: { recursive: true } },
      { type: 'write-file', path: '/home/mailbox/node_modules/pkg/index.js', data: 'module.exports = 1;' },
      { type: 'write-file', path: '/home/mailbox/node_modules/pkg/package.json', data: '{}' }
    );
    const client = await harness.open('probe');
    const probe = () => ({
      missingFile: code(() => client.statSync('/home/mailbox/node_modules/pkg/index.ts')),
      missingDirectory: client.existsSync('/home/mailbox/node_modules/absent/package.json'),
      missingRead: code(() => client.readFileSync('/home/mailbox/node_modules/pkg/index.mjs')),
      stat: client.statSync('/home/mailbox/node_modules/pkg/index.js').size,
      manifest: client.readFileSync('/home/mailbox/node_modules/pkg/package.json', 'utf8'),
      entries: client.readdirSync('/home/mailbox/node_modules/pkg'),
      real: client.realpathSync('/home/mailbox/node_modules/pkg/index.js')
    });

    const first = probe();
    expect(first).toEqual({
      missingFile: 'NOT_FOUND',
      missingDirectory: false,
      missingRead: 'NOT_FOUND',
      stat: 19,
      manifest: '{}',
      entries: ['index.js', 'package.json'],
      real: '/home/mailbox/node_modules/pkg/index.js'
    });
    const afterFirst = client.diagnostics;
    expect(afterFirst.requests).toBe(7);

    for (let round = 0; round < 5; round += 1) {
      await harness.commit({
        type: 'write-file',
        path: `/home/mailbox/unrelated-${round}.log`,
        data: `round ${round}`
      });
      expect(probe()).toEqual(first);
    }

    const afterWrites = client.diagnostics;
    // Each interleaved commit costs one journal round trip; no probe is re-sent.
    expect(afterWrites.requests - afterFirst.requests).toBe(5);
    expect(afterWrites.cacheHits - afterFirst.cacheHits).toBe(5 * 7);
    expect(afterWrites.invalidations).toBe(0);
  });

  test('forgets a cached NOT_FOUND when the path or one of its ancestors is created', async () => {
    const harness = await createMailboxHarness();
    const client = await harness.open('negative');

    expect(client.existsSync('/home/mailbox/generated/deep/value.txt')).toBe(false);
    expect(client.existsSync('/home/mailbox/generated/deep/value.txt')).toBe(false);
    expect(code(() => client.statSync('/home/mailbox/later.txt'))).toBe('NOT_FOUND');
    expect(client.diagnostics.cacheHits).toBe(1);

    await harness.commit({ type: 'mkdir', path: '/home/mailbox/generated/deep', options: { recursive: true } });
    expect(client.existsSync('/home/mailbox/generated/deep/value.txt')).toBe(false);
    await harness.commit({ type: 'write-file', path: '/home/mailbox/generated/deep/value.txt', data: 'value' });
    expect(client.existsSync('/home/mailbox/generated/deep/value.txt')).toBe(true);

    await harness.commit({ type: 'write-file', path: '/home/mailbox/later.txt', data: 'later' });
    expect(client.statSync('/home/mailbox/later.txt').size).toBe(5);
    client.rmSync('/home/mailbox/later.txt');
    expect(code(() => client.statSync('/home/mailbox/later.txt'))).toBe('NOT_FOUND');
  });

  test('refreshes a cached directory listing when an entry is added, keeping its siblings cached', async () => {
    const harness = await createMailboxHarness();
    await harness.commit(
      { type: 'mkdir', path: '/home/mailbox/listed', options: { recursive: true } },
      { type: 'write-file', path: '/home/mailbox/listed/a.js', data: 'a' }
    );
    const client = await harness.open('listing');

    expect(client.readdirSync('/home/mailbox/listed')).toEqual(['a.js']);
    expect(client.statSync('/home/mailbox/listed/a.js').size).toBe(1);

    await harness.commit({ type: 'write-file', path: '/home/mailbox/listed/b.js', data: 'bb' });
    const before = client.diagnostics;
    expect(client.readdirSync('/home/mailbox/listed')).toEqual(['a.js', 'b.js']);
    expect(client.statSync('/home/mailbox/listed/a.js').size).toBe(1);
    // The listing is asked again; the sibling's stat is answered from the cache.
    expect(client.diagnostics.cacheHits - before.cacheHits).toBe(1);
    expect(client.diagnostics.invalidations - before.invalidations).toBe(1);
  });

  test('keeps a NOT_FOUND answer without a second copy of its path, so many more fit in the budget', async () => {
    const harness = await createMailboxHarness();
    // Each answer would be charged about 1 KB if it kept the message and the path beside the key.
    const client = await harness.open('many-absent-paths', undefined, 512 * 1024);
    const directory = `/home/mailbox/${'d'.repeat(120)}`;
    const paths = Array.from({ length: 1_000 }, (_, index) => `${directory}/missing-${String(index).padStart(4, '0')}.js`);
    expect(paths[0]).toHaveLength(150);

    for (const path of paths) expect(client.existsSync(path)).toBe(false);
    const afterFirstPass = client.diagnostics;
    for (const path of paths) expect(client.existsSync(path)).toBe(false);

    expect(client.diagnostics.requests - afterFirstPass.requests).toBe(0);
    expect(client.diagnostics.cacheHits - afterFirstPass.cacheHits).toBe(paths.length);
    // A cached answer reports what the authority reported.
    const missing = `${directory}/stat-target.js`;
    const fromAuthority = rejection(() => client.statSync(missing));
    const fromCache = rejection(() => client.statSync(missing));
    expect(client.diagnostics.cacheHits - afterFirstPass.cacheHits).toBe(paths.length + 1);
    expect(fromCache).toEqual(fromAuthority);
    expect(fromAuthority).toEqual({ code: 'NOT_FOUND', message: expect.stringContaining(missing) });
  });

  test('invalidates entries reached through symlinks, hard links, and archives', async () => {
    const harness = await createMailboxHarness();
    await harness.commit(
      { type: 'mkdir', path: '/home/mailbox/store/pkg', options: { recursive: true } },
      { type: 'write-file', path: '/home/mailbox/store/pkg/index.js', data: 'one' },
      { type: 'symlink', target: '/home/mailbox/store/pkg', path: '/home/mailbox/linked' },
      { type: 'link', existingPath: '/home/mailbox/store/pkg/index.js', newPath: '/home/mailbox/hard.js' }
    );
    const client = await harness.open('aliases');

    expect(client.readFileSync('/home/mailbox/linked/index.js', 'utf8')).toBe('one');
    expect(client.readFileSync('/home/mailbox/hard.js', 'utf8')).toBe('one');
    expect(client.existsSync('/home/mailbox/linked/extra.js')).toBe(false);

    await harness.commit({ type: 'write-file', path: '/home/mailbox/store/pkg/index.js', data: 'two' });
    expect(client.readFileSync('/home/mailbox/linked/index.js', 'utf8')).toBe('two');
    expect(client.readFileSync('/home/mailbox/hard.js', 'utf8')).toBe('two');

    await harness.commit({ type: 'write-file', path: '/home/mailbox/store/pkg/extra.js', data: 'extra' });
    expect(client.existsSync('/home/mailbox/linked/extra.js')).toBe(true);

    await harness.commit(
      { type: 'rm', path: '/home/mailbox/linked' },
      { type: 'mkdir', path: '/home/mailbox/linked' }
    );
    expect(client.existsSync('/home/mailbox/linked/index.js')).toBe(false);

    const archive = (contents: string) =>
      encodeFileSystemArchive(
        { 'inner.txt': { file: { contents }, mtimeMs: Date.UTC(2026, 0, 1) } },
        'zip'
      );
    await harness.commit({ type: 'write-file', path: '/home/mailbox/bundle.zip', data: archive('zipped one') });
    expect(client.readFileSync('/home/mailbox/bundle.zip/inner.txt', 'utf8')).toBe('zipped one');
    await harness.commit({ type: 'write-file', path: '/home/mailbox/bundle.zip', data: archive('zipped two') });
    expect(client.readFileSync('/home/mailbox/bundle.zip/inner.txt', 'utf8')).toBe('zipped two');
  });

  test('bounds the cache by total bytes and evicts the least recently used entries', async () => {
    const harness = await createMailboxHarness();
    await harness.commit(
      ...Array.from({ length: 8 }, (_, index): VfsCommitOperation => ({
        type: 'write-file',
        path: `/home/mailbox/blob-${index}.bin`,
        data: new Uint8Array(4_096).fill(index)
      }))
    );
    const client = await harness.open('bounded-cache', undefined, 24 * 1024);

    for (let index = 0; index < 8; index += 1) {
      expect(client.readFileSync(`/home/mailbox/blob-${index}.bin`)[0]).toBe(index);
    }
    expect(client.diagnostics.cacheBytes).toBeLessThanOrEqual(24 * 1024);

    const before = client.diagnostics;
    client.readFileSync('/home/mailbox/blob-7.bin');
    expect(client.diagnostics.cacheHits - before.cacheHits).toBe(1);
    client.readFileSync('/home/mailbox/blob-0.bin');
    expect(client.diagnostics.requests - before.requests).toBe(1);

    const mutable = client.readFileSync('/home/mailbox/blob-7.bin');
    mutable.fill(255);
    expect(client.readFileSync('/home/mailbox/blob-7.bin')[0]).toBe(7);
  });
});

describe('Synchronous VFS mailbox Open File Descriptions', () => {
  test('closes the descriptions a context left open when its mailbox closes, freeing unlinked inodes', async () => {
    const harness = await createMailboxHarness();
    const survivor = await harness.open('survivor');
    survivor.writeFileSync('/home/mailbox/kept.txt', 'kept');
    survivor.writeFileSync('/home/mailbox/unlinked.txt', 'unlinked');
    const survivorFile = survivor.openFileSync('/home/mailbox/kept.txt', {
      append: false,
      readable: true,
      writable: false
    });
    const idle = await harness.usage();

    const killed = await harness.open('killed');
    const mode = { append: false, readable: true, writable: true };
    const kept = killed.openFileSync('/home/mailbox/kept.txt', mode);
    const unlinked = killed.openFileSync('/home/mailbox/unlinked.txt', mode);
    const closedByItself = killed.openFileSync('/home/mailbox/kept.txt', mode);
    killed.closeFileSync(closedByItself);
    killed.rmSync('/home/mailbox/unlinked.txt');
    expect(new TextDecoder().decode(killed.readOpenFileSync(unlinked, 16))).toBe('unlinked');
    expect(await harness.usage()).toEqual({
      openFileDescriptions: idle.openFileDescriptions + 2,
      inodes: idle.inodes
    });

    await harness.close('killed');

    expect(await harness.usage()).toEqual({
      openFileDescriptions: idle.openFileDescriptions,
      inodes: idle.inodes - 1
    });
    for (const id of [kept, unlinked, closedByItself]) {
      expect(code(() => survivor.statOpenFileSync(id))).toBe('BAD_FILE_DESCRIPTOR');
    }
    expect(new TextDecoder().decode(survivor.readOpenFileSync(survivorFile, 16))).toBe('kept');
  });
});

describe('Synchronous VFS mailbox framing', () => {
  test('moves a megabyte of raw bytes in one round trip by default', async () => {
    const harness = await createMailboxHarness();
    const client = await harness.open('framing');
    const bytes = Uint8Array.from({ length: 1_000_000 }, (_, index) => index % 251);

    const before = client.diagnostics;
    client.writeFileSync('/home/mailbox/large.bin', bytes);
    const afterWrite = client.diagnostics;
    expect(afterWrite.requestChunks - before.requestChunks).toBe(1);
    expect(afterWrite.responseChunks - before.responseChunks).toBe(1);

    const observed = client.readFileSync('/home/mailbox/large.bin');
    const afterRead = client.diagnostics;
    expect(observed).toEqual(bytes);
    // One journal exchange for the write above, then the read itself.
    expect(afterRead.requests - afterWrite.requests).toBe(2);
    expect(afterRead.responseChunks - afterWrite.responseChunks).toBe(2);
  });

  test('writes and reads a file larger than one request carries in parts', async () => {
    // Yarn writes its install cache with one writeFileSync.
    const harness = await createMailboxHarness();
    const client = await harness.open('parts', { payloadCapacity: 4096, maxPayloadBytes: 64 * 1024 });
    const bytes = Uint8Array.from({ length: 200_000 }, (_, index) => (index * 7) % 256);

    client.writeFileSync('/home/mailbox/cache.zip', bytes, { mode: 0o600 });
    const text = 'yarn '.repeat(40_000);
    client.writeFileSync('/home/mailbox/cache.txt', text);

    expect(client.readFileSync('/home/mailbox/cache.zip')).toEqual(bytes);
    expect(client.readFileSync('/home/mailbox/cache.txt', 'utf8')).toBe(text);
    expect(client.statSync('/home/mailbox/cache.zip').size).toBe(200_000);
  });

  test('round-trips text, bytes, and options through small chunks without corrupting them', async () => {
    const harness = await createMailboxHarness();
    const client = await harness.open('chunked', { payloadCapacity: 64, maxPayloadBytes: 1024 * 1024 });
    const text = `${'длинный текст 🚀 '.repeat(400)}\u0000"\\end`;
    const bytes = Uint8Array.from({ length: 70_000 }, (_, index) => (index * 31) % 256);

    client.writeFileSync('/home/mailbox/text.txt', text);
    client.writeFileSync('/home/mailbox/bytes.bin', bytes, { mode: 0o755 });
    client.writeFileSync('/home/mailbox/bytes.bin', new Uint8Array([1, 2, 3]), { append: true });

    expect(client.readFileSync('/home/mailbox/text.txt', 'utf8')).toBe(text);
    const observed = client.readFileSync('/home/mailbox/bytes.bin');
    expect(observed.byteLength).toBe(70_003);
    expect(observed.subarray(0, 70_000)).toEqual(bytes);
    expect([...observed.subarray(70_000)]).toEqual([1, 2, 3]);
    expect(client.statSync('/home/mailbox/bytes.bin').mode).toBe(0o100755);
    expect(code(() => client.writeFileSync('/home/mailbox/bytes.bin', '', { exclusive: true }))).toBe(
      'ALREADY_EXISTS'
    );

    const descriptor = client.openFileSync('/home/mailbox/bytes.bin', {
      append: false,
      readable: true,
      writable: true
    });
    client.writeOpenFileSync(descriptor, new Uint8Array([9, 9]), 1);
    expect([...client.readOpenFileSync(descriptor, 4, 0)]).toEqual([bytes[0], 9, 9, bytes[3]]);
    client.closeFileSync(descriptor);
  });

  test('serves in parts a file whose response or request is too large for one call', async () => {
    const harness = await createMailboxHarness();
    await harness.commit(
      { type: 'write-file', path: '/home/mailbox/oversized.bin', data: new Uint8Array(65_536).fill(3) },
      { type: 'write-file', path: '/home/mailbox/small.txt', data: 'small' }
    );
    const client = await harness.open('bounded', { payloadCapacity: 1024, maxPayloadBytes: 16 * 1024 });

    expect(client.readFileSync('/home/mailbox/oversized.bin')).toEqual(new Uint8Array(65_536).fill(3));
    expect(client.readFileSync('/home/mailbox/small.txt', 'utf8')).toBe('small');
    client.writeFileSync('/home/mailbox/too-large.bin', new Uint8Array(40_000).fill(9));
    expect(client.readFileSync('/home/mailbox/too-large.bin')).toEqual(new Uint8Array(40_000).fill(9));
    client.writeFileSync('/home/mailbox/small.txt', 'still usable');
    expect(client.readFileSync('/home/mailbox/small.txt', 'utf8')).toBe('still usable');
  });

  test('fails one slow call and keeps the mailbox usable once the host catches up', async () => {
    const harness = await createMailboxHarness();
    await harness.commit({ type: 'write-file', path: '/home/mailbox/value.txt', data: 'value' });
    const client = await harness.open('slow-host', { watchdogMs: 100 });

    await harness.stall(400);
    expect(code(() => client.readFileSync('/home/mailbox/value.txt'))).toBe('VFS_MAILBOX_TIMEOUT');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(client.readFileSync('/home/mailbox/value.txt', 'utf8')).toBe('value');
  });
});
