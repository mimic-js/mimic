import { describe, expect, it, test } from 'vitest';

import {
  assertDefaultViteConfigLoader,
  findUnexpectedViteRequestFailures,
  isAllowedOptimizerReloadAbort
} from '../e2e/vite-dev-suite-policy';

describe('Vite development suite policy', () => {
  it('accepts the default bundle config loader without a configurable loader shape', () => {
    expect(() =>
      assertDefaultViteConfigLoader('{"scripts":{"dev":"vite --host 0.0.0.0"}}', 'Vanilla')
    ).not.toThrow();
  });

  it.each(['vite --configLoader runner', 'vite --configLoader=bundle'])(
    'rejects the explicit config loader override %s',
    (devScript) => {
      expect(() =>
        assertDefaultViteConfigLoader(
          JSON.stringify({ scripts: { dev: devScript } }),
          'Vanilla'
        )
      ).toThrow(
        "Vanilla fixture must use Vite's default bundle config loader without an explicit --configLoader override"
      );
    }
  );
});

test('optimizer reload allowance is limited to the late-discovery interval', () => {
  const event = {
    kind: 'request-failed',
    url: 'http://localhost/preview/',
    error: 'net::ERR_ABORTED',
    occurredAtMs: 200
  } as const;
  const lateDiscovery = { startedAtMs: 100, completedAtMs: 300 };

  expect(isAllowedOptimizerReloadAbort(event, event.url, lateDiscovery)).toBe(true);
  expect(isAllowedOptimizerReloadAbort({ ...event, occurredAtMs: 99 }, event.url, lateDiscovery)).toBe(false);
  expect(isAllowedOptimizerReloadAbort({ ...event, occurredAtMs: 301 }, event.url, lateDiscovery)).toBe(false);
  expect(isAllowedOptimizerReloadAbort(event, event.url, null)).toBe(false);
});

test('identical optimizer aborts preserve their phase identity', () => {
  const previewUrl = 'http://localhost/preview/';
  const lateDiscovery = { startedAtMs: 100, completedAtMs: 300 };
  const beforeDiscovery = {
    kind: 'request-failed',
    url: previewUrl,
    error: 'net::ERR_ABORTED',
    occurredAtMs: 99
  } as const;
  const duringDiscovery = { ...beforeDiscovery, occurredAtMs: 200 };

  expect(
    findUnexpectedViteRequestFailures(
      [beforeDiscovery, duringDiscovery],
      new Set(),
      previewUrl,
      lateDiscovery
    )
  ).toEqual([beforeDiscovery]);
});

test('transform-error URLs allow only aborted requests', () => {
  const transformUrl = 'http://localhost/src/App.js';
  const aborted = {
    kind: 'request-failed',
    url: transformUrl,
    error: 'net::ERR_ABORTED',
    occurredAtMs: 100
  } as const;
  const failed = { ...aborted, error: 'net::ERR_FAILED' };

  expect(
    findUnexpectedViteRequestFailures(
      [aborted, failed],
      new Set([transformUrl]),
      'http://localhost/preview/',
      null
    )
  ).toEqual([failed]);
});
