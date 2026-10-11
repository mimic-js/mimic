import { expect, test as base } from '@playwright/test';

import {
  installPlaywrightTarballCache,
  type PlaywrightTarballCacheEvidence,
  type PlaywrightTarballCacheSession,
  type TarballCacheBrowserContext
} from '../playwright-tarball-cache';
import { serveInstallLayers } from './install-layer-store';
import { defaultRuntimeHardwareConcurrencyPin, pinRuntimeHardwareConcurrency } from './runtime-hardware-concurrency';

const tarballCacheDirectory = '.cache/playwright-tarballs';

type InstallTarballCache = (context: TarballCacheBrowserContext) => Promise<void>;
type ReadTarballCacheEvidence = () => PlaywrightTarballCacheEvidence;

type CompatibilityFixtures = Readonly<{
  installTarballCache: InstallTarballCache;
  tarballCacheEvidence: ReadTarballCacheEvidence;
}>;

const defaultTarballCacheSessions = new WeakMap<object, PlaywrightTarballCacheSession>();

export async function installTarballCacheForContext(
  context: TarballCacheBrowserContext
): Promise<PlaywrightTarballCacheSession> {
  return installPlaywrightTarballCache(context, { directory: tarballCacheDirectory });
}

export const test = base.extend<CompatibilityFixtures>({
  context: async ({ context }, use) => {
    await context.addInitScript(pinRuntimeHardwareConcurrency, defaultRuntimeHardwareConcurrencyPin);
    const session = await installTarballCacheForContext(context);
    await serveInstallLayers(context);
    defaultTarballCacheSessions.set(context, session);
    // The built-in context fixture closes the whole BrowserContext next. Avoid
    // an explicit interception update while Chromium is still detaching the
    // runtime's terminated workers; context close releases the route itself.
    try {
      await use(context);
    } finally {
      defaultTarballCacheSessions.delete(context);
    }
  },
  tarballCacheEvidence: async ({ context }, use) => {
    const session = defaultTarballCacheSessions.get(context);
    if (!session) throw new Error('The default compatibility tarball cache session is unavailable');
    await use(() => session.evidence());
  },
  installTarballCache: async ({}, use) => {
    const sessions: PlaywrightTarballCacheSession[] = [];
    try {
      await use(async (context) => {
        const session = await installTarballCacheForContext(context);
        sessions.push(session);
      });
    } finally {
      await Promise.all(sessions.map((session) => session.close()));
    }
  }
});

export { expect };
