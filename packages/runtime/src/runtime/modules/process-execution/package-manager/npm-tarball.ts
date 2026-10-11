export type TarballEntry = {
  path: string;
  data: Uint8Array;
};

export class TarballIntegrityError extends Error {
  override readonly name = 'TarballIntegrityError';
}

/** The integrity value names no algorithm strong enough to verify a tarball. */
export class UnsupportedIntegrityError extends Error {
  override readonly name = 'UnsupportedIntegrityError';
}

/** The algorithms a tarball may be verified with, strongest first. `sha1` is refused. */
const INTEGRITY_ALGORITHMS = ['sha512', 'sha384', 'sha256'] as const;
type IntegrityAlgorithm = (typeof INTEGRITY_ALGORITHMS)[number];

const textDecoder = new TextDecoder();

/**
 * Verifies npm Subresource Integrity over the tarball bytes. When several
 * algorithms are listed, only the strongest one present counts (`sha512`,
 * then `sha384`, then `sha256`); any of its digests may match. An integrity
 * value that lists only `sha1`, or nothing recognised, is refused.
 */
export async function verifyTarball(
  bytes: Uint8Array,
  options: { integrity: string }
): Promise<void> {
  const candidates = options.integrity
    .split(/\s+/u)
    .flatMap((item) => {
      const index = item.indexOf('-');
      const algorithm = item.slice(0, index).toLowerCase();
      return index > 0 && isIntegrityAlgorithm(algorithm)
        ? [{ algorithm, expected: item.slice(index + 1) }]
        : [];
    });
  const strongest = INTEGRITY_ALGORITHMS.find((algorithm) =>
    candidates.some((candidate) => candidate.algorithm === algorithm)
  );
  if (!strongest) {
    throw new UnsupportedIntegrityError(`Unsupported integrity value: ${options.integrity}`);
  }
  const actual = await digestBase64(strongest, bytes);
  const expected = candidates.filter((candidate) => candidate.algorithm === strongest);
  if (expected.some((candidate) => candidate.expected === actual)) return;
  throw new TarballIntegrityError(
    `Tarball integrity mismatch: expected ${strongest}-${expected[0]!.expected}, got ${strongest}-${actual}`
  );
}

function isIntegrityAlgorithm(algorithm: string): algorithm is IntegrityAlgorithm {
  return (INTEGRITY_ALGORITHMS as readonly string[]).includes(algorithm);
}

/** The regular files of an npm package tarball, relative to its `package/` root. */
export async function extractNpmTarball(compressed: Uint8Array): Promise<TarballEntry[]> {
  const tar = await gunzip(compressed);
  return readTarEntries(tar)
    .filter((entry) => entry.path.startsWith('package/'))
    .map((entry) => ({ path: entry.path.slice('package/'.length), data: entry.data }))
    .filter((entry) => entry.path.length > 0);
}

async function gunzip(compressed: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([toArrayBuffer(compressed)])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function readTarEntries(tar: Uint8Array): TarballEntry[] {
  const entries: TarballEntry[] = [];
  let offset = 0;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const size = Number.parseInt(readString(header, 124, 12) || '0', 8);
    const typeflag = readString(header, 156, 1);
    offset += 512;
    if (typeflag === '0' || typeflag === '') {
      entries.push({
        path: prefix ? `${prefix}/${name}` : name,
        data: tar.slice(offset, offset + size)
      });
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}

function readString(block: Uint8Array, offset: number, length: number): string {
  const bytes = block.subarray(offset, offset + length);
  const zero = bytes.indexOf(0);
  return textDecoder.decode(zero >= 0 ? bytes.subarray(0, zero) : bytes).trim();
}

async function digestBase64(algorithm: IntegrityAlgorithm, bytes: Uint8Array): Promise<string> {
  const name = algorithm === 'sha512' ? 'SHA-512' : algorithm === 'sha384' ? 'SHA-384' : 'SHA-256';
  const digest = new Uint8Array(await crypto.subtle.digest(name, toArrayBuffer(bytes)));
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
