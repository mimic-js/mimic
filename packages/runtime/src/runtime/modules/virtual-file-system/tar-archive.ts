import {
  concatenateArchiveChunks,
  DEFAULT_ARCHIVE_DIRECTORY_MODE,
  DEFAULT_ARCHIVE_FILE_MODE,
  type FileSystemArchiveEntry
} from './archive-entry';

const BLOCK_SIZE = 512;
const TAR_MAGIC_OFFSET = 257;
const TAR_VERSION_OFFSET = 263;
const TAR_NAME_OFFSET = 0;
const TAR_NAME_LENGTH = 100;
const TAR_MODE_OFFSET = 100;
const TAR_UID_OFFSET = 108;
const TAR_GID_OFFSET = 116;
const TAR_SIZE_OFFSET = 124;
const TAR_MTIME_OFFSET = 136;
const TAR_CHECKSUM_OFFSET = 148;
const TAR_TYPE_OFFSET = 156;
const TAR_LINK_NAME_OFFSET = 157;
const TAR_LINK_NAME_LENGTH = 100;
const TAR_PREFIX_OFFSET = 345;
const TAR_PREFIX_LENGTH = 155;

const textEncoder = new TextEncoder();
const strictTextDecoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Encodes a deterministic POSIX ustar archive. Paths and timestamps are
 * normalized to the format's relative-path and one-second boundaries; a path
 * or symlink target too long for a ustar header travels in a pax extended
 * header before its entry, as `tar` and npm write them.
 */
export function encodeTarArchive(entries: readonly FileSystemArchiveEntry[]): Uint8Array {
  const normalizedEntries = entries.map(normalizeEntry).sort(compareEntries);
  const seenPaths = new Set<string>();
  const chunks: Uint8Array[] = [];

  for (const entry of normalizedEntries) {
    if (seenPaths.has(entry.path)) throw tarError(`Archive contains duplicate path: ${entry.path}`);
    seenPaths.add(entry.path);

    const extended: Array<[string, string]> = [];
    if (!fitsUstarPath(entry.path)) extended.push(['path', entry.path]);
    if (entry.kind === 'symlink' && textEncoder.encode(entry.target).byteLength > TAR_LINK_NAME_LENGTH) {
      extended.push(['linkpath', entry.target]);
    }
    if (extended.length > 0) chunks.push(...paxHeader(entry.path, entry.mtimeMs, extended));

    const header = new Uint8Array(BLOCK_SIZE);
    writePath(header, entry.path);
    writeOctal(
      header,
      TAR_MODE_OFFSET,
      8,
      entry.kind === 'directory'
        ? entry.mode ?? DEFAULT_ARCHIVE_DIRECTORY_MODE
        : entry.kind === 'symlink' ? 0o777 : entry.mode ?? DEFAULT_ARCHIVE_FILE_MODE
    );
    writeOctal(header, TAR_UID_OFFSET, 8, 0);
    writeOctal(header, TAR_GID_OFFSET, 8, 0);
    writeOctal(header, TAR_SIZE_OFFSET, 12, entry.kind === 'file' ? entry.data.byteLength : 0);
    writeOctal(header, TAR_MTIME_OFFSET, 12, Math.floor(entry.mtimeMs / 1_000));
    header.set([0x75, 0x73, 0x74, 0x61, 0x72, 0], TAR_MAGIC_OFFSET);
    header.set([0x30, 0x30], TAR_VERSION_OFFSET);

    if (entry.kind === 'file') {
      header[TAR_TYPE_OFFSET] = 0x30;
    } else if (entry.kind === 'directory') {
      header[TAR_TYPE_OFFSET] = 0x35;
    } else {
      header[TAR_TYPE_OFFSET] = 0x32;
      writeString(
        header,
        TAR_LINK_NAME_OFFSET,
        TAR_LINK_NAME_LENGTH,
        truncateUtf8(entry.target, TAR_LINK_NAME_LENGTH),
        'symlink target'
      );
    }

    writeChecksum(header);
    chunks.push(header);
    if (entry.kind === 'file') {
      chunks.push(entry.data);
      const paddingLength = paddingFor(entry.data.byteLength);
      if (paddingLength > 0) chunks.push(new Uint8Array(paddingLength));
    }
  }

  chunks.push(new Uint8Array(BLOCK_SIZE * 2));
  return concatenateArchiveChunks(chunks);
}

