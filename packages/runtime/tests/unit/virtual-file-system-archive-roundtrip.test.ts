import { describe, expect, test } from 'vitest';

import { type FileSystemTree } from '../../src/runtime/modules/virtual-file-system/index';
import {
  VirtualFileSystem
} from '../../src/runtime/modules/virtual-file-system/virtual-file-system';

const archiveMtimeMs = Date.UTC(2024, 0, 2, 3, 4, 6);

const sourceTree: FileSystemTree = {
  empty: {
    directory: {},
    mtimeMs: archiveMtimeMs
  },
  nested: {
    directory: {
      'payload.bin': {
        file: { contents: new Uint8Array([0, 255, 1, 2]) },
        mtimeMs: archiveMtimeMs
      },
      'payload-link': {
        symlink: { target: 'payload.bin' },
        mtimeMs: archiveMtimeMs
      }
    },
    mtimeMs: archiveMtimeMs
  }
};

describe('Virtual File System snapshot and archive round trips', () => {
  test('exports a deterministic binary-safe JSON tree through the owner interface', () => {
    const fileSystem = new VirtualFileSystem('/home/source');
    fileSystem.mount(sourceTree);

    const first = fileSystem.exportTree();
    const second = fileSystem.exportTree();

    expect(first).toEqual(sourceTree);
    expect(second).toEqual(first);
    expect(first.nested).toMatchObject({
      directory: {
        'payload.bin': {
          file: { contents: new Uint8Array([0, 255, 1, 2]) }
        },
        'payload-link': {
          symlink: { target: 'payload.bin' }
        }
      }
    });
  });

  test.each(['zip', 'tar'] as const)(
    'mounts its deterministic %s export without losing bytes, metadata, empty directories, or symlinks',
    (format) => {
      const source = new VirtualFileSystem('/home/source');
      source.mount(sourceTree);

      const firstArchive = source.exportArchive('/home/source', format);
      const secondArchive = source.exportArchive('/home/source', format);
      expect(secondArchive).toEqual(firstArchive);

      const mounted = new VirtualFileSystem('/home/mounted');
      mounted.mountArchive(firstArchive, '/home/mounted');

      expect(mounted.exportTree('/home/mounted')).toEqual(sourceTree);
      expect(mounted.readFileSync('/home/mounted/nested/payload-link')).toEqual(
        new Uint8Array([0, 255, 1, 2])
      );
      expect(mounted.lstatSync('/home/mounted/nested/payload-link')).toMatchObject({
        mtimeMs: archiveMtimeMs
      });
      expect(mounted.lstatSync('/home/mounted/nested/payload-link').isSymbolicLink()).toBe(true);
      expect(mounted.readlinkSync('/home/mounted/nested/payload-link')).toBe('payload.bin');
      expect(mounted.readdirSync('/home/mounted/empty')).toEqual([]);
      expect(mounted.exportArchive('/home/mounted', format)).toEqual(firstArchive);
    }
  );

  test.each(['json', 'zip', 'tar'] as const)(
    'keeps non-default permission bits through a %s export and mount',
    (format) => {
      const source = new VirtualFileSystem('/home/source');
      source.mount(sourceTree);
      source.chmodSync('/home/source/nested/payload.bin', 0o755);
      source.chmodSync('/home/source/empty', 0o700);

      const exported = source.exportTree('/home/source');
      expect(exported.empty).toMatchObject({ mode: 0o700 });
      expect(exported.nested).not.toHaveProperty('mode');
      const nested = exported.nested as { directory: FileSystemTree };
      expect(nested.directory['payload.bin']).toMatchObject({ mode: 0o755 });
      expect(nested.directory['payload-link']).not.toHaveProperty('mode');

      const mounted = new VirtualFileSystem('/home/mounted');
      if (format === 'json') {
        mounted.mount(exported, '/home/mounted');
      } else {
        mounted.mountArchive(source.exportArchive('/home/source', format), '/home/mounted');
      }

      expect(mounted.statSync('/home/mounted/nested/payload.bin').mode & 0o7777).toBe(0o755);
      expect(mounted.statSync('/home/mounted/empty').mode & 0o7777).toBe(0o700);
      expect(mounted.statSync('/home/mounted/nested').mode & 0o7777).toBe(0o755);
      expect(mounted.exportTree('/home/mounted')).toEqual(exported);
    }
  );

  test('mounts a tree mode exactly and rejects one that is not permission bits', () => {
    const fileSystem = new VirtualFileSystem('/home/project');
    fileSystem.mount({ open: { file: { contents: 'x' }, mode: 0o777 } });
    expect(fileSystem.statSync('/home/project/open').mode & 0o7777).toBe(0o777);

    for (const mode of [0o10000, -1, 1.5]) {
      expect(() => fileSystem.mount({ bad: { file: { contents: 'x' }, mode } })).toThrow(
        expect.objectContaining({ code: 'INVALID_ARGUMENT' })
      );
    }
  });

  test('rejects unsupported and malformed binary snapshots without mutating the VFS', () => {
    const fileSystem = new VirtualFileSystem('/home/project');
    fileSystem.writeFileSync('/home/project/preserved.txt', 'preserved');

    expect(() => fileSystem.mountArchive(new Uint8Array([1, 2, 3]), '/home/project')).toThrow(
      'Unsupported binary filesystem snapshot'
    );
    expect(fileSystem.readText('/home/project/preserved.txt')).toBe('preserved');
    expect(fileSystem.readdirSync('/home/project')).toEqual(['preserved.txt']);
  });
});
