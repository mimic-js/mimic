import { expect, test } from 'vitest';

import { decodeZipArchive, encodeZipArchive, isZipArchive } from './zip-archive';
import { type FileSystemArchiveEntry } from './archive-entry';

test('ZIP archive codec deterministically round-trips nested binary files, empty directories, and symlinks', () => {
  const entries: readonly FileSystemArchiveEntry[] = [
    {
      path: 'nested/link',
      kind: 'symlink',
      target: '../bin.dat',
      mtimeMs: 1_704_067_201_999
    },
    {
      path: 'nested/empty',
      kind: 'directory',
      mtimeMs: 1_704_067_204_999
    },
    {
      path: 'nested/bin.dat',
      kind: 'file',
      data: new Uint8Array([0, 255, 128, 10, 13, 42]),
      mtimeMs: 1_704_067_203_999
    }
  ];

  const archive = encodeZipArchive(entries);
  const sameArchive = encodeZipArchive(entries);

  expect(archive).toEqual(sameArchive);
  expect(isZipArchive(archive)).toBe(true);
  expect(decodeZipArchive(archive)).toEqual([
    {
      path: 'nested/bin.dat',
      kind: 'file',
      data: new Uint8Array([0, 255, 128, 10, 13, 42]),
      mtimeMs: 1_704_067_202_000
    },
    {
      path: 'nested/empty',
      kind: 'directory',
      mtimeMs: 1_704_067_204_000
    },
    {
      path: 'nested/link',
      kind: 'symlink',
      target: '../bin.dat',
      mtimeMs: 1_704_067_200_000
    }
  ]);
});

test('ZIP archive codec writes and round-trips non-default file and directory modes', () => {
  const mtimeMs = 1_704_067_200_000;
  const archive = encodeZipArchive([
    { path: 'bin', kind: 'directory', mtimeMs, mode: 0o700 },
    { path: 'bin/run', kind: 'file', data: new Uint8Array([1]), mtimeMs, mode: 0o755 },
    { path: 'bin/plain', kind: 'file', data: new Uint8Array([2]), mtimeMs }
  ]);

  expect(encodeZipArchive([
    { path: 'bin/plain', kind: 'file', data: new Uint8Array([2]), mtimeMs },
    { path: 'bin/run', kind: 'file', data: new Uint8Array([1]), mtimeMs, mode: 0o755 },
    { path: 'bin', kind: 'directory', mtimeMs, mode: 0o700 }
  ])).toEqual(archive);
  const decoded = decodeZipArchive(archive);
  expect(decoded).toEqual([
    { path: 'bin', kind: 'directory', mtimeMs, mode: 0o700 },
    { path: 'bin/plain', kind: 'file', data: new Uint8Array([2]), mtimeMs },
    { path: 'bin/run', kind: 'file', data: new Uint8Array([1]), mtimeMs, mode: 0o755 }
  ]);
  expect(decoded[1]).not.toHaveProperty('mode');
  expect(() => encodeZipArchive([
    { path: 'bad', kind: 'file', data: new Uint8Array(), mtimeMs, mode: -1 }
  ])).toThrow(/mode/);
});

test('ZIP archive codec rejects malformed archives and traversal entries', () => {
  const archive = encodeZipArchive([
    { path: 'safe', kind: 'file', data: new Uint8Array([1]), mtimeMs: 1_704_067_200_000 }
  ]);
  const traversal = archive.slice();
  traversal.set(new TextEncoder().encode('../x'), 30);
  const centralDirectory = traversal.findIndex((_, index) =>
    traversal[index] === 80 &&
    traversal[index + 1] === 75 &&
    traversal[index + 2] === 1 &&
    traversal[index + 3] === 2
  );
  traversal.set(new TextEncoder().encode('../x'), centralDirectory + 46);

  expect(isZipArchive(new Uint8Array([80, 75, 3, 4]))).toBe(false);
  expect(() => decodeZipArchive(new Uint8Array([80, 75, 3, 4]))).toThrow(/invalid ZIP archive/i);
  expect(() => decodeZipArchive(traversal)).toThrow(/unsafe ZIP entry path/i);
  expect(() => encodeZipArchive([
    { path: '../outside', kind: 'file', data: new Uint8Array(), mtimeMs: 1_704_067_200_000 }
  ])).toThrow(/unsafe ZIP entry path/i);
});
