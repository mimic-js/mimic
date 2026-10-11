import nodeCrypto from 'node:crypto';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { BrowserBuffer } from '../buffer';
import { type NodeCompatibility, type NodeCompatibilityGlobals } from '../node-compatibility';
import { createNodeCompatibilityHarness } from './node-compatibility-harness';

type CryptoHash = {
  update(data: string | ArrayBufferView, inputEncoding?: string): CryptoHash;
  digest(encoding?: string): string | Uint8Array;
  copy(): CryptoHash;
};

type CryptoBuiltin = {
  readonly webcrypto: Crypto;
  readonly subtle: SubtleCrypto;
  createHash(algorithm: string): CryptoHash;
  createHmac(algorithm: string, key: string | ArrayBufferView): Omit<CryptoHash, 'copy'>;
  getHashes(): string[];
  hash(algorithm: string, data: string | Uint8Array, outputEncoding?: string): string | Uint8Array;
  pbkdf2(
    password: string | Uint8Array,
    salt: string | Uint8Array,
    iterations: number,
    keyLength: number,
    digest: string,
    callback: (error: Error | null, derivedKey: Uint8Array) => void
  ): void;
  pbkdf2Sync(password: string | Uint8Array, salt: string | Uint8Array, iterations: number, keyLength: number, digest: string): Uint8Array;
  randomBytes(size: number): Uint8Array;
  randomBytes(size: number, callback: (error: Error | null, bytes: Uint8Array) => void): void;
  randomFill<T extends ArrayBufferView>(buffer: T, callback: (error: Error | null, buffer: T) => void): void;
  randomInt(max: number): number;
  randomInt(min: number, max: number): number;
  randomInt(min: number, max: number, callback: (error: Error | null, value: number) => void): void;
  randomFillSync<T extends ArrayBufferLike | ArrayBufferView>(buffer: T, offset?: number, size?: number): T;
  getRandomValues<T extends Uint8Array>(values: T): T;
  randomUUID(): string;
  timingSafeEqual(first: ArrayBufferLike | ArrayBufferView, second: ArrayBufferLike | ArrayBufferView): boolean;
  default: Record<string, unknown>;
};

afterEach(() => vi.unstubAllGlobals());

