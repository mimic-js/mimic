import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

const retiredPreviewSources = [
  'src/runtime/dev-server-observation.ts',
  'src/runtime/http-preview-bridge.ts',
  'src/runtime/preview-cache-generation.ts',
  'src/runtime/preview-compatibility.ts',
  'src/runtime/preview-websocket-observer.ts',
  'src/runtime/runtime-watch-hmr-compatibility.ts',
  'src/runtime/server-manager.ts',
  'src/runtime/service-worker-client.ts',
  'src/runtime/vite-cache-generation-adapter.ts',
  'src/runtime/vite-compatibility-adapter.ts'
] as const;

describe('Published Endpoint host-routing cutover', () => {
  test('deletes preview authorities and their shrink-only bridge', () => {
    for (const source of retiredPreviewSources) {
      expect(existsSync(source), `${source} should be deleted by #324`).toBe(false);
    }
    expect(existsSync('architecture/published-endpoint-preview-migration-bridge.cjs')).toBe(false);
  });

  test('owns browser publication behind one Published Endpoint host seam', () => {
    const mimic = readFileSync('src/runtime/index.ts', 'utf8');
    // The Runtime Host document composes the Published Endpoint host (ADR-0033).
    const runtimeHost = readFileSync(
      'src/runtime/modules/runtime-host/runtime-host-document.ts',
      'utf8'
    );
    const publishedEndpointBrowserHost = readFileSync(
      'src/runtime/modules/published-endpoint/browser-host.ts',
      'utf8'
    );
    const publishedEndpointHost = readFileSync(
      'src/runtime/modules/published-endpoint/service-worker-host.ts',
      'utf8'
    );

    expect(mimic).not.toMatch(
      /from '.\/modules\/(?:browser-adapters|published-endpoint)'/
    );
    expect(mimic).not.toMatch(
      /bindPublishedEndpointHost|createBrowserMessagePortRelay|createPublishedEndpointHost(?:Boundary|Router)|injectPublishedEndpointDocumentAdapter/
    );
    expect(runtimeHost).toContain('createPublishedEndpointHost');
    expect(runtimeHost).not.toMatch(
      /bindPublishedEndpointHost|createBrowserMessagePortRelay|createPublishedEndpointPublicationState|createPublishedEndpointServerState|injectPublishedEndpointDocumentAdapter/
    );
    expect(publishedEndpointBrowserHost).toContain('bindPublishedEndpointHost');
    expect(publishedEndpointBrowserHost).not.toMatch(
      /createPublishedEndpoint(?:PublicationState|ServerState)|createBrowserMessagePortRelay/
    );
    expect(publishedEndpointBrowserHost).toContain('injectPublishedEndpointDocumentAdapter');
    expect(existsSync('src/runtime/modules/published-endpoint/host-boundary.ts')).toBe(false);
    expect(existsSync('src/runtime/modules/published-endpoint/host-router.ts')).toBe(false);
    expect(existsSync('src/runtime/modules/published-endpoint/publication-state.ts')).toBe(false);
    expect(existsSync('src/runtime/modules/published-endpoint/server-state.ts')).toBe(false);
    expect(existsSync('src/runtime/modules/published-endpoint/message-port-relay.ts')).toBe(false);
    expect(publishedEndpointHost).toContain('connectRpc');
    expect(publishedEndpointHost).toContain('openMessageStream');
    expect(
      existsSync('src/runtime/modules/worker-transport/message-port-adapter.ts')
    ).toBe(false);
    expect(readFileSync('src/runtime/modules/worker-transport/index.ts', 'utf8')).not.toMatch(
      /MessagePortAdapter|message-port-adapter/
    );
    expect(existsSync('src/runtime/modules/browser-adapters')).toBe(false);
    expect(mimic).not.toMatch(
      /PreviewServerManager|bindPreviewRequests|previewServers|devServerObserver|webSocketObserver/
    );
  });

  test('keeps process publication protocol generic and free of request routing', () => {
    const protocol = readFileSync(
      'src/runtime/modules/runtime-host/process-worker-protocol.ts',
      'utf8'
    );
    const worker = readFileSync(
      'src/runtime/modules/runtime-host/node-process-worker.ts',
      'utf8'
    );
    const runtimeProgram = readFileSync(
      'src/runtime/modules/runtime-host/runtime-program-host.ts',
      'utf8'
    );

    for (const source of [protocol, worker, runtimeProgram]) {
      expect(source).not.toMatch(
        /preview-request|preview-response|preview-upgrade|preview-websocket|dev-server-observation/
      );
    }
    expect(protocol).toMatch(/readonly endpoints: \{\s+listen\(/);
    expect(protocol).toMatch(/close\(port: number\): void;/);
  });
});
