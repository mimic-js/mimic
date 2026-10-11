import { expect, type Page } from '@playwright/test';

export type FixtureName = 'vanilla' | 'vanilla-vite7' | 'react' | 'solid' | 'typescript' | 'svelte';

/**
 * The e2e demo application (apps/e2e-demo) consumes the built package like any other
 * application. Claims that drive its fixture runner load it from its own
 * development server, which playwright.config.ts starts beside the test host.
 */
/** The port the Playwright web server listens on; `MIMIC_E2E_PORT` moves it (playwright.config.ts). */
export const e2ePort = Number(process.env.MIMIC_E2E_PORT ?? 4179);
export const documentationApplicationUrl = `http://127.0.0.1:${e2ePort + 1}`;

export const iframeSelector = 'iframe[title="Mimic preview"]';
export const terminalSelector = '.terminal-panel pre';
export const hmrUpdatedHeading = 'Vite HMR update applied inside the browser.';

const serverHmrProbeErrorText = 'mimic server-originated error payload';
const hmrPayloadStorageKey = '__mimicHmrPayloadLog';
const cssUpdatedMetricColor = 'rgb(255, 203, 112)';
const babelGeneratorDeoptimizationNote =
  /^\[BABEL\] Note: The code generator has deoptimised the styling of .+ as it exceeds the max of 500KB\.$/;
const forbiddenOutput = [
  'falling back to registered command adapter',
  'MimicUnsupportedExecutableError: Cannot execute "vite"',
  'esm.sh',
  'vfsPreviewFallback'
];

type PersistedHmrPayload = Readonly<Record<string, unknown>> & Readonly<{ type?: string }>;

type PersistedHmrUpdatePayload = PersistedHmrPayload & Readonly<{
  type: 'update';
  updates: ReadonlyArray<Readonly<{ path?: string; acceptedPath?: string }>>;
}>;

export class BrowserRuntimeDiagnostics {
  readonly browserRequests: string[] = [];
  readonly endpointNavigations: string[] = [];
  readonly pendingRequests = new Set<string>();
  readonly finishedRequests: string[] = [];
  readonly badResponses: string[] = [];
  readonly expectedOutdatedOptimizerUrls = new Set<string>();
  readonly expectedRetiredPreviewUrls = new Set<string>();
  readonly expectedNavigationAbortUrls = new Set<string>();
  readonly failedRequests: string[] = [];
  readonly consoleMessages: string[] = [];
  readonly consoleErrors: string[] = [];
  readonly pageErrors: string[] = [];
  readonly sourceResponses: string[] = [];
  readonly outdatedOptimizerResponses: string[] = [];

  constructor(private readonly page: Page) {
    page.on('request', (request) => {
      this.browserRequests.push(request.url());
      if (request.resourceType() === 'document' && request.url().includes('/__mimic__/')) {
        this.endpointNavigations.push(request.url());
      }
      this.pendingRequests.add(request.url());
    });
    page.on('requestfinished', (request) => {
      this.pendingRequests.delete(request.url());
      this.finishedRequests.push(request.url());
    });
    page.on('requestfailed', (request) => {
      this.pendingRequests.delete(request.url());
      this.failedRequests.push(`${request.failure()?.errorText ?? 'failed'} ${request.url()}`);
    });
    page.on('response', (response) => {
      if (response.url().includes('/src/App.svelte') || response.url().includes('/node_modules/.vite/deps/chunk-')) {
        void response
          .text()
          .then((body) => this.sourceResponses.push(`${response.status()} ${response.url()}\n${body.slice(0, 4000)}`))
          .catch(() => undefined);
      }
      if (response.status() < 400 || response.url().endsWith('/favicon.ico')) return;
      if (
        this.expectedOutdatedOptimizerUrls.has(response.url()) &&
        response.status() === 504 &&
        response.statusText() === 'Outdated Optimize Dep'
      ) {
        this.outdatedOptimizerResponses.push(`${response.status()} ${response.statusText()} ${response.url()}`);
        return;
      }
      if (this.expectedRetiredPreviewUrls.has(response.url()) && response.status() === 404) return;
      this.badResponses.push(`${response.status()} ${response.statusText()} ${response.url()}`);
    });
    page.on('console', (message) => {
      this.consoleMessages.push(`${message.type()} ${message.text()}`);
      if (message.text().startsWith('Failed to load resource:')) return;
      if (message.text().includes(serverHmrProbeErrorText)) return;
      if (message.type() === 'error' && !babelGeneratorDeoptimizationNote.test(message.text())) {
        this.consoleErrors.push(message.text());
      }
    });
    page.on('pageerror', (error) => this.pageErrors.push(error.stack ?? error.message));
  }

