import type { CoreUtilityFileStatus, CoreUtilityFileSystem } from '../process-execution';
import type { FileStatLike, RuntimeVirtualFileSystemClient } from '../virtual-file-system';

function fileStatus(stat: FileStatLike): CoreUtilityFileStatus {
  const kind = stat.isDirectory()
    ? 'directory'
    : stat.isSymbolicLink()
      ? 'symlink'
      : stat.isFile()
        ? 'file'
        : 'other';
  return {
    kind,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mode: stat.mode ?? (kind === 'directory' ? 0o755 : 0o644)
  };
}

/** Projects the asynchronous Virtual File System client onto the core utilities' filesystem port. */
export function asyncCoreUtilityFileSystem(fs: RuntimeVirtualFileSystemClient): CoreUtilityFileSystem {
  return {
    async stat(path, options) {
      try {
        return fileStatus(await (options?.followSymlinks === false ? fs.lstat(path) : fs.stat(path)));
      } catch {
        return undefined;
      }
    },
    readFile: (path) => fs.readFile(path),
    writeFile: (path, data) => fs.writeFile(path, data),
    readDirectory: async (path) => (await fs.readdir(path)) as string[],
    makeDirectory: (path, options) => fs.mkdir(path, options),
    remove: (path, options) => fs.rm(path, options),
    rename: (from, to) => fs.rename(from, to),
    setModifiedTime: (path, mtimeMs) => fs.utimes(path, mtimeMs),
    readLink: (path) => fs.readlink(path),
    symlink: (target, path) => fs.symlink(target, path)
  };
}
