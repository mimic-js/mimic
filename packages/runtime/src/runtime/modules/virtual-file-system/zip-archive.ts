import { Zip, ZipPassThrough, unzipSync } from 'fflate';
import {
  concatenateArchiveChunks,
  DEFAULT_ARCHIVE_DIRECTORY_MODE,
  DEFAULT_ARCHIVE_FILE_MODE,
  type FileSystemArchiveEntry
} from './archive-entry';

type CentralDirectoryEntry = {
  readonly archivePath: string;
  readonly compressedSize: number;
  readonly kind: FileSystemArchiveEntry['kind'];
  readonly mtimeMs: number;
  /** Permission bits of an entry made on Unix, if they differ from the default for its kind. */
  readonly mode?: number;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });
const unixOs = 3;
const unixFileType = 0o100000;
const unixDirectoryType = 0o040000;
const unixSymlinkMode = 0o120777;
const zipEocdSignature = 0x06054b50;
const zipCentralDirectorySignature = 0x02014b50;
const zipLocalFileSignature = 0x04034b50;

export function encodeZipArchive(entries: readonly FileSystemArchiveEntry[]): Uint8Array {
  const preparedEntries = entries
    .map((entry) => prepareEntry(entry))
    .sort((left, right) => comparePaths(left.path, right.path));
  assertEntryTree(preparedEntries);

  const chunks: Uint8Array[] = [];
  let archiveError: unknown;
  const archive = new Zip((error, chunk) => {
    if (error) {
      archiveError = error;
      return;
    }
    if (chunk) chunks.push(chunk.slice());
  });

  for (const entry of preparedEntries) {
    const file = new ZipPassThrough(entry.archivePath);
    file.os = unixOs;
    file.attrs = entry.attributes;
    file.mtime = new Date(entry.mtimeMs);
    archive.add(file);
    file.push(entry.data, true);
  }
  archive.end();

  if (archiveError) throw invalidZipArchive(archiveError);
  return concatenateArchiveChunks(chunks);
}

export function decodeZipArchive(bytes: Uint8Array): FileSystemArchiveEntry[] {
  const centralEntries = readCentralDirectory(bytes);
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (error) {
    throw invalidZipArchive(error);
  }

  const entries = centralEntries.map((entry) => {
    const data = files[entry.archivePath];
    if (!Object.hasOwn(files, entry.archivePath) || !data) {
      throw invalidZipArchive(`missing ZIP entry ${entry.archivePath}`);
    }
    const path = entry.kind === 'directory' && entry.archivePath.endsWith('/')
      ? entry.archivePath.slice(0, -1)
      : entry.archivePath;
    const mode = entry.mode === undefined ? {} : { mode: entry.mode };
    if (entry.kind === 'file') {
      return { path, kind: 'file' as const, data: data.slice(), mtimeMs: entry.mtimeMs, ...mode };
    }
    if (entry.kind === 'directory') {
      if (data.byteLength !== 0) throw invalidZipArchive(`directory ${path} has file data`);
      return { path, kind: 'directory' as const, mtimeMs: entry.mtimeMs, ...mode };
    }
    return {
      path,
      kind: 'symlink' as const,
      target: textDecoder.decode(data),
      mtimeMs: entry.mtimeMs
    };
  });

  assertEntryTree(entries);
  return entries.sort((left, right) => comparePaths(left.path, right.path));
}

export function isZipArchive(bytes: Uint8Array): boolean {
  try {
    decodeZipArchive(bytes);
    return true;
  } catch {
    return false;
  }
}

function prepareEntry(entry: FileSystemArchiveEntry): {
  readonly path: string;
  readonly kind: FileSystemArchiveEntry['kind'];
  readonly archivePath: string;
  readonly attributes: number;
  readonly data: Uint8Array;
  readonly mtimeMs: number;
} {
  const path = assertSafePath(entry.path);
  const mtimeMs = zipMtime(entry.mtimeMs);
  if (entry.kind === 'file') {
    const mode = zipMode(entry.mode ?? DEFAULT_ARCHIVE_FILE_MODE, path);
    return { path, kind: 'file', archivePath: path, attributes: (unixFileType | mode) << 16, data: entry.data.slice(), mtimeMs };
  }
  if (entry.kind === 'directory') {
    const mode = zipMode(entry.mode ?? DEFAULT_ARCHIVE_DIRECTORY_MODE, path);
    return {
      path,
      kind: 'directory',
      archivePath: `${path}/`,
      attributes: ((unixDirectoryType | mode) << 16) | 0x10,
      data: new Uint8Array(),
      mtimeMs
    };
  }
  if (entry.kind === 'symlink') {
    return {
      path,
      kind: 'symlink',
      archivePath: path,
      attributes: unixSymlinkMode << 16,
      data: textEncoder.encode(entry.target),
      mtimeMs
    };
  }
  throw new Error(`Unsupported ZIP entry kind: ${String((entry as { kind?: unknown }).kind)}`);
}

