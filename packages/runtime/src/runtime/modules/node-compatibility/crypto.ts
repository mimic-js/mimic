import { hmac } from '@noble/hashes/hmac.js';
import { md5, ripemd160, sha1 } from '@noble/hashes/legacy.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha224, sha256, sha384, sha512, sha512_224, sha512_256 } from '@noble/hashes/sha2.js';
import { sha3_224, sha3_256, sha3_384, sha3_512 } from '@noble/hashes/sha3.js';
import type { CHash, Hash } from '@noble/hashes/utils.js';
import { BrowserBuffer, encodeBytes, isArrayBufferLike } from './buffer';
import { nodeStream as stream } from './streams';

type CryptoBinary = ArrayBufferLike | ArrayBufferView;
type CryptoInput = string | CryptoBinary;
type RandomCallback<T> = (error: Error | null, value: T) => void;

export type NodeHash = {
  update(data: CryptoInput, inputEncoding?: string): NodeHash;
  digest(encoding?: string): string | Uint8Array;
  copy(): NodeHash;
};

export type NodeHmac = {
  update(data: CryptoInput, inputEncoding?: string): NodeHmac;
  digest(encoding?: string): string | Uint8Array;
};

/**
 * Operations the browser runtime does not implement. Each one throws when it
 * is called, so a package never receives a wrong ciphertext, signature or key.
 */
const UNSUPPORTED_OPERATIONS = [
  'createCipheriv', 'createDecipheriv', 'createSign', 'createVerify', 'sign', 'verify',
  'scrypt', 'scryptSync', 'hkdf', 'hkdfSync',
  'generateKey', 'generateKeySync', 'generateKeyPair', 'generateKeyPairSync',
  'generatePrime', 'generatePrimeSync', 'checkPrime', 'checkPrimeSync',
  'createPublicKey', 'createPrivateKey', 'createSecretKey',
  'createDiffieHellman', 'createDiffieHellmanGroup', 'getDiffieHellman', 'createECDH', 'diffieHellman',
  'publicEncrypt', 'publicDecrypt', 'privateEncrypt', 'privateDecrypt'
] as const;

export function createCryptoBuiltin(): unknown {
  const randomBytes = (size: number, callback?: RandomCallback<BrowserBuffer>) => {
    assertRandomFillRange(size, 0, 0x7fff_ffff, 'size');
    const bytes = new Uint8Array(size);
    fillRandomBytes(bytes);
    const buffer = BrowserBuffer.from(bytes);
    if (callback === undefined) return buffer;
    assertCallback(callback);
    queueMicrotask(() => callback(null, buffer));
    return undefined;
  };
  const pbkdf2Sync = (password: CryptoInput, salt: CryptoInput, iterations: number, keyLength: number, digest: string) =>
    BrowserBuffer.from(
      pbkdf2Bytes(inputBytes(password, undefined, 'password'), inputBytes(salt, undefined, 'salt'), iterations, keyLength, digest)
    );
  const crypto = {
    getHashes: () => [...DIGESTS.keys()],
    getCurves: () => ['prime256v1', 'secp256k1', 'secp384r1', 'secp521r1'],
    getCiphers: () => ['aes-128-cbc', 'aes-192-cbc', 'aes-256-cbc', 'aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm'],
    createHash: (algorithm: string) => createNodeHash(algorithm),
    createHmac: (algorithm: string, key: CryptoInput) => createNodeHmac(algorithm, key),
    hash: (algorithm: string, data: CryptoInput, outputEncoding = 'hex') =>
      createNodeHash(algorithm).update(data).digest(outputEncoding),
    pbkdf2Sync,
    // The derivation itself runs synchronously; only the callback is deferred.
    pbkdf2: (
      password: CryptoInput,
      salt: CryptoInput,
      iterations: number,
      keyLength: number,
      digest: string,
      callback: RandomCallback<BrowserBuffer>
    ) => {
      assertCallback(callback);
      const derived = pbkdf2Sync(password, salt, iterations, keyLength, digest);
      queueMicrotask(() => callback(null, derived));
    },
    randomBytes,
    pseudoRandomBytes: randomBytes,
    randomFillSync,
    randomFill,
    randomInt,
    getRandomValues,
    randomUUID,
    timingSafeEqual,
    ...Object.fromEntries(UNSUPPORTED_OPERATIONS.map((name) => [name, unsupportedOperation(name)]))
  };

  const module = { ...crypto, default: crypto };
  for (const target of [crypto, module]) {
    Object.defineProperty(target, 'webcrypto', { enumerable: true, get: secureWebCrypto });
    Object.defineProperty(target, 'subtle', { enumerable: true, get: () => secureWebCrypto().subtle });
  }
  return module;
}

