/// <reference lib="webworker" />

import { declareRuntimeAssets, isRuntimeAssetManifest } from './runtime-assets';
import { RUNTIME_HOST_CONNECT_MESSAGE } from './runtime-host-protocol';

/**
 * How a Runtime Host worker meets its two peers (ADR-0033). The Runtime Host
 * document that created the worker posts one `runtime-host:connect` message
 * with the asset manifest and the embedding page's port; the worker's own
 * scope then serves the document, and the port serves the page.
 */
export function awaitRuntimeHostConnection(
  scope: DedicatedWorkerGlobalScope,
  connect: (page: MessagePort) => void
): void {
  const onMessage = (event: MessageEvent<unknown>): void => {
    const data = event.data;
    if (
      typeof data !== 'object' ||
      data === null ||
      (data as { type?: unknown }).type !== RUNTIME_HOST_CONNECT_MESSAGE
    ) {
      return;
    }
    scope.removeEventListener('message', onMessage);
    const assets = (data as { assets?: unknown }).assets;
    const page = event.ports[0];
    if (!isRuntimeAssetManifest(assets) || !page) {
      throw new Error('The Runtime Host worker received an invalid connect message.');
    }
    declareRuntimeAssets(assets);
    connect(page);
  };
  scope.addEventListener('message', onMessage);
}