function readCentralDirectory(bytes: Uint8Array): CentralDirectoryEntry[] {
  const eocdOffset = findEndOfCentralDirectory(bytes);
  const entryCount = readU16(bytes, eocdOffset + 10);
  const centralDirectorySize = readU32(bytes, eocdOffset + 12);
  const centralDirectoryOffset = readU32(bytes, eocdOffset + 16);
  if (
    readU16(bytes, eocdOffset + 4) !== 0 ||
    readU16(bytes, eocdOffset + 6) !== 0 ||
    readU16(bytes, eocdOffset + 8) !== entryCount ||
    entryCount === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff ||
    centralDirectoryOffset + centralDirectorySize !== eocdOffset
  ) {
    throw invalidZipArchive('unsupported multi-disk or ZIP64 archive');
  }

  const entries: CentralDirectoryEntry[] = [];
  const paths = new Set<string>();
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocdOffset || readU32(bytes, offset) !== zipCentralDirectorySignature) {
      throw invalidZipArchive('invalid central directory entry');
    }
    const flags = readU16(bytes, offset + 8);
    const compression = readU16(bytes, offset + 10);
    const compressedSize = readU32(bytes, offset + 20);
    const nameLength = readU16(bytes, offset + 28);
    const extraLength = readU16(bytes, offset + 30);
    const commentLength = readU16(bytes, offset + 32);
    const diskNumber = readU16(bytes, offset + 34);
    const attributes = readU32(bytes, offset + 38);
    const localHeaderOffset = readU32(bytes, offset + 42);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (
      flags & 1 ||
      diskNumber !== 0 ||
      nextOffset > eocdOffset ||
      localHeaderOffset === 0xffffffff ||
      (compression !== 0 && compression !== 8)
    ) {
      throw invalidZipArchive('unsupported ZIP entry metadata');
    }

    const rawName = bytes.slice(offset + 46, offset + 46 + nameLength);
    const archivePath = decodePath(rawName, Boolean(flags & 0x800));
    const versionMadeBy = readU16(bytes, offset + 4);
    const kind = entryKind(archivePath, versionMadeBy, attributes);
    const mode = entryMode(kind, versionMadeBy, attributes);
    validateLocalHeader(bytes, localHeaderOffset, rawName, flags, compression, compressedSize, eocdOffset);
    if (paths.has(archivePath)) throw invalidZipArchive(`duplicate ZIP entry ${archivePath}`);
    paths.add(archivePath);
    entries.push({
      archivePath,
      compressedSize,
      kind,
      mtimeMs: decodeMtime(readU16(bytes, offset + 12), readU16(bytes, offset + 14)),
      ...(mode === undefined ? {} : { mode })
    });
    offset = nextOffset;
  }
  if (offset !== eocdOffset) throw invalidZipArchive('invalid central directory length');
  return entries;
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  for (let offset = bytes.byteLength - 22; offset >= Math.max(0, bytes.byteLength - 65_557); offset -= 1) {
    if (
      readU32(bytes, offset) === zipEocdSignature &&
      offset + 22 + readU16(bytes, offset + 20) === bytes.byteLength
    ) {
      return offset;
    }
  }
  throw invalidZipArchive('missing end of central directory');
}

function validateLocalHeader(
  bytes: Uint8Array,
  offset: number,
  expectedName: Uint8Array,
  expectedFlags: number,
  expectedCompression: number,
  compressedSize: number,
  centralDirectoryOffset: number
): void {
  if (offset + 30 > centralDirectoryOffset || readU32(bytes, offset) !== zipLocalFileSignature) {
    throw invalidZipArchive('invalid local file header');
  }
  const flags = readU16(bytes, offset + 6);
  const compression = readU16(bytes, offset + 8);
  const nameLength = readU16(bytes, offset + 26);
  const extraLength = readU16(bytes, offset + 28);
  const dataOffset = offset + 30 + nameLength + extraLength;
  if (
    flags !== expectedFlags ||
    compression !== expectedCompression ||
    dataOffset + compressedSize > centralDirectoryOffset ||
    nameLength !== expectedName.byteLength ||
    !equalBytes(bytes.subarray(offset + 30, offset + 30 + nameLength), expectedName)
  ) {
    throw invalidZipArchive('local file header does not match central directory');
  }
}