export function createNodeHash(algorithm: string): NodeHash {
  const digest = findDigest(algorithm);
  if (!digest) {
    throw Object.assign(new Error('Digest method not supported'), { code: 'ERR_OSSL_EVP_UNSUPPORTED' });
  }
  return nodeHash(digest.create());
}

/**
 * A Hash is also a Transform stream, as Node's is: what is written is hashed,
 * and ending it makes the digest its one chunk (babel-loader 7 names its
 * cache files with `hash.end(contents); hash.read()`).
 */
function nodeHash(state: Hash<unknown>): NodeHash {
  let digested = false;
  const assertUsable = () => {
    if (digested) throw Object.assign(new Error('Digest already called'), { code: 'ERR_CRYPTO_HASH_FINALIZED' });
  };
  const transform = new stream.Transform({
    transform(chunk: unknown, encoding: unknown, callback: (error?: Error | null) => void) {
      try {
        assertUsable();
        state.update(inputBytes(chunk as CryptoInput, encoding === 'buffer' ? undefined : (encoding as string), 'data'));
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback: (error?: Error | null, data?: unknown) => void) {
      try {
        assertUsable();
        digested = true;
        callback(null, BrowserBuffer.from(state.digest()));
      } catch (error) {
        callback(error as Error);
      }
    }
  });
  const hash = Object.assign(transform, {
    update(data: CryptoInput, inputEncoding?: string) {
      assertUsable();
      state.update(inputBytes(data, inputEncoding, 'data'));
      return hash;
    },
    digest(encoding?: string) {
      assertUsable();
      digested = true;
      return encodeDigest(state.digest(), encoding);
    },
    copy() {
      assertUsable();
      return nodeHash(state.clone() as Hash<unknown>);
    }
  }) as unknown as NodeHash;
  return hash;
}

function createNodeHmac(algorithm: string, key: CryptoInput): NodeHmac {
  const state = hmac.create(requireDigest(algorithm), inputBytes(key, undefined, 'key'));
  let digested = false;
  const nodeHmac: NodeHmac = {
    update(data, inputEncoding) {
      if (digested) throw Object.assign(new Error('Digest already called'), { code: 'ERR_CRYPTO_HASH_FINALIZED' });
      state.update(inputBytes(data, inputEncoding, 'data'));
      return nodeHmac;
    },
    digest(encoding) {
      // Node answers a second `digest()` with an empty result instead of throwing.
      if (digested) return encodeDigest(new Uint8Array(), encoding);
      digested = true;
      return encodeDigest(state.digest(), encoding);
    }
  };
  return nodeHmac;
}

function pbkdf2Bytes(password: Uint8Array, salt: Uint8Array, iterations: number, keyLength: number, digest: string): Uint8Array {
  if (typeof digest !== 'string') {
    throw nodeTypeError('ERR_INVALID_ARG_TYPE', `The "digest" argument must be of type string. Received ${String(digest)}`);
  }
  assertIntegerRange(iterations, 1, 0x7fff_ffff, 'iterations');
  assertIntegerRange(keyLength, 0, 0x7fff_ffff, 'keylen');
  const hash = requireDigest(digest);
  return keyLength === 0 ? new Uint8Array() : pbkdf2(hash, password, salt, { c: iterations, dkLen: keyLength });
}

/** The digests of `@noble/hashes`, by the name Node lists them under. */
const DIGESTS: ReadonlyMap<string, CHash> = new Map<string, CHash>([
  ['md5', md5],
  ['ripemd160', ripemd160],
  ['rmd160', ripemd160],
  ['sha1', sha1],
  ['sha224', sha224],
  ['sha256', sha256],
  ['sha384', sha384],
  ['sha512', sha512],
  ['sha512-224', sha512_224],
  ['sha512-256', sha512_256],
  ['sha3-224', sha3_224],
  ['sha3-256', sha3_256],
  ['sha3-384', sha3_384],
  ['sha3-512', sha3_512]
]);

/** Digest names match without case or dashes, as `SHA-256` and `sha256` both name SHA-256. */
const DIGESTS_BY_NORMALIZED_NAME = new Map([...DIGESTS].map(([name, hash]) => [normalizeDigestName(name), hash]));

function findDigest(algorithm: string): CHash | undefined {
  return DIGESTS_BY_NORMALIZED_NAME.get(normalizeDigestName(algorithm));
}

function requireDigest(algorithm: string): CHash {
  const digest = findDigest(algorithm);
  if (!digest) throw nodeTypeError('ERR_CRYPTO_INVALID_DIGEST', `Invalid digest: ${algorithm}`);
  return digest;
}

function normalizeDigestName(algorithm: string): string {
  return String(algorithm).toLowerCase().replaceAll('-', '');
}

function inputBytes(data: unknown, encoding: string | undefined, name: string): Uint8Array {
  if (typeof data === 'string') {
    return BrowserBuffer.from(data, encoding === undefined || encoding === 'buffer' ? 'utf8' : encoding);
  }
  if (ArrayBuffer.isView(data) || isArrayBufferLike(data)) return cryptoBytes(data, name);
  throw nodeTypeError(
    'ERR_INVALID_ARG_TYPE',
    `The "${name}" argument must be of type string or an instance of Buffer, TypedArray, or DataView.`
  );
}

function encodeDigest(bytes: Uint8Array, encoding: string | undefined): string | Uint8Array {
  return encoding === undefined || encoding === 'buffer' ? BrowserBuffer.from(bytes) : encodeBytes(bytes, encoding);
}

function unsupportedOperation(name: string): () => never {
  return () => {
    throw Object.assign(new Error(`crypto.${name} is not supported by this runtime`), { code: 'ENOTSUP' });
  };
}

function assertCallback(callback: unknown): asserts callback is (...args: never[]) => unknown {
  if (typeof callback !== 'function') {
    throw nodeTypeError('ERR_INVALID_ARG_TYPE', 'The "callback" argument must be of type function.');
  }
}

function assertIntegerRange(value: number, minimum: number, maximum: number, name: string): void {
  if (typeof value !== 'number') {
    throw nodeTypeError('ERR_INVALID_ARG_TYPE', `The "${name}" argument must be of type number.`);
  }
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw nodeRangeError(
      'ERR_OUT_OF_RANGE',
      `The value of "${name}" is out of range. It must be >= ${minimum} && <= ${maximum}. Received ${value}`
    );
  }
}