  async assertNoUnexpectedErrors(): Promise<void> {
    const unexpectedFailedRequests = this.failedRequests.filter(
      (failure) =>
        ![...this.expectedOutdatedOptimizerUrls, ...this.expectedNavigationAbortUrls].some((url) => failure.endsWith(url))
    );
    expect(
      [...this.badResponses, ...unexpectedFailedRequests, ...this.consoleErrors, ...this.pageErrors],
      await this.summary()
    ).toEqual([]);
  }

  async assertNoForbiddenFallbacks(): Promise<void> {
    const terminalText = await this.page.locator(terminalSelector).innerText();
    const iframeHtml = await this.page.frameLocator(iframeSelector).locator('body').evaluate((body) => body.ownerDocument.documentElement.outerHTML);
    const evidence = [terminalText, iframeHtml, this.browserRequests.join('\n')].join('\n');
    for (const forbidden of forbiddenOutput) {
      expect(evidence, `forbidden fallback "${forbidden}"\n${excerpt(evidence)}`).not.toContain(forbidden);
    }
  }

  async summary(): Promise<string> {
    return [
      `terminal:\n${excerpt(await this.page.locator(terminalSelector).innerText().catch(() => '<terminal unavailable>'))}`,
      `bad responses:\n${this.badResponses.slice(-20).join('\n') || '<none>'}`,
      `failed requests:\n${this.failedRequests.slice(-20).join('\n') || '<none>'}`,
      `pending requests:\n${[...this.pendingRequests].slice(-20).join('\n') || '<none>'}`,
      `console messages:\n${this.consoleMessages.slice(-30).join('\n') || '<none>'}`,
      `console errors:\n${this.consoleErrors.slice(-20).join('\n') || '<none>'}`,
      `page errors:\n${this.pageErrors.slice(-20).join('\n') || '<none>'}`,
      `source responses:\n${this.sourceResponses.map(excerpt).join('\n\n') || '<none>'}`,
      `recent finished requests:\n${this.finishedRequests.slice(-40).join('\n') || '<none>'}`,
      `recent requests:\n${this.browserRequests.slice(-40).join('\n') || '<none>'}`
    ].join('\n\n');
  }
}

export async function loadFixture(page: Page, fixture: FixtureName, diagnostics: BrowserRuntimeDiagnostics): Promise<void> {
  await page.goto(
    fixture === 'vanilla' ? documentationApplicationUrl : `${documentationApplicationUrl}/?fixture=${fixture}`,
    { waitUntil: 'domcontentloaded', timeout: 30_000 }
  );
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated), { timeout: 10_000 }).toBe(true);
  await page.locator(terminalSelector).waitFor({ timeout: 15_000 });
  const rendered = page
    .frameLocator(iframeSelector)
    .locator('h1', { hasText: headingForFixture(fixture) })
    .waitFor({ timeout: 240_000 });
  const runtimeFailed = page
    .locator('.status[data-state="failed"]')
    .waitFor({ timeout: 240_000 })
    .then(() => {
      throw new Error(`fixture ${fixture} runtime failed before render`);
    });
  await Promise.race([rendered, runtimeFailed])
    .catch(async (error) => {
      throw new Error(`fixture ${fixture} did not render:\n${await diagnostics.summary()}\n${error instanceof Error ? error.message : String(error)}`);
    });
  await assertDemoUiState(page, fixture);
}

export async function assertRuntimeEvidence(page: Page, fixture: FixtureName, diagnostics: BrowserRuntimeDiagnostics): Promise<void> {
  await assertFixtureDependencyEvidence(fixture, diagnostics.browserRequests);
  await diagnostics.assertNoForbiddenFallbacks();
  await diagnostics.assertNoUnexpectedErrors();
}

