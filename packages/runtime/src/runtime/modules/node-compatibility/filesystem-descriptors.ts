import type {
  NodeFileSystemAsynchronousPort,
  NodeFileSystemSynchronousPort
} from './filesystem';
import {
  errorCode,
  fileMode,
  type FileSystemPath,
  NODE_FS_CONSTANTS,
  nodeFileSystemError,
  nodeStat,
  resolveFileSystemPath
} from './filesystem-shared';

type DescriptorRecord = {
  /** The open file of the Virtual File System; a directory has none. */
  readonly handle: number;
  /** The path the descriptor was opened through, for path-based operations on it. */
  readonly path: string;
  /** A directory opened for reading: it can be stated and closed, as `opendir(3)` users expect. */
  readonly directory: boolean;
  pending: Promise<void>;
};

const NO_HANDLE = -1;

type FileOpenMode = {
  readonly append: boolean;
  readonly create: boolean;
  readonly exclusive: boolean;
  readonly readable: boolean;
  readonly truncate: boolean;
  readonly writable: boolean;
};

/** Where writes to descriptors 1 and 2 go: the process's own output, past any patched `write`. */
export interface NodeFileSystemStandardStreams {
  write(descriptor: 1 | 2, bytes: Uint8Array): void;
}

export interface NodeFileSystemDescriptorOperations {
  close(descriptor: number): Promise<void>;
  closeSync(descriptor: number): void;
  createFileHandle(descriptor: number): object;
  open(path: FileSystemPath, flags?: string | number | null, mode?: string | number | null): Promise<number>;
  openSync(path: FileSystemPath, flags?: string | number | null, mode?: string | number | null): number;
  pathOf(descriptor: number, operation: 'fchmod' | 'fstat' | 'ftruncate'): string;
  read(
    descriptor: number,
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number | null
  ): Promise<number>;
  readSync(
    descriptor: number,
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number | null
  ): number;
  stat(
    descriptor: number,
    options?: { readonly bigint?: boolean }
  ): Promise<ReturnType<typeof nodeStat>>;
  statSync(
    descriptor: number,
    options?: { readonly bigint?: boolean }
  ): ReturnType<typeof nodeStat>;
  sync(descriptor: number): Promise<void>;
  syncSync(descriptor: number): void;
  write(
    descriptor: number,
    data: string | Uint8Array,
    offsetOrPosition?: number | null,
    lengthOrEncoding?: number | string,
    position?: number | null
  ): Promise<number>;
  writeSync(
    descriptor: number,
    data: string | Uint8Array,
    offsetOrPosition?: number | null,
    lengthOrEncoding?: number | string,
    position?: number | null
  ): number;
}

