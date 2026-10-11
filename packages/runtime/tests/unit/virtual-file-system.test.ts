import { describe, expect, test } from 'vitest';

import {
  createAsyncVirtualFileSystemClient,
  createSynchronousVirtualFileSystemClient,
  selectVfsCommittedWatchChanges,
  serveVirtualFileSystem,
  type VirtualFileSystemApi
} from '../../src/runtime/modules/virtual-file-system/index';
import {
  createSynchronousVirtualFileSystemMailboxHost
} from '../../src/runtime/modules/virtual-file-system/mailbox';
import {
  createVirtualFileSystemAuthority
} from '../../src/runtime/modules/virtual-file-system/authority';
import { connectRpc } from '../../src/runtime/modules/worker-transport/index';

describe('Virtual File System Runtime Deep Module', () => {
  test('selects deduplicated committed changes for exact, child, and recursive watches', () => {
    const invalidations = [
      { path: '/home/project/src/index.ts', scope: 'path' as const },
      { path: '/home/project/src', scope: 'directory' as const },
      { path: '/home/project/assets', scope: 'subtree' as const },
      { path: '/home/project/assets', scope: 'subtree' as const }
    ];

    expect(
      selectVfsCommittedWatchChanges(invalidations, '/home/project/src/index.ts', false)
    ).toEqual([{ path: '/home/project/src/index.ts', event: 'change' }]);
    expect(selectVfsCommittedWatchChanges(invalidations, '/home/project', false)).toEqual([
      { path: '/home/project/assets', event: 'rename' }
    ]);
    expect(selectVfsCommittedWatchChanges(invalidations, '/home/project', true)).toEqual([
      { path: '/home/project/src/index.ts', event: 'change' },
      { path: '/home/project/assets', event: 'rename' }
    ]);
  });

  test('prefers a committed rename when one path is both changed and replaced', () => {
    expect(
      selectVfsCommittedWatchChanges(
        [
          { path: '/home/project/generated/value.ts', scope: 'path' },
          { path: '/home/project/generated/value.ts', scope: 'subtree' }
        ],
        '/home/project/generated',
        true
      )
    ).toEqual([{ path: '/home/project/generated/value.ts', event: 'rename' }]);
  });

  test('retains a bounded compact commit journal and requires resynchronization after expiry', () => {
    const authority = createVirtualFileSystemAuthority('/home/project', { journalCapacity: 2 });

    authority.commit({
      origin: 'journal-contract',
      operations: [{ type: 'write-file', path: '/home/project/first.txt', data: 'first-payload' }]
    });
    authority.commit({
      origin: 'journal-contract',
      operations: [{ type: 'write-file', path: '/home/project/second.txt', data: 'second-payload' }]
    });
    authority.commit({
      origin: 'journal-contract',
      operations: [{ type: 'rename', oldPath: '/home/project/second.txt', newPath: '/home/project/renamed.txt' }]
    });

    expect(authority.readCommitJournal(1)).toEqual({
      status: 'delta',
      fromRevision: 1,
      toRevision: 3,
      records: [
        {
          revision: 2,
          invalidations: [
            { path: '/home/project/second.txt', scope: 'subtree' },
            { path: '/home/project', scope: 'directory' }
          ]
        },
        {
          revision: 3,
          invalidations: [
            { path: '/home/project/second.txt', scope: 'subtree' },
            { path: '/home/project/renamed.txt', scope: 'subtree' },
            { path: '/home/project', scope: 'directory' }
          ]
        }
      ]
    });
    expect(JSON.stringify(authority.readCommitJournal(1))).not.toContain('payload');
    expect(authority.readCommitJournal(0)).toEqual({
      status: 'resync-required',
      currentRevision: 3,
      oldestRetainedRevision: 2
    });
  });

  test('normalizes relative invalidations and names every directory a recursive mkdir creates', () => {
    const authority = createVirtualFileSystemAuthority('/home/project');

    authority.commit({
      origin: 'journal-contract',
      operations: [{ type: 'mkdir', path: 'generated/deep', options: { recursive: true } }]
    });
    authority.commit({
      origin: 'journal-contract',
      operations: [{ type: 'write-file', path: 'generated/deep/value.txt', data: 'latest' }]
    });

    expect(authority.readCommitJournal(0)).toEqual({
      status: 'delta',
      fromRevision: 0,
      toRevision: 2,
      records: [
        {
          revision: 1,
          invalidations: [
            { path: '/home/project/generated', scope: 'subtree' },
            { path: '/home/project/generated/deep', scope: 'subtree' },
            { path: '/home/project', scope: 'directory' },
            { path: '/home/project/generated', scope: 'directory' }
          ]
        },
        {
          revision: 2,
          invalidations: [
            { path: '/home/project/generated/deep/value.txt', scope: 'subtree' },
            { path: '/home/project/generated/deep', scope: 'directory' }
          ]
        }
      ]
    });
  });

  test('rejects failed hosts and over-capacity synchronous mailbox requests without fallback authority', () => {
    const authority = createVirtualFileSystemAuthority('/home/project');
    const host = createSynchronousVirtualFileSystemMailboxHost(authority, { autoSchedule: false });
    const descriptor = host.open('bounded-context', {
      payloadCapacity: 32,
      maxPayloadBytes: 64,
      watchdogMs: 50
    });
    const client = createSynchronousVirtualFileSystemClient(descriptor);

    expect(() => client.writeFileSync('/home/project/large.txt', 'x'.repeat(128))).toThrowError(
      expect.objectContaining({ code: 'VFS_PAYLOAD_TOO_LARGE' })
    );
    expect(() => host.open('bounded-context')).toThrow('already exists');

    host.fail();
    expect(() => client.readFileSync('/home/project/missing.txt')).toThrowError(
      expect.objectContaining({ code: 'VFS_EPOCH_FAILED' })
    );
  });

  test('publishes one revision for an atomic operation batch and rejects partial commits', () => {
    const authority = createVirtualFileSystemAuthority('/home/project');

    const committed = authority.commit({
      origin: 'owner-contract',
      operations: [
        { type: 'mkdir', path: '/home/project/src', options: { recursive: true } },
        { type: 'write-file', path: '/home/project/src/index.ts', data: 'export const ready = true;\n' }
      ]
    });

    expect(committed).toEqual({
      status: 'committed',
      revision: 1,
      origin: 'owner-contract',
      operations: [
        { type: 'mkdir', path: '/home/project/src', options: { recursive: true } },
        { type: 'write-file', path: '/home/project/src/index.ts', data: 'export const ready = true;\n' }
      ]
    });
    expect(authority.readFile('/home/project/src/index.ts')).toEqual({
      status: 'ok',
      revision: 1,
      data: new TextEncoder().encode('export const ready = true;\n')
    });

    const rejected = authority.commit({
      origin: 'owner-contract',
      operations: [
        { type: 'write-file', path: '/home/project/src/partial.ts', data: 'partial' },
        { type: 'write-file', path: '/missing/parent/failure.ts', data: 'failure' }
      ]
    });

    expect(rejected).toMatchObject({
      status: 'rejected',
      revision: 1,
      error: {
        code: 'NOT_FOUND',
        operationIndex: 1,
        operationType: 'write-file'
      }
    });
    expect(authority.readFile('/home/project/src/partial.ts')).toMatchObject({
      status: 'rejected',
      revision: 1,
      error: { code: 'NOT_FOUND' }
    });

    authority.commit({
      origin: 'mount-atomicity-setup',
      operations: [
        { type: 'mkdir', path: '/home/project/a-existing', options: { recursive: true } },
        { type: 'write-file', path: '/home/project/z-conflict', data: 'file' }
      ]
    });
    const beforeMount = authority.stat('/home/project/a-existing', true);
    expect(
      authority.commit({
        origin: 'mount-atomicity',
        operations: [
          {
            type: 'mount',
            tree: {
              'a-existing': { directory: {}, mtimeMs: 1 },
              'z-conflict': { directory: {} }
            }
          }
        ]
      })
    ).toMatchObject({ status: 'rejected', error: { code: 'NOT_DIRECTORY' } });
    expect(authority.stat('/home/project/a-existing', true)).toEqual(beforeMount);
  });

  test('serves an asynchronous client with clone-safe values and structured domain errors', async () => {
    const harness = await createVfsWatchHarness(undefined, '/home/client');
    const { fs } = harness;
    await fs.mkdir('/home/client/src', { recursive: true });
    await fs.writeFile('/home/client/src/index.ts', 'export const value = 42;\n');

    expect(await fs.readFile('/home/client/src/index.ts', 'utf8')).toBe('export const value = 42;\n');
    const [entry] = await fs.readdir('/home/client/src', { withFileTypes: true });
    expect(typeof entry === 'string' ? entry : { name: entry.name, file: entry.isFile(), directory: entry.isDirectory() }).toEqual({
      name: 'index.ts',
      file: true,
      directory: false
    });
    await expect(fs.readFile('/home/client/missing', 'utf8')).rejects.toMatchObject({
      name: 'VirtualFileSystemError',
      code: 'NOT_FOUND'
    });
    expect(fs.revision).toBe(2);

    await harness.close();
  });

  test('delivers ordered compact committed-watch revisions through the public client', async () => {
    const harness = await createVfsWatchHarness();
    const events: unknown[] = [];
    const stop = harness.fs.watchCommitted((event) => events.push(event), {
      afterRevision: 0,
      maxQueuedRevisions: 2
    });

    harness.authority.commit({
      origin: 'watch-source',
      operations: [{ type: 'write-file', path: '/home/watch/first.txt', data: 'first-payload' }]
    });
    harness.authority.commit({
      origin: 'watch-source',
      operations: [{ type: 'write-file', path: '/home/watch/first.txt', data: 'second-payload' }]
    });
    await harness.fs.readFile('/home/watch/first.txt', 'utf8');

    await expect.poll(() => events.length).toBe(2);
    expect(events).toEqual([
      {
        kind: 'commit',
        revision: 1,
        invalidations: [
          { path: '/home/watch/first.txt', scope: 'subtree' },
          { path: '/home/watch', scope: 'directory' }
        ]
      },
      {
        kind: 'commit',
        revision: 2,
        invalidations: [
          { path: '/home/watch/first.txt', scope: 'path' },
          { path: '/home/watch', scope: 'directory' }
        ]
      }
    ]);
    expect(JSON.stringify(events)).not.toContain('payload');

    stop();
    await harness.close();
  });

  test('establishes the default committed-watch cursor at authoritative registration time', async () => {
    const harness = await createVfsWatchHarness();
    harness.authority.commit({
      origin: 'before-watch-registration',
      operations: [{ type: 'write-file', path: '/home/watch/before.txt', data: 'before' }]
    });

    const events: unknown[] = [];
    const registrations: unknown[] = [];
    const stop = harness.fs.watchCommitted((event) => events.push(event), {
      onRegistered: (registration) => registrations.push(registration)
    });
    await expect.poll(() => harness.fs.revision).toBe(1);
    await expect.poll(() => registrations).toEqual([
      { registrationRevision: 1, cursor: 1 }
    ]);

    await harness.fs.writeFile('/home/watch/after.txt', 'after');

    await expect.poll(() => events.length).toBe(1);
    expect(events).toEqual([
      expect.objectContaining({
        kind: 'commit',
        revision: 2,
        invalidations: expect.arrayContaining([
          { path: '/home/watch/after.txt', scope: 'subtree' }
        ])
      })
    ]);

    stop();
    await harness.close();
  });

  test('reports subscriber backpressure and journal expiry as committed-watch resynchronization', async () => {
    const backpressure = await createVfsWatchHarness();
    const backpressureEvents: unknown[] = [];
    const stopBackpressure = backpressure.fs.watchCommitted((event) => backpressureEvents.push(event), {
      afterRevision: 0,
      maxQueuedRevisions: 1
    });
    backpressure.authority.commit({
      origin: 'watch-source',
      operations: [{ type: 'write-file', path: '/home/watch/one.txt', data: 'one' }]
    });
    backpressure.authority.commit({
      origin: 'watch-source',
      operations: [{ type: 'write-file', path: '/home/watch/two.txt', data: 'two' }]
    });
    await backpressure.fs.readFile('/home/watch/two.txt', 'utf8');
    await expect.poll(() => backpressureEvents.length).toBe(1);
    expect(backpressureEvents).toEqual([
      {
        kind: 'resync-required',
        afterRevision: 0,
        currentRevision: 2,
        oldestRetainedRevision: 1,
        reason: 'subscriber-backpressure'
      }
    ]);
    stopBackpressure();
    await backpressure.close();

    const expired = await createVfsWatchHarness(2);
    const expiredEvents: unknown[] = [];
    const stopExpired = expired.fs.watchCommitted((event) => expiredEvents.push(event), {
      afterRevision: 0
    });
    for (const name of ['one', 'two', 'three']) {
      expired.authority.commit({
        origin: 'watch-source',
        operations: [{ type: 'write-file', path: `/home/watch/${name}.txt`, data: name }]
      });
    }
    await expired.fs.readFile('/home/watch/three.txt', 'utf8');
    await expect.poll(() => expiredEvents.length).toBe(1);
    expect(expiredEvents).toEqual([
      {
        kind: 'resync-required',
        afterRevision: 0,
        currentRevision: 3,
        oldestRetainedRevision: 2,
        reason: 'journal-expired'
      }
    ]);
    stopExpired();
    await expired.close();
  });
});

async function createVfsWatchHarness(
  journalCapacity?: number,
  workdir = '/home/watch'
) {
  const channel = new MessageChannel();
  const service = serveVirtualFileSystem({
    authority: journalCapacity === undefined ? undefined : { journalCapacity }
  });
  const server = connectRpc(channel.port1, { fs: service.api });
  const client = connectRpc<{ fs: VirtualFileSystemApi }>(channel.port2);
  await client.remote.fs.initialize(workdir);
  const fs = await createAsyncVirtualFileSystemClient(client.remote.fs);
  if (!service.authority) throw new Error('Expected the VFS authority after initialization.');
  return {
    authority: service.authority,
    fs,
    async close() {
      fs.close();
      client.close();
      service.dispose();
      await Promise.all([client.closed, server.closed]);
    }
  };
}