async function prepareHmrClientObservation(page: Page): Promise<string> {
  return page.frameLocator(iframeSelector).locator('body').evaluate((body, payloadStorageKey) => {
    const win = body.ownerDocument.defaultView;
    if (!win) throw new Error('preview window is unavailable');
    const marker = `${Date.now()}-${Math.random()}`;
    (win as typeof win & { __mimicReloadMarker?: string }).__mimicReloadMarker = marker;
    win.sessionStorage.removeItem(payloadStorageKey);
    (win as typeof win & { __mimicHmrEvents?: Array<{ type: string; detail?: unknown }> }).__mimicHmrEvents = [];
    win.addEventListener('vite:beforeUpdate', (event) =>
      (win as typeof win & { __mimicHmrEvents: Array<{ type: string; detail?: unknown }> }).__mimicHmrEvents.push({
        type: 'vite:beforeUpdate',
        detail: (event as CustomEvent).detail
      })
    );
    win.addEventListener('vite:afterUpdate', (event) =>
      (win as typeof win & { __mimicHmrEvents: Array<{ type: string; detail?: unknown }> }).__mimicHmrEvents.push({
        type: 'vite:afterUpdate',
        detail: (event as CustomEvent).detail
      })
    );
    win.addEventListener('vite:error', (event) =>
      (win as typeof win & { __mimicHmrEvents: Array<{ type: string; detail?: unknown }> }).__mimicHmrEvents.push({
        type: 'vite:error',
        detail: (event as CustomEvent).detail
      })
    );
    return marker;
  }, hmrPayloadStorageKey);
}

async function openHmrObserverSocket(page: Page): Promise<void> {
  await page.frameLocator(iframeSelector).locator('body').evaluate(async (body, payloadStorageKey) => {
    const win = body.ownerDocument.defaultView;
    if (!win) throw new Error('preview window is unavailable');
    const socketUrl = `${win.location.protocol === 'https:' ? 'wss' : 'ws'}://${win.location.host}/`;
    await new Promise<void>((resolve, reject) => {
      const socket = new win.WebSocket(socketUrl, 'vite-hmr');
      (win as typeof win & { __mimicHmrObserverSocket?: WebSocket }).__mimicHmrObserverSocket = socket;
      const timeout = win.setTimeout(() => reject(new Error('timed out opening preview HMR socket')), 5000);
      (win as typeof win & { __mimicHmrPayloads?: Array<{ type?: string }> }).__mimicHmrPayloads = [];
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ type: 'ping' }));
        win.clearTimeout(timeout);
        resolve();
      });
      socket.addEventListener('message', (event) => {
        try {
          const payload = JSON.parse(String(event.data));
          const payloads = (win as typeof win & { __mimicHmrPayloads: Array<{ type?: string }> }).__mimicHmrPayloads;
          payloads.push(payload);
          win.sessionStorage.setItem(payloadStorageKey, JSON.stringify(payloads));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.addEventListener('error', () => reject(new Error('preview HMR socket errored before open')));
    });
  }, hmrPayloadStorageKey);
}

export async function applyHmrHeadingUpdate(page: Page, fixture: FixtureName, diagnostics: BrowserRuntimeDiagnostics): Promise<void> {
  const reloadMarker = await prepareHmrClientObservation(page);
  const previewUrlBeforeUpdate = await page.locator('.browser-bar code').innerText();
  expect(await hasHmrObserverSocket(page), `${fixture} App update must precede the observer socket`).toBe(false);
  if (fixture === 'react') {
    const preview = page.frameLocator(iframeSelector);
    await preview.getByRole('button', { name: 'Increment' }).click();
    await preview.locator('[data-refresh-count]', { hasText: '1' }).waitFor({ timeout: 5_000 });
  }
  const editor = page.locator('.editor-panel textarea');
  const source = await editor.inputValue();
  if (isVanillaFixture(fixture)) {
    expect(source, 'vanilla App update must be owned by its upstream Vite client accept handler').toContain(
      'import.meta.hot.accept'
    );
  }
  const updatedSource = source.replace(headingForFixture(fixture), hmrUpdatedHeading);
  expect(updatedSource, `${fixture} source should contain expected heading`).not.toBe(source);
  await editor.fill(updatedSource);
  await page.locator('.editor-panel .write-button').click();
  const changedAppPath = appPathForFixture(fixture);
  await expect(page.locator(terminalSelector)).toContainText(`hmr update ${changedAppPath}`, {
    timeout: 15_000
  });
  await page.frameLocator(iframeSelector).locator('h1', { hasText: hmrUpdatedHeading }).waitFor({ timeout: 15_000 }).catch(async (error) => {
    throw new Error(`${fixture} Vite server reported HMR but DOM did not update:\n${await diagnostics.summary()}\n${error instanceof Error ? error.message : String(error)}`);
  });
  const markerAfterUpdate = await previewReloadMarker(page);
  expect(markerAfterUpdate, `${fixture} HMR should not reload iframe`).toBe(reloadMarker);
  expect(await page.locator('.browser-bar code').innerText(), `${fixture} HMR should preserve the Published Endpoint URL`).toBe(
    previewUrlBeforeUpdate
  );
  expect(await hasHmrObserverSocket(page), `${fixture} App update must complete before the observer socket opens`).toBe(false);
  if (fixture === 'react') {
    await page.frameLocator(iframeSelector).locator('[data-refresh-count]', { hasText: '1' }).waitFor({ timeout: 5_000 });
  }
  // The observer must remain passive proof; the upstream client owns the App update above.
  await openHmrObserverSocket(page);
  if (isVanillaFixture(fixture)) await assertVanillaCssHmr(page, reloadMarker);
}

