import type {
  DirentLike,
  FileSystemArchiveFormat,
  FileStatLike,
  FileSystemAPI,
  FileSystemTree,
  VfsCommitInvalidation,
  VfsCommitOperation,
  VfsWriteFileOptions
} from './types';
import { decodeFileSystemArchive, encodeFileSystemArchive } from './archive';
import { basename, dirname, joinPath, normalizePath, stripLeadingSlash } from './path';
import { unzipSync } from 'fflate';

type FileContents = {
  readonly data: Uint8Array;
  /** Growable backing store shared by successive append-only snapshots of this inode. */
  readonly store?: AppendStore;
  readonly snapshotIdentity: object;
  readonly ino: number;
  readonly mode: number;
  readonly mtimeMs: number;
  /** Every namespace path linked to this inode. */
  readonly paths: readonly string[];
};

type AppendStore = {
  readonly buffer: Uint8Array;
  used: number;
};

type OpenFileDescription = {
  append: boolean;
  ino: number;
  offset: number;
  readable: boolean;
  writable: boolean;
};

export type VfsOpenFileOptions = {
  readonly append: boolean;
  readonly readable: boolean;
  readonly writable: boolean;
};

export type VfsCommitApplication =
  | { readonly ok: true; readonly invalidations: VfsCommitInvalidation[] }
  | {
      readonly ok: false;
      readonly error: unknown;
      readonly operationIndex: number;
      readonly operationType: VfsCommitOperation['type'];
    };

type FileNode = {
  kind: 'file';
  ino: number;
};

type DirectoryNode = {
  kind: 'dir';
  entries: Set<string>;
  ino: number;
  mode: number;
  mtimeMs: number;
};

type SymlinkNode = {
  kind: 'symlink';
  ino: number;
  target: string;
  mtimeMs: number;
};

type VfsNode = FileNode | DirectoryNode | SymlinkNode;

type VfsError = Error & { code?: string };

export type VirtualFileSystemZipLimits = {
  /** Uncompressed bytes an archive's central directory may claim in total before a path through it is refused. */
  readonly maxInflatedBytes: number;
  /** Entries an archive may hold before a path through it is refused. */
  readonly maxEntries: number;
  /** Inflated bytes the archive cache keeps across archives; the least recently read archive leaves first. */
  readonly maxCachedBytes: number;
};

export type VirtualFileSystemOptions = {
  readonly zipLimits?: Partial<VirtualFileSystemZipLimits>;
};

type CachedZipArchive = {
  readonly mtimeMs: number;
  readonly entries: Record<string, Uint8Array>;
  /** Inflated bytes of every entry, what the cache bound counts. */
  readonly bytes: number;
};
type ZipPathNode =
  | { kind: 'file'; data: Uint8Array; mtimeMs: number }
  | { kind: 'dir'; entries: string[]; mtimeMs: number };
type InvalidationNote = (path: string, scope: VfsCommitInvalidation['scope']) => void;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const UMASK = 0o022;
const DEFAULT_FILE_MODE = 0o666 & ~UMASK;
const DEFAULT_DIRECTORY_MODE = 0o777 & ~UMASK;
const SYMLINK_MODE = 0o777;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const MAX_APPEND_HEADROOM = 8 * 1024 * 1024;
// A mount that touches more entries than this is journaled as one subtree.
const MOUNT_INVALIDATION_LIMIT = 512;
/**
 * A path through `x.zip/...` inflates the whole archive inside the Runtime
 * Host worker that owns the VFS, so one archive whose kilobytes of compressed
 * bytes claim gigabytes would exhaust that worker and end every process. The
 * central directory is read first, inflating nothing, and an archive beyond
 * these bounds fails for that path alone. 256 MiB exceeds any package archive
 * read this way; 65,536 entries is the classic ZIP entry count; the cache
 * holds at most as much inflated data as one archive may claim.
 */
export const DEFAULT_ZIP_LIMITS: VirtualFileSystemZipLimits = Object.freeze({
  maxInflatedBytes: 256 * 1024 * 1024,
  maxEntries: 65_536,
  maxCachedBytes: 256 * 1024 * 1024
});

export class VirtualFileSystem implements FileSystemAPI {
  private nextInode = 1;
  private nextOpenFileDescription = 1;
  private readonly nodes = new Map<string, VfsNode>();
  private readonly inodes = new Map<number, FileContents>();
  /**
   * Restores what a rejected commit changed, newest first. A mount that meets
   * a conflicting entry part way through its tree is the operation that needs it.
   */
  private undo: Array<() => void> | undefined;
  private note: InvalidationNote | undefined;
  private adoptData = false;
  private readonly openFileDescriptions = new Map<number, OpenFileDescription>();
  /** Inflated archives by path, least recently read first. */
  private readonly zipArchives = new Map<string, CachedZipArchive>();
  private zipCachedBytes = 0;
  private readonly zipLimits: VirtualFileSystemZipLimits;
  private readonly zipSnapshotIdentities = new WeakMap<Uint8Array, object>();

  constructor(private readonly workdir: string, options: VirtualFileSystemOptions = {}) {
    this.zipLimits = resolveZipLimits(options.zipLimits);
    this.nodes.set('/', {
      kind: 'dir',
      entries: new Set(),
      ino: this.nextInode++,
      mode: DEFAULT_DIRECTORY_MODE,
      mtimeMs: Date.now()
    });
    this.mkdirSync('/home', { recursive: true });
    this.mkdirSync(this.workdir, { recursive: true });
    this.mkdirSync('/tmp', { recursive: true });
  }

  async readFile(path: string, encoding: 'utf8'): Promise<string>;
  async readFile(path: string, encoding?: null): Promise<Uint8Array>;
  async readFile(path: string, encoding?: 'utf8' | null): Promise<string | Uint8Array> {
    return encoding === 'utf8'
      ? textDecoder.decode(this.readFileViewSync(path))
      : this.readFileSync(path);
  }

  readText(path: string): string {
    return textDecoder.decode(this.readFileViewSync(path));
  }

  readFileSync(path: string): Uint8Array {
    return this.readFileViewSync(path).slice();
  }

