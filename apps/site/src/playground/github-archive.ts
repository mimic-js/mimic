import type { FileSystemTree } from '@mimic-js/runtime';

export type Repository = {
  readonly owner: string;
  readonly name: string;
  /** A branch, tag or commit; `HEAD` is the default branch. */
  readonly ref: string;
};

const TAR_BLOCK = 512;
const decoder = new TextDecoder();

/** Reads `?repo=owner/name` (a github.com URL works too) and an optional `&ref=`. */
export function repositoryFromSearch(search: string): Repository | undefined {
  const params = new URLSearchParams(search);
  const match = /^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(
    params.get('repo')?.trim() ?? ''
  );
  if (!match) return undefined;
  return { owner: match[1]!, name: match[2]!, ref: params.get('ref')?.trim() || 'HEAD' };
}

const FILE_DOWNLOADS_AT_ONCE = 24;

/**
 * Downloads the repository and returns its files as a mountable tree.
 *
 * GitHub serves a repository's archive without CORS headers, so a page can
 * only read it through its own server: the development and preview servers
 * proxy `/github-archive/<owner>/<name>/tar.gz/<ref>` to codeload.github.com,
 * and so does the rewrite of the root `vercel.json`. Codeload answers that path
 * with the archive itself (`200`, `application/x-gzip`), not a redirect, and it
 * takes no query string. Where the application is hosted without such a
 * proxy, the files are listed through the GitHub API and read one by one from
 * raw.githubusercontent.com, which both allow any origin.
 */
export async function downloadRepository(
  repository: Repository,
  onProgress: (progress: string) => void,
  signal: AbortSignal
): Promise<FileSystemTree> {
  const archive = await requestArchive(repository, signal);
  return archive
    ? treeFromArchive(archive, onProgress)
    : treeFromFiles(repository, onProgress, signal);
}

/** The archive as the server's proxy returns it, or nothing where the server has no such proxy. */
async function requestArchive(
  { owner, name, ref }: Repository,
  signal: AbortSignal
): Promise<ReadableStream<Uint8Array<ArrayBuffer>> | undefined> {
  const refPath = ref.split('/').map(encodeURIComponent).join('/');
  const response = await fetch(`/github-archive/${owner}/${name}/tar.gz/${refPath}`, { signal }).catch(
    () => undefined
  );
  // A static host answers an unknown path with its own page or a 404 of its own.
  const gzip = response?.ok && /gzip/.test(response.headers.get('content-type') ?? '');
  if (!gzip || !response?.body) {
    await response?.body?.cancel();
    return undefined;
  }
  return response.body;
}

async function treeFromArchive(
  archive: ReadableStream<Uint8Array<ArrayBuffer>>,
  onProgress: (progress: string) => void
): Promise<FileSystemTree> {
  let received = 0;
  const counted = archive.pipeThrough(
    new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        onProgress(formatSize(received));
        controller.enqueue(chunk);
      }
    })
  );
  const tar = await new Response(counted.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  return treeFromTar(new Uint8Array(tar));
}

type GitTreeEntry = {
  readonly path: string;
  /** `120000` is a symbolic link, `100755` an executable file. */
  readonly mode: string;
  readonly type: 'blob' | 'tree' | 'commit';
};