export async function hardReloadPreview(page: Page, fixture: FixtureName, diagnostics: BrowserRuntimeDiagnostics): Promise<string[]> {
  const requestOffset = diagnostics.browserRequests.length;
  const previousTimeOrigin = await previewTimeOrigin(page);
  await page.locator(iframeSelector).evaluate((iframe) => (iframe as HTMLIFrameElement).contentWindow?.location.reload());
  await waitForPreviewNavigation(page, previousTimeOrigin);
  await page.frameLocator(iframeSelector).locator('h1', { hasText: headingForFixture(fixture) }).waitFor({ timeout: 30_000 });
  await sleep(250);
  return [...new Set(diagnostics.browserRequests.slice(requestOffset).filter(isOptimizedDependencyUrl))];
}

export async function hostReload(page: Page, fixture: FixtureName, diagnostics: BrowserRuntimeDiagnostics): Promise<string[]> {
  const requestOffset = diagnostics.browserRequests.length;
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated), { timeout: 10_000 }).toBe(true);
  await page.frameLocator(iframeSelector).locator('h1', { hasText: headingForFixture(fixture) }).waitFor({ timeout: 240_000 }).catch(async (error) => {
    throw new Error(`host reload did not restore ${fixture} iframe:\n${await diagnostics.summary()}\n${error instanceof Error ? error.message : String(error)}`);
  });
  await sleep(250);
  return [...new Set(diagnostics.browserRequests.slice(requestOffset).filter(isOptimizedDependencyUrl))];
}

export async function proveServerOriginatedHmrPayloads(page: Page, diagnostics: BrowserRuntimeDiagnostics): Promise<string[]> {
  const beforeProbeCount = await hmrPayloadCount(page);
  const previousTimeOrigin = await previewTimeOrigin(page);
  const probeTypes = ['update', 'prune', 'error', 'full-reload'] as const;
  for (const type of probeTypes) {
    const result = await page.frameLocator(iframeSelector).locator('body').evaluate(async (body, payloadType) => {
      const win = body.ownerDocument.defaultView;
      const url = new URL(`__mimic_hmr_probe?type=${payloadType}`, win?.location.href).href;
      try {
        const response = await win?.fetch(url, { cache: 'no-store' });
        return { ok: true, status: `${response?.status ?? 0} ${response?.statusText ?? ''}`.trim(), url };
      } catch (error) {
        return { ok: false, status: error instanceof Error ? error.message : String(error), url };
      }
    }, type);
    expect(result, `server-originated HMR probe ${type}\n${await diagnostics.summary()}`).toMatchObject({ ok: true, status: '200 OK' });
    // The payload navigates the iframe, which may abort the request that triggered it.
    if (type === 'full-reload') diagnostics.expectedNavigationAbortUrls.add(result.url);
    if (type !== 'full-reload') await waitForHmrPayloadType(page, type, beforeProbeCount);
  }

  await waitForPreviewNavigation(page, previousTimeOrigin);
  await page.frameLocator(iframeSelector).locator('h1', { hasText: hmrUpdatedHeading }).waitFor({ timeout: 30_000 });
  const payloads = await readPersistedHmrPayloads(page);
  const observedTypes = payloads.map((payload) => payload.type).filter((type): type is string => typeof type === 'string');
  for (const type of probeTypes) expect(observedTypes).toContain(type);

  const updatePayloads = payloads.filter(isPersistedHmrUpdatePayload);
  expect(
    updatePayloads.some((payload) =>
      payload.updates.some((entry) => entry.path === '/src/App.js' && entry.acceptedPath === '/src/App.js')
    )
  ).toBe(true);
  const prunePayload = payloads.find((payload) => payload.type === 'prune') as { paths?: string[] } | undefined;
  expect(prunePayload?.paths).toContain('/src/removed-by-server.js');
  const errorPayload = payloads.find((payload) => payload.type === 'error') as { err?: { message?: string } } | undefined;
  expect(errorPayload?.err?.message).toContain(serverHmrProbeErrorText);
  const fullReloadPayload = payloads.find((payload) => payload.type === 'full-reload') as { path?: string } | undefined;
  expect(fullReloadPayload?.path).toBe('/index.html');

  return observedTypes;
}