describe('Node Compatibility crypto', () => {
  test('loads one canonical crypto builtin with Node-compatible hashes, bytes, and default exports', () => {
    const compatibility = createNodeCompatibilityHarness({
      global: Object.create(globalThis) as typeof globalThis,
      globals: nodeCompatibilityGlobals()
    });
    const bare = loadCrypto(compatibility, 'crypto');
    const qualified = loadCrypto(compatibility, 'node:crypto');

    expect(qualified).toBe(bare);
    expect(bare.default.createHash).toBe(bare.createHash);
    expect(bare.default.randomBytes).toBe(bare.randomBytes);
    expect(bare.default.randomFillSync).toBe(bare.randomFillSync);
    expect(bare.default.timingSafeEqual).toBe(bare.timingSafeEqual);
    expect(bare.webcrypto).toBe(globalThis.crypto);
    expect(bare.default.webcrypto).toBe(globalThis.crypto);

    const vectors = {
      md5: '900150983cd24fb0d6963f7d28e17f72',
      sha1: 'a9993e364706816aba3e25717850c26c9cd0d89d',
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      sha384:
        'cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7',
      sha512:
        'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f'
    } as const;
    for (const [algorithm, expected] of Object.entries(vectors)) {
      expect(bare.createHash(algorithm).update('a').update('bc').digest('hex')).toBe(expected);
    }
    expect(bare.createHash('md5').digest('hex')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(bare.createHash('md5').update('1234567890'.repeat(8)).digest('hex')).toBe(
      '57edf4a22be3c955ac49da2e2107b67a'
    );
    expect(bare.hash('sha256', BrowserBuffer.from('abc'), 'base64url')).toBe('ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');

    const randomBytes = bare.randomBytes(16);
    const chunkedRandomBytes = bare.randomBytes(65_537);
    const randomValues = new Uint8Array(16);
    expect(BrowserBuffer.isBuffer(randomBytes)).toBe(true);
    expect(randomBytes).toBeInstanceOf(BrowserBuffer);
    expect(chunkedRandomBytes).toBeInstanceOf(BrowserBuffer);
    expect(chunkedRandomBytes).toHaveLength(65_537);
    expect(bare.getRandomValues(randomValues)).toBe(randomValues);
    expect(bare.randomUUID()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });

  test('hashes incrementally to the digests the host Node produces for every length and split', () => {
    const crypto = loadCryptoBuiltin();
    const data = Uint8Array.from({ length: 300 }, (_, index) => (index * 131 + 7) & 0xff);

    expect(crypto.getHashes()).toEqual([
      'md5', 'ripemd160', 'rmd160', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512',
      'sha512-224', 'sha512-256', 'sha3-224', 'sha3-256', 'sha3-384', 'sha3-512'
    ]);
    for (const algorithm of crypto.getHashes()) {
      // Lengths cross the 64- and 128-byte block boundaries and both padding cases.
      for (let length = 0; length <= data.length; length += 1) {
        const input = data.subarray(0, length);
        const expected = nodeCrypto.createHash(algorithm).update(input).digest('hex');
        const split = Math.floor(length / 3);
        expect(crypto.createHash(algorithm).update(input).digest('hex'), `${algorithm} of ${length} bytes`).toBe(expected);
        expect(
          crypto.createHash(algorithm)
            .update(input.subarray(0, split))
            .update(input.subarray(split, split * 2))
            .update(input.subarray(split * 2))
            .digest('hex'),
          `${algorithm} of ${length} bytes in three updates`
        ).toBe(expected);
      }
      const large = new Uint8Array(200_003).fill(0x61);
      expect(crypto.createHash(algorithm).update(large).digest('base64'))
        .toBe(nodeCrypto.createHash(algorithm).update(large).digest('base64'));
    }
    expect(crypto.createHash('sha384').digest('hex')).toBe(
      '38b060a751ac96384cd9327eb1b1e36a21fdb71114be07434c0cc7bf63f6e1da274edebfe76f65fbd51ad2f14898b95b'
    );
    expect(crypto.createHash('sha512').digest('hex')).toBe(
      'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e'
    );
    expect(crypto.createHash('SHA-256').digest('hex')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
  });

  test('honors update input encodings, digest encodings, copies and finalization', () => {
    const crypto = loadCryptoBuiltin();
    const abc = 'a9993e364706816aba3e25717850c26c9cd0d89d';

    expect(crypto.createHash('sha1').update('616263', 'hex').digest('hex')).toBe(abc);
    expect(crypto.createHash('sha1').update('YWJj', 'base64').digest('hex')).toBe(abc);
    expect(crypto.createHash('sha1').update('abc', 'latin1').digest('hex')).toBe(abc);
    expect(crypto.createHash('sha1').update(new DataView(Uint8Array.from([97, 98, 99]).buffer)).digest('hex')).toBe(abc);
    // A wider typed array is hashed by its bytes, not by its element values.
    expect(crypto.createHash('sha1').update(new Uint16Array([0x6261, 0x63])).digest('hex')).toBe(
      '686483805ac47ca14e03514f7481a7973b401762'
    );
    expect(crypto.createHash('sha1').update('abc').digest('base64')).toBe('qZk+NkcGgWq6PiVxeFDCbJzQ2J0=');
    expect(crypto.createHash('sha1').update('abc').digest('base64url')).toBe('qZk-NkcGgWq6PiVxeFDCbJzQ2J0');
    expect(crypto.createHash('md5').update('a').digest('latin1')).toHaveLength(16);
    const bytes = crypto.createHash('sha1').update('abc').digest('buffer');
    expect(BrowserBuffer.isBuffer(bytes)).toBe(true);
    expect((bytes as BrowserBuffer).toString('hex')).toBe(abc);

    const prefix = crypto.createHash('sha1').update('ab');
    const copy = prefix.copy();
    expect(prefix.update('c').digest('hex')).toBe(abc);
    expect(copy.update('c').digest('hex')).toBe(abc);
    expect(() => prefix.update('d')).toThrow(expect.objectContaining({ code: 'ERR_CRYPTO_HASH_FINALIZED' }));
    expect(() => prefix.digest()).toThrow(expect.objectContaining({ code: 'ERR_CRYPTO_HASH_FINALIZED' }));
    expect(() => crypto.createHash('nope')).toThrow('Digest method not supported');
    expect(() => crypto.createHash('sha1').update(1 as unknown as string)).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' })
    );
  });

  test('hashes what is written to it as a stream, as babel-loader 7 does with end and read', async () => {
    const crypto = loadCryptoBuiltin();
    const contents = JSON.stringify({ source: 'module.exports = 1;' });
    const expected = nodeCrypto.createHash('sha256').update(contents).digest('hex');
    const ended = crypto.createHash('sha256') as unknown as { end(data: string): void; read(): Uint8Array };
    ended.end(contents);

    const piped = crypto.createHash('sha256') as unknown as NodeJS.WritableStream & NodeJS.ReadableStream;
    const digest = new Promise<string>((resolve) => piped.on('data', (chunk: Uint8Array) => resolve(BrowserBuffer.from(chunk).toString('hex'))));
    piped.write(contents.slice(0, 10));
    piped.end(contents.slice(10));

    expect(BrowserBuffer.from(ended.read()).toString('hex')).toBe(expected);
    await expect(digest).resolves.toBe(expected);
  });

  test('computes HMAC and PBKDF2 to the values real Node produces', async () => {
    const crypto = loadCryptoBuiltin();
    const hmac = (algorithm: string) =>
      crypto.createHmac(algorithm, 'key').update('The quick brown fox ').update('jumps over the lazy dog').digest('hex');

    expect(hmac('md5')).toBe('80070713463e7749b90c2dc24911e275');
    expect(hmac('sha1')).toBe('de7c9b85b8b78aa6bc8a7a36f70a90701c9db4d9');
    expect(hmac('sha256')).toBe('f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
    expect(hmac('sha384')).toBe(
      'd7f4727e2c0b39ae0f1e40cc96f60242d5b7801841cea6fc592c5d3e1ae50700582a96cf35e1e554995fe4e03381c237'
    );
    expect(hmac('sha512')).toBe(
      'b42af09057bac1e2d41708e48a902e09b5ff7f12ab428a4fe86653c73dd248fb82f948a549f7b791a5b41915ee4d1ec3935357e4e2317250d0372afa2ebeeb3a'
    );
    expect(crypto.createHmac('sha1', Uint8Array.from([1, 2])).update('a').digest('hex')).toBe(
      '12b6b96a96a7a0964ee9e07a256937dab9221c09'
    );
    // A key longer than the block is hashed first.
    expect(crypto.createHmac('sha512', 'k'.repeat(300)).update('a').digest('hex')).toBe(
      'f9624c9bba23b670a6050c131105361f1394efac6538226be5c27ab4c18a2526994c9e1802fde055641f16c79ba47595dbf7700733c4c9cde43b265f471141dc'
    );
    const finished = crypto.createHmac('sha256', 'k');
    finished.digest('hex');
    expect(finished.digest('hex')).toBe('');
    expect(() => crypto.createHmac('nope', 'k')).toThrow(expect.objectContaining({ code: 'ERR_CRYPTO_INVALID_DIGEST' }));

    const derive = (...args: Parameters<CryptoBuiltin['pbkdf2Sync']>) => (crypto.pbkdf2Sync(...args) as BrowserBuffer).toString('hex');
    expect(derive('password', 'salt', 1, 20, 'sha1')).toBe('0c60c80f961f0e71f3a9b524af6012062fe037a6');
    expect(derive('password', 'salt', 4096, 25, 'sha256')).toBe('c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4');
    expect(derive('passwordPASSWORDpassword', 'saltSALTsaltSALTsaltSALTsaltSALTsalt', 1000, 70, 'sha512')).toBe(
      '0e28f3efa802a2f0cd3b4ace5e3d9afadb7c2dccc5ef10eedb8a6564dfb0c9a63b6f46b1e150587b9fe7875cfaf999d00b454bb7d74295c60df1bbe5f8f36da188271db22110'
    );
    expect(derive(BrowserBuffer.from('p'), Uint8Array.from([1, 2, 3]), 3, 40, 'md5')).toBe(
      'a70ea58c31b2d5d1eabddad0e83a79862bba8513b0618fd7be4356b30601d1b1b016b794faea99f2'
    );
    expect(derive('', '', 2, 10, 'sha384')).toBe('4e2b9109c23c305fc5c1');
    expect(BrowserBuffer.isBuffer(crypto.pbkdf2Sync('p', 's', 1, 8, 'sha1'))).toBe(true);
    expect(() => crypto.pbkdf2Sync('p', 's', 1, 8, 'nope')).toThrow(expect.objectContaining({ code: 'ERR_CRYPTO_INVALID_DIGEST' }));
    expect(() => crypto.pbkdf2Sync('p', 's', 0, 8, 'sha1')).toThrow(expect.objectContaining({ code: 'ERR_OUT_OF_RANGE' }));

    let returned = false;
    const derived = await new Promise<Uint8Array>((resolve, reject) => {
      crypto.pbkdf2('password', 'salt', 1, 20, 'sha1', (error, key) => {
        expect(returned).toBe(true);
        if (error) reject(error);
        else resolve(key);
      });
      returned = true;
    });
    expect((derived as BrowserBuffer).toString('hex')).toBe('0c60c80f961f0e71f3a9b524af6012062fe037a6');
  });

  test('delivers callback randomness asynchronously and keeps random integers in range', async () => {
    const crypto = loadCryptoBuiltin();

    let returned = false;
    const bytes = await new Promise<Uint8Array>((resolve, reject) => {
      const result = crypto.randomBytes(24, (error, value) => {
        expect(returned).toBe(true);
        if (error) reject(error);
        else resolve(value);
      });
      expect(result).toBeUndefined();
      returned = true;
    });
    expect(BrowserBuffer.isBuffer(bytes)).toBe(true);
    expect(bytes).toHaveLength(24);
    expect(() => crypto.randomBytes(-1)).toThrow(expect.objectContaining({ code: 'ERR_OUT_OF_RANGE' }));
    expect(() => crypto.randomBytes('1' as unknown as number)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));

    const target = new Uint8Array(32);
    expect(await new Promise((resolve) => crypto.randomFill(target, (_error, filled) => resolve(filled)))).toBe(target);
    expect(target.some((byte) => byte !== 0)).toBe(true);

    const seen = new Set<number>();
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const value = crypto.randomInt(5, 9);
      expect(Number.isInteger(value) && value >= 5 && value < 9).toBe(true);
      seen.add(value);
    }
    expect([...seen].sort()).toEqual([5, 6, 7, 8]);
    expect(crypto.randomInt(1)).toBe(0);
    expect(await new Promise((resolve) => crypto.randomInt(3, 4, (_error, value) => resolve(value)))).toBe(3);
    expect(() => crypto.randomInt(5, 5)).toThrow(expect.objectContaining({ code: 'ERR_OUT_OF_RANGE' }));
    expect(() => crypto.randomInt(1.5)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    expect(() => crypto.randomInt(0, 2 ** 48 + 1)).toThrow(expect.objectContaining({ code: 'ERR_OUT_OF_RANGE' }));
  });

  test('passes WebCrypto through and refuses unimplemented operations instead of answering wrongly', async () => {
    const crypto = loadCryptoBuiltin();
    const unsupported = crypto as unknown as Record<string, (...args: unknown[]) => unknown>;

    expect(crypto.subtle).toBe(globalThis.crypto.subtle);
    expect(crypto.default.subtle).toBe(globalThis.crypto.subtle);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc'));
    expect(BrowserBuffer.from(digest).toString('hex')).toBe(crypto.createHash('sha256').update('abc').digest('hex'));

    for (const operation of [
      'createCipheriv', 'createDecipheriv', 'createSign', 'createVerify', 'sign', 'verify', 'scrypt', 'scryptSync',
      'hkdfSync', 'generateKeyPairSync', 'createPublicKey', 'createPrivateKey', 'createSecretKey',
      'createDiffieHellman', 'createECDH', 'publicEncrypt', 'privateDecrypt'
    ]) {
      expect(() => unsupported[operation]('aes-256-gcm', new Uint8Array(32), new Uint8Array(12)), operation).toThrow(
        expect.objectContaining({ code: 'ENOTSUP', message: expect.stringContaining(`crypto.${operation}`) })
      );
    }
  });

  test('compares underlying bytes without accepting length or input mismatches', () => {
    const crypto = loadCryptoBuiltin();
    const shared = Uint8Array.from([0xaa, 0xbb, 0xcc, 0xdd]);

    expect(crypto.timingSafeEqual(shared, Uint8Array.from(shared))).toBe(true);
    expect(crypto.timingSafeEqual(shared, Uint8Array.from([0xaa, 0xbb, 0xcc, 0xde]))).toBe(false);
    expect(crypto.timingSafeEqual(shared.buffer, new DataView(shared.buffer))).toBe(true);
    const sharedBuffer = new SharedArrayBuffer(shared.byteLength);
    new Uint8Array(sharedBuffer).set(shared);
    expect(crypto.timingSafeEqual(sharedBuffer, shared)).toBe(true);
    const words = new Uint16Array([0x1234]);
    expect(crypto.timingSafeEqual(words, Uint8Array.from(new Uint8Array(words.buffer)))).toBe(true);
    expect(() => crypto.timingSafeEqual(new Uint8Array(1), new Uint8Array(2))).toThrow(
      expect.objectContaining({ code: 'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH' })
    );
    expect(() => Reflect.apply(crypto.timingSafeEqual, crypto, [[1], new Uint8Array(1)])).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' })
    );
  });

  test('fills supported random views in bounded element ranges and returns the supplied object', () => {
    let nextByte = 1;
    vi.stubGlobal('crypto', {
      getRandomValues<T extends ArrayBufferView>(view: T): T {
        const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        for (let index = 0; index < bytes.byteLength; index += 1) bytes[index] = nextByte++;
        return view;
      }
    });
    const crypto = loadCryptoBuiltin();
    const buffer = BrowserBuffer.alloc(6, 0);
    const words = new Uint16Array(4);
    const dataViewBacking = new Uint8Array(6);
    const dataView = new DataView(dataViewBacking.buffer, 1, 4);
    const arrayBuffer = new ArrayBuffer(4);
    const sharedArrayBuffer = new SharedArrayBuffer(4);

    expect(crypto.randomFillSync(buffer, 1, 3)).toBe(buffer);
    expect([...buffer]).toEqual([0, 1, 2, 3, 0, 0]);
    expect(crypto.randomFillSync(words, 1, 2)).toBe(words);
    expect([...new Uint8Array(words.buffer)]).toEqual([0, 0, 4, 5, 6, 7, 0, 0]);
    expect(crypto.randomFillSync(dataView, 1, 2)).toBe(dataView);
    expect([...dataViewBacking]).toEqual([0, 0, 8, 9, 0, 0]);
    expect(crypto.randomFillSync(arrayBuffer)).toBe(arrayBuffer);
    expect([...new Uint8Array(arrayBuffer)]).toEqual([10, 11, 12, 13]);
    expect(crypto.randomFillSync(sharedArrayBuffer)).toBe(sharedArrayBuffer);
    expect([...new Uint8Array(sharedArrayBuffer)]).toEqual([14, 15, 16, 17]);
  });

  test('rejects invalid random fill inputs and ranges with Node-shaped errors', () => {
    const crypto = loadCryptoBuiltin();

    expect(() => Reflect.apply(crypto.randomFillSync, crypto, ['bytes'])).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' })
    );
    expect(() => crypto.randomFillSync(new Uint8Array(4), -1)).toThrow(
      expect.objectContaining({ code: 'ERR_OUT_OF_RANGE' })
    );
    expect(() => crypto.randomFillSync(new Uint8Array(4), 3, 2)).toThrow(
      expect.objectContaining({ code: 'ERR_OUT_OF_RANGE' })
    );
    expect(() => Reflect.apply(crypto.randomFillSync, crypto, [new Uint8Array(4), 0, null])).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' })
    );
  });

  test('rejects random APIs explicitly when secure Web Crypto is unavailable', () => {
    vi.stubGlobal('crypto', undefined);
    const crypto = loadCrypto(
      createNodeCompatibilityHarness({
        global: Object.create(globalThis) as typeof globalThis,
        globals: nodeCompatibilityGlobals()
      }),
      'node:crypto'
    );

    expect(() => crypto.randomBytes(1)).toThrow(expect.objectContaining({ code: 'ERR_CRYPTO_UNAVAILABLE' }));
    expect(() => crypto.randomFillSync(new Uint8Array(1))).toThrow(
      expect.objectContaining({ code: 'ERR_CRYPTO_UNAVAILABLE' })
    );
    expect(() => crypto.getRandomValues(new Uint8Array(1))).toThrow(expect.objectContaining({ code: 'ERR_CRYPTO_UNAVAILABLE' }));
    expect(() => crypto.randomUUID()).toThrow(expect.objectContaining({ code: 'ERR_CRYPTO_UNAVAILABLE' }));
    expect(() => crypto.webcrypto).toThrow(expect.objectContaining({ code: 'ERR_CRYPTO_UNAVAILABLE' }));
  });
});