function randomFill<T extends CryptoBinary>(
  buffer: T,
  ...rest: [RandomCallback<T>] | [number, RandomCallback<T>] | [number, number, RandomCallback<T>]
): void {
  const callback = rest[rest.length - 1] as RandomCallback<T>;
  assertCallback(callback);
  const [offset, size] = rest.slice(0, -1) as [number?, number?];
  randomFillSync(buffer, offset, size);
  queueMicrotask(() => callback(null, buffer));
}

const RANDOM_INT_SPAN = 2 ** 48;

function randomInt(max: number, callback?: RandomCallback<number>): number | undefined;
function randomInt(min: number, max: number, callback?: RandomCallback<number>): number | undefined;
function randomInt(
  minOrMax: number,
  maxOrCallback?: number | RandomCallback<number>,
  maybeCallback?: RandomCallback<number>
): number | undefined {
  const bounded = maxOrCallback !== undefined && typeof maxOrCallback !== 'function';
  const min = bounded ? minOrMax : 0;
  const max = bounded ? maxOrCallback : minOrMax;
  const callback = bounded ? maybeCallback : maxOrCallback;
  if (!Number.isSafeInteger(min)) throw nodeTypeError('ERR_INVALID_ARG_TYPE', 'The "min" argument must be a safe integer.');
  if (!Number.isSafeInteger(max)) throw nodeTypeError('ERR_INVALID_ARG_TYPE', 'The "max" argument must be a safe integer.');
  if (max <= min) {
    throw nodeRangeError(
      'ERR_OUT_OF_RANGE',
      `The value of "max" is out of range. It must be greater than the value of "min" (${min}). Received ${max}`
    );
  }
  const range = max - min;
  if (range >= RANDOM_INT_SPAN) {
    throw nodeRangeError(
      'ERR_OUT_OF_RANGE',
      `The value of "max - min" is out of range. It must be <= ${RANDOM_INT_SPAN - 1}. Received ${range}`
    );
  }
  // Rejecting the tail of the 48-bit space keeps every value in the range equally likely.
  const limit = RANDOM_INT_SPAN - (RANDOM_INT_SPAN % range);
  const bytes = new Uint8Array(6);
  let sample: number;
  do {
    fillRandomBytes(bytes);
    sample = 0;
    for (const byte of bytes) sample = sample * 256 + byte;
  } while (sample >= limit);
  const value = min + (sample % range);
  if (callback === undefined) return value;
  assertCallback(callback);
  queueMicrotask(() => callback(null, value));
  return undefined;
}

