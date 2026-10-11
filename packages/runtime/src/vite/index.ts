import type { Plugin } from 'vite';

/**
 * The `Cross-Origin-Embedder-Policy` of the embedding page. `require-corp`
 * loads a cross-origin resource only when its response allows it;
 * `credentialless` loads it without credentials instead, which spares the
 * page CORP headers on every CDN it uses (Chromium and Firefox; Safari needs
 * `require-corp`). Pass the same value to `Mimic.boot()`.
 */
export type EmbedderPolicy = 'require-corp' | 'credentialless';

/**
 * The response headers Mimic needs from the server of the embedding
 * page: together they make the page cross-origin isolated.
 */
export function mimicHeadersFor(
  embedderPolicy: EmbedderPolicy
): Readonly<Record<'Cross-Origin-Embedder-Policy' | 'Cross-Origin-Opener-Policy', string>> {
  return {
    'Cross-Origin-Embedder-Policy': embedderPolicy,
    'Cross-Origin-Opener-Policy': 'same-origin'
  };
}

/** {@link mimicHeadersFor} with `require-corp`. */
export const mimicHeaders = {
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Opener-Policy': 'same-origin'
} as const;

/**
 * Makes `Mimic.boot()` work in a Vite application: sends the
 * headers of {@link mimicHeadersFor} from the development and
 * preview servers, and keeps the package out of the dependency optimizer,
 * which would detach the entry from its assets.
 */
export function mimic(
  options: {
    embedderPolicy?: EmbedderPolicy;
    /**
     * Set when `Mimic.boot({ previewOrigin })` names a second
     * hostname of this same server, such as `http://localhost:5173` beside
     * `http://127.0.0.1:5173` in development. The embedding page then loads
     * the package's Runtime Host document from that origin, which needs
     * `Cross-Origin-Resource-Policy: cross-origin` on top of the two headers.
     * A wildcard such as `http://*.localhost:5173` serves each endpoint from
     * an origin of its own, whose Service Worker takes the origin's root and
     * so needs `Service-Worker-Allowed: /` as well.
     */
    previewOrigin?: string;
  } = {}
): Plugin {
  const headers: Record<string, string> = {
    ...mimicHeadersFor(options.embedderPolicy ?? 'require-corp'),
    ...(options.previewOrigin ? { 'Cross-Origin-Resource-Policy': 'cross-origin' } : {}),
    ...(options.previewOrigin?.includes('*') ? { 'Service-Worker-Allowed': '/' } : {})
  };
  return {
    name: 'mimic',
    config: () => ({
      optimizeDeps: { exclude: ['@mimic-js/mimic'] },
      server: { headers },
      preview: { headers }
    })
  };
}