export async function switchFixture(page: Page, from: FixtureName, to: FixtureName, diagnostics: BrowserRuntimeDiagnostics): Promise<{ previewUrl: string }> {
  const previousPreviewUrl = await page.locator('.browser-bar code').innerText();
  await page.getByLabel('Fixture').selectOption(to);
  await page.frameLocator(iframeSelector).locator('h1', { hasText: headingForFixture(to) }).waitFor({ timeout: 240_000 }).catch(async (error) => {
    throw new Error(`fixture switch ${from} -> ${to} failed:\n${await diagnostics.summary()}\n${error instanceof Error ? error.message : String(error)}`);
  });
  const nextPreviewUrl = await page.locator('.browser-bar code').innerText();
  expect(nextPreviewUrl, `fixture switch ${from} -> ${to} should get a fresh preview URL`).not.toBe(previousPreviewUrl);
  await page.waitForFunction(() => document.querySelectorAll('iframe[title="Mimic preview"]').length === 1, null, { timeout: 5_000 });
  await page.waitForFunction(() => document.querySelector('.status')?.getAttribute('data-state') === 'ready', null, { timeout: 5_000 });
  await assertDemoUiState(page, to);
  return { previewUrl: nextPreviewUrl };
}

export async function assertRetiredPreviewRouteRejected(page: Page, retiredPreviewUrl: string, diagnostics: BrowserRuntimeDiagnostics): Promise<void> {
  diagnostics.expectedRetiredPreviewUrls.add(retiredPreviewUrl);
  // Requests are routed by the document that makes them; the current preview's is one.
  const retiredResponse = await page.frameLocator(iframeSelector).locator('body').evaluate(async (body, url) => {
    const win = body.ownerDocument.defaultView;
    if (!win) throw new Error('The preview has no window.');
    const response = await win.fetch(url, { cache: 'no-store' });
    return { status: response.status, body: await response.text() };
  }, retiredPreviewUrl);
  expect(retiredResponse.status).toBe(404);
  expect(retiredResponse.body).toContain('Published Endpoint route is stale or unavailable.');
}

export function headingForFixture(selected: FixtureName): string {
  return selected === 'react'
    ? 'React + Vite preview is running inside the browser.'
    : selected === 'solid'
      ? 'Solid + Vite preview is running inside the browser.'
      : selected === 'typescript'
        ? 'TypeScript + Vite preview is running inside the browser.'
        : selected === 'svelte'
          ? 'Svelte + Vite preview is running inside the browser.'
          : 'Vite preview is running inside the browser.';
}

function appPathForFixture(selected: FixtureName): string {
  return isVanillaFixture(selected)
    ? '/src/App.js'
    : selected === 'typescript'
      ? '/src/App.ts'
      : selected === 'svelte'
        ? '/src/App.svelte'
        : '/src/App.jsx';
}

async function assertDemoUiState(page: Page, selected: FixtureName): Promise<void> {
  await page.waitForFunction(
    ({ expectedSupport }) =>
      document.querySelector('.fixture-support')?.textContent?.trim() === expectedSupport &&
      document.querySelector('.status')?.getAttribute('data-state') === 'ready',
    { expectedSupport: supportForFixture(selected) },
    { timeout: 5_000 }
  );
  const selectedOption = await page.getByLabel('Fixture').evaluate((select) => {
    const element = select as HTMLSelectElement;
    return element.selectedOptions[0]?.textContent?.trim() ?? '';
  });
  expect(selectedOption).toContain(supportForFixture(selected).replace(':', ' -'));
}

function supportForFixture(selected: FixtureName): string {
  return selected === 'react'
    ? 'React: First framework target'
    : selected === 'svelte'
      ? 'Svelte: Experimental browser proof'
      : `${labelForFixture(selected)}: Browser-proven partial`;
}

