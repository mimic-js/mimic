import type { RuntimeAssetManifest } from './runtime-assets';

/**
 * Where the embedding page's build put the runtime's assets. Each reference is
 * a literal `new URL(…, import.meta.url)`, the one form a bundler recognises
 * and rewrites, so this is the only module that names an asset by path: the
 * page resolves them all and the manifest travels from here (ADR-0033). The
 * script and worker files are prebuilt by `scripts/build-runtime-assets.mjs`
 * as self-contained bundles; the Service Worker is committed beside its
 * program; the SQLite engine is the publisher's package.
 */
export function pageRuntimeAssets(): RuntimeAssetManifest {
  return {
    'runtime-host.html': new URL('./runtime-host.html', import.meta.url).href,
    'runtime-host-document.js': new URL(
      '../../../../generated/runtime-host/runtime-host-document.js',
      import.meta.url
    ).href,
    'runtime-host-worker.js': new URL(
      '../../../../generated/runtime-host/runtime-host-worker.js',
      import.meta.url
    ).href,
    'node-process-worker.js': new URL(
      '../../../../generated/runtime-host/node-process-worker.js',
      import.meta.url
    ).href,
    'wasi-runtime-worker.js': new URL(
      '../../../../generated/runtime-host/wasi-runtime-worker.js',
      import.meta.url
    ).href,
    'runtime-artifact-compiler-worker.js': new URL(
      '../../../../generated/runtime-host/runtime-artifact-compiler-worker.js',
      import.meta.url
    ).href,
    'service-worker.js': new URL('../published-endpoint/service-worker.js', import.meta.url).href,
    'published-endpoint-origin.html': new URL(
      '../published-endpoint/published-endpoint-origin.html',
      import.meta.url
    ).href,
    'node-sqlite3-wasm.js': new URL(
      '../../../../node_modules/node-sqlite3-wasm/dist/node-sqlite3-wasm.js',
      import.meta.url
    ).href,
    'node-sqlite3-wasm.wasm': new URL(
      '../../../../node_modules/node-sqlite3-wasm/dist/node-sqlite3-wasm.wasm',
      import.meta.url
    ).href
  };
}