  /**
   * Returns the stored bytes without copying them. The caller must treat the
   * view as immutable and copy it before it leaves the authority.
   */
  readFileViewSync(path: string): Uint8Array {
    const normalized = this.resolvePath(path);
    const node = this.nodes.get(normalized);
    if (!node) {
      const zipNode = this.zipPathNode(normalized);
      if (!zipNode) throw vfsError('NOT_FOUND', `No such file: ${normalized}`);
      if (zipNode.kind !== 'file') throw vfsError('IS_DIRECTORY', `Path is a directory: ${normalized}`);
      return zipNode.data;
    }
    if (node.kind !== 'file') throw vfsError('IS_DIRECTORY', `Path is a directory: ${normalized}`);
    return this.fileContents(node).data;
  }

  readFileSliceSync(path: string, offset: number, length: number): Uint8Array {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw vfsError('INVALID_ARGUMENT', `Invalid file read offset for ${path}: ${offset}`);
    }
    if (!Number.isSafeInteger(length) || length < 0) {
      throw vfsError('INVALID_ARGUMENT', `Invalid file read length for ${path}: ${length}`);
    }
    return this.readFileViewSync(path).slice(offset, offset + length);
  }

  openFileDescriptionSync(path: string, options: VfsOpenFileOptions): number {
    const normalized = this.resolvePath(path);
    const node = this.nodes.get(normalized);
    if (!node) throw vfsError('NOT_FOUND', `No such file: ${normalized}`);
    if (node.kind !== 'file') throw vfsError('IS_DIRECTORY', `Path is a directory: ${normalized}`);
    const id = this.nextOpenFileDescription++;
    this.openFileDescriptions.set(id, {
      append: options.append,
      readable: options.readable,
      writable: options.writable,
      ino: node.ino,
      offset: options.append ? this.fileContents(node).data.byteLength : 0
    });
    return id;
  }

  async openFile(path: string, options: VfsOpenFileOptions): Promise<number> {
    return this.openFileDescriptionSync(path, options);
  }

  openFileSync(path: string, options: VfsOpenFileOptions): number {
    return this.openFileDescriptionSync(path, options);
  }

  closeFileDescriptionSync(id: number): void {
    const opened = this.openFileDescriptions.get(id);
    if (!opened) {
      throw vfsError('BAD_FILE_DESCRIPTOR', `Unknown open file description: ${id}`);
    }
    this.openFileDescriptions.delete(id);
    const contents = this.inodes.get(opened.ino);
    if (contents && contents.paths.length === 0 && !this.hasOpenFileDescription(opened.ino)) {
      this.deleteInode(opened.ino);
    }
  }

  async closeFile(id: number): Promise<void> {
    this.closeFileDescriptionSync(id);
  }

  closeFileSync(id: number): void {
    this.closeFileDescriptionSync(id);
  }

  /** What the file system currently holds, for leak witnesses. */
  usage(): { readonly openFileDescriptions: number; readonly inodes: number } {
    return { openFileDescriptions: this.openFileDescriptions.size, inodes: this.inodes.size };
  }

  readFileDescriptionSync(
    id: number,
    length: number,
    position?: number
  ): Uint8Array {
    const opened = this.requireOpenFileDescription(id);
    if (!opened.readable) {
      throw vfsError('BAD_FILE_DESCRIPTOR', `Open file description ${id} is not readable.`);
    }
    const offset = position ?? opened.offset;
    const data = this.openFileContents(opened).data.slice(offset, offset + length);
    if (position === undefined) opened.offset = offset + data.byteLength;
    return data;
  }

  async readOpenFile(id: number, length: number, position?: number): Promise<Uint8Array> {
    return this.readFileDescriptionSync(id, length, position);
  }

  readOpenFileSync(id: number, length: number, position?: number): Uint8Array {
    return this.readFileDescriptionSync(id, length, position);
  }

  writeFileDescriptionSync(
    id: number,
    data: Uint8Array,
    position?: number
  ): number {
    const opened = this.requireOpenFileDescription(id);
    if (!opened.writable) {
      throw vfsError('BAD_FILE_DESCRIPTOR', `Open file description ${id} is not writable.`);
    }
    const contents = this.openFileContents(opened);
    const size = contents.data.byteLength;
    const offset = opened.append ? size : position ?? opened.offset;
    let written: Pick<FileContents, 'data' | 'store'>;
    if (offset === size) {
      written = appendBytes(contents, data);
    } else {
      const next = new Uint8Array(Math.max(size, offset + data.byteLength));
      next.set(contents.data);
      next.set(data, offset);
      written = { data: next, store: undefined };
    }
    this.setInode(opened.ino, {
      ...contents,
      ...written,
      snapshotIdentity: Object.freeze({}),
      mtimeMs: Date.now()
    });
    if (opened.append || position === undefined) {
      const priorOffset = opened.offset;
      this.undo?.push(() => {
        opened.offset = priorOffset;
      });
      opened.offset = offset + data.byteLength;
    }
    for (const path of contents.paths) this.noteChange('path', path);
    return data.byteLength;
  }

  async writeOpenFile(id: number, data: Uint8Array, position?: number): Promise<number> {
    return this.writeFileDescriptionSync(id, data, position);
  }

  writeOpenFileSync(id: number, data: Uint8Array, position?: number): number {
    return this.writeFileDescriptionSync(id, data, position);
  }

  statFileDescriptionSync(id: number): FileStatLike {
    return statFromFile(this.openFileContents(this.requireOpenFileDescription(id)));
  }

  async statOpenFile(id: number): Promise<FileStatLike> {
    return this.statFileDescriptionSync(id);
  }

  statOpenFileSync(id: number): FileStatLike {
    return this.statFileDescriptionSync(id);
  }

  pathsForFileDescription(id: number): readonly string[] {
    return this.openFileContents(this.requireOpenFileDescription(id)).paths;
  }

  fileSnapshotIdentitySync(path: string): object {
    const normalized = this.resolvePath(path);
    const node = this.nodes.get(normalized);
    if (node?.kind === 'file') return this.fileContents(node).snapshotIdentity;
    if (node) throw vfsError('IS_DIRECTORY', `Path is a directory: ${normalized}`);
    const zipNode = this.zipPathNode(normalized);
    if (!zipNode) throw vfsError('NOT_FOUND', `No such file: ${normalized}`);
    if (zipNode.kind !== 'file') throw vfsError('IS_DIRECTORY', `Path is a directory: ${normalized}`);
    const existing = this.zipSnapshotIdentities.get(zipNode.data);
    if (existing) return existing;
    const identity = Object.freeze({});
    this.zipSnapshotIdentities.set(zipNode.data, identity);
    return identity;
  }

  async writeFile(
    path: string,
    data: string | Uint8Array,
    options?: VfsWriteFileOptions
  ): Promise<void> {
    this.writeFileSync(path, data, options);
  }

  writeFileSync(path: string, data: string | Uint8Array, options?: VfsWriteFileOptions): void {
    const requested = normalizePath(path, this.workdir);
    const normalized = this.resolvePath(path);
    const parent = dirname(normalized);
    const parentNode = this.nodes.get(parent);

    if (!parentNode) throw vfsError('NOT_FOUND', `Parent directory does not exist: ${parent}`);
    if (parentNode.kind !== 'dir') throw vfsError('NOT_DIRECTORY', `Parent is not a directory: ${parent}`);

    const existing = this.nodes.get(normalized);
    if (existing?.kind === 'dir') throw vfsError('IS_DIRECTORY', `Path is a directory: ${normalized}`);
    if (options?.exclusive && (existing || this.nodes.has(this.resolvePath(path, false)))) {
      throw vfsError('ALREADY_EXISTS', `File already exists: ${normalized}`);
    }
    // An append into an existing file copies the bytes into its store; every
    // other write keeps them, so it needs its own copy unless the caller gave them up.
    const copiedByAppend = options?.append === true && existing?.kind === 'file';
    const bytes =
      typeof data === 'string'
        ? textEncoder.encode(data)
        : this.adoptData || copiedByAppend
          ? data
          : data.slice();
    if (existing?.kind === 'file') {
      // Appending nothing leaves the file untouched, as open(2) with O_APPEND does.
      if (options?.append && bytes.byteLength === 0) return;
      const contents = this.fileContents(existing);
      this.setInode(existing.ino, {
        ...contents,
        ...(options?.append ? appendBytes(contents, bytes) : { data: bytes, store: undefined }),
        snapshotIdentity: Object.freeze({}),
        mtimeMs: Date.now()
      });
      for (const linked of contents.paths) this.noteChange('path', linked);
      this.noteChange('path', requested);
    } else {
      const name = basename(normalized);
      this.updateDirectoryEntry(parentNode, name, true);
      const ino = this.nextInode++;
      this.setInode(ino, {
        data: bytes,
        snapshotIdentity: Object.freeze({}),
        ino,
        mode: options?.mode === undefined ? DEFAULT_FILE_MODE : options.mode & 0o7777 & ~UMASK,
        mtimeMs: Date.now(),
        paths: [normalized]
      });
      this.setNode(normalized, { kind: 'file', ino });
      this.noteChange('subtree', normalized);
      this.noteChange('subtree', requested);
    }
    this.forgetZipArchive(normalized);
  }

  async utimes(path: string, mtimeMs: number): Promise<void> {
    this.utimesSync(path, mtimeMs);
  }

  utimesSync(path: string, mtimeMs: number): void {
    if (!Number.isFinite(mtimeMs) || mtimeMs < 0) {
      throw vfsError('INVALID_ARGUMENT', `Invalid modification time for ${path}: ${mtimeMs}`);
    }
    const normalized = this.resolvePath(path);
    this.setMtime(normalized, mtimeMs);
    this.noteMetadataChange(normalized, normalizePath(path, this.workdir));
    this.forgetZipArchive(normalized);
  }

  async chmod(path: string, mode: number): Promise<void> {
    this.chmodSync(path, mode);
  }

  chmodSync(path: string, mode: number): void {
    if (!Number.isInteger(mode) || mode < 0) {
      throw vfsError('INVALID_ARGUMENT', `Invalid file mode for ${path}: ${mode}`);
    }
    const normalized = this.resolvePath(path);
    const node = this.nodes.get(normalized);
    if (!node) throw vfsError('NOT_FOUND', `No such path: ${normalized}`);
    if (node.kind === 'file') {
      this.setInode(node.ino, { ...this.fileContents(node), mode: mode & 0o7777 });
    } else if (node.kind === 'dir') {
      this.journalNode(node);
      node.mode = mode & 0o7777;
    }
    this.noteMetadataChange(normalized, normalizePath(path, this.workdir));
  }

  async readdir(path: string, options?: { withFileTypes?: boolean }): Promise<Array<string | DirentLike>> {
    return this.readdirSync(path, options);
  }

  readdirSync(path: string, options?: { withFileTypes?: boolean }): Array<string | DirentLike> {
    const normalized = this.resolvePath(path);
    const node = this.nodes.get(normalized);
    if (!node) {
      const zipNode = this.zipPathNode(normalized);
      if (!zipNode) throw vfsError('NOT_FOUND', `No such directory: ${normalized}`);
      if (zipNode.kind !== 'dir') throw vfsError('NOT_DIRECTORY', `Path is not a directory: ${normalized}`);
      if (!options?.withFileTypes) return zipNode.entries;
      return zipNode.entries.map((name) => {
        const child = this.zipPathNode(joinPath(normalized, name));
        return {
          name,
          isFile: () => child?.kind === 'file',
          isDirectory: () => child?.kind === 'dir',
          isSymbolicLink: () => false
        };
      });
    }
    if (node.kind !== 'dir') throw vfsError('NOT_DIRECTORY', `Path is not a directory: ${normalized}`);

    const names = [...node.entries].sort();
    if (!options?.withFileTypes) return names;

    return names.map((name) => {
      const child = this.nodes.get(childPath(normalized, name));
      return {
        name,
        isFile: () => child?.kind === 'file',
        isDirectory: () => child?.kind === 'dir',
        isSymbolicLink: () => child?.kind === 'symlink'
      };
    });
  }

  async mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void> {
    this.mkdirSync(path, options);
  }

  mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): void {
    const normalized = normalizePath(path, this.workdir);
    const parts = stripLeadingSlash(normalized).split('/').filter(Boolean);
    let current = '/';
    let created = false;

    for (const part of parts) {
      const next = childPath(current, part);
      const existing = this.nodes.get(next);
      if (existing) {
        if (next === normalized && !options?.recursive) {
          throw vfsError('ALREADY_EXISTS', `File already exists: ${normalized}`);
        }
        if (existing.kind === 'symlink') {
          const target = this.resolvePath(next);
          if (this.nodes.get(target)?.kind !== 'dir') throw vfsError('NOT_DIRECTORY', `Path segment is not a directory: ${next}`);
          current = target;
          continue;
        }
        if (existing.kind !== 'dir') throw vfsError('NOT_DIRECTORY', `Path segment is not a directory: ${next}`);
        current = next;
        continue;
      }

      if (!options?.recursive && next !== normalized) {
        throw vfsError('NOT_FOUND', `Parent directory does not exist: ${dirname(normalized)}`);
      }

      this.updateDirectoryEntry(this.directory(current), part, true);
      this.setNode(next, {
        kind: 'dir',
        entries: new Set(),
        ino: this.nextInode++,
        mode:
          options?.mode === undefined ? DEFAULT_DIRECTORY_MODE : options.mode & 0o7777 & ~UMASK,
        mtimeMs: Date.now()
      });
      this.noteChange('subtree', next);
      created = true;
      current = next;
    }
    if (created) this.noteChange('subtree', normalized);
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    this.rmSync(path, options);
  }

  rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void {
    const normalized = this.resolvePath(path, false);
    if (normalized === '/') throw vfsError('OPERATION_NOT_PERMITTED', 'Cannot remove the root directory.');
    const node = this.nodes.get(normalized);
    if (!node) {
      if (options?.force) return;
      throw vfsError('NOT_FOUND', `No such path: ${normalized}`);
    }

    if (node.kind === 'dir' && node.entries.size > 0 && !options?.recursive) {
      throw vfsError('DIRECTORY_NOT_EMPTY', `Directory is not empty: ${normalized}`);
    }

    this.removeSubtree(normalized, node);

    const parent = this.nodes.get(dirname(normalized));
    if (parent?.kind === 'dir') this.updateDirectoryEntry(parent, basename(normalized), false);
    this.noteChange('subtree', normalized);
    this.noteChange('subtree', normalizePath(path, this.workdir));
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    this.renameSync(oldPath, newPath);
  }

  renameSync(oldPath: string, newPath: string): void {
    const from = this.resolvePath(oldPath, false);
    const to = this.resolvePath(newPath, false);
    if (from === '/' || to === '/') throw vfsError('OPERATION_NOT_PERMITTED', 'Cannot rename the root directory.');
    const node = this.nodes.get(from);
    if (!node) throw vfsError('NOT_FOUND', `No such path: ${from}`);

    if (from === to) return;

    const parent = this.nodes.get(dirname(to));
    if (!parent || parent.kind !== 'dir') throw vfsError('NOT_FOUND', `Destination parent does not exist: ${dirname(to)}`);

    if (node.kind === 'dir' && to.startsWith(`${from}/`)) {
      throw vfsError('INVALID_ARGUMENT', `Cannot move a directory into itself: ${to}`);
    }

    const destination = this.nodes.get(to);
    if (destination) {
      if (node.kind !== 'dir' && destination.kind === 'dir') {
        throw vfsError('IS_DIRECTORY', `Cannot replace a directory with a file: ${to}`);
      }
      if (node.kind === 'dir' && destination.kind !== 'dir') {
        throw vfsError('NOT_DIRECTORY', `Cannot replace a file with a directory: ${to}`);
      }
      if (node.kind === 'dir' && destination.kind === 'dir' && destination.entries.size > 0) {
        throw vfsError('DIRECTORY_NOT_EMPTY', `Destination directory is not empty: ${to}`);
      }
    }

    const moving = this.collectSubtree(from, node);
    if (destination) this.removeSubtree(to, destination);

    for (const [candidate] of moving) this.deleteNode(candidate);

    for (const [candidate, movingNode] of moving) {
      const moved = `${to}${candidate.slice(from.length)}`;
      if (movingNode.kind === 'file') {
        const contents = this.fileContents(movingNode);
        this.setInode(movingNode.ino, {
          ...contents,
          paths: contents.paths.map((linked) => (linked === candidate ? moved : linked))
        });
      }
      this.setNode(moved, movingNode);
    }

    const oldParent = this.nodes.get(dirname(from));
    if (oldParent?.kind === 'dir') this.updateDirectoryEntry(oldParent, basename(from), false);
    this.updateDirectoryEntry(this.directory(dirname(to)), basename(to), true);
    this.noteChange('subtree', from);
    this.noteChange('subtree', normalizePath(oldPath, this.workdir));
    this.noteChange('subtree', to);
    this.noteChange('subtree', normalizePath(newPath, this.workdir));
  }

  async symlink(target: string, path: string): Promise<void> {
    this.symlinkSync(target, path);
  }

  symlinkSync(target: string, path: string): void {
    const normalized = this.resolvePath(path, false);
    const parent = this.nodes.get(dirname(normalized));
    if (!parent) throw vfsError('NOT_FOUND', `Parent directory does not exist: ${dirname(normalized)}`);
    if (parent.kind !== 'dir') throw vfsError('NOT_DIRECTORY', `Parent is not a directory: ${dirname(normalized)}`);
    if (this.nodes.has(normalized)) throw vfsError('ALREADY_EXISTS', `File already exists: ${normalized}`);
    this.updateDirectoryEntry(parent, basename(normalized), true);
    this.setNode(normalized, {
      kind: 'symlink',
      ino: this.nextInode++,
      target,
      mtimeMs: Date.now()
    });
    this.noteChange('subtree', normalized);
    this.noteChange('subtree', normalizePath(path, this.workdir));
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    this.linkSync(existingPath, newPath);
  }

  linkSync(existingPath: string, newPath: string): void {
    const source = this.resolvePath(existingPath);
    const destination = this.resolvePath(newPath, false);
    const sourceNode = this.nodes.get(source);
    if (!sourceNode) throw vfsError('NOT_FOUND', `No such file: ${source}`);
    if (sourceNode.kind !== 'file') throw vfsError('OPERATION_NOT_PERMITTED', `Hard links require a file: ${source}`);
    if (this.nodes.has(destination)) throw vfsError('ALREADY_EXISTS', `File already exists: ${destination}`);
    const parent = this.nodes.get(dirname(destination));
    if (!parent) throw vfsError('NOT_FOUND', `Parent directory does not exist: ${dirname(destination)}`);
    if (parent.kind !== 'dir') throw vfsError('NOT_DIRECTORY', `Parent is not a directory: ${dirname(destination)}`);
    this.updateDirectoryEntry(parent, basename(destination), true);
    const contents = this.fileContents(sourceNode);
    this.setInode(sourceNode.ino, { ...contents, paths: [...contents.paths, destination] });
    this.setNode(destination, { kind: 'file', ino: sourceNode.ino });
    for (const linked of contents.paths) this.noteChange('path', linked);
    this.noteChange('subtree', destination);
    this.noteChange('subtree', normalizePath(newPath, this.workdir));
  }

  async readlink(path: string): Promise<string> {
    return this.readlinkSync(path);
  }

  readlinkSync(path: string): string {
    const normalized = this.resolvePath(path, false);
    const node = this.nodes.get(normalized);
    if (!node) throw vfsError('NOT_FOUND', `No such file: ${normalized}`);
    if (node.kind !== 'symlink') throw vfsError('INVALID_ARGUMENT', `Path is not a symbolic link: ${normalized}`);
    return node.target;
  }

  async stat(path: string): Promise<FileStatLike> {
    return this.statSync(path);
  }

  statSync(path: string): FileStatLike {
    return this.statResolved(this.resolvePath(path));
  }

  async lstat(path: string): Promise<FileStatLike> {
    return this.lstatSync(path);
  }

  lstatSync(path: string): FileStatLike {
    return this.statResolved(this.resolvePath(path, false));
  }

  async access(path: string): Promise<void> {
    const normalized = this.resolvePath(path);
    if (!this.nodes.has(normalized) && !this.zipPathNode(normalized)) throw vfsError('NOT_FOUND', `No such path: ${normalized}`);
  }

  async realpath(path: string): Promise<string> {
    return this.realpathSync(path);
  }

  realpathSync(path: string): string {
    const normalized = this.resolvePath(path);
    if (!this.nodes.has(normalized) && !this.zipPathNode(normalized)) throw vfsError('NOT_FOUND', `No such path: ${normalized}`);
    return normalized;
  }

  tracePathResolutionSync(
    path: string,
    followFinal = true
  ): { readonly path: string; readonly symlinks: readonly string[] } {
    let candidate = normalizePath(path, this.workdir);
    const symlinks: string[] = [];

    while (true) {
      const parts = candidate.split('/');
      let current = '';
      let restart = false;
      for (let index = 1; index < parts.length; index += 1) {
        if (!parts[index]) continue;
        const next = `${current}/${parts[index]}`;
        const node = this.nodes.get(next);
        if (node?.kind === 'symlink' && (followFinal || index < parts.length - 1)) {
          symlinks.push(next);
          if (symlinks.length > 40) {
            throw vfsError('SYMBOLIC_LINK_LOOP', `Too many symbolic links: ${candidate}`);
          }
          const rest = parts.slice(index + 1).join('/');
          const target = node.target.startsWith('/')
            ? node.target
            : joinPath(dirname(next), node.target);
          candidate = normalizePath(rest ? joinPath(target, rest) : target, this.workdir);
          restart = true;
          break;
        }
        current = next;
      }
      if (!restart) return { path: candidate, symlinks };
    }
  }

  exists(path: string): boolean {
    try {
      const normalized = this.resolvePath(path);
      return this.nodes.has(normalized) || this.zipPathNode(normalized) !== undefined;
    } catch {
      return false;
    }
  }

  existsSync(path: string): boolean {
    return this.exists(path);
  }

  isFile(path: string): boolean {
    try {
      const normalized = this.resolvePath(path);
      return this.nodes.get(normalized)?.kind === 'file' || this.zipPathNode(normalized)?.kind === 'file';
    } catch {
      return false;
    }
  }

  isDirectory(path: string): boolean {
    try {
      const normalized = this.resolvePath(path);
      return this.nodes.get(normalized)?.kind === 'dir' || this.zipPathNode(normalized)?.kind === 'dir';
    } catch {
      return false;
    }
  }

  mount(tree: FileSystemTree, mountPoint = this.workdir): void {
    const root = normalizePath(mountPoint, this.workdir);
    this.mkdirSync(root, { recursive: true });
    const note = this.note;
    if (!note) {
      this.mountTree(root, tree);
      return;
    }
    const buffered: Array<[string, VfsCommitInvalidation['scope']]> = [];
    this.note = (path, scope) => {
      if (buffered.length <= MOUNT_INVALIDATION_LIMIT) buffered.push([path, scope]);
    };
    try {
      this.mountTree(root, tree);
    } finally {
      this.note = note;
    }
    if (buffered.length <= MOUNT_INVALIDATION_LIMIT) {
      for (const [path, scope] of buffered) note(path, scope);
      return;
    }
    this.noteChange('subtree', this.resolvePath(root));
    this.noteChange('subtree', root);
  }

  mountArchive(archive: Uint8Array, mountPoint = this.workdir): void {
    const tree = decodeFileSystemArchive(archive);
    this.mount(tree, mountPoint);
  }

  exportTree(path = this.workdir): FileSystemTree {
    const root = normalizePath(path, this.workdir);
    const node = this.nodes.get(root);
    if (!node) throw vfsError('NOT_FOUND', `No such path: ${root}`);
    if (node.kind !== 'dir') throw vfsError('NOT_DIRECTORY', `Can only export directories as tree: ${root}`);
    return this.exportDirectory(root);
  }

  exportArchive(
    path = this.workdir,
    format: FileSystemArchiveFormat
  ): Uint8Array {
    return encodeFileSystemArchive(this.snapshotTree(path), format);
  }

  snapshotTree(path = this.workdir): FileSystemTree {
    const root = normalizePath(path, this.workdir);
    const node = this.nodes.get(root);
    if (!node) throw vfsError('NOT_FOUND', `No such path: ${root}`);
    if (node.kind !== 'dir') throw vfsError('NOT_DIRECTORY', `Can only snapshot directories as a tree: ${root}`);
    return this.exportDirectory(root);
  }

  /**
   * Applies one commit to this file system in place. A failing operation
   * restores every earlier one, and the invalidations are those the applied
   * operations actually caused.
   */
  applyCommit(
    operations: readonly VfsCommitOperation[],
    options: { readonly adoptData?: boolean } = {}
  ): VfsCommitApplication {
    const invalidations: VfsCommitInvalidation[] = [];
    const seen = new Set<string>();
    const undo: Array<() => void> = [];
    const priorNextInode = this.nextInode;
    this.undo = undo;
    this.note = (path, scope) => {
      const key = `${scope}:${path}`;
      if (seen.has(key)) return;
      seen.add(key);
      invalidations.push({ path, scope });
    };
    this.adoptData = options.adoptData === true;
    let operationIndex = 0;
    try {
      for (; operationIndex < operations.length; operationIndex += 1) {
        applyOperation(this, operations[operationIndex]);
      }
    } catch (error) {
      for (let index = undo.length - 1; index >= 0; index -= 1) undo[index]();
      this.nextInode = priorNextInode;
      return {
        ok: false,
        error,
        operationIndex,
        operationType: operations[operationIndex].type
      };
    } finally {
      this.undo = undefined;
      this.note = undefined;
      this.adoptData = false;
    }
    return {
      ok: true,
      invalidations: invalidations.sort(
        (left, right) =>
          Number(left.scope === 'directory') - Number(right.scope === 'directory')
      )
    };
  }

  private mountTree(parentPath: string, tree: FileSystemTree): void {
    for (const [name, node] of Object.entries(tree).sort(([left], [right]) => left.localeCompare(right))) {
      const target = joinPath(parentPath, name);
      if ('file' in node) {
        const contents = node.file.contents;
        this.writeFileSync(
          target,
          typeof contents === 'string' || contents instanceof Uint8Array
            ? contents
            : new Uint8Array(contents)
        );
      } else if ('symlink' in node) {
        this.symlinkSync(node.symlink.target, target);
      } else {
        this.mkdirSync(target, { recursive: true });
        this.mountTree(target, node.directory);
      }
      if (node.mtimeMs !== undefined) {
        if (!Number.isFinite(node.mtimeMs) || node.mtimeMs < 0) {
          throw vfsError('INVALID_ARGUMENT', `Invalid modification time for ${target}: ${node.mtimeMs}`);
        }
        this.setMtime(normalizePath(target, this.workdir), node.mtimeMs);
      }
      // A snapshot restores its permission bits exactly, without the umask.
      if (node.mode !== undefined && !('symlink' in node)) {
        if (!Number.isInteger(node.mode) || node.mode < 0 || node.mode > 0o7777) {
          throw vfsError('INVALID_ARGUMENT', `Invalid file mode for ${target}: ${node.mode}`);
        }
        this.setMode(normalizePath(target, this.workdir), node.mode);
      }
    }
  }

  private exportDirectory(path: string): FileSystemTree {
    const directory = this.nodes.get(path);
    if (!directory || directory.kind !== 'dir') throw vfsError('NOT_DIRECTORY', `Not a directory: ${path}`);

    // Names are own entries only, so `__proto__` is a name like any other.
    const tree = Object.create(null) as FileSystemTree;
    for (const name of [...directory.entries].sort()) {
      const target = childPath(path, name);
      const child = this.nodes.get(target);
      if (!child) continue;
      if (child.kind === 'file') {
        const contents = this.fileContents(child);
        tree[name] = {
          file: { contents: contents.data.slice() },
          mtimeMs: contents.mtimeMs,
          ...(contents.mode === DEFAULT_FILE_MODE ? {} : { mode: contents.mode })
        };
      } else if (child.kind === 'symlink') {
        tree[name] = { symlink: { target: child.target }, mtimeMs: child.mtimeMs };
      } else {
        tree[name] = {
          directory: this.exportDirectory(target),
          mtimeMs: child.mtimeMs,
          ...(child.mode === DEFAULT_DIRECTORY_MODE ? {} : { mode: child.mode })
        };
      }
    }
    return tree;
  }

  private setMtime(path: string, mtimeMs: number): void {
    const node = this.nodes.get(path);
    if (!node) throw vfsError('NOT_FOUND', `No such path: ${path}`);
    if (node.kind === 'file') {
      this.setInode(node.ino, { ...this.fileContents(node), mtimeMs });
      return;
    }
    this.journalNode(node);
    node.mtimeMs = mtimeMs;
  }

  private setMode(path: string, mode: number): void {
    const node = this.nodes.get(path);
    if (!node) throw vfsError('NOT_FOUND', `No such path: ${path}`);
    if (node.kind === 'file') {
      this.setInode(node.ino, { ...this.fileContents(node), mode });
    } else if (node.kind === 'dir') {
      this.journalNode(node);
      node.mode = mode;
    }
  }

  private statResolved(normalized: string): FileStatLike {
    const node = this.nodes.get(normalized);
    if (!node) {
      const zipNode = this.zipPathNode(normalized);
      if (!zipNode) throw vfsError('NOT_FOUND', `No such path: ${normalized}`);
      return statFromZipNode(zipNode);
    }
    return node.kind === 'file' ? statFromFile(this.fileContents(node)) : statFromNode(node);
  }

  private fileContents(node: FileNode): FileContents {
    const contents = this.inodes.get(node.ino);
    if (!contents) throw vfsError('IO_FAILURE', `The inode ${node.ino} has no contents.`);
    return contents;
  }

  private openFileContents(opened: OpenFileDescription): FileContents {
    const contents = this.inodes.get(opened.ino);
    if (!contents) throw vfsError('IO_FAILURE', `The inode ${opened.ino} has no contents.`);
    return contents;
  }

  private hasOpenFileDescription(ino: number): boolean {
    for (const opened of this.openFileDescriptions.values()) {
      if (opened.ino === ino) return true;
    }
    return false;
  }

  /** Lists a node and everything beneath it, parents before their children. */
  private collectSubtree(root: string, rootNode: VfsNode): Array<[string, VfsNode]> {
    const collected: Array<[string, VfsNode]> = [[root, rootNode]];
    for (let index = 0; index < collected.length; index += 1) {
      const [path, node] = collected[index];
      if (node.kind !== 'dir') continue;
      for (const name of node.entries) {
        const target = childPath(path, name);
        const child = this.nodes.get(target);
        if (child) collected.push([target, child]);
      }
    }
    return collected;
  }

  private removeSubtree(root: string, rootNode: VfsNode): void {
    const removed = this.collectSubtree(root, rootNode);
    for (let index = removed.length - 1; index >= 0; index -= 1) {
      const [path, node] = removed[index];
      if (node.kind === 'file') this.unlinkFile(path, node);
      this.deleteNode(path);
    }
  }

  private unlinkFile(path: string, node: FileNode): void {
    const contents = this.fileContents(node);
    const paths = contents.paths.filter((linked) => linked !== path);
    if (paths.length === 0 && !this.hasOpenFileDescription(node.ino)) {
      this.deleteInode(node.ino);
      return;
    }
    this.setInode(node.ino, { ...contents, paths });
    for (const linked of paths) this.noteChange('path', linked);
  }

  private setNode(path: string, node: VfsNode): void {
    this.journalMap(this.nodes, path);
    this.nodes.set(path, node);
  }

  private deleteNode(path: string): void {
    this.journalMap(this.nodes, path);
    this.nodes.delete(path);
  }

  private setInode(ino: number, contents: FileContents): void {
    this.journalMap(this.inodes, ino);
    this.inodes.set(ino, contents);
  }

  private deleteInode(ino: number): void {
    this.journalMap(this.inodes, ino);
    this.inodes.delete(ino);
  }

  /** Records the entry a commit replaces so that a rejected commit restores it. */
  private journalMap<Key, Value>(map: Map<Key, Value>, key: Key): void {
    const undo = this.undo;
    if (!undo) return;
    const prior = map.get(key);
    undo.push(() => {
      if (prior === undefined) map.delete(key);
      else map.set(key, prior);
    });
  }

  /** Records the scalar fields of a node before a commit changes them in place. */
  private journalNode(node: DirectoryNode | SymlinkNode): void {
    const undo = this.undo;
    if (!undo) return;
    const prior = { ...node };
    undo.push(() => {
      Object.assign(node, prior);
    });
  }

  private directory(path: string): DirectoryNode {
    const node = this.nodes.get(path);
    if (!node || node.kind !== 'dir') throw vfsError('NOT_DIRECTORY', `Parent is not a directory: ${path}`);
    return node;
  }

  private updateDirectoryEntry(directory: DirectoryNode, name: string, present: boolean): void {
    const undo = this.undo;
    if (undo) {
      const had = directory.entries.has(name);
      this.journalNode(directory);
      undo.push(() => {
        if (had) directory.entries.add(name);
        else directory.entries.delete(name);
      });
    }
    if (present) directory.entries.add(name);
    else directory.entries.delete(name);
    directory.mtimeMs = Date.now();
  }

  private noteChange(scope: 'path' | 'subtree', path: string): void {
    const note = this.note;
    if (!note) return;
    note(path, scope);
    note(dirname(path), 'directory');
  }

  private noteMetadataChange(normalized: string, requested: string): void {
    if (!this.note) return;
    const node = this.nodes.get(normalized);
    if (node?.kind === 'file') {
      for (const linked of this.fileContents(node).paths) this.noteChange('path', linked);
    } else {
      this.noteChange('path', normalized);
    }
    this.noteChange('path', requested);
  }

  private requireOpenFileDescription(id: number): OpenFileDescription {
    const opened = this.openFileDescriptions.get(id);
    if (!opened) throw vfsError('BAD_FILE_DESCRIPTOR', `Unknown open file description: ${id}`);
    return opened;
  }

  private resolvePath(path: string, followFinal = true): string {
    return this.tracePathResolutionSync(path, followFinal).path;
  }

  private zipPathNode(path: string): ZipPathNode | undefined {
    if (!path.includes('.zip/')) return undefined;
    const normalized = normalizePath(path, this.workdir);
    const parts = stripLeadingSlash(normalized).split('/').filter(Boolean);
    for (let index = parts.length - 2; index >= 0; index -= 1) {
      if (!parts[index].endsWith('.zip')) continue;
      const archivePath = `/${parts.slice(0, index + 1).join('/')}`;
      const archiveNode = this.nodes.get(archivePath);
      if (archiveNode?.kind !== 'file') continue;
      const archive = this.fileContents(archiveNode);
      const entryPath = parts.slice(index + 1).join('/');
      const entries = this.zipArchiveEntries(archivePath, archive);
      const file = entries[entryPath];
      if (file && !entryPath.endsWith('/')) return { kind: 'file', data: file, mtimeMs: archive.mtimeMs };
      const prefix = `${entryPath.replace(/\/$/, '')}/`;
      const children = new Set<string>();
      for (const entry of Object.keys(entries)) {
        if (!entry.startsWith(prefix) || entry === prefix) continue;
        const child = entry.slice(prefix.length).split('/')[0];
        if (child) children.add(child);
      }
      if (children.size > 0 || Object.hasOwn(entries, prefix)) {
        return { kind: 'dir', entries: [...children].sort(), mtimeMs: archive.mtimeMs };
      }
    }
    return undefined;
  }

  private zipArchiveEntries(archivePath: string, archive: FileContents): Record<string, Uint8Array> {
    const cached = this.zipArchives.get(archivePath);
    if (cached?.mtimeMs === archive.mtimeMs) {
      // Re-inserting keeps the map ordered from least to most recently read.
      this.zipArchives.delete(archivePath);
      this.zipArchives.set(archivePath, cached);
      return cached.entries;
    }
    if (cached) this.forgetZipArchive(archivePath);
    this.assertZipArchiveWithinLimits(archivePath, archive.data);
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(archive.data);
    } catch (error) {
      throw invalidZipArchive(archivePath, error);
    }
    let bytes = 0;
    for (const data of Object.values(entries)) bytes += data.byteLength;
    this.rememberZipArchive(archivePath, { mtimeMs: archive.mtimeMs, entries, bytes });
    return entries;
  }

  /**
   * Reads the central directory without inflating anything and refuses an
   * archive whose entries would exceed the inflated-size or entry-count bound.
   */
  private assertZipArchiveWithinLimits(archivePath: string, data: Uint8Array): void {
    const { maxEntries, maxInflatedBytes } = this.zipLimits;
    let entryCount = 0;
    let inflatedBytes = 0;
    try {
      unzipSync(data, {
        filter: (entry) => {
          entryCount += 1;
          inflatedBytes += entry.originalSize;
          if (entryCount > maxEntries) {
            throw vfsError('ARCHIVE_TOO_LARGE', `ZIP archive ${archivePath} holds more than ${maxEntries} entries.`);
          }
          if (inflatedBytes > maxInflatedBytes) {
            throw vfsError(
              'ARCHIVE_TOO_LARGE',
              `ZIP archive ${archivePath} would inflate to more than ${maxInflatedBytes} bytes.`
            );
          }
          return false;
        }
      });
    } catch (error) {
      if ((error as VfsError).code === 'ARCHIVE_TOO_LARGE') throw error;
      throw invalidZipArchive(archivePath, error);
    }
  }

  private rememberZipArchive(archivePath: string, archive: CachedZipArchive): void {
    const { maxCachedBytes } = this.zipLimits;
    if (archive.bytes > maxCachedBytes) return;
    for (const [path, cached] of this.zipArchives) {
      if (this.zipCachedBytes + archive.bytes <= maxCachedBytes) break;
      this.zipArchives.delete(path);
      this.zipCachedBytes -= cached.bytes;
    }
    this.zipArchives.set(archivePath, archive);
    this.zipCachedBytes += archive.bytes;
  }

  private forgetZipArchive(archivePath: string): void {
    const cached = this.zipArchives.get(archivePath);
    if (!cached) return;
    this.zipArchives.delete(archivePath);
    this.zipCachedBytes -= cached.bytes;
  }

}