function labelForFixture(selected: FixtureName): string {
  return selected === 'typescript'
    ? 'TypeScript'
    : selected === 'vanilla-vite7'
      ? 'Vanilla Vite 7'
      : selected[0].toUpperCase() + selected.slice(1);
}

function isVanillaFixture(selected: FixtureName): boolean {
  return selected === 'vanilla' || selected === 'vanilla-vite7';
}

async function assertFixtureDependencyEvidence(fixture: FixtureName, browserRequests: string[]): Promise<void> {
  if (fixture === 'react') {
    expect(browserRequests.some((url) => url.includes('/@react-refresh'))).toBe(true);
    expect(browserRequests.some((url) => url.includes('/node_modules/.vite/deps/react.js'))).toBe(true);
    expect(browserRequests.some((url) => url.includes('/node_modules/.vite/deps/react-dom_client.js'))).toBe(true);
  } else if (fixture === 'solid') {
    expect(browserRequests.some((url) => url.includes('/src/main.jsx'))).toBe(true);
    expect(browserRequests.some((url) => url.includes('/node_modules/.vite/deps/solid-js_web.js'))).toBe(true);
  } else if (fixture === 'svelte') {
    expect(browserRequests.some((url) => url.includes('/src/App.svelte'))).toBe(true);
  } else {
    expect(browserRequests.some((url) => url.includes('/node_modules/.vite/deps/picocolors.js'))).toBe(true);
  }
}

async function assertVanillaCssHmr(page: Page, reloadMarker: string): Promise<void> {
  const payloadCountBeforeCss = await hmrPayloadCount(page);
  await page.getByRole('tab', { name: 'CSS' }).click();
  const cssEditor = page.locator('.editor-panel textarea');
  const cssSource = await cssEditor.inputValue();
  const updatedCssSource = cssSource.replace('article strong {\n  color: white;', `article strong {\n  color: ${cssUpdatedMetricColor};`);
  expect(updatedCssSource).not.toBe(cssSource);
  await cssEditor.fill(updatedCssSource);
  await page.locator('.editor-panel .write-button').click();
  await waitForHmrPayload(page, '/src/style.css', payloadCountBeforeCss);
  await page.waitForFunction(
    ({ selector, expectedColor }) => {
      const iframe = document.querySelector(selector) as HTMLIFrameElement | null;
      const strong = iframe?.contentDocument?.querySelector('article strong');
      return Boolean(strong && iframe?.contentWindow?.getComputedStyle(strong).color === expectedColor);
    },
    { selector: iframeSelector, expectedColor: cssUpdatedMetricColor },
    { timeout: 15_000 }
  );
  expect(await previewReloadMarker(page)).toBe(reloadMarker);
}

async function previewReloadMarker(page: Page): Promise<string | undefined> {
  return page
    .frameLocator(iframeSelector)
    .locator('body')
    .evaluate((body) => (body.ownerDocument.defaultView as Window & { __mimicReloadMarker?: string } | null)?.__mimicReloadMarker);
}

async function hasHmrObserverSocket(page: Page): Promise<boolean> {
  return page
    .frameLocator(iframeSelector)
    .locator('body')
    .evaluate(
      (body) =>
        Boolean(
          (body.ownerDocument.defaultView as
            | (Window & { __mimicHmrObserverSocket?: WebSocket })
            | null)?.__mimicHmrObserverSocket
        )
    );
}

async function previewTimeOrigin(page: Page): Promise<number> {
  return page.locator(iframeSelector).evaluate((iframe) => {
    const timeOrigin = (iframe as HTMLIFrameElement).contentWindow?.performance.timeOrigin;
    if (typeof timeOrigin !== 'number') throw new Error('preview time origin is unavailable');
    return timeOrigin;
  });
}

async function waitForPreviewNavigation(page: Page, previousTimeOrigin: number): Promise<void> {
  await page.waitForFunction(
    ({ selector, previous }) => {
      const iframe = document.querySelector(selector) as HTMLIFrameElement | null;
      try {
        const next = iframe?.contentWindow?.performance.timeOrigin;
        return typeof next === 'number' && next !== previous;
      } catch {
        return false;
      }
    },
    { selector: iframeSelector, previous: previousTimeOrigin },
    { timeout: 30_000 }
  );
}