export function createNodeFileSystemDescriptorOperations(options: {
  readonly asynchronous: NodeFileSystemAsynchronousPort;
  readonly cwd: string;
  readonly synchronous: NodeFileSystemSynchronousPort;
  readonly standardStreams?: NodeFileSystemStandardStreams;
}): NodeFileSystemDescriptorOperations {
  const descriptors = new Map<number, DescriptorRecord>();
  let nextDescriptor = 3;

  function openSync(
    path: FileSystemPath,
    flags?: string | number | null,
    mode?: string | number | null
  ): number {
    const normalized = resolveFileSystemPath(path, options.cwd);
    const openMode = fileOpenMode(flags ?? 'r');
    const creation = creationWrite(openMode, fileMode(mode));
    if (creation) options.synchronous.writeFileSync(normalized, new Uint8Array(), creation);
    let handle: number;
    try {
      handle = options.synchronous.openFileSync(normalized, openMode);
    } catch (error) {
      if (!opensDirectory(error, openMode)) throw error;
      return allocateDescriptor(NO_HANDLE, normalized, true);
    }
    // Truncation without creation applies only once the open proved the file exists.
    if (openMode.truncate && !creation) options.synchronous.writeFileSync(normalized, new Uint8Array());
    return allocateDescriptor(handle, normalized);
  }

  async function open(
    path: FileSystemPath,
    flags?: string | number | null,
    mode?: string | number | null
  ): Promise<number> {
    const normalized = resolveFileSystemPath(path, options.cwd);
    const openMode = fileOpenMode(flags ?? 'r');
    const creation = creationWrite(openMode, fileMode(mode));
    if (creation) await options.asynchronous.writeFile(normalized, new Uint8Array(), creation);
    let handle: number;
    try {
      handle = await options.asynchronous.openFile(normalized, openMode);
    } catch (error) {
      if (!opensDirectory(error, openMode)) throw error;
      return allocateDescriptor(NO_HANDLE, normalized, true);
    }
    if (openMode.truncate && !creation) await options.asynchronous.writeFile(normalized, new Uint8Array());
    return allocateDescriptor(handle, normalized);
  }

  function allocateDescriptor(handle: number, path: string, directory = false): number {
    const descriptor = nextDescriptor;
    nextDescriptor += 1;
    descriptors.set(descriptor, {
      handle,
      path,
      directory,
      pending: Promise.resolve()
    });
    return descriptor;
  }

  function requireDescriptor(
    descriptor: number,
    operation: 'close' | 'fchmod' | 'fstat' | 'fsync' | 'ftruncate' | 'read' | 'write'
  ): DescriptorRecord {
    const record = descriptors.get(descriptor);
    if (!record) {
      throw nodeFileSystemError(
        'EBADF',
        `bad file descriptor, ${operation} ${descriptor}`,
        undefined,
        operation
      );
    }
    return record;
  }

  function readSync(
    descriptor: number,
    buffer: Uint8Array,
    offset = 0,
    length = buffer.byteLength - offset,
    position?: number | null
  ): number {
    const record = requireDescriptor(descriptor, 'read');
    if (record.directory) throw directoryReadError();
    const usesCurrentPosition = position === undefined || position === null || position < 0;
    try {
      const data = options.synchronous.readOpenFileSync(
        record.handle,
        length,
        usesCurrentPosition ? undefined : position
      );
      buffer.set(data, offset);
      return data.byteLength;
    } catch (error) {
      throw descriptorError(error, descriptor, 'read');
    }
  }

  async function read(
    descriptor: number,
    buffer: Uint8Array,
    offset = 0,
    length = buffer.byteLength - offset,
    position?: number | null
  ): Promise<number> {
    const record = requireDescriptor(descriptor, 'read');
    if (record.directory) throw directoryReadError();
    return enqueue(record, async () => {
      const usesCurrentPosition = position === undefined || position === null || position < 0;
      try {
        const data = await options.asynchronous.readOpenFile(
          record.handle,
          length,
          usesCurrentPosition ? undefined : position
        );
        buffer.set(data, offset);
        return data.byteLength;
      } catch (error) {
        throw descriptorError(error, descriptor, 'read');
      }
    });
  }

  /**
   * Descriptors 1 and 2 are the process's standard output and error, as in
   * Node, where a worker thread shares them too: sonic-boom (pino and its
   * transports) writes its lines with `fs.write(1, …)`.
   */
  function writeStandardStream(
    descriptor: number,
    data: string | Uint8Array,
    offsetOrPosition?: number | null,
    lengthOrEncoding?: number | string
  ): number | undefined {
    if ((descriptor !== 1 && descriptor !== 2) || descriptors.has(descriptor) || !options.standardStreams) return undefined;
    const { bytes } = writeArguments(data, offsetOrPosition, lengthOrEncoding);
    options.standardStreams.write(descriptor, bytes);
    return bytes.byteLength;
  }

  function writeSync(
    descriptor: number,
    data: string | Uint8Array,
    offsetOrPosition?: number | null,
    lengthOrEncoding?: number | string,
    position?: number | null
  ): number {
    const standard = writeStandardStream(descriptor, data, offsetOrPosition, lengthOrEncoding);
    if (standard !== undefined) return standard;
    const record = requireDescriptor(descriptor, 'write');
    const write = writeArguments(data, offsetOrPosition, lengthOrEncoding, position);
    try {
      return options.synchronous.writeOpenFileSync(
        record.handle,
        write.bytes,
        write.usesCurrentPosition ? undefined : write.position
      );
    } catch (error) {
      throw descriptorError(error, descriptor, 'write');
    }
  }

  async function write(
    descriptor: number,
    data: string | Uint8Array,
    offsetOrPosition?: number | null,
    lengthOrEncoding?: number | string,
    position?: number | null
  ): Promise<number> {
    const standard = writeStandardStream(descriptor, data, offsetOrPosition, lengthOrEncoding);
    if (standard !== undefined) return standard;
    const record = requireDescriptor(descriptor, 'write');
    return enqueue(record, async () => {
      const write = writeArguments(data, offsetOrPosition, lengthOrEncoding, position);
      try {
        return await options.asynchronous.writeOpenFile(
          record.handle,
          write.bytes,
          write.usesCurrentPosition ? undefined : write.position
        );
      } catch (error) {
        throw descriptorError(error, descriptor, 'write');
      }
    });
  }

  async function enqueue<Value>(
    record: DescriptorRecord,
    operation: () => Promise<Value>
  ): Promise<Value> {
    const result = record.pending.then(operation, operation);
    record.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  async function close(descriptor: number): Promise<void> {
    const record = requireDescriptor(descriptor, 'close');
    await record.pending;
    if (!record.directory) await options.asynchronous.closeFile(record.handle);
    descriptors.delete(descriptor);
  }

  function closeSync(descriptor: number): void {
    const record = requireDescriptor(descriptor, 'close');
    if (!record.directory) options.synchronous.closeFileSync(record.handle);
    descriptors.delete(descriptor);
  }

  async function sync(descriptor: number): Promise<void> {
    await requireDescriptor(descriptor, 'fsync').pending;
  }

  function syncSync(descriptor: number): void {
    requireDescriptor(descriptor, 'fsync');
  }

  async function stat(
    descriptor: number,
    statOptions?: { readonly bigint?: boolean }
  ): Promise<ReturnType<typeof nodeStat>> {
    const record = requireDescriptor(descriptor, 'fstat');
    await record.pending;
    return nodeStat(
      record.directory
        ? await options.asynchronous.stat(record.path)
        : await options.asynchronous.statOpenFile(record.handle),
      statOptions?.bigint === true
    );
  }

  function statSync(
    descriptor: number,
    statOptions?: { readonly bigint?: boolean }
  ): ReturnType<typeof nodeStat> {
    const record = requireDescriptor(descriptor, 'fstat');
    return nodeStat(
      record.directory
        ? options.synchronous.statSync(record.path)
        : options.synchronous.statOpenFileSync(record.handle),
      statOptions?.bigint === true
    );
  }

  function createFileHandle(descriptor: number): object {
    return {
      fd: descriptor,
      close: () => close(descriptor),
      read: async (
        buffer: Uint8Array,
        offset = 0,
        length = buffer.byteLength - offset,
        position?: number | null
      ) => ({
        buffer,
        bytesRead: await read(descriptor, buffer, offset, length, position)
      }),
      stat: (statOptions?: { readonly bigint?: boolean }) => stat(descriptor, statOptions),
      sync: () => sync(descriptor),
      write: async (
        data: string | Uint8Array,
        offsetOrPosition?: number | null,
        lengthOrEncoding?: number | string,
        position?: number | null
      ) => ({
        buffer: data,
        bytesWritten: await write(
          descriptor,
          data,
          offsetOrPosition,
          lengthOrEncoding,
          position
        )
      })
    };
  }

  function pathOf(descriptor: number, operation: 'fchmod' | 'fstat' | 'ftruncate'): string {
    return requireDescriptor(descriptor, operation).path;
  }

  return {
    close,
    closeSync,
    createFileHandle,
    open,
    openSync,
    pathOf,
    read,
    readSync,
    stat,
    statSync,
    sync,
    syncSync,
    write,
    writeSync
  };
}

/**
 * The single write that performs the create, truncate, and exclusive parts of
 * an open. The authority applies it atomically, so no other writer can slip in
 * between an existence check and the creation.
 */
function creationWrite(
  mode: FileOpenMode,
  permissions: number | undefined
): { readonly append?: boolean; readonly exclusive?: boolean; readonly mode?: number } | undefined {
  if (mode.create && mode.exclusive) return { exclusive: true, mode: permissions };
  if (mode.truncate) return mode.create ? { mode: permissions } : undefined;
  // Appending nothing creates a missing file and leaves an existing one untouched.
  return mode.create ? { append: true, mode: permissions } : undefined;
}

function fileOpenMode(flags: string | number): FileOpenMode {
  if (typeof flags === 'number') {
    return {
      append: Boolean(flags & NODE_FS_CONSTANTS.O_APPEND),
      create: Boolean(flags & NODE_FS_CONSTANTS.O_CREAT),
      exclusive: Boolean(flags & NODE_FS_CONSTANTS.O_EXCL),
      readable:
        (flags & NODE_FS_CONSTANTS.O_WRONLY) === 0 || Boolean(flags & NODE_FS_CONSTANTS.O_RDWR),
      truncate: Boolean(flags & NODE_FS_CONSTANTS.O_TRUNC),
      writable: Boolean(flags & (NODE_FS_CONSTANTS.O_WRONLY | NODE_FS_CONSTANTS.O_RDWR))
    };
  }
  if (!/^(?:r|w|a)(?:x)?\+?$|^(?:r|w|a)\+(?:x)?$|^(?:rs|as)\+?$/.test(flags)) {
    throw nodeFileSystemError('EINVAL', `Invalid file open flag: ${flags}`);
  }
  return {
    append: flags.startsWith('a'),
    create: flags.startsWith('w') || flags.startsWith('a'),
    exclusive: flags.includes('x'),
    readable: flags.startsWith('r') || flags.includes('+'),
    truncate: flags.startsWith('w'),
    writable: flags.startsWith('w') || flags.startsWith('a') || flags.includes('+')
  };
}

function writeArguments(
  data: string | Uint8Array,
  offsetOrPosition?: number | null,
  lengthOrEncoding?: number | string,
  position?: number | null
): {
  readonly bytes: Uint8Array;
  readonly position: number;
  readonly usesCurrentPosition: boolean;
} {
  if (typeof data === 'string') {
    return {
      bytes: new TextEncoder().encode(data),
      position: typeof offsetOrPosition === 'number' ? offsetOrPosition : 0,
      usesCurrentPosition: offsetOrPosition === undefined || offsetOrPosition === null || offsetOrPosition < 0
    };
  }
  const offset = typeof offsetOrPosition === 'number' ? offsetOrPosition : 0;
  const length = typeof lengthOrEncoding === 'number' ? lengthOrEncoding : data.byteLength - offset;
  return {
    // A copy: `slice()` on a Buffer would alias memory the caller may reuse.
    bytes: Uint8Array.from(data.subarray(offset, offset + length)),
    position: typeof position === 'number' ? position : 0,
    usesCurrentPosition: position === undefined || position === null || position < 0
  };
}

/** Whether an open failed only because the path is a directory, which may be opened for reading. */
function opensDirectory(error: unknown, mode: FileOpenMode): boolean {
  const code = errorCode(error);
  return (code === 'EISDIR' || code === 'IS_DIRECTORY') && !mode.writable && !mode.create && !mode.truncate;
}

function directoryReadError(): Error {
  return nodeFileSystemError('EISDIR', 'illegal operation on a directory, read', undefined, 'read');
}

function descriptorError(
  error: unknown,
  descriptor: number,
  operation: 'read' | 'write'
): unknown {
  return errorCode(error) === 'BAD_FILE_DESCRIPTOR'
    ? nodeFileSystemError(
        'EBADF',
        `bad file descriptor, ${operation} ${descriptor}`,
        undefined,
        operation
      )
    : error;
}
