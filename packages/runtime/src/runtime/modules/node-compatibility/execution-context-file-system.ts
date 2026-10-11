import type { InlineNodeEntry } from '../process-execution';
import {
  INLINE_NODE_MODULE_ENTRY,
  type InlineNodeModuleEntry,
  type ModuleAccess
} from '../module-execution-engine';
import type {
  AsyncVirtualFileSystemClient,
  DirentLike,
  FileStatLike,
  RuntimeVirtualFileSystemClient,
  SynchronousVirtualFileSystemClient,
  VfsWriteFileOptions
} from '../virtual-file-system';
import { normalizePath } from '../virtual-file-system';

export interface ExecutionContextFileSystem
  extends RuntimeVirtualFileSystemClient {
  chmod(path: string, mode: number): Promise<void>;
  chmodSync(path: string, mode: number): void;
  closeFile(id: number): Promise<void>;
  closeFileSync(id: number): void;
  /** Present when the client can report committed revisions for module resolution caching. */
  readonly commitJournal?: ModuleAccess['commitJournal'];
  exists(path: string): boolean;
  existsSync?(path: string): boolean;
  isDirectory(path: string): boolean;
  isFile(path: string): boolean;
  linkSync(existingPath: string, newPath: string): void;
  lstatSync(path: string): FileStatLike;
  mkdirSync(path: string, options?: { readonly recursive?: boolean; readonly mode?: number }): void;
  openFile(path: string, options: OpenFileOptions): Promise<number>;
  openFileSync(path: string, options: OpenFileOptions): number;
  readOpenFile(id: number, length: number, position?: number): Promise<Uint8Array>;
  readOpenFileSync(id: number, length: number, position?: number): Uint8Array;
  readFileSync(path: string): Uint8Array;
  readFileSliceSync(path: string, offset: number, length: number): Uint8Array;
  readText(path: string): string;
  readdirSync(path: string, options?: { readonly withFileTypes?: boolean }): Array<string | DirentLike>;
  readlinkSync(path: string): string;
  realpathSync(path: string): string;
  renameSync(oldPath: string, newPath: string): void;
  rmSync(path: string, options?: { readonly recursive?: boolean; readonly force?: boolean }): void;
  statSync(path: string): FileStatLike;
  statOpenFile(id: number): Promise<FileStatLike>;
  statOpenFileSync(id: number): FileStatLike;
  symlinkSync(target: string, path: string): void;
  utimesSync(path: string, mtimeMs: number): void;
  writeFileSync(path: string, data: string | Uint8Array, options?: VfsWriteFileOptions): void;
  writeOpenFile(id: number, data: Uint8Array, position?: number): Promise<number>;
  writeOpenFileSync(id: number, data: Uint8Array, position?: number): number;
}

type OpenFileOptions = {
  readonly append: boolean;
  readonly readable: boolean;
  readonly writable: boolean;
};

export type ProjectedInlineNodeEntry = Readonly<{
  args: readonly string[];
  path: string;
  fileSystem: ExecutionContextFileSystem;
}>;

