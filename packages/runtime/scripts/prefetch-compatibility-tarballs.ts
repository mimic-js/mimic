import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hasCachedPlaywrightTarball, storePlaywrightTarball } from '../tests/playwright-tarball-cache';

/**
 * Fills the Playwright Tarball Cache with every publisher tarball the tracked
 * npm lockfiles name, so compatibility installs never wait on the registry.
 *
 *   tsx scripts/prefetch-compatibility-tarballs.ts [fixture-name-substring...]
 */

const fixturesRoot = fileURLToPath(new URL('../compatibility/fixtures/', import.meta.url));
const directory = process.env.COMPATIBILITY_TARBALL_CACHE ?? '.cache/playwright-tarballs';
const concurrency = 16;
const filters = process.argv.slice(2);

type LockedPackage = Readonly<{ resolved?: string; integrity?: string; os?: string[]; cpu?: string[] }>;

// The Runtime Platform Profile: npm inside Mimic skips packages
// limited to another operating system or architecture, so the cache does too.
const installsOnVirtualPlatform = (entry: LockedPackage): boolean =>
  (entry.os === undefined || entry.os.includes('browser')) &&
  (entry.cpu === undefined || entry.cpu.includes('wasm32'));

const tarballs = new Map<string, string | undefined>();
for (const fixture of readdirSync(fixturesRoot)) {
  if (filters.length > 0 && !filters.some((filter) => fixture.includes(filter))) continue;
  let lockfile: { packages?: Record<string, LockedPackage> };
  try {
    lockfile = JSON.parse(readFileSync(join(fixturesRoot, fixture, 'package-lock.json'), 'utf8'));
  } catch {
    continue;
  }
  for (const entry of Object.values(lockfile.packages ?? {})) {
    if (entry.resolved?.startsWith('https://') && entry.resolved.endsWith('.tgz') && installsOnVirtualPlatform(entry)) {
      tarballs.set(entry.resolved, entry.integrity);
    }
  }
}

const startedAt = Date.now();
const queue = [...tarballs];
let fetched = 0;
let bytes = 0;
const failures: string[] = [];

await Promise.all(
  Array.from({ length: concurrency }, async () => {
    for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
      const [url, integrity] = next;
      if (await hasCachedPlaywrightTarball(directory, url)) continue;
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = Buffer.from(await response.arrayBuffer());
        if (integrity?.startsWith('sha512-') && sha512(body) !== integrity) throw new Error('integrity mismatch');
        await storePlaywrightTarball(directory, url, body);
        fetched += 1;
        bytes += body.byteLength;
      } catch (error) {
        failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  })
);

const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(
  `${tarballs.size} tarballs named, ${fetched} fetched (${(bytes / 2 ** 20).toFixed(1)} MiB) in ${seconds}s into ${directory}`
);
if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
}

function sha512(body: Buffer): string {
  return `sha512-${createHash('sha512').update(body).digest('base64')}`;
}
