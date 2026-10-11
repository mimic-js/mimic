import { expect, test } from 'vitest';

import { decodeFileSystemArchive, encodeFileSystemArchive } from './archive';
import { decodeTarArchive, encodeTarArchive, isTarArchive } from './tar-archive';
import { type FileSystemArchiveEntry } from './archive-entry';

test('encodes deterministic ustar entries and round-trips nested binary files, empty directories, and symlinks', () => {
  const entries: readonly FileSystemArchiveEntry[] = [
    { path: 'empty', kind: 'directory', mtimeMs: 1_700_000_002_999 },
    { path: 'nested/data.bin', kind: 'file', data: new Uint8Array([0, 255, 1, 128, 10]), mtimeMs: 1_700_000_000_123 },
    { path: 'nested/link', kind: 'symlink', target: '../empty', mtimeMs: 1_700_000_001_456 }
  ];

  const archive = encodeTarArchive(entries);
  const reorderedArchive = encodeTarArchive([...entries].reverse());

  expect(archive).toEqual(reorderedArchive);
  expect(new TextDecoder().decode(archive.subarray(257, 265))).toBe('ustar\0' + '00');
  expect(isTarArchive(archive)).toBe(true);
  expect(decodeTarArchive(archive)).toEqual([
    { path: 'empty', kind: 'directory', mtimeMs: 1_700_000_002_000 },
    { path: 'nested/data.bin', kind: 'file', data: new Uint8Array([0, 255, 1, 128, 10]), mtimeMs: 1_700_000_000_000 },
    { path: 'nested/link', kind: 'symlink', target: '../empty', mtimeMs: 1_700_000_001_000 }
  ]);
});

test('writes and round-trips non-default file and directory modes', () => {
  const archive = encodeTarArchive([
    { path: 'bin', kind: 'directory', mtimeMs: 0, mode: 0o700 },
    { path: 'bin/run', kind: 'file', data: new Uint8Array([1]), mtimeMs: 0, mode: 0o755 },
    { path: 'bin/plain', kind: 'file', data: new Uint8Array([2]), mtimeMs: 0 }
  ]);

  expect(new TextDecoder().decode(archive.subarray(100, 107))).toBe('0000700');
  expect(decodeTarArchive(archive)).toEqual([
    { path: 'bin', kind: 'directory', mtimeMs: 0, mode: 0o700 },
    { path: 'bin/plain', kind: 'file', data: new Uint8Array([2]), mtimeMs: 0 },
    { path: 'bin/run', kind: 'file', data: new Uint8Array([1]), mtimeMs: 0, mode: 0o755 }
  ]);
  expect(decodeTarArchive(archive)[1]).not.toHaveProperty('mode');
  expect(() => encodeTarArchive([
    { path: 'bad', kind: 'file', data: new Uint8Array(), mtimeMs: 0, mode: 0o10000 }
  ])).toThrow(/mode/);
});

test('rejects malformed, truncated, checksum-invalid, and traversal TAR entries', () => {
  const archive = encodeTarArchive([
    { path: 'safe.txt', kind: 'file', data: new Uint8Array([1]), mtimeMs: 0 }
  ]);
  const checksumInvalid = archive.slice();
  checksumInvalid[0] ^= 1;

  expect(() => decodeTarArchive(archive.subarray(0, archive.byteLength - 1))).toThrow();
  expect(() => decodeTarArchive(checksumInvalid)).toThrow();
  expect(isTarArchive(checksumInvalid)).toBe(false);

  const traversal = archive.slice();
  new TextEncoder().encodeInto('../escape.txt', traversal.subarray(0, 100));
  setChecksum(traversal, 0);
  expect(() => decodeTarArchive(traversal)).toThrow();
});

function setChecksum(bytes: Uint8Array, headerOffset: number): void {
  for (let index = 148; index < 156; index += 1) bytes[headerOffset + index] = 0x20;
  let checksum = 0;
  for (let index = 0; index < 512; index += 1) checksum += bytes[headerOffset + index]!;
  const field = `${checksum.toString(8).padStart(6, '0')}\0 `;
  new TextEncoder().encodeInto(field, bytes.subarray(headerOffset + 148, headerOffset + 156));
}

test('round-trips a tree whose names are also members of Object.prototype', () => {
  const tree = {
    constructor: { directory: { 'index.js': { file: { contents: 'a' } } } },
    toString: { file: { contents: 'b' } },
    nested: { directory: { constructor: { directory: { valueOf: { file: { contents: 'c' } } } } } }
  };

  const mounted = decodeFileSystemArchive(encodeFileSystemArchive(tree, 'tar'));

  expect(Object.keys(mounted)).toEqual(['constructor', 'nested', 'toString']);
  const constructorDirectory = mounted.constructor as unknown as { directory: Record<string, unknown> };
  expect(Object.keys(constructorDirectory.directory)).toEqual(['index.js']);
  const nested = mounted.nested as { directory: Record<string, { directory: Record<string, unknown> }> };
  expect(Object.keys(nested.directory.constructor.directory)).toEqual(['valueOf']);
});

test('carries paths and symlink targets longer than a ustar header in pax extended headers', () => {
  const longDirectory = `node_modules/${'nested-package/'.repeat(12)}lib`;
  const longTarget = `../${'nested-package/'.repeat(9)}bin/cli-with-a-long-name.js`;
  const entries = [
    { path: `${longDirectory}/index.js`, kind: 'file' as const, data: Uint8Array.of(1, 2, 3), mtimeMs: 1_000 },
    { path: 'node_modules/.bin/cli', kind: 'symlink' as const, target: longTarget, mtimeMs: 1_000 },
    { path: `${'é'.repeat(120)}.txt`, kind: 'file' as const, data: Uint8Array.of(4), mtimeMs: 1_000 }
  ];

  const decoded = decodeTarArchive(encodeTarArchive(entries));

  expect(decoded).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: `${longDirectory}/index.js`, data: Uint8Array.of(1, 2, 3) }),
      expect.objectContaining({ path: 'node_modules/.bin/cli', kind: 'symlink', target: longTarget }),
      expect.objectContaining({ path: `${'é'.repeat(120)}.txt` })
    ])
  );
  expect(decoded).toHaveLength(3);
});
