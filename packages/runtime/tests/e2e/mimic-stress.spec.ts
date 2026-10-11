import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';

import {
  BrowserRuntimeDiagnostics,
  type FixtureName,
  applyHmrHeadingUpdate,
  assertRetiredPreviewRouteRejected,
  assertRuntimeEvidence,
  hardReloadPreview,
  headingForFixture,
  hostReload,
  iframeSelector,
  loadFixture,
  proveServerOriginatedHmrPayloads,
  switchFixture
} from './browser-runtime-helpers';

const reactHostReloadClaim = defineCompatibilityClaim({
  id: 'react-host-reload-optimized-dependencies-v1',
  statement: 'React host reload restores the runtime preview with optimized dependency diagnostics',
  target: {
    kind: 'runtime-capability',
    capability: 'host-reload-optimized-dependency-coherence'
  }
});

const vanillaHostReloadClaim = defineCompatibilityClaim({
  id: 'vanilla-host-reload-optimized-dependencies-v1',
  statement: 'Vanilla host reload restores the runtime preview with optimized dependency diagnostics',
  target: {
    kind: 'runtime-capability',
    capability: 'host-reload-optimized-dependency-coherence'
  }
});

const serverOriginatedHmrClaim = defineCompatibilityClaim({
  id: 'server-originated-hmr-session-v1',
  statement: 'Server-originated HMR payloads stay on the active real WebSocket session',
  target: {
    kind: 'runtime-capability',
    capability: 'active-websocket-hmr-session'
  }
});

const fixtureReloadMatrixClaim = defineCompatibilityClaim({
  id: 'maintained-fixture-reload-matrix-v1',
  statement:
    'Browser reloads keep Vanilla, TypeScript, React, and Solid on coherent optimized dependency generations',
  target: {
    kind: 'runtime-capability',
    capability: 'maintained-preview-reload-coherence'
  }
});

const fixtureSwitchingClaim = defineCompatibilityClaim({
  id: 'runtime-fixture-switching-teardown-v1',
  statement: 'Browser fixture switching among positive fixtures tears down retired previews and preserves one active preview',
  target: {
    kind: 'runtime-capability',
    capability: 'runtime-preview-switch-teardown'
  }
});

test.describe.configure({ mode: 'serial' });

test(reactHostReloadClaim.statement, async ({ page }) => {
  test.setTimeout(300_000);
  const diagnostics = new BrowserRuntimeDiagnostics(page);

  await loadFixture(page, 'react', diagnostics);
  const optimizedUrls = await hostReload(page, 'react', diagnostics);

  expect(optimizedUrls.some((url) => url.includes('/node_modules/.vite/deps/react'))).toBe(true);
  await assertRuntimeEvidence(page, 'react', diagnostics);
});

test(vanillaHostReloadClaim.statement, async ({ page }) => {
  test.setTimeout(300_000);
  const diagnostics = new BrowserRuntimeDiagnostics(page);

  await loadFixture(page, 'vanilla', diagnostics);
  const optimizedUrls = await hostReload(page, 'vanilla', diagnostics);

  expect(optimizedUrls.some((url) => url.includes('/node_modules/.vite/deps/picocolors'))).toBe(true);
  await assertRuntimeEvidence(page, 'vanilla', diagnostics);
});

test(serverOriginatedHmrClaim.statement, async ({ page }) => {
  test.setTimeout(240_000);
  const diagnostics = new BrowserRuntimeDiagnostics(page);

  await loadFixture(page, 'vanilla', diagnostics);
  await applyHmrHeadingUpdate(page, 'vanilla', diagnostics);
  const observedTypes = await proveServerOriginatedHmrPayloads(page, diagnostics);

  expect(observedTypes).toEqual(expect.arrayContaining(['update', 'prune', 'error', 'full-reload']));
  await assertRuntimeEvidence(page, 'vanilla', diagnostics);
});

test(fixtureReloadMatrixClaim.statement, async ({ page }) => {
  test.setTimeout(600_000);
  const fixtures: FixtureName[] = ['vanilla', 'typescript', 'react', 'solid'];
  const matrix: Array<{ fixture: FixtureName; optimizedUrls: string[] }> = [];

  for (const fixture of fixtures) {
    const fixturePage = fixture === fixtures[0] ? page : await page.context().newPage();
    const diagnostics = new BrowserRuntimeDiagnostics(fixturePage);
    await loadFixture(fixturePage, fixture, diagnostics);
    const optimizedUrls = [
      ...(await hardReloadPreview(fixturePage, fixture, diagnostics)),
      ...(await hardReloadPreview(fixturePage, fixture, diagnostics))
    ];
    matrix.push({ fixture, optimizedUrls });
    await assertRuntimeEvidence(fixturePage, fixture, diagnostics);
    if (fixturePage !== page) await fixturePage.close();
  }

  expect(matrix.map((entry) => entry.fixture)).toEqual(fixtures);
  for (const entry of matrix) {
    expect(entry.optimizedUrls, `${entry.fixture} optimized dependency URLs`).not.toContainEqual(expect.stringContaining('504'));
  }
});

test(fixtureSwitchingClaim.statement, async ({ page }) => {
  test.setTimeout(600_000);
  const diagnostics = new BrowserRuntimeDiagnostics(page);
  const switchFixtures: FixtureName[] = ['typescript', 'react', 'solid'];
  const observedPreviewUrls = new Set<string>();

  await loadFixture(page, 'vanilla', diagnostics);
  const initialPreviewUrl = await page.locator('.browser-bar code').innerText();
  observedPreviewUrls.add(initialPreviewUrl);
  let current: FixtureName = 'vanilla';
  for (const next of switchFixtures) {
    const result = await switchFixture(page, current, next, diagnostics);
    expect(observedPreviewUrls.has(result.previewUrl)).toBe(false);
    observedPreviewUrls.add(result.previewUrl);
    current = next;
  }

  await assertRetiredPreviewRouteRejected(page, initialPreviewUrl, diagnostics);
  await expect(page.frameLocator(iframeSelector).locator('h1', { hasText: headingForFixture('solid') })).toBeVisible();
  await assertRuntimeEvidence(page, 'solid', diagnostics);
});
