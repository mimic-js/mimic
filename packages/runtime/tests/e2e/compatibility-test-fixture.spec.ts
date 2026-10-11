import { randomUUID } from 'node:crypto';

import type { BrowserContext, Page } from '@playwright/test';

import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';

const tarballCacheClaim = defineCompatibilityClaim({
  id: 'playwright-tarball-cache-context-lifecycle',
  statement: 'Compatibility tests reuse publisher tarballs across fresh BrowserContexts',
  target: {
    kind: 'runtime-capability',
    capability: 'playwright-tarball-cache-context-lifecycle'
  }
});

const tarballUrl =
  `https://registry.npmjs.org/picocolors/-/picocolors-1.1.1.tgz?compatibility-fixture=${randomUUID()}`;
let additionalContext: BrowserContext | undefined;

test.describe.configure({ mode: 'serial' });

test(tarballCacheClaim.statement, async ({ browser, installTarballCache, page }) => {
  const cold = await fetchTarball(page);
  expect(cold.status).toBe(200);
  expect(cold.byteLength).toBeGreaterThan(0);

  additionalContext = await browser.newContext({ offline: true });
  await installTarballCache(additionalContext);
  const offlinePage = await additionalContext.newPage();

  await expect(fetchTarball(offlinePage)).resolves.toEqual(cold);
});

test('removes additional-context tarball routes with fixture lifecycle cleanup', async () => {
  expect(additionalContext).toBeDefined();
  const offlinePage = additionalContext!.pages()[0];

  await expect(fetchTarball(offlinePage)).rejects.toThrow();
  await additionalContext!.close();
  additionalContext = undefined;
});

test.afterAll(async () => {
  await additionalContext?.close();
});

async function fetchTarball(page: Page): Promise<{ status: number; byteLength: number }> {
  return page.evaluate(async (url) => {
    const response = await fetch(url);
    return { status: response.status, byteLength: (await response.arrayBuffer()).byteLength };
  }, tarballUrl);
}
