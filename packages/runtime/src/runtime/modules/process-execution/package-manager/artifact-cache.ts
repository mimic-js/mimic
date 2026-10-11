/**
 * Verified tarball bytes of the pinned package-manager CLIs and of Browser
 * Package Replacement artifacts, keyed by `name@version`. Only bytes that
 * passed their integrity check are stored. Once the stored bytes exceed the
 * budget, the oldest entries are evicted.
 */
export interface ArtifactCache {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, bytes: Uint8Array): Promise<void>;
}

export const ARTIFACT_CACHE_BUDGET_BYTES = 256 * 1024 * 1024;

const OPFS_DIRECTORY = 'mimic-artifacts-v2';
/** Directories of earlier cache formats, removed when the cache opens. */
const RETIRED_OPFS_DIRECTORIES = ['mimic-cache-v1'];

export function createArtifactCache(
  budgetBytes = ARTIFACT_CACHE_BUDGET_BYTES
): ArtifactCache {
  return typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function'
    ? new OpfsArtifactCache(budgetBytes)
    : new MemoryArtifactCache(budgetBytes);
}

export class MemoryArtifactCache implements ArtifactCache {
  readonly #entries = new Map<string, Uint8Array>();

  constructor(private readonly budgetBytes = ARTIFACT_CACHE_BUDGET_BYTES) {}

  async get(key: string): Promise<Uint8Array | undefined> {
    return this.#entries.get(key)?.slice();
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.#entries.delete(key);
    this.#entries.set(key, bytes.slice());
    let size = 0;
    for (const entry of this.#entries.values()) size += entry.byteLength;
    for (const [candidate, entry] of this.#entries) {
      if (size <= this.budgetBytes) break;
      this.#entries.delete(candidate);
      size -= entry.byteLength;
    }
  }

  keys(): readonly string[] {
    return [...this.#entries.keys()];
  }
}

class OpfsArtifactCache implements ArtifactCache {
  /** Undefined where the browser denies this context its origin private file system. */
  readonly #directory: Promise<FileSystemDirectoryHandle | undefined>;
  // The runtime runs in a frame of the preview origin (ADR-0033); a browser
  // that denies storage to a cross-site frame leaves the cache in memory.
  readonly #memory: MemoryArtifactCache;

  constructor(private readonly budgetBytes: number) {
    this.#memory = new MemoryArtifactCache(budgetBytes);
    this.#directory = navigator.storage
      .getDirectory()
      .then(async (root) => {
        for (const retired of RETIRED_OPFS_DIRECTORIES) {
          await root.removeEntry(retired, { recursive: true }).catch(() => undefined);
        }
        return root.getDirectoryHandle(OPFS_DIRECTORY, { create: true });
      })
      .catch(() => undefined);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const directory = await this.#directory;
    if (!directory) return this.#memory.get(key);
    try {
      const handle = await directory.getFileHandle(fileName(key));
      return new Uint8Array(await (await handle.getFile()).arrayBuffer());
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return undefined;
      throw error;
    }
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const directory = await this.#directory;
    if (!directory) return this.#memory.put(key, bytes);
    const name = fileName(key);
    try {
      const writable = await (await directory.getFileHandle(name, { create: true })).createWritable();
      try {
        await writable.write(toArrayBuffer(bytes));
        await writable.close();
      } catch (error) {
        await writable.abort().catch(() => undefined);
        throw error;
      }
    } catch (error) {
      await directory.removeEntry(name).catch(() => undefined);
      // A full origin leaves the artifact uncached instead of failing the caller.
      if (isStorageExhausted(error)) return;
      throw error;
    }
    await this.#evict(directory);
  }

  async #evict(directory: FileSystemDirectoryHandle): Promise<void> {
    const files: { name: string; size: number; lastModified: number }[] = [];
    for await (const handle of directoryHandles(directory)) {
      if (handle.kind !== 'file') continue;
      let file: File;
      try {
        file = await (handle as FileSystemFileHandle).getFile();
      } catch (error) {
        // A concurrent put or eviction removed the entry, or it was the swap
        // file of a write that has since finished.
        if (error instanceof DOMException && error.name === 'NotFoundError') continue;
        throw error;
      }
      files.push({ name: handle.name, size: file.size, lastModified: file.lastModified });
    }
    let size = files.reduce((total, file) => total + file.size, 0);
    files.sort((left, right) => left.lastModified - right.lastModified);
    for (const file of files) {
      if (size <= this.budgetBytes) return;
      await directory.removeEntry(file.name).catch(() => undefined);
      size -= file.size;
    }
  }
}

function directoryHandles(
  directory: FileSystemDirectoryHandle
): AsyncIterable<FileSystemHandle> {
  return (directory as FileSystemDirectoryHandle & {
    values(): AsyncIterable<FileSystemHandle>;
  }).values();
}

function fileName(key: string): string {
  return `${encodeURIComponent(key)}.tgz`;
}

function isStorageExhausted(error: unknown): boolean {
  // Chromium reports a full origin as QuotaExceededError, and under the same
  // pressure aborts an in-flight write ("Failed to write data to data pipe").
  return error instanceof DOMException &&
    (error.name === 'QuotaExceededError' || error.name === 'AbortError');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