function getRandomValues<T extends Uint8Array>(array: T): T {
  return secureWebCrypto().getRandomValues(array);
}

function randomFillSync<T extends CryptoBinary>(buffer: T, offset: number | undefined = 0, size?: number): T {
  const bytes = cryptoBytes(buffer, 'buf');
  const elementSize = isArrayBufferLike(buffer) || buffer instanceof DataView
    ? 1
    : typedArrayElementSize(buffer);
  const elementLength = bytes.byteLength / elementSize;
  assertRandomFillRange(offset, 0, elementLength, 'offset');
  const resolvedSize = size === undefined ? elementLength - offset : size;
  assertRandomFillRange(resolvedSize, 0, 0x7fff_ffff, 'size');
  if (offset + resolvedSize > elementLength) {
    throw nodeRangeError(
      'ERR_OUT_OF_RANGE',
      `The value of "size + offset" is out of range. It must be <= ${elementLength}. Received ${offset + resolvedSize}`
    );
  }
  fillRandomBytes(bytes.subarray(offset * elementSize, (offset + resolvedSize) * elementSize));
  return buffer;
}

function typedArrayElementSize(view: ArrayBufferView): number {
  if ('BYTES_PER_ELEMENT' in view && typeof view.BYTES_PER_ELEMENT === 'number') {
    return view.BYTES_PER_ELEMENT;
  }
  throw nodeTypeError(
    'ERR_INVALID_ARG_TYPE',
    'The "buf" argument must be an instance of ArrayBuffer or ArrayBufferView.'
  );
}

function timingSafeEqual(first: CryptoBinary, second: CryptoBinary): boolean {
  const firstBytes = cryptoBytes(first, 'buf1');
  const secondBytes = cryptoBytes(second, 'buf2');
  if (firstBytes.byteLength !== secondBytes.byteLength) {
    throw nodeRangeError(
      'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH',
      'Input buffers must have the same byte length'
    );
  }
  let difference = 0;
  for (let index = 0; index < firstBytes.byteLength; index += 1) {
    difference |= firstBytes[index] ^ secondBytes[index];
  }
  return difference === 0;
}

function fillRandomBytes(bytes: Uint8Array): void {
  if (typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer) {
    const randomBytes = new Uint8Array(bytes.byteLength);
    fillRandomBytes(randomBytes);
    bytes.set(randomBytes);
    return;
  }
  const crypto = secureWebCrypto();
  for (let offset = 0; offset < bytes.byteLength; offset += 65_536) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65_536, bytes.byteLength)));
  }
}

function cryptoBytes(input: unknown, name: string): Uint8Array {
  if (isArrayBufferLike(input)) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw nodeTypeError(
    'ERR_INVALID_ARG_TYPE',
    `The "${name}" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView.`
  );
}

function assertRandomFillRange(value: number, minimum: number, maximum: number, name: string): void {
  if (typeof value !== 'number') {
    throw nodeTypeError('ERR_INVALID_ARG_TYPE', `The "${name}" argument must be of type number.`);
  }
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw nodeRangeError(
      'ERR_OUT_OF_RANGE',
      `The value of "${name}" is out of range. It must be >= ${minimum} && <= ${maximum}. Received ${value}`
    );
  }
}

function nodeTypeError(code: string, message: string): TypeError & { code: string } {
  const error = new TypeError(message) as TypeError & { code: string };
  error.code = code;
  return error;
}

function nodeRangeError(code: string, message: string): RangeError & { code: string } {
  const error = new RangeError(message) as RangeError & { code: string };
  error.code = code;
  return error;
}

function randomUUID(): string {
  const crypto = secureWebCrypto();
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = encodeBytes(bytes, 'hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function secureWebCrypto(): Crypto {
  const crypto = globalThis.crypto;
  if (!crypto || typeof crypto.getRandomValues !== 'function') {
    const error = new Error('Secure Web Crypto randomness is unavailable in this execution context.') as Error & { code: string };
    error.code = 'ERR_CRYPTO_UNAVAILABLE';
    throw error;
  }
  return crypto;
}
