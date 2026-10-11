import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * Names the key derivation, as part of the compile cache's compiler version:
 * a store written under another derivation is never consulted.
 */
export const CONTENT_HASH_ALGORITHM = 'sha256';

/**
 * The compile cache's content key: SHA-256 over the UTF-8 bytes of a source,
 * hex-encoded. The key is collision-resistant, so a context cannot make one
 * source's key name another source's compiled text, and the Runtime Host
 * recomputes it from the source a context sends before storing anything
 * under it. Synchronous: a process worker computes it inside a blocking
 * mailbox call.
 */
export function contentHash(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}
