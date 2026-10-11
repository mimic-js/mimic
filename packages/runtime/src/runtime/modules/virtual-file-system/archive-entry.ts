export type FileSystemArchiveEntry =
  | {
      readonly path: string;
      readonly kind: 'file';
      readonly data: Uint8Array;
      readonly mtimeMs: number;
      /** Permission bits; omitted for the default file mode. */
      readonly mode?: number;
    }
  | {
      readonly path: string;
      readonly kind: 'directory';
      readonly mtimeMs: number;
      /** Permission bits; omitted for the default directory mode. */
      readonly mode?: number;
    }
  | {
      readonly path: string;
      readonly kind: 'symlink';
      readonly target: string;
      readonly mtimeMs: number;
    };

/** The Virtual File System's default modes, written when an entry has no mode. */
export const DEFAULT_ARCHIVE_FILE_MODE = 0o644;
export const DEFAULT_ARCHIVE_DIRECTORY_MODE = 0o755;

export function concatenateArchiveChunks(
  chunks: readonly Uint8Array[]
): Uint8Array {
  let totalLength = 0;
  for (const chunk of chunks) {
    totalLength += chunk.byteLength;
    if (!Number.isSafeInteger(totalLength)) {
      throw new RangeError('Filesystem archive exceeds the supported size.');
    }
  }
  const archive = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return archive;
}
