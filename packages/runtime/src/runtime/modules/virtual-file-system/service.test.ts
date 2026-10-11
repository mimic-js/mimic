import { describe, expect, test } from 'vitest';

import { serveVirtualFileSystem } from './service';

const readWrite = { append: false, readable: true, writable: true };

describe('Virtual File System owners', () => {
  test('releasing an owner closes the Open File Descriptions and mailboxes it left open', () => {
    const service = serveVirtualFileSystem({ mailboxHost: { autoSchedule: false } });
    service.api.initialize('/home/owners');
    const write = (path: string, text: string) =>
      service.api.commit({
        origin: 'test',
        operations: [{ type: 'write-file', path, data: text }]
      });
    write('/home/owners/kept.txt', 'kept');
    write('/home/owners/unlinked.txt', 'unlinked');
    const usage = () => service.authority!.usage();
    const idle = usage();

    const ended = service.forOwner();
    const other = service.forOwner();
    const kept = ended.api.openFile('/home/owners/kept.txt', readWrite).id;
    const unlinked = ended.api.openFile('/home/owners/unlinked.txt', readWrite).id;
    const closedByItself = ended.api.openFile('/home/owners/kept.txt', readWrite).id;
    ended.api.closeFile(closedByItself);
    const othersFile = other.api.openFile('/home/owners/kept.txt', readWrite).id;
    ended.api.openSynchronousMailbox('ended-process');
    service.api.commit({
      origin: 'test',
      operations: [{ type: 'rm', path: '/home/owners/unlinked.txt' }]
    });
    expect(new TextDecoder().decode(service.api.readOpenFile(unlinked, 16).data)).toBe('unlinked');
    expect(usage()).toEqual({
      openFileDescriptions: idle.openFileDescriptions + 3,
      inodes: idle.inodes
    });

    ended.release();

    expect(usage()).toEqual({
      openFileDescriptions: idle.openFileDescriptions + 1,
      inodes: idle.inodes - 1
    });
    for (const id of [kept, unlinked, closedByItself]) {
      expect(() => service.api.statOpenFile(id)).toThrow(/Unknown open file description/u);
    }
    expect(service.api.statOpenFile(othersFile).stat.size).toBe(4);
    // The mailbox is gone with its owner, so its context id is free again.
    expect(() => other.api.openSynchronousMailbox('ended-process')).not.toThrow();
    ended.release();
    other.release();
    expect(usage()).toEqual({ openFileDescriptions: idle.openFileDescriptions, inodes: idle.inodes - 1 });
    service.dispose();
  });

  test('an owner closes only the mailboxes it opened, and a bound owner opens only its own', () => {
    const service = serveVirtualFileSystem({ mailboxHost: { autoSchedule: false } });
    service.api.initialize('/home/owners');
    const victim = service.forOwner({ mailboxContextId: 'execution-context:1:process:7' });
    const attacker = service.forOwner({ mailboxContextId: 'execution-context:1:process:8' });
    const page = service.forOwner();

    const opened = victim.api.openSynchronousMailbox('named by the worker', { maxPayloadBytes: 2 ** 31 });
    expect(opened.descriptor.contextId).toBe('execution-context:1:process:7');
    // The bound owner's options are the host's: a worker cannot size its own channel.
    expect(opened.descriptor.channel.maxMessageBytes).toBeLessThan(2 ** 31);

    // Naming the victim's mailbox reaches only the attacker's own, which is not open.
    expect(() => attacker.api.closeSynchronousMailbox('execution-context:1:process:7')).toThrow(
      expect.objectContaining({ code: 'VFS_MAILBOX_NOT_OWNED' })
    );
    expect(() => attacker.api.openSynchronousMailbox('execution-context:1:process:7')).not.toThrow();
    expect(() => service.api.openSynchronousMailbox('execution-context:1:process:7')).toThrow(/already exists/u);
    // An unbound owner, as the page is, still closes only what it opened.
    expect(() => page.api.closeSynchronousMailbox('execution-context:1:process:7')).toThrow(
      expect.objectContaining({ code: 'VFS_MAILBOX_NOT_OWNED' })
    );
    expect(() => service.api.openSynchronousMailbox('execution-context:1:process:7')).toThrow(/already exists/u);

    victim.api.closeSynchronousMailbox('whatever the worker names');
    expect(() => service.api.openSynchronousMailbox('execution-context:1:process:7')).not.toThrow();
    service.api.closeSynchronousMailbox('execution-context:1:process:7');
    attacker.release();
    expect(() => service.api.openSynchronousMailbox('execution-context:1:process:8')).not.toThrow();
    service.dispose();
  });
});
