import type { FrameLocator } from '@playwright/test';

import { documentId, eventually, resourceUrls, textOf } from './stack-scenario';

/**
 * Waits for the application of a Vite case to show its heading and the name of
 * its framework after loading each of `resourcePaths`, and answers the
 * addresses of everything its document loaded.
 */
export async function expectRendered(
  app: FrameLocator,
  expected: Readonly<{ heading: string; framework: string; resourcePaths: readonly string[] }>
): Promise<string[]> {
  await eventually(() => textOf(app.locator('h1'))).toBe(expected.heading);
  await eventually(() => textOf(app.locator('[data-framework]'))).toBe(expected.framework);
  let urls: string[] = [];
  await eventually(async () => {
    urls = await resourceUrls(app).catch(() => []);
    return ['/@vite/client', ...expected.resourcePaths].filter((path) => !urls.some((url) => url.includes(path)));
  }, 'the application did not load these resources').toEqual([]);
  return urls;
}

/** Waits until the frame has shown one completely loaded document for a moment, as it does once Vite stops reloading it. */
export async function expectSettled(app: FrameLocator): Promise<void> {
  const loaded = (): Promise<number | undefined> =>
    app
      .locator('html')
      .evaluate(() => (document.readyState === 'complete' ? performance.timeOrigin : undefined))
      .catch(() => undefined);
  await eventually(async () => {
    const before = await loaded();
    await new Promise((resolve) => setTimeout(resolve, 100));
    return before !== undefined && before === (await loaded()) && before === (await documentId(app).catch(() => undefined));
  }, 'the document did not settle').toBe(true);
}