function entryKind(archivePath: string, versionMadeBy: number, attributes: number): FileSystemArchiveEntry['kind'] {
  const os = versionMadeBy >>> 8;
  const unixType = (attributes >>> 16) & 0o170000;
  if (os === unixOs && unixType === 0o120000) {
    assertSafePath(archivePath);
    return 'symlink';
  }
  if (archivePath.endsWith('/') || (os === unixOs && unixType === 0o040000)) {
    const path = archivePath.endsWith('/') ? archivePath.slice(0, -1) : archivePath;
    assertSafePath(path);
    return 'directory';
  }
  assertSafePath(archivePath);
  return 'file';
}

function entryMode(
  kind: FileSystemArchiveEntry['kind'],
  versionMadeBy: number,
  attributes: number
): number | undefined {
  // Only Unix-made entries carry a mode; some Unix writers leave it zero.
  if (kind === 'symlink' || versionMadeBy >>> 8 !== unixOs || attributes >>> 16 === 0) return undefined;
  const mode = (attributes >>> 16) & 0o7777;
  const defaultMode = kind === 'directory' ? DEFAULT_ARCHIVE_DIRECTORY_MODE : DEFAULT_ARCHIVE_FILE_MODE;
  return mode === defaultMode ? undefined : mode;
}

function decodePath(bytes: Uint8Array, utf8: boolean): string {
  if (!utf8) {
    let path = '';
    for (const byte of bytes) path += String.fromCharCode(byte);
    return path;
  }
  return textDecoder.decode(bytes);
}

function assertSafePath(path: string): string {
  if (
    !path ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`Unsafe ZIP entry path: ${path}`);
  }
  return path;
}

function assertEntryTree(entries: readonly Pick<FileSystemArchiveEntry, 'path' | 'kind'>[]): void {
  const kinds = new Map<string, FileSystemArchiveEntry['kind']>();
  for (const entry of entries) {
    if (kinds.has(entry.path)) throw new Error(`Duplicate ZIP entry path: ${entry.path}`);
    const segments = entry.path.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = segments.slice(0, index).join('/');
      if (kinds.has(ancestor) && kinds.get(ancestor) !== 'directory') {
        throw new Error(`ZIP entry ${entry.path} has a non-directory ancestor ${ancestor}`);
      }
    }
    for (const [path, kind] of kinds) {
      if (path.startsWith(`${entry.path}/`) && entry.kind !== 'directory') {
        throw new Error(`ZIP entry ${entry.path} conflicts with descendant ${path}`);
      }
      if (kind !== 'directory' && entry.path.startsWith(`${path}/`)) {
        throw new Error(`ZIP entry ${entry.path} has a non-directory ancestor ${path}`);
      }
    }
    kinds.set(entry.path, entry.kind);
  }
}

function zipMode(mode: number, path: string): number {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw new Error(`Invalid ZIP entry mode: ${path}`);
  return mode;
}

function zipMtime(mtimeMs: number): number {
  if (!Number.isFinite(mtimeMs)) throw new Error(`Invalid ZIP modification time: ${mtimeMs}`);
  const date = new Date(mtimeMs);
  if (date.getFullYear() < 1980 || date.getFullYear() > 2099) {
    throw new Error(`ZIP modification time is outside the supported range: ${mtimeMs}`);
  }
  date.setMilliseconds(0);
  date.setSeconds(date.getSeconds() - (date.getSeconds() % 2));
  return date.getTime();
}

function decodeMtime(time: number, date: number): number {
  const seconds = (time & 0x1f) * 2;
  const minutes = (time >>> 5) & 0x3f;
  const hours = time >>> 11;
  const day = date & 0x1f;
  const month = (date >>> 5) & 0x0f;
  const year = 1980 + (date >>> 9);
  if (hours > 23 || minutes > 59 || seconds > 59 || day === 0 || month === 0 || month > 12) {
    throw invalidZipArchive('invalid ZIP modification time');
  }
  const mtime = new Date(year, month - 1, day, hours, minutes, seconds, 0);
  if (mtime.getFullYear() !== year || mtime.getMonth() !== month - 1 || mtime.getDate() !== day) {
    throw invalidZipArchive('invalid ZIP modification date');
  }
  return mtime.getTime();
}

function readU16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.byteLength) throw invalidZipArchive('unexpected end of archive');
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) throw invalidZipArchive('unexpected end of archive');
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function comparePaths(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function invalidZipArchive(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Invalid ZIP archive: ${message}`);
}