function loadCrypto(
  compatibility: NodeCompatibility,
  specifier: 'crypto' | 'node:crypto'
): CryptoBuiltin {
  const loaded = compatibility.builtinModuleProvider.load(specifier);
  if (!loaded.found) throw new Error(`Expected ${specifier} to be a builtin.`);
  return loaded.module as CryptoBuiltin;
}

function loadCryptoBuiltin(): CryptoBuiltin {
  return loadCrypto(
    createNodeCompatibilityHarness({
      global: Object.create(globalThis) as typeof globalThis,
      globals: nodeCompatibilityGlobals()
    }),
    'node:crypto'
  );
}

function nodeCompatibilityGlobals(): NodeCompatibilityGlobals {
  return {
    process: {
      arch: 'wasm32',
      platform: 'browser',
      version: 'v22.22.3',
      versions: { node: '22.22.3' },
      release: {
        name: 'node',
        lts: 'Jod',
        sourceUrl: 'https://nodejs.org/download/release/v22.22.3/node-v22.22.3.tar.gz',
        headersUrl: 'https://nodejs.org/download/release/v22.22.3/node-v22.22.3-headers.tar.gz'
      }
    },
    console,
    Buffer: BrowserBuffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    WebSocket,
    MessageChannel,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
    queueMicrotask
  };
}
