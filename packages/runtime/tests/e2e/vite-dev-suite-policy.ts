import {
  parseJsonEvidenceRecord,
  requireEvidenceRecord
} from './json-evidence-decoder';
import type { BrowserNetworkEvent } from './stack-scenario';

/** When an optimizer case added its late dependency and when Vite had served it. */
export type LateDiscovery = Readonly<{ startedAtMs: number; completedAtMs: number }>;

export function assertDefaultViteConfigLoader(packageJsonSource: string, label: string): void {
  const packageJson = parseJsonEvidenceRecord(packageJsonSource, `${label} fixture package.json`);
  const scripts = requireEvidenceRecord(packageJson.scripts, `${label} fixture package scripts`);
  const devScript = scripts.dev;
  if (typeof devScript !== 'string' || devScript.trim() === '') {
    throw new Error(`${label} fixture must declare a dev script`);
  }
  if (/(?:^|\s)--configLoader(?:=|\s|$)/u.test(devScript)) {
    throw new Error(
      `${label} fixture must use Vite's default bundle config loader without an explicit --configLoader override`
    );
  }
}

/** Whether `event` is the document request Vite abandons when it reloads the preview during late discovery. */
export function isAllowedOptimizerReloadAbort(
  event: BrowserNetworkEvent,
  previewUrl: string,
  lateDiscovery: LateDiscovery | null
): boolean {
  return lateDiscovery !== null &&
    event.kind === 'request-failed' &&
    event.error === 'net::ERR_ABORTED' &&
    event.url === previewUrl &&
    event.occurredAtMs >= lateDiscovery.startedAtMs &&
    event.occurredAtMs <= lateDiscovery.completedAtMs;
}

/**
 * Whether `event` is a request of a preview document that Vite's late-discovery
 * reload replaced while the request was still open: the browser aborts it with
 * the document, as the stack teardown accepts for any navigating document.
 */
export function isAbandonedByOptimizerReload(
  event: BrowserNetworkEvent,
  previewUrl: string,
  lateDiscovery: LateDiscovery | null
): boolean {
  return lateDiscovery !== null &&
    event.kind === 'request-failed' &&
    event.error === 'net::ERR_ABORTED' &&
    new URL(event.url).origin === new URL(previewUrl).origin &&
    event.occurredAtMs >= lateDiscovery.startedAtMs &&
    event.occurredAtMs <= lateDiscovery.completedAtMs &&
    event.navigatedAway?.() === true;
}

export function findUnexpectedViteRequestFailures(
  events: readonly BrowserNetworkEvent[],
  expectedTransformErrorUrls: ReadonlySet<string>,
  previewUrl: string,
  lateDiscovery: LateDiscovery | null
): readonly BrowserNetworkEvent[] {
  return events.filter((event) =>
    event.kind === 'request-failed' &&
    !(event.error === 'net::ERR_ABORTED' && expectedTransformErrorUrls.has(event.url)) &&
    !isAllowedOptimizerReloadAbort(event, previewUrl, lateDiscovery) &&
    !isAbandonedByOptimizerReload(event, previewUrl, lateDiscovery)
  );
}
