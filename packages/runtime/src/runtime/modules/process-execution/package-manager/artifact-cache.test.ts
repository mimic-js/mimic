import { expect, test } from 'vitest';

import { MemoryArtifactCache } from './artifact-cache';

test('evicts the oldest artifacts once the stored bytes exceed the budget', async () => {
  const cache = new MemoryArtifactCache(10);

  await cache.put('a@1.0.0', new Uint8Array(4));
  await cache.put('b@1.0.0', new Uint8Array(4));
  await cache.put('a@1.0.0', new Uint8Array(4));
  await cache.put('c@1.0.0', new Uint8Array(4));

  expect(cache.keys()).toEqual(['a@1.0.0', 'c@1.0.0']);
  expect(await cache.get('b@1.0.0')).toBeUndefined();
  expect(await cache.get('c@1.0.0')).toEqual(new Uint8Array(4));
});
