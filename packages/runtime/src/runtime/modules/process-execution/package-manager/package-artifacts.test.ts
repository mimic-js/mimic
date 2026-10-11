import { createHash } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { makePackageTgz } from '../../../../../tests/npm-tarball-fixture';
import { MemoryArtifactCache } from './artifact-cache';
import { acquireRegistryTarball, publishedVersions, registryPublishes } from './package-artifacts';

const genuine = new Uint8Array(makePackageTgz({ 'package.json': JSON.stringify({ name: 'lightningcss-wasm', version: '1.30.1' }) }));
const planted = new Uint8Array(makePackageTgz({ 'package.json': JSON.stringify({ name: 'lightningcss-wasm', version: '1.30.1' }), 'index.js': 'planted' }));
const metadataUrl = 'https://registry.npmjs.org/lightningcss-wasm/1.30.1';
const tarballUrl = 'https://tarballs.test/lightningcss-wasm-1.30.1.tgz';

describe('acquireRegistryTarball', () => {
  test('refetches cached bytes that do not match the integrity the registry states', async () => {
    const cache = new MemoryArtifactCache();
    await cache.put('lightningcss-wasm@1.30.1', planted);
    const registry = createRegistry();

    const bytes = await acquireRegistryTarball(cache, 'lightningcss-wasm', '1.30.1', registry.fetch);

    expect(bytes).toEqual(genuine);
    expect(await cache.get('lightningcss-wasm@1.30.1')).toEqual(genuine);
    expect(registry.fetched).toEqual([metadataUrl, tarballUrl]);
  });

  test('verifies a cache hit against the registry on every call and skips only the download', async () => {
    const cache = new MemoryArtifactCache();
    const registry = createRegistry();

    await acquireRegistryTarball(cache, 'lightningcss-wasm', '1.30.1', registry.fetch);
    const bytes = await acquireRegistryTarball(cache, 'lightningcss-wasm', '1.30.1', registry.fetch);

    expect(bytes).toEqual(genuine);
    expect(registry.fetched).toEqual([metadataUrl, tarballUrl, metadataUrl]);
  });

  test('refuses an integrity the registry states with sha1 only, cached bytes or not', async () => {
    const cache = new MemoryArtifactCache();
    await cache.put('lightningcss-wasm@1.30.1', genuine);
    const registry = createRegistry({ integrity: `sha1-${createHash('sha1').update(genuine).digest('base64')}` });

    await expect(acquireRegistryTarball(cache, 'lightningcss-wasm', '1.30.1', registry.fetch))
      .rejects.toThrow(/Unsupported integrity value/u);
  });

  test('encodes every slash of a scoped name and refuses a name that is not a package name', async () => {
    const registry = createRegistry();

    await registryPublishes('@rollup/wasm-node', '4.62.3', registry.fetch);
    await publishedVersions('@rollup/wasm-node', registry.fetch);
    expect(registry.fetched).toEqual([
      'https://registry.npmjs.org/@rollup%2fwasm-node/4.62.3',
      'https://registry.npmjs.org/@rollup%2fwasm-node'
    ]);

    await expect(registryPublishes('../evil', '1.0.0', registry.fetch)).rejects.toThrow(/not a valid npm package name/u);
    await expect(publishedVersions('@a/b/c', registry.fetch)).rejects.toThrow(/not a valid npm package name/u);
    expect(registry.fetched).toHaveLength(2);
  });
});

test('registryPublishes asks the registry rather than trusting a cached tarball', async () => {
  const registry = createRegistry({ unpublished: true });

  expect(await registryPublishes('lightningcss-wasm', '1.30.1', registry.fetch)).toBe(false);
  expect(registry.fetched).toEqual([metadataUrl]);
});

function createRegistry(options: Readonly<{ integrity?: string; unpublished?: boolean }> = {}) {
  const fetched: string[] = [];
  const integrity = options.integrity ?? `sha512-${createHash('sha512').update(genuine).digest('base64')}`;
  return {
    fetched,
    async fetch(url: string): Promise<Response> {
      fetched.push(url);
      if (url === tarballUrl) return new Response(genuine.slice());
      if (url === metadataUrl) {
        if (options.unpublished) return new Response('{}', { status: 404 });
        return Response.json({ dist: { tarball: tarballUrl, integrity } });
      }
      if (/^https:\/\/registry\.npmjs\.org\/[^/]+\/[^/]+$/u.test(url)) return Response.json({ dist: { tarball: tarballUrl, integrity } });
      if (/^https:\/\/registry\.npmjs\.org\/[^/]+$/u.test(url)) return Response.json({ versions: {} });
      return new Response('missing', { status: 404 });
    }
  };
}
