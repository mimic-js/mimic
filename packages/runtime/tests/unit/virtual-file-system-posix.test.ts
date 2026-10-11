import { describe, expect, test } from 'vitest';

import {
  createVirtualFileSystemAuthority
} from '../../src/runtime/modules/virtual-file-system/authority';
import {
  VirtualFileSystem
} from '../../src/runtime/modules/virtual-file-system/virtual-file-system';

describe('Virtual File System POSIX semantics', () => {
  test('preserves nonzero inode identity across symlink, hardlink, and rename operations', async () => {
    const fs = new VirtualFileSystem('/home/project');
    await fs.mkdir('/home/project/assets');
    await fs.writeFile('/home/project/assets/target.txt', 'source');
    await fs.symlink('target.txt', '/home/project/assets/target-link.txt');
    await fs.link('/home/project/assets/target.txt', '/home/project/assets/target-hard-link.txt');

    const directory = await fs.stat('/home/project/assets');
    const target = await fs.stat('/home/project/assets/target.txt');
    const linkedTarget = await fs.stat('/home/project/assets/target-hard-link.txt');
    const symlink = await fs.lstat('/home/project/assets/target-link.txt');

    expect(directory.ino).toBeGreaterThan(0);
    expect(target.ino).toBeGreaterThan(0);
    expect(symlink.ino).toBeGreaterThan(0);
    expect(directory.ino).not.toBe(target.ino);
    expect(symlink.ino).not.toBe(target.ino);
    expect((await fs.stat('/home/project/assets')).ino).toBe(directory.ino);
    expect((await fs.lstat('/home/project/assets/target-link.txt')).ino).toBe(symlink.ino);
    expect(linkedTarget.ino).toBe(target.ino);
    const followedSymlink = await fs.stat('/home/project/assets/target-link.txt');
    expect(followedSymlink.ino).toBe(target.ino);
    expect(followedSymlink.isFile()).toBe(true);
    expect(symlink.isSymbolicLink()).toBe(true);
    expect(await fs.realpath('/home/project/assets/target-link.txt')).toBe('/home/project/assets/target.txt');

    await fs.rename('/home/project/assets/target-hard-link.txt', '/home/project/assets/renamed-hard-link.txt');

    expect((await fs.stat('/home/project/assets/renamed-hard-link.txt')).ino).toBe(target.ino);
    expect((await fs.stat('/home/project/assets/target.txt')).ino).toBe(target.ino);
  });

  test('rejects replacing directories or moving the root with stable POSIX errors', () => {
    const fs = new VirtualFileSystem('/home/project');
    fs.mkdirSync('/home/project/directory');

    expectVfsError(() => fs.mkdirSync('/home/project/directory'), 'ALREADY_EXISTS');
    expectVfsError(() => fs.writeFileSync('/home/project/directory', 'not a file'), 'IS_DIRECTORY');
    expect(fs.readdirSync('/home/project/directory')).toEqual([]);
    expectVfsError(() => fs.rmSync('/', { recursive: true }), 'OPERATION_NOT_PERMITTED');
    expectVfsError(() => fs.renameSync('/', '/home/project/moved-root'), 'OPERATION_NOT_PERMITTED');
  });

  test('rolls back a rename when a later directory operation rejects the authority commit', () => {
    const authority = createVirtualFileSystemAuthority('/home/project');
    expect(authority.commit({
      origin: 'posix-test',
      operations: [{ type: 'write-file', path: '/home/project/original.txt', data: 'original' }]
    })).toMatchObject({ status: 'committed', revision: 1 });

    const rejected = authority.commit({
      origin: 'posix-test',
      operations: [
        { type: 'rename', oldPath: '/home/project/original.txt', newPath: '/home/project/renamed.txt' },
        { type: 'mkdir', path: '/home/project' }
      ]
    });

    expect(rejected).toMatchObject({
      status: 'rejected',
      revision: 1,
      error: { code: 'ALREADY_EXISTS', operationIndex: 1, operationType: 'mkdir' }
    });
    expect(authority.readFile('/home/project/original.txt')).toEqual({
      status: 'ok',
      revision: 1,
      data: new TextEncoder().encode('original')
    });
    expect(authority.readFile('/home/project/renamed.txt')).toMatchObject({
      status: 'rejected',
      revision: 1,
      error: { code: 'NOT_FOUND' }
    });
  });
});

function expectVfsError(operation: () => void, code: string): void {
  try {
    operation();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected VFS operation to reject with ${code}.`);
}