export function projectInlineNodeEntry(
  fileSystem: ExecutionContextFileSystem,
  cwd: string,
  pid: number,
  entry: InlineNodeEntry
): ProjectedInlineNodeEntry {
  const extension = entry.inputType === 'module' ? 'mjs' : 'cjs';
  const path = normalizePath(`.mimic-inline-${pid}.${extension}`, cwd);
  const moduleEntry: InlineNodeModuleEntry = Object.freeze({
    source: entry.source,
    execArgv: entry.execArgv,
    print: entry.print === true
  });
  const bytes = new TextEncoder().encode(entry.source);
  const projected = new Proxy(fileSystem, {
    get(target, property) {
      if (property === INLINE_NODE_MODULE_ENTRY) {
        return (candidate: string) => candidate === path ? moduleEntry : undefined;
      }
      if (property === 'isFile' || property === 'exists') {
        return (candidate: string) => candidate === path || target[property](candidate);
      }
      if (property === 'readText') {
        return (candidate: string) => candidate === path ? entry.source : target.readText(candidate);
      }
      if (property === 'readFileSync') {
        return (candidate: string) => candidate === path ? bytes.slice() : target.readFileSync(candidate);
      }
      if (property === 'readFileSliceSync') {
        return (candidate: string, offset: number, length: number) =>
          candidate === path
            ? bytes.slice(offset, offset + length)
            : target.readFileSliceSync(candidate, offset, length);
      }
      if (property === 'readFile') {
        return (candidate: string, encoding?: 'utf8' | null) =>
          candidate === path
            ? Promise.resolve(encoding === 'utf8' ? entry.source : bytes.slice())
            : encoding === 'utf8'
              ? target.readFile(candidate, 'utf8')
              : target.readFile(candidate);
      }
      if (property === 'realpathSync') {
        return (candidate: string) => candidate === path ? path : target.realpathSync(candidate);
      }
      if (property === 'writeFile') {
        return (candidate: string, data: string | Uint8Array, options?: VfsWriteFileOptions) =>
          candidate === path
            ? Promise.reject(readOnlyEntryError(path))
            : target.writeFile(candidate, data, options);
      }
      if (property === 'writeFileSync') {
        return (candidate: string, data: string | Uint8Array, options?: VfsWriteFileOptions) => {
          if (candidate === path) throw readOnlyEntryError(path);
          return target.writeFileSync(candidate, data, options);
        };
      }
      if (property === 'rm') {
        return (candidate: string, options?: { recursive?: boolean; force?: boolean }) =>
          candidate === path ? Promise.reject(readOnlyEntryError(path)) : target.rm(candidate, options);
      }
      if (property === 'rmSync') {
        return (candidate: string, options?: { recursive?: boolean; force?: boolean }) => {
          if (candidate === path) throw readOnlyEntryError(path);
          return target.rmSync(candidate, options);
        };
      }
      if (property === 'rename' || property === 'renameSync') {
        return (from: string, to: string) => {
          if (from === path || to === path) throw readOnlyEntryError(path);
          return target[property](from, to);
        };
      }
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      return value.bind(target);
    }
  }) as ExecutionContextFileSystem;

  return Object.freeze({
    // The terminator keeps application arguments that look like options out of the option table.
    args: Object.freeze([...entry.preloadArgv, '--', path, ...entry.applicationArgs]),
    path,
    fileSystem: projected
  });
}

export function requireExecutionContextFileSystem(
  fileSystem: RuntimeVirtualFileSystemClient
): ExecutionContextFileSystem {
  const candidate = fileSystem as RuntimeVirtualFileSystemClient &
    Partial<ExecutionContextFileSystem>;
  for (const method of [
    'exists',
    'isDirectory',
    'isFile',
    'linkSync',
    'lstatSync',
    'mkdirSync',
    'readFileSync',
    'readFileSliceSync',
    'readText',
    'readdirSync',
    'readlinkSync',
    'realpathSync',
    'renameSync',
    'rmSync',
    'statSync',
    'symlinkSync',
    'writeFileSync'
  ] as const) {
    if (typeof candidate[method] !== 'function') {
      throw new Error(
        `Node execution requires the authoritative synchronous VFS client method ${method}.`
      );
    }
  }
  return candidate as ExecutionContextFileSystem;
}

function readOnlyEntryError(path: string): Error {
  return Object.assign(new Error(`Inline Node entry is immutable: ${path}`), { code: 'EROFS' });
}

/**
 * The file system of a process worker's Execution Context, from its
 * asynchronous Virtual File System client and its synchronous mailbox client.
 */
export function combineExecutionFileSystem(
  asynchronous: AsyncVirtualFileSystemClient,
  synchronous: SynchronousVirtualFileSystemClient
): ExecutionContextFileSystem {
  const local = {
    commitJournal: {
      get revision() {
        return synchronous.revision;
      },
      readCommitJournal: (afterRevision: number) => synchronous.readCommitJournalSync(afterRevision)
    },
    readText: (path: string) => synchronous.readFileSync(path, 'utf8'),
    exists: (path: string) => synchronous.existsSync(path),
    isFile: (path: string) => synchronous.existsSync(path) && synchronous.statSync(path).isFile(),
    isDirectory: (path: string) =>
      synchronous.existsSync(path) && synchronous.statSync(path).isDirectory()
  };
  return new Proxy(local, {
    get(target, property) {
      const source = property in target
        ? target
        : property in asynchronous
          ? asynchronous
          : synchronous;
      const value = Reflect.get(source, property);
      return typeof value === 'function' ? value.bind(source) : value;
    }
  }) as ExecutionContextFileSystem;
}
