import type { ProcessFileSystemClient } from '../src/runtime/modules/process-execution/file-system-ports';
import { VirtualFileSystem } from '../src/runtime/modules/virtual-file-system/virtual-file-system';

export { VirtualFileSystem };

/** The asynchronous filesystem a Runtime Program sees, over an in-memory Virtual File System. */
export function memoryProcessFileSystem(vfs: VirtualFileSystem): ProcessFileSystemClient {
  async function readFile(path: string, encoding: 'utf8'): Promise<string>;
  async function readFile(path: string, encoding?: null): Promise<Uint8Array>;
  async function readFile(path: string, encoding?: 'utf8' | null): Promise<string | Uint8Array> {
    const data = vfs.readFileSync(path);
    return encoding === 'utf8' ? new TextDecoder().decode(data) : data;
  }
  return {
    exists: async (path) => vfs.existsSync(path),
    mkdir: async (path, options) => vfs.mkdirSync(path, options),
    mount: async (tree, mountPoint) => vfs.mount(tree, mountPoint),
    readFile,
    readdir: async (path) => vfs.readdirSync(path),
    realpath: async (path) => vfs.realpathSync(path),
    rm: async (path, options) => vfs.rmSync(path, options),
    stat: async (path) => vfs.statSync(path),
    writeFile: async (path, data) => vfs.writeFileSync(path, data)
  };
}