/**
 * Decodes a strict POSIX ustar archive and rejects unsafe or malformed
 * entries. The pax `path` and `linkpath` records and GNU long names replace
 * the fields of the entry that follows them; other extensions are ignored.
 */
export function decodeTarArchive(bytes: Uint8Array): FileSystemArchiveEntry[] {
  if (!(bytes instanceof Uint8Array)) throw tarError('TAR archive bytes must be a Uint8Array.');
  if (bytes.byteLength < BLOCK_SIZE * 2 || bytes.byteLength % BLOCK_SIZE !== 0) {
    throw tarError('TAR archive is truncated.');
  }

  const entries: FileSystemArchiveEntry[] = [];
  const seenPaths = new Set<string>();
  let offset = 0;
  let pendingPath: string | undefined;
  let pendingTarget: string | undefined;

  while (offset < bytes.byteLength) {
    if (isZeroBlock(bytes, offset)) {
      if (offset + BLOCK_SIZE * 2 > bytes.byteLength || !isZeroBlock(bytes, offset + BLOCK_SIZE)) {
        throw tarError('TAR archive is missing its second end-of-archive block.');
      }
      for (let index = offset + BLOCK_SIZE * 2; index < bytes.byteLength; index += 1) {
        if (bytes[index] !== 0) throw tarError('TAR archive has data after its end marker.');
      }
      return entries;
    }

    const headerOffset = offset;
    validateHeader(bytes, headerOffset);
    const size = readOctal(bytes, headerOffset + TAR_SIZE_OFFSET, 12, 'size');
    const type = bytes[headerOffset + TAR_TYPE_OFFSET];
    if (type === 0x78 || type === 0x67 || type === 0x4c || type === 0x4b) {
      const dataOffset = headerOffset + BLOCK_SIZE;
      const nextOffset = dataOffset + size + paddingFor(size);
      if (!Number.isSafeInteger(nextOffset) || nextOffset > bytes.byteLength) {
        throw tarError('TAR extended header is truncated.');
      }
      const data = bytes.subarray(dataOffset, dataOffset + size);
      if (type === 0x78) {
        const records = readPaxRecords(data);
        if (records.has('path')) pendingPath = records.get('path');
        if (records.has('linkpath')) pendingTarget = records.get('linkpath');
      } else if (type === 0x4c) {
        pendingPath = readString(data, 0, data.byteLength, 'long path name');
      } else if (type === 0x4b) {
        pendingTarget = readString(data, 0, data.byteLength, 'long symlink target');
      }
      offset = nextOffset;
      continue;
    }
    const path = normalizeArchivePath(pendingPath ?? readPath(bytes, headerOffset));
    const longTarget = pendingTarget;
    pendingPath = undefined;
    pendingTarget = undefined;
    if (seenPaths.has(path)) throw tarError(`Archive contains duplicate path: ${path}`);
    seenPaths.add(path);

    const mode = readOctal(bytes, headerOffset + TAR_MODE_OFFSET, 8, 'mode') & 0o7777;
    const mtimeSeconds = readOctal(bytes, headerOffset + TAR_MTIME_OFFSET, 12, 'modification time');
    const dataOffset = headerOffset + BLOCK_SIZE;
    const paddingLength = paddingFor(size);
    const nextOffset = dataOffset + size + paddingLength;
    if (!Number.isSafeInteger(nextOffset) || nextOffset > bytes.byteLength) {
      throw tarError(`TAR entry is truncated: ${path}`);
    }

    const mtimeMs = mtimeSeconds * 1_000;
    if (type === 0 || type === 0x30) {
      entries.push({
        path,
        kind: 'file',
        data: bytes.slice(dataOffset, dataOffset + size),
        mtimeMs,
        ...(mode !== DEFAULT_ARCHIVE_FILE_MODE ? { mode } : {})
      });
    } else if (type === 0x35) {
      if (size !== 0) throw tarError(`Directory entry has data: ${path}`);
      entries.push({
        path,
        kind: 'directory',
        mtimeMs,
        ...(mode !== DEFAULT_ARCHIVE_DIRECTORY_MODE ? { mode } : {})
      });
    } else if (type === 0x32) {
      if (size !== 0) throw tarError(`Symlink entry has data: ${path}`);
      const target =
        longTarget ?? readString(bytes, headerOffset + TAR_LINK_NAME_OFFSET, TAR_LINK_NAME_LENGTH, 'symlink target');
      if (!target) throw tarError(`Symlink entry has an empty target: ${path}`);
      entries.push({ path, kind: 'symlink', target, mtimeMs });
    } else {
      throw tarError(`Unsupported TAR entry type: ${String.fromCharCode(type ?? 0)}`);
    }
    offset = nextOffset;
  }

  throw tarError('TAR archive is missing an end marker.');
}