async function treeFromFiles(
  { owner, name, ref }: Repository,
  onProgress: (progress: string) => void,
  signal: AbortSignal
): Promise<FileSystemTree> {
  const refPath = ref.split('/').map(encodeURIComponent).join('/');
  const listing = await fetch(
    `https://api.github.com/repos/${owner}/${name}/git/trees/${refPath}?recursive=1`,
    { signal }
  );
  if (listing.status === 404) {
    throw new Error(`GitHub has no public repository ${owner}/${name} at "${ref}".`);
  }
  if (listing.headers.get('x-ratelimit-remaining') === '0') {
    throw new Error('GitHub allows 60 anonymous API requests an hour from one address, and they are spent.');
  }
  if (!listing.ok) {
    throw new Error(`GitHub answered ${listing.status} for the file list of ${owner}/${name}.`);
  }
  const { tree, truncated } = (await listing.json()) as {
    readonly tree: readonly GitTreeEntry[];
    readonly truncated: boolean;
  };
  if (truncated) {
    throw new Error(`${owner}/${name} has more files than GitHub lists in one request.`);
  }

  const root: FileSystemTree = {};
  // A submodule is a `commit` entry: its files belong to another repository.
  const files = tree.filter((entry) => entry.type === 'blob');
  let downloaded = 0;
  const next = files[Symbol.iterator]();
  const download = async (): Promise<void> => {
    for (let entry = next.next(); !entry.done; entry = next.next()) {
      const { path, mode } = entry.value;
      const response = await fetch(
        `https://raw.githubusercontent.com/${owner}/${name}/${refPath}/${path.split('/').map(encodeURIComponent).join('/')}`,
        { signal }
      );
      if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path}.`);
      const contents = new Uint8Array(await response.arrayBuffer());
      const segments = path.split('/');
      const entryName = segments.pop()!;
      let directory = root;
      for (const segment of segments) directory = childDirectory(directory, segment);
      directory[entryName] =
        mode === '120000'
          ? { symlink: { target: decoder.decode(contents) } }
          : { file: { contents }, ...(mode === '100755' ? { mode: 0o755 } : {}) };
      onProgress(`${++downloaded} of ${files.length} files`);
    }
  };
  await Promise.all(Array.from({ length: FILE_DOWNLOADS_AT_ONCE }, download));
  return root;
}

function formatSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Converts a tar archive to a tree, without the single directory GitHub wraps a repository in. */
function treeFromTar(tar: Uint8Array): FileSystemTree {
  const root: FileSystemTree = {};
  // Records of a pax header apply to the one entry that follows it.
  let pax: Record<string, string> = {};

  for (let offset = 0; offset + TAR_BLOCK <= tar.byteLength; ) {
    const header = tar.subarray(offset, offset + TAR_BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const size = parseInt(text(header, 124, 12), 8) || 0;
    const body = tar.subarray(offset + TAR_BLOCK, offset + TAR_BLOCK + size);
    offset += TAR_BLOCK + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;

    const type = text(header, 156, 1) || '0';
    if (type === 'x') {
      pax = paxRecords(body);
      continue;
    }
    if (type === 'L') {
      pax = { ...pax, path: text(body, 0, body.byteLength) };
      continue;
    }
    const prefix = text(header, 345, 155);
    const path = pax.path ?? (prefix ? `${prefix}/` : '') + text(header, 0, 100);
    const linkTarget = pax.linkpath ?? text(header, 157, 100);
    pax = {};

    const segments = path.split('/').filter(Boolean).slice(1);
    const entryName = segments.pop();
    if (entryName === undefined) continue;
    let directory = root;
    for (const segment of segments) directory = childDirectory(directory, segment);

    if (type === '5') {
      childDirectory(directory, entryName);
    } else if (type === '2') {
      directory[entryName] = { symlink: { target: linkTarget } };
    } else if (type === '0') {
      const executable = (parseInt(text(header, 100, 8), 8) & 0o111) !== 0;
      directory[entryName] = {
        file: { contents: body.slice() },
        ...(executable ? { mode: 0o755 } : {})
      };
    }
  }
  return root;
}

function childDirectory(parent: FileSystemTree, name: string): FileSystemTree {
  const existing = parent[name];
  if (existing && 'directory' in existing) return existing.directory;
  const directory: FileSystemTree = {};
  parent[name] = { directory };
  return directory;
}

function text(bytes: Uint8Array, start: number, length: number): string {
  const field = bytes.subarray(start, start + length);
  const end = field.indexOf(0);
  return decoder.decode(end === -1 ? field : field.subarray(0, end)).trim();
}

/** Parses `"<length> <key>=<value>\n"` records, where the length counts the whole record. */
function paxRecords(body: Uint8Array): Record<string, string> {
  const records: Record<string, string> = {};
  for (let offset = 0; offset < body.byteLength; ) {
    const space = body.indexOf(0x20, offset);
    if (space === -1) break;
    const length = parseInt(decoder.decode(body.subarray(offset, space)), 10);
    if (!length) break;
    const record = decoder.decode(body.subarray(space + 1, offset + length - 1));
    const separator = record.indexOf('=');
    if (separator !== -1) records[record.slice(0, separator)] = record.slice(separator + 1);
    offset += length;
  }
  return records;
}
