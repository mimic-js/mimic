import { describe, expect, it } from 'vitest';

import {
  VirtualFileSystem
} from '../../src/runtime/modules/virtual-file-system/virtual-file-system';

describe('VirtualFileSystem hard links', () => {
  it('shares inode identity and file contents until the final path is removed', async () => {
    const fs = new VirtualFileSystem('/home/project');
    await fs.writeFile('/home/project/source.txt', 'first');
    await fs.link('/home/project/source.txt', '/home/project/linked.txt');

    expect((await fs.stat('/home/project/source.txt')).ino).toBeGreaterThan(0);
    expect((await fs.stat('/home/project/linked.txt')).ino).toBe((await fs.stat('/home/project/source.txt')).ino);

    await fs.writeFile('/home/project/linked.txt', 'second');
    expect(await fs.readFile('/home/project/source.txt', 'utf8')).toBe('second');

    await fs.rm('/home/project/source.txt');
    expect(await fs.readFile('/home/project/linked.txt', 'utf8')).toBe('second');
  });

  it('returns a copy of the bytes linked paths share', async () => {
    const fs = new VirtualFileSystem('/home/project');
    await fs.writeFile('/home/project/source.txt', 'original');
    await fs.link('/home/project/source.txt', '/home/project/linked.txt');

    const externalRead = fs.readFileSync('/home/project/source.txt');
    externalRead[0] = 0;
    expect(await fs.readFile('/home/project/source.txt', 'utf8')).toBe('original');
    expect(await fs.readFile('/home/project/linked.txt', 'utf8')).toBe('original');
  });
});