/** Returns true only for complete, checksum-valid, safe POSIX ustar archives. */
export function isTarArchive(bytes: Uint8Array): boolean {
  try {
    decodeTarArchive(bytes);
    return true;
  } catch {
    return false;
  }
}

function normalizeEntry(entry: FileSystemArchiveEntry): FileSystemArchiveEntry {
  const path = normalizeArchivePath(entry.path);
  const mtimeMs = normalizeMtime(entry.mtimeMs);
  if (entry.kind === 'file') {
    if (!(entry.data instanceof Uint8Array)) throw tarError(`File entry data must be a Uint8Array: ${path}`);
    return { path, kind: 'file', data: entry.data, mtimeMs, mode: normalizeMode(entry.mode, path) };
  }
  if (entry.kind === 'directory') return { path, kind: 'directory', mtimeMs, mode: normalizeMode(entry.mode, path) };
  if (entry.kind === 'symlink') {
    assertString(entry.target, 'symlink target');
    if (!entry.target) throw tarError(`Symlink entry has an empty target: ${path}`);
    return { path, kind: 'symlink', target: entry.target, mtimeMs };
  }
  throw tarError(`Unsupported TAR entry kind: ${String((entry as { kind?: unknown }).kind)}`);
}

function normalizeArchivePath(value: string): string {
  assertString(value, 'entry path');
  if (value.startsWith('/')) throw tarError(`Archive path must be relative: ${value}`);

  const segments: string[] = [];
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') throw tarError(`Archive path must not traverse parent directories: ${value}`);
    assertString(segment, 'path segment');
    segments.push(segment);
  }
  if (segments.length === 0) throw tarError('Archive path must name an entry.');
  return segments.join('/');
}

function normalizeMtime(mtimeMs: number): number {
  if (!Number.isFinite(mtimeMs) || mtimeMs < 0) throw tarError('TAR modification time must be a non-negative finite number.');
  const seconds = Math.floor(mtimeMs / 1_000);
  if (!Number.isSafeInteger(seconds)) throw tarError('TAR modification time is outside the supported range.');
  return seconds * 1_000;
}

function normalizeMode(mode: number | undefined, path: string): number | undefined {
  if (mode !== undefined && (!Number.isInteger(mode) || mode < 0 || mode > 0o7777)) {
    throw tarError(`TAR entry mode must be permission bits: ${path}`);
  }
  return mode;
}

function compareEntries(left: FileSystemArchiveEntry, right: FileSystemArchiveEntry): number {
  return compareBytes(textEncoder.encode(left.path), textEncoder.encode(right.path));
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.byteLength - right.byteLength;
}

/** Writes the path, or where a pax `path` record carries it, a truncated stand-in. */
function writePath(header: Uint8Array, path: string): void {
  const pathParts = splitUstarPath(path) ?? { name: truncateUtf8(path, TAR_NAME_LENGTH), prefix: '' };
  writeString(header, TAR_NAME_OFFSET, TAR_NAME_LENGTH, pathParts.name, 'path name');
  if (pathParts.prefix) writeString(header, TAR_PREFIX_OFFSET, TAR_PREFIX_LENGTH, pathParts.prefix, 'path prefix');
}

function fitsUstarPath(path: string): boolean {
  return splitUstarPath(path) !== undefined;
}

