import { describe, expect, test } from 'vitest';

import {
  normalizePreviewOrigin,
  publishedEndpointLayout,
  publishedEndpointOriginDocumentUrl,
  publishedEndpointScopeDocumentUrl,
  publishedEndpointUrl,
  runtimeHostOrigin
} from './endpoint-layout';

const endpoint = (port: number) => ({
  routeId: `epoch-1:route-${port}`,
  address: { host: '127.0.0.1', port }
});

describe('normalizePreviewOrigin', () => {
  test('keeps an origin and rejects a path, another scheme or a malformed wildcard', () => {
    expect(normalizePreviewOrigin(undefined)).toBeUndefined();
    expect(normalizePreviewOrigin('https://preview.example')).toBe('https://preview.example');
    expect(normalizePreviewOrigin('http://*.localhost:5173')).toBe('http://*.localhost:5173');
    expect(normalizePreviewOrigin('https://*.preview.example')).toBe('https://*.preview.example');
    for (const invalid of [
      'preview.example',
      'https://preview.example/path',
      'ftp://*.preview.example',
      'https://preview-*.example',
      'https://*.example/',
      'https://*.*.example',
      'https://*.preview.example:443'
    ]) {
      expect(() => normalizePreviewOrigin(invalid), invalid).toThrow(TypeError);
    }
  });

  test('a wildcard puts the Runtime Host document on its fixed label', () => {
    expect(runtimeHostOrigin(undefined)).toBeUndefined();
    expect(runtimeHostOrigin('https://preview.example')).toBe('https://preview.example');
    expect(runtimeHostOrigin('http://*.localhost:5173')).toBe('http://mimic.localhost:5173');
  });
});

describe('publishedEndpointLayout', () => {
  const serviceWorkerUrl = 'https://mimic.preview.example/assets/service-worker-abc123.js';

  test('a single origin serves endpoints under the directory beside the Service Worker', () => {
    const layout = publishedEndpointLayout({ previewOrigin: 'https://preview.example', serviceWorkerUrl: 'https://preview.example/assets/service-worker-abc123.js' });
    expect(layout).toEqual({ kind: 'directory', scopeUrl: 'https://preview.example/assets/__mimic__/' });
    expect(publishedEndpointUrl(layout, 'epoch-1', endpoint(4200))).toBe(
      'https://preview.example/assets/__mimic__/epoch-1/epoch-1%3Aroute-4200/4200/'
    );
    expect(
      publishedEndpointScopeDocumentUrl(layout, 'epoch-1', 'https://preview.example/assets/__mimic__/epoch-1/epoch-1%3Aroute-4200/4200/api')
    ).toBe('https://preview.example/assets/__mimic__/');
    expect(publishedEndpointScopeDocumentUrl(layout, 'epoch-1', 'https://preview.example/other')).toBeUndefined();
  });

  test('a wildcard serves each port from the root of an origin of its own', () => {
    const layout = publishedEndpointLayout({ previewOrigin: 'https://*.preview.example', serviceWorkerUrl });
    expect(layout).toEqual({
      kind: 'origin',
      pattern: 'https://*.preview.example',
      serviceWorkerPath: '/assets/service-worker-abc123.js'
    });
    expect(publishedEndpointUrl(layout, 'epoch-1', endpoint(4200))).toBe('https://epoch-1--4200.preview.example/');
    // The route is not in the URL: a server that restarts on its port keeps its address.
    expect(publishedEndpointUrl(layout, 'epoch-1', { ...endpoint(4200), routeId: 'epoch-1:route-9' })).toBe(
      'https://epoch-1--4200.preview.example/'
    );
    expect(publishedEndpointScopeDocumentUrl(layout, 'epoch-1', 'https://epoch-1--4200.preview.example/deep/path?x=1')).toBe(
      'https://epoch-1--4200.preview.example/assets/__mimic__/'
    );
    for (const foreign of [
      'https://epoch-2--4200.preview.example/',
      'https://epoch-1--4200.other.example/',
      'http://epoch-1--4200.preview.example/',
      'https://epoch-1--x.preview.example/',
      'not a url'
    ]) {
      expect(publishedEndpointScopeDocumentUrl(layout, 'epoch-1', foreign), foreign).toBeUndefined();
    }
    expect(
      publishedEndpointOriginDocumentUrl(layout, {
        epochId: 'epoch-1',
        port: 4200,
        documentUrl: 'https://mimic.preview.example/assets/published-endpoint-origin-def456.html',
        hostOrigin: 'https://mimic.preview.example'
      })
    ).toBe(
      'https://epoch-1--4200.preview.example/assets/published-endpoint-origin-def456.html?host=https%3A%2F%2Fmimic.preview.example&worker=%2Fassets%2Fservice-worker-abc123.js'
    );
  });
});