function applyOperation(fileSystem: VirtualFileSystem, operation: VfsCommitOperation): void {
  switch (operation.type) {
    case 'write-file':
      fileSystem.writeFileSync(operation.path, operation.data, operation);
      return;
    case 'mkdir':
      fileSystem.mkdirSync(operation.path, operation.options);
      return;
    case 'rm':
      fileSystem.rmSync(operation.path, operation.options);
      return;
    case 'rename':
      fileSystem.renameSync(operation.oldPath, operation.newPath);
      return;
    case 'symlink':
      fileSystem.symlinkSync(operation.target, operation.path);
      return;
    case 'link':
      fileSystem.linkSync(operation.existingPath, operation.newPath);
      return;
    case 'utimes':
      fileSystem.utimesSync(operation.path, operation.mtimeMs);
      return;
    case 'chmod':
      fileSystem.chmodSync(operation.path, operation.mode);
      return;
    case 'write-open-file':
      fileSystem.writeFileDescriptionSync(
        operation.id,
        operation.data,
        operation.position
      );
      return;
    case 'mount':
      fileSystem.mount(operation.tree, operation.mountPoint);
      return;
  }
}

function childPath(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`;
}

/**
 * Appends without rewriting the existing bytes when this snapshot is the
 * newest one written into its backing store. Older snapshots (a view already
 * handed out, or the contents a rejected commit restores) keep reading their
 * own prefix, so no reader ever observes the appended tail.
 */
function appendBytes(contents: FileContents, bytes: Uint8Array): Pick<FileContents, 'data' | 'store'> {
  const size = contents.data.byteLength;
  const next = size + bytes.byteLength;
  const store = contents.store;
  if (store && store.used === size && store.buffer.byteLength >= next) {
    store.buffer.set(bytes, size);
    store.used = next;
    return { data: store.buffer.subarray(0, next), store };
  }
  const buffer = new Uint8Array(next + Math.min(Math.max(next, 256), MAX_APPEND_HEADROOM));
  buffer.set(contents.data);
  buffer.set(bytes, size);
  return { data: buffer.subarray(0, next), store: { buffer, used: next } };
}

function statFromFile(contents: FileContents): FileStatLike {
  return statLike('file', contents.data.byteLength, contents.ino, S_IFREG | contents.mode, contents.paths.length, contents.mtimeMs);
}

function statFromNode(node: DirectoryNode | SymlinkNode): FileStatLike {
  return node.kind === 'dir'
    ? statLike('dir', 0, node.ino, S_IFDIR | node.mode, 1, node.mtimeMs)
    : statLike('symlink', node.target.length, node.ino, S_IFLNK | SYMLINK_MODE, 1, node.mtimeMs);
}

function statFromZipNode(node: ZipPathNode): FileStatLike {
  return node.kind === 'file'
    ? statLike('file', node.data.byteLength, 0, S_IFREG | 0o444, 1, node.mtimeMs)
    : statLike('dir', 0, 0, S_IFDIR | 0o555, 1, node.mtimeMs);
}

function statLike(
  kind: VfsNode['kind'],
  size: number,
  ino: number,
  mode: number,
  nlink: number,
  mtimeMs: number
): FileStatLike {
  return {
    size,
    ino,
    mode,
    nlink,
    ctime: new Date(mtimeMs),
    mtime: new Date(mtimeMs),
    mtimeMs,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
    isSocket: () => false,
    isSymbolicLink: () => kind === 'symlink'
  };
}

function vfsError(code: string, message: string): VfsError {
  const error = new Error(message) as VfsError;
  error.code = code;
  return error;
}

function invalidZipArchive(archivePath: string, error: unknown): VfsError {
  return vfsError(
    'INVALID_ARGUMENT',
    `Invalid ZIP archive ${archivePath}: ${error instanceof Error ? error.message : String(error)}`
  );
}

function resolveZipLimits(limits: Partial<VirtualFileSystemZipLimits> | undefined): VirtualFileSystemZipLimits {
  const resolved = { ...DEFAULT_ZIP_LIMITS, ...limits };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new RangeError(`ZIP limit ${name} must be a non-negative integer.`);
    }
  }
  return Object.freeze(resolved);
}
