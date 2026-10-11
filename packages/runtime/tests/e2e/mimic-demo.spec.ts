import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';
import {
  applyHmrHeadingUpdate,
  assertRuntimeEvidence,
  BrowserRuntimeDiagnostics,
  hostReload,
  loadFixture,
  terminalSelector
} from './browser-runtime-helpers';

const mimicPublicPackageBoundaryClaim = defineCompatibilityClaim({
  id: 'mimic-public-package-boundary-v1',
  statement:
    'The public Mimic package boundary renders the vanilla Vite 6 and Vite 7 demos, applies upstream HMR, and remains ready after host reload without fallback paths',
  target: {
    kind: 'runtime-capability',
    capability: 'mimic-public-package-boundary'
  }
});

for (const demo of [
  { fixture: 'vanilla', version: '6.4.3' },
  { fixture: 'vanilla-vite7', version: '7.3.6' }
] as const) {
  test(`${mimicPublicPackageBoundaryClaim.statement}: Vite ${demo.version}`, async ({ page }) => {
    const diagnostics = new BrowserRuntimeDiagnostics(page);
    await loadFixture(page, demo.fixture, diagnostics);

    const previewUrl = await page.locator('.browser-bar code').innerText();
    expect(previewUrl).toContain('/__mimic__/');

    await assertTerminalEvidence(page, demo.version);
    await assertRuntimeEvidence(page, demo.fixture, diagnostics);

    await applyHmrHeadingUpdate(page, demo.fixture, diagnostics);
    await assertRuntimeEvidence(page, demo.fixture, diagnostics);

    const endpointNavigationOffset = diagnostics.endpointNavigations.length;
    await hostReload(page, demo.fixture, diagnostics);
    const reloadedPreviewUrl = await page.locator('.browser-bar code').innerText();
    expect(reloadedPreviewUrl).toContain('/__mimic__/');
    expect(reloadedPreviewUrl).not.toBe(previewUrl);
    expect(diagnostics.endpointNavigations.slice(endpointNavigationOffset)).toContain(reloadedPreviewUrl);
    await assertTerminalEvidence(page, demo.version);
    await assertRuntimeEvidence(page, demo.fixture, diagnostics);
  });
}

async function assertTerminalEvidence(page: Parameters<typeof loadFixture>[0], viteVersion: string): Promise<void> {
  const terminalText = await page.locator(terminalSelector).innerText();
  expect(terminalText).toMatch(/added \d+ packages in \d+s/);
  expect(terminalText).toContain('install exited with 0');
  expect(terminalText).toContain(`VITE v${viteVersion}`);
  expect(terminalText).not.toContain('ourpm install:');
}