/** A pax extended header (`x`) and its records, for the entry that follows. */
function paxHeader(path: string, mtimeMs: number, records: ReadonlyArray<[string, string]>): Uint8Array[] {
  const data = textEncoder.encode(records.map(([key, value]) => paxRecord(key, value)).join(''));
  const header = new Uint8Array(BLOCK_SIZE);
  const base = path.slice(path.lastIndexOf('/') + 1);
  writeString(header, TAR_NAME_OFFSET, TAR_NAME_LENGTH, truncateUtf8(`PaxHeader/${base}`, TAR_NAME_LENGTH), 'path name');
  writeOctal(header, TAR_MODE_OFFSET, 8, 0o644);
  writeOctal(header, TAR_UID_OFFSET, 8, 0);
  writeOctal(header, TAR_GID_OFFSET, 8, 0);
  writeOctal(header, TAR_SIZE_OFFSET, 12, data.byteLength);
  writeOctal(header, TAR_MTIME_OFFSET, 12, Math.floor(mtimeMs / 1_000));
  header[TAR_TYPE_OFFSET] = 0x78;
  header.set([0x75, 0x73, 0x74, 0x61, 0x72, 0], TAR_MAGIC_OFFSET);
  header.set([0x30, 0x30], TAR_VERSION_OFFSET);
  writeChecksum(header);
  const padding = paddingFor(data.byteLength);
  return padding > 0 ? [header, data, new Uint8Array(padding)] : [header, data];
}

/** `"<length> <key>=<value>\n"`, whose length counts its own digits. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  const bodyLength = textEncoder.encode(body).byteLength;
  let digits = 1;
  while (String(bodyLength + digits).length > digits) digits += 1;
  return `${bodyLength + digits}${body}`;
}

function readPaxRecords(data: Uint8Array): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < data.byteLength) {
    let space = offset;
    while (space < data.byteLength && data[space] !== 0x20) space += 1;
    const length = Number(new TextDecoder().decode(data.subarray(offset, space)));
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > data.byteLength) {
      throw tarError('TAR pax header record is malformed.');
    }
    let record: string;
    try {
      record = strictTextDecoder.decode(data.subarray(space + 1, offset + length - 1));
    } catch {
      throw tarError('TAR pax header record is not valid UTF-8.');
    }
    const separator = record.indexOf('=');
    if (separator <= 0) throw tarError('TAR pax header record is malformed.');
    records.set(record.slice(0, separator), record.slice(separator + 1));
    offset += length;
  }
  return records;
}

/** The longest prefix of `value` that encodes in at most `length` bytes. */
function truncateUtf8(value: string, length: number): string {
  let result = '';
  let size = 0;
  for (const character of value) {
    const characterSize = textEncoder.encode(character).byteLength;
    if (size + characterSize > length) break;
    result += character;
    size += characterSize;
  }
  return result;
}

function splitUstarPath(path: string): { readonly name: string; readonly prefix: string } | undefined {
  if (textEncoder.encode(path).byteLength <= TAR_NAME_LENGTH) return { name: path, prefix: '' };

  for (let index = 0; index < path.length; index += 1) {
    if (path[index] !== '/') continue;
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (textEncoder.encode(prefix).byteLength <= TAR_PREFIX_LENGTH && textEncoder.encode(name).byteLength <= TAR_NAME_LENGTH) {
      return { name, prefix };
    }
  }
  return undefined;
}

function writeString(buffer: Uint8Array, offset: number, length: number, value: string, label: string): void {
  assertString(value, label);
  const encoded = textEncoder.encode(value);
  if (encoded.byteLength > length) throw tarError(`TAR ${label} exceeds its supported length.`);
  buffer.set(encoded, offset);
}

function writeOctal(buffer: Uint8Array, offset: number, length: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw tarError('TAR numeric field is outside the supported range.');
  const digits = value.toString(8);
  if (digits.length > length - 1) throw tarError('TAR numeric field is outside the POSIX ustar range.');
  const padded = digits.padStart(length - 1, '0');
  for (let index = 0; index < padded.length; index += 1) buffer[offset + index] = padded.charCodeAt(index);
  buffer[offset + length - 1] = 0;
}

function writeChecksum(header: Uint8Array): void {
  header.fill(0x20, TAR_CHECKSUM_OFFSET, TAR_CHECKSUM_OFFSET + 8);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const digits = checksum.toString(8);
  if (digits.length > 6) throw tarError('TAR checksum exceeds its supported range.');
  const padded = digits.padStart(6, '0');
  for (let index = 0; index < padded.length; index += 1) header[TAR_CHECKSUM_OFFSET + index] = padded.charCodeAt(index);
  header[TAR_CHECKSUM_OFFSET + 6] = 0;
  header[TAR_CHECKSUM_OFFSET + 7] = 0x20;
}

