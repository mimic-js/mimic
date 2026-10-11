import { createHash } from 'node:crypto';

import { expect, test } from 'vitest';

import { TarballIntegrityError, UnsupportedIntegrityError, verifyTarball } from './npm-tarball';

const bytes = new TextEncoder().encode('tarball bytes');
const other = new TextEncoder().encode('other bytes');
const digest = (algorithm: string, data: Uint8Array): string =>
  `${algorithm}-${createHash(algorithm).update(data).digest('base64')}`;

test('accepts sha512, sha384 and sha256 integrity', async () => {
  for (const algorithm of ['sha512', 'sha384', 'sha256']) {
    await expect(verifyTarball(bytes, { integrity: digest(algorithm, bytes) })).resolves.toBeUndefined();
    await expect(verifyTarball(other, { integrity: digest(algorithm, bytes) })).rejects.toThrow(TarballIntegrityError);
  }
});

test('refuses integrity that lists sha1 only, or nothing it recognises', async () => {
  await expect(verifyTarball(bytes, { integrity: digest('sha1', bytes) })).rejects.toThrow(UnsupportedIntegrityError);
  await expect(verifyTarball(bytes, { integrity: 'md5-abc' })).rejects.toThrow(UnsupportedIntegrityError);
  await expect(verifyTarball(bytes, { integrity: '' })).rejects.toThrow(UnsupportedIntegrityError);
});

test('verifies against the strongest algorithm listed and ignores the weaker ones', async () => {
  // A matching sha1 or sha256 does not rescue a sha512 that does not match.
  await expect(
    verifyTarball(bytes, { integrity: `${digest('sha1', bytes)} ${digest('sha256', bytes)} ${digest('sha512', other)}` })
  ).rejects.toThrow(/expected sha512-/u);
  // A sha1 that does not match is not consulted when a stronger digest matches.
  await expect(
    verifyTarball(bytes, { integrity: `${digest('sha1', other)} ${digest('sha256', bytes)}` })
  ).resolves.toBeUndefined();
  // Several digests of the strongest algorithm: any one may match.
  await expect(
    verifyTarball(bytes, { integrity: `${digest('sha512', other)} ${digest('sha512', bytes)}` })
  ).resolves.toBeUndefined();
});
