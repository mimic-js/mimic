import { unzipSync, zipSync } from 'fflate';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { DEFAULT_ZIP_LIMITS, VirtualFileSystem } from './virtual-file-system';

vi.mock('fflate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fflate')>();
  return { ...actual, unzipSync: vi.fn(actual.unzipSync) };
});

const WORKDIR = '/home/project';
const inflatingCalls = () => vi.mocked(unzipSync).mock.calls.filter(([, options]) => !options?.filter);
const cachedArchives = (fileSystem: VirtualFileSystem) =>
  [...(fileSystem as unknown as { zipArchives: Map<string, unknown> }).zipArchives.keys()];

describe('Virtual File System ZIP paths', () => {
  beforeEach(() => {
    vi.mocked(unzipSync).mockClear();
  });

  test('bounds inflated archive size, entry count and the archive cache by default', () => {
    expect(DEFAULT_ZIP_LIMITS).toEqual({
      maxInflatedBytes: 256 * 1024 * 1024,
      maxEntries: 65_536,
      maxCachedBytes: 256 * 1024 * 1024
    });
    expect(() => new VirtualFileSystem(WORKDIR, { zipLimits: { maxEntries: -1 } })).toThrow(RangeError);
  });

  test('refuses an archive whose central directory claims more than the inflated-size bound without inflating it', () => {
    const fileSystem = new VirtualFileSystem(WORKDIR, { zipLimits: { maxInflatedBytes: 64 * 1024 } });
    // A megabyte of zeros deflates to about a kilobyte: the bomb shape.
    const archive = zipSync({ 'big.txt': new Uint8Array(1024 * 1024), 'small.txt': new TextEncoder().encode('ok') });
    expect(archive.byteLength).toBeLessThan(8 * 1024);
    fileSystem.writeFileSync(`${WORKDIR}/bomb.zip`, archive);

    expect(() => fileSystem.readFileSync(`${WORKDIR}/bomb.zip/small.txt`)).toThrowError(
      expect.objectContaining({ code: 'ARCHIVE_TOO_LARGE', message: expect.stringContaining('would inflate to more than 65536 bytes') })
    );
    expect(() => fileSystem.statSync(`${WORKDIR}/bomb.zip/small.txt`)).toThrowError(
      expect.objectContaining({ code: 'ARCHIVE_TOO_LARGE' })
    );
    expect(inflatingCalls()).toEqual([]);
    expect(cachedArchives(fileSystem)).toEqual([]);
    // Only the path through the archive fails; the archive file and the rest of the tree stay readable.
    expect(fileSystem.readFileSync(`${WORKDIR}/bomb.zip`)).toEqual(archive);
    expect(fileSystem.exists(`${WORKDIR}/bomb.zip/small.txt`)).toBe(false);
  });

  test('refuses an archive with more entries than the bound before inflating it', () => {
    const fileSystem = new VirtualFileSystem(WORKDIR, { zipLimits: { maxEntries: 2 } });
    const text = new TextEncoder();
    fileSystem.writeFileSync(
      `${WORKDIR}/many.zip`,
      zipSync({ 'a.txt': text.encode('a'), 'b.txt': text.encode('b'), 'c.txt': text.encode('c') })
    );

    expect(() => fileSystem.readFileSync(`${WORKDIR}/many.zip/a.txt`)).toThrowError(
      expect.objectContaining({ code: 'ARCHIVE_TOO_LARGE', message: expect.stringContaining('more than 2 entries') })
    );
    expect(inflatingCalls()).toEqual([]);

    fileSystem.writeFileSync(`${WORKDIR}/two.zip`, zipSync({ 'a.txt': text.encode('a'), 'b.txt': text.encode('b') }));
    expect(fileSystem.readText(`${WORKDIR}/two.zip/b.txt`)).toBe('b');
    expect(inflatingCalls()).toHaveLength(1);
  });

  test('keeps inflated archives up to the cache bound and evicts the least recently read first', () => {
    const fileSystem = new VirtualFileSystem(WORKDIR, { zipLimits: { maxCachedBytes: 3000 } });
    const entry = (size: number, fill: number) => new Uint8Array(size).fill(fill);
    fileSystem.writeFileSync(`${WORKDIR}/a.zip`, zipSync({ 'a.bin': entry(1000, 1) }));
    fileSystem.writeFileSync(`${WORKDIR}/b.zip`, zipSync({ 'b.bin': entry(1500, 2) }));
    fileSystem.writeFileSync(`${WORKDIR}/c.zip`, zipSync({ 'c.bin': entry(1000, 3) }));
    fileSystem.writeFileSync(`${WORKDIR}/huge.zip`, zipSync({ 'huge.bin': entry(4000, 4) }));

    expect(fileSystem.readFileSync(`${WORKDIR}/a.zip/a.bin`)).toEqual(entry(1000, 1));
    expect(fileSystem.readFileSync(`${WORKDIR}/b.zip/b.bin`)).toEqual(entry(1500, 2));
    expect(cachedArchives(fileSystem)).toEqual([`${WORKDIR}/a.zip`, `${WORKDIR}/b.zip`]);
    // Reading `a` again makes `b` the least recently read, so `c` evicts `b`.
    expect(fileSystem.readFileSync(`${WORKDIR}/a.zip/a.bin`)).toEqual(entry(1000, 1));
    expect(inflatingCalls()).toHaveLength(2);
    expect(fileSystem.readFileSync(`${WORKDIR}/c.zip/c.bin`)).toEqual(entry(1000, 3));
    expect(cachedArchives(fileSystem)).toEqual([`${WORKDIR}/a.zip`, `${WORKDIR}/c.zip`]);
    // An archive larger than the whole cache is served but not kept.
    expect(fileSystem.readFileSync(`${WORKDIR}/huge.zip/huge.bin`)).toEqual(entry(4000, 4));
    expect(cachedArchives(fileSystem)).toEqual([`${WORKDIR}/a.zip`, `${WORKDIR}/c.zip`]);
    // Rewriting an archive drops its cached entries.
    fileSystem.writeFileSync(`${WORKDIR}/a.zip`, zipSync({ 'a.bin': entry(10, 9) }));
    expect(cachedArchives(fileSystem)).toEqual([`${WORKDIR}/c.zip`]);
    expect(fileSystem.readFileSync(`${WORKDIR}/a.zip/a.bin`)).toEqual(entry(10, 9));
    expect(cachedArchives(fileSystem)).toEqual([`${WORKDIR}/c.zip`, `${WORKDIR}/a.zip`]);
  });
});
