import { runtimeHostOrigin } from '../published-endpoint';
import {
  runtimeAssetsOnOrigin,
  type RuntimeAssetManifest
} from './runtime-assets';

/**
 * The messages between the embedding page and the Runtime Host document it
 * loads in a hidden frame (ADR-0033). The document answers only the origin
 * its `host` query parameter names; the page accepts only the frame's window
 * on the origin it loaded the document from.
 */
export type RuntimeHostDocumentBootMessage = {
  readonly type: 'runtime-host:boot';
  readonly assets: RuntimeAssetManifest;
  readonly epochId: string;
  readonly embedderPolicy: 'require-corp' | 'credentialless';
  /** The preview origin as the facade normalized it; the document derives the endpoints' layout from it. */
  readonly previewOrigin: string | undefined;
};

export type RuntimeHostDocumentMessage =
  | { readonly type: 'runtime-host:ready' }
  | { readonly type: 'runtime-host:started' }
  | { readonly type: 'runtime-host:failed'; readonly message: string }
  | { readonly type: 'runtime-host:unloaded' };

export interface RuntimeHostDocumentFrame {
  /** The page's end of the port the Runtime Host worker serves. */
  readonly port: MessagePort;
  /** Rejects when the document reports a failure or goes away. */
  readonly failed: Promise<never>;
  /** The asset manifest the document received: on its own origin. */
  readonly assets: RuntimeAssetManifest;
  dispose(): void;
}

const DOCUMENT_READY_TIMEOUT_MS = 30_000;

export function openRuntimeHostDocument(options: {
  readonly assets: RuntimeAssetManifest;
  /** The preview origin when it is not the page's own, a wildcard included (ADR-0032, ADR-0044). */
  readonly previewOrigin?: string;
  readonly epochId: string;
  readonly embedderPolicy: 'require-corp' | 'credentialless';
}): Promise<RuntimeHostDocumentFrame> {
  const hostOrigin = runtimeHostOrigin(options.previewOrigin);
  const assets = runtimeAssetsOnOrigin(options.assets, hostOrigin);
  const documentOrigin = hostOrigin ?? window.location.origin;
  const documentUrl = new URL(assets['runtime-host.html']);
  documentUrl.searchParams.set('host', window.location.origin);
  return new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe');
    iframe.hidden = true;
    iframe.setAttribute('aria-hidden', 'true');
    // A cross-origin frame is cross-origin isolated only when its parent
    // delegates the permission; the worker's SharedArrayBuffer needs it.
    iframe.setAttribute('allow', 'cross-origin-isolated');
    iframe.title = 'Mimic runtime host';
    const channel = new MessageChannel();
    let settled = false;
    let rejectFailed!: (error: Error) => void;
    const failed = new Promise<never>((_resolve, rejectFailure) => {
      rejectFailed = rejectFailure;
    });
    void failed.catch(() => undefined);
    const finish = (): void => {
      settled = true;
      window.clearTimeout(timeout);
    };
    const dispose = (): void => {
      window.removeEventListener('message', onMessage);
      iframe.remove();
    };
    const fail = (message: string): void => {
      const error = new Error(message);
      if (!settled) {
        finish();
        dispose();
        reject(error);
        return;
      }
      rejectFailed(error);
    };
    const timeout = window.setTimeout(() => {
      fail(
        `The origin ${documentOrigin} did not answer: it must serve this package's assets at ${documentUrl.pathname} ` +
          'with Cross-Origin-Embedder-Policy and Cross-Origin-Resource-Policy: cross-origin headers (see the README).'
      );
    }, DOCUMENT_READY_TIMEOUT_MS);
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (event.origin !== documentOrigin || event.source !== iframe.contentWindow) return;
      const data = event.data as Partial<RuntimeHostDocumentMessage> | null;
      if (typeof data !== 'object' || data === null) return;
      switch (data.type) {
        case 'runtime-host:ready': {
          if (settled) return;
          const boot: RuntimeHostDocumentBootMessage = {
            type: 'runtime-host:boot',
            assets,
            epochId: options.epochId,
            embedderPolicy: options.embedderPolicy,
            previewOrigin: options.previewOrigin
          };
          iframe.contentWindow?.postMessage(boot, documentOrigin, [channel.port2]);
          return;
        }
        case 'runtime-host:started':
          if (settled) return;
          finish();
          resolve({ port: channel.port1, failed, assets, dispose });
          return;
        case 'runtime-host:failed':
          fail(`The Runtime Host document failed: ${String(data.message)}`);
          return;
        case 'runtime-host:unloaded':
          fail('The Runtime Host document unloaded.');
          return;
        default:
          return;
      }
    };
    window.addEventListener('message', onMessage);
    iframe.src = documentUrl.href;
    (document.body ?? document.documentElement).append(iframe);
  });
}
