import type { CompiledArtifactStore } from '../module-execution-engine';

const STORE_DIRECTORY = 'mimic-compile-cache';
/** The default bound of persisted compiled text. */
const COMPILED_ARTIFACT_STORE_BYTES = 256 * 1024 * 1024;

type DirectoryHandle = FileSystemDirectoryHandle & {
  entries(): AsyncIterable<[string, FileSystemHandle]>;
};

type Entry = { size: number; time: number };

/**
 * Compiled text persisted in the origin private file system, one file per
 * entry in a directory per compiler version, so every epoch of this origin
 * (a reload, another tab) reuses what any earlier one compiled. Directories of
 * other compiler versions are removed when the store opens. When the entries
 * exceed `maxBytes`, the oldest written are removed first.
 *
 * Resolves to undefined where the origin private file system is unavailable;
 * compiled text is then kept for the epoch only.
 */
export async function openCompiledArtifactStore(options: {
  readonly version: string;
  readonly maxBytes?: number;
}): Promise<CompiledArtifactStore | undefined> {
  const maxBytes = options.maxBytes ?? COMPILED_ARTIFACT_STORE_BYTES;
  const versionName = options.version.replace(/[^A-Za-z0-9.@+-]/g, '_');
  let directory: DirectoryHandle;
  try {
    const root = await navigator.storage.getDirectory();
    const cache = (await root.getDirectoryHandle(STORE_DIRECTORY, { create: true })) as DirectoryHandle;
    directory = (await cache.getDirectoryHandle(versionName, { create: true })) as DirectoryHandle;
    void removeOtherVersions(cache, versionName);
  } catch {
    return undefined;
  }

  const entries = new Map<string, Entry>();
  let bytes = 0;
  const record = (key: string, entry: Entry): void => {
    const previous = entries.get(key);
    if (previous) bytes -= previous.size;
    entries.set(key, entry);
    bytes += entry.size;
  };
  // The index of what earlier epochs wrote is read in the background. Once
  // it is complete, a key it does not hold is answered as absent without
  // asking the file system; until then every key is looked up. Another tab's
  // later writes are not in it, which costs a compilation, not correctness.
  let complete = false;
  const indexed = (async () => {
    for await (const [name, handle] of directory.entries()) {
      if (handle.kind !== 'file' || entries.has(name)) continue;
      const file = await (handle as FileSystemFileHandle).getFile().catch(() => undefined);
      if (file) record(name, { size: file.size, time: file.lastModified });
    }
    complete = true;
  })().catch(() => undefined);
  const absent = (key: string): boolean => complete && !entries.has(key);

  let evicting = false;
  const evict = async (): Promise<void> => {
    if (evicting || bytes <= maxBytes) return;
    evicting = true;
    try {
      await indexed;
      const oldestFirst = [...entries].sort((left, right) => left[1].time - right[1].time);
      for (const [key, entry] of oldestFirst) {
        if (bytes <= maxBytes * 0.9) break;
        entries.delete(key);
        bytes -= entry.size;
        await directory.removeEntry(key).catch(() => undefined);
      }
    } finally {
      evicting = false;
    }
  };

  return {
    async read(key) {
      if (absent(key)) return undefined;
      try {
        const handle = await directory.getFileHandle(key);
        return await (await handle.getFile()).text();
      } catch {
        return undefined;
      }
    },
    async has(key) {
      if (absent(key)) return false;
      try {
        await directory.getFileHandle(key);
        return true;
      } catch {
        return false;
      }
    },
    async write(key, text) {
      // Recorded before it is written, so a read meanwhile looks for it.
      record(key, { size: text.length, time: Date.now() });
      try {
        const handle = await directory.getFileHandle(key, { create: true });
        const writable = await handle.createWritable();
        try {
          await writable.write(text);
          await writable.close();
        } catch (error) {
          await writable.abort().catch(() => undefined);
          throw error;
        }
      } catch (error) {
        const entry = entries.get(key);
        if (entry) {
          entries.delete(key);
          bytes -= entry.size;
        }
        throw error;
      }
      await evict();
    }
  };
}

async function removeOtherVersions(cache: DirectoryHandle, current: string): Promise<void> {
  const stale: string[] = [];
  for await (const [name] of cache.entries()) if (name !== current) stale.push(name);
  for (const name of stale) await cache.removeEntry(name, { recursive: true }).catch(() => undefined);
}
