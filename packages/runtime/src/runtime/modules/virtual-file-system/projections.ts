import type { DirentLike, FileStatLike, VfsDirentData, VfsStatData } from './types';

export function direntFromData(entry: VfsDirentData): DirentLike {
  return {
    name: entry.name,
    isFile: () => entry.kind === 'file',
    isDirectory: () => entry.kind === 'directory',
    isSymbolicLink: () => entry.kind === 'symlink'
  };
}

export function statFromData(stat: VfsStatData): FileStatLike {
  return {
    size: stat.size,
    ino: stat.ino,
    mode: stat.mode,
    nlink: stat.nlink,
    ctime: new Date(stat.ctimeMs),
    mtime: new Date(stat.mtimeMs),
    mtimeMs: stat.mtimeMs,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isFile: () => stat.kind === 'file',
    isDirectory: () => stat.kind === 'directory',
    isSocket: () => false,
    isSymbolicLink: () => stat.kind === 'symlink'
  };
}

export function statDataFrom(stat: FileStatLike): VfsStatData {
  return {
    size: stat.size,
    ino: stat.ino,
    mode: stat.mode ?? 0,
    nlink: stat.nlink ?? 1,
    ctimeMs: stat.ctime.getTime(),
    mtimeMs: stat.mtimeMs,
    kind: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'symlink'
  };
}
