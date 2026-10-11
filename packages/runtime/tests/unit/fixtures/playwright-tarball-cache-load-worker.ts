import { rm, writeFile } from 'node:fs/promises';

import { acquirePlaywrightTarballCacheLoadLease } from '../../playwright-tarball-cache';

const path = process.env.PLAYWRIGHT_TARBALL_CACHE_LOAD_PATH;
if (!path) throw new Error('PLAYWRIGHT_TARBALL_CACHE_LOAD_PATH is required');
const capacity = Number(process.env.PLAYWRIGHT_TARBALL_CACHE_LOAD_CAPACITY ?? '1');

process.send?.({ type: 'contending' });
const release = await acquirePlaywrightTarballCacheLoadLease(path, capacity);

if (process.env.PLAYWRIGHT_TARBALL_CACHE_LOAD_MODE === 'abandon') {
  process.send?.({ type: 'acquired' });
  process.exit(0);
}

const occupancyPath = capacity === 1 ? `${path}.occupied` : `${path}.${process.pid}.occupied`;
await writeFile(occupancyPath, String(process.pid), { flag: 'wx' });
process.send?.({ type: 'acquired' });

process.once('message', (message: unknown) => {
  if (message !== 'release') return;
  void rm(occupancyPath, { force: true })
    .then(release)
    .then(() => process.exit(0));
});