function isOptimizedDependencyUrl(url: string): boolean {
  return url.includes('/node_modules/.vite/deps/') && /[?&]v=/.test(url);
}

async function waitForHmrPayloadType(page: Page, type: string, minimumPayloadCount = 0): Promise<void> {
  await page.waitForFunction(
    ({ selector, type, minimumPayloadCount }) => {
      const iframe = document.querySelector(selector) as HTMLIFrameElement | null;
      const payloads = (iframe?.contentWindow as (Window & { __mimicHmrPayloads?: Array<{ type?: string }> }) | undefined)
        ?.__mimicHmrPayloads;
      return payloads?.slice(minimumPayloadCount).some((payload) => payload.type === type) === true;
    },
    { selector: iframeSelector, type, minimumPayloadCount },
    { timeout: 15_000 }
  );
}

async function readPersistedHmrPayloads(page: Page): Promise<ReadonlyArray<PersistedHmrPayload>> {
  const raw = await page.frameLocator(iframeSelector).locator('body').evaluate(
    (body, payloadStorageKey) => body.ownerDocument.defaultView?.sessionStorage.getItem(payloadStorageKey) ?? null,
    hmrPayloadStorageKey
  );
  if (raw === null) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(isPersistedHmrPayload)) {
    throw new Error(`persisted HMR payload log has an invalid shape: ${raw}`);
  }
  return parsed;
}

function isPersistedHmrPayload(value: unknown): value is PersistedHmrPayload {
  return isRecord(value) && (value.type === undefined || typeof value.type === 'string');
}

function isPersistedHmrUpdatePayload(payload: PersistedHmrPayload): payload is PersistedHmrUpdatePayload {
  return payload.type === 'update' &&
    Array.isArray(payload.updates) &&
    payload.updates.every(
      (update) =>
        isRecord(update) &&
        (update.path === undefined || typeof update.path === 'string') &&
        (update.acceptedPath === undefined || typeof update.acceptedPath === 'string')
    );
}

async function waitForHmrPayload(
  page: Page,
  changedPath = '/src/',
  minimumPayloadCount = 0
): Promise<Array<{ type?: string; updates?: Array<{ path?: string }> }>> {
  await page.waitForFunction(
    ({ selector, changedPath, minimumPayloadCount }) => {
      const iframe = document.querySelector(selector) as HTMLIFrameElement | null;
      const payloads = (
        iframe?.contentWindow as (Window & { __mimicHmrPayloads?: Array<{ type?: string; updates?: Array<{ path?: string }> }> }) | undefined
      )?.__mimicHmrPayloads;
      return payloads?.slice(minimumPayloadCount).some((payload) => {
        if (payload.type === 'full-reload') return changedPath === '/' || changedPath.endsWith('.html');
        return payload.type === 'update' && payload.updates?.some((entry) => entry.path === changedPath || entry.path?.startsWith(changedPath));
      }) === true;
    },
    { selector: iframeSelector, changedPath, minimumPayloadCount },
    { timeout: 15_000 }
  );
  return page.frameLocator(iframeSelector).locator('body').evaluate((body, { changedPath, minimumPayloadCount }) => {
    const win = body.ownerDocument.defaultView as
      | (Window & { __mimicHmrPayloads?: Array<{ type?: string; updates?: Array<{ path?: string }> }> })
      | null;
    const payloads = win?.__mimicHmrPayloads ?? [];
    const update = payloads.slice(minimumPayloadCount).find((payload) => payload.type === 'update' || payload.type === 'full-reload');
    if (!update) throw new Error(`preview HMR socket did not receive a Vite payload: ${JSON.stringify(payloads)}`);
    if (update.type === 'update' && !update.updates?.some((entry) => entry.path === changedPath || entry.path?.startsWith(changedPath))) {
      throw new Error(`preview HMR update payload did not include the changed source path: ${JSON.stringify(update)}`);
    }
    return payloads;
  }, { changedPath, minimumPayloadCount });
}

async function hmrPayloadCount(page: Page): Promise<number> {
  return page.frameLocator(iframeSelector).locator('body').evaluate((body) => {
    const win = body.ownerDocument.defaultView as (Window & { __mimicHmrPayloads?: unknown[] }) | null;
    return win?.__mimicHmrPayloads?.length ?? 0;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function excerpt(value: string): string {
  return value.length > 4_000 ? `${value.slice(0, 4_000)}\n...` : value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