function validateHeader(bytes: Uint8Array, offset: number): void {
  if (offset + BLOCK_SIZE > bytes.byteLength) throw tarError('TAR header is truncated.');
  if (
    bytes[offset + TAR_MAGIC_OFFSET] !== 0x75 ||
    bytes[offset + TAR_MAGIC_OFFSET + 1] !== 0x73 ||
    bytes[offset + TAR_MAGIC_OFFSET + 2] !== 0x74 ||
    bytes[offset + TAR_MAGIC_OFFSET + 3] !== 0x61 ||
    bytes[offset + TAR_MAGIC_OFFSET + 4] !== 0x72 ||
    bytes[offset + TAR_MAGIC_OFFSET + 5] !== 0 ||
    bytes[offset + TAR_VERSION_OFFSET] !== 0x30 ||
    bytes[offset + TAR_VERSION_OFFSET + 1] !== 0x30
  ) {
    throw tarError('Archive entry is not POSIX ustar.');
  }

  const expectedChecksum = readOctal(bytes, offset + TAR_CHECKSUM_OFFSET, 8, 'checksum');
  let actualChecksum = 0;
  for (let index = 0; index < BLOCK_SIZE; index += 1) {
    actualChecksum += index >= TAR_CHECKSUM_OFFSET && index < TAR_CHECKSUM_OFFSET + 8 ? 0x20 : bytes[offset + index]!;
  }
  if (actualChecksum !== expectedChecksum) throw tarError('TAR header checksum is invalid.');

  readOctal(bytes, offset + TAR_MODE_OFFSET, 8, 'mode');
  readOctal(bytes, offset + TAR_UID_OFFSET, 8, 'uid');
  readOctal(bytes, offset + TAR_GID_OFFSET, 8, 'gid');
  readOctal(bytes, offset + TAR_SIZE_OFFSET, 12, 'size');
  readOctal(bytes, offset + TAR_MTIME_OFFSET, 12, 'modification time');
}

function readPath(bytes: Uint8Array, offset: number): string {
  const name = readString(bytes, offset + TAR_NAME_OFFSET, TAR_NAME_LENGTH, 'path name');
  const prefix = readString(bytes, offset + TAR_PREFIX_OFFSET, TAR_PREFIX_LENGTH, 'path prefix');
  if (!name) throw tarError('TAR entry has an empty path.');
  return prefix ? `${prefix}/${name}` : name;
}

function readString(bytes: Uint8Array, offset: number, length: number, label: string): string {
  let end = offset + length;
  for (let index = offset; index < offset + length; index += 1) {
    if (bytes[index] === 0) {
      end = index;
      for (let trailing = index + 1; trailing < offset + length; trailing += 1) {
        if (bytes[trailing] !== 0) throw tarError(`TAR ${label} has bytes after its terminator.`);
      }
      break;
    }
  }
  try {
    return strictTextDecoder.decode(bytes.subarray(offset, end));
  } catch {
    throw tarError(`TAR ${label} is not valid UTF-8.`);
  }
}

function readOctal(bytes: Uint8Array, offset: number, length: number, label: string): number {
  let index = offset;
  while (index < offset + length && bytes[index] === 0x20) index += 1;

  let value = 0;
  let hasDigits = false;
  while (index < offset + length) {
    const byte = bytes[index]!;
    if (byte === 0 || byte === 0x20) break;
    if (byte < 0x30 || byte > 0x37) throw tarError(`TAR ${label} is not an octal number.`);
    value = value * 8 + byte - 0x30;
    if (!Number.isSafeInteger(value)) throw tarError(`TAR ${label} exceeds the supported range.`);
    hasDigits = true;
    index += 1;
  }
  while (index < offset + length) {
    const byte = bytes[index]!;
    if (byte !== 0 && byte !== 0x20) throw tarError(`TAR ${label} has invalid padding.`);
    index += 1;
  }
  return hasDigits ? value : 0;
}

function paddingFor(size: number): number {
  const remainder = size % BLOCK_SIZE;
  return remainder === 0 ? 0 : BLOCK_SIZE - remainder;
}

function isZeroBlock(bytes: Uint8Array, offset: number): boolean {
  for (let index = offset; index < offset + BLOCK_SIZE; index += 1) {
    if (bytes[index] !== 0) return false;
  }
  return true;
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.includes('\0')) throw tarError(`TAR ${label} must be a string without NUL bytes.`);
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) throw tarError(`TAR ${label} must be well-formed Unicode.`);
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw tarError(`TAR ${label} must be well-formed Unicode.`);
    }
  }
}

function tarError(message: string): Error {
  return new Error(`Invalid TAR archive: ${message}`);
}
