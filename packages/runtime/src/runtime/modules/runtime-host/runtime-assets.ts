/**
 * The files the runtime loads outside the module graph: the Runtime Host
 * document and its script, the workers, the Service Worker, the endpoint
 * origin document (ADR-0044) and the SQLite engine. A bundler copies a file it sees behind `new URL(…, import.meta.url)`
 * and may rename it, but it does not follow references inside a file it
 * copies, so every such reference is resolved once, on the embedding page
 * (`page-assets.ts`), and travels as one manifest: to the Runtime Host
 * document, which the page loads from the origin that serves the endpoints,
 * and on to the workers that document starts (ADR-0033).
 */

export const RUNTIME_ASSET_NAMES = [
  'runtime-host.html',
  'runtime-host-document.js',
  'runtime-host-worker.js',
  'node-process-worker.js',
  'wasi-runtime-worker.js',
  'runtime-artifact-compiler-worker.js',
  'service-worker.js',
  'published-endpoint-origin.html',
  'node-sqlite3-wasm.js',
  'node-sqlite3-wasm.wasm'
] as const;

export type RuntimeAssetName = (typeof RUNTIME_ASSET_NAMES)[number];

/** Absolute URLs, all on the origin that serves the endpoints. */
export type RuntimeAssetManifest = Readonly<Record<RuntimeAssetName, string>>;

let declared: RuntimeAssetManifest | undefined;

/** Names the assets this context loads; a context declares them once, before it starts a worker. */
export function declareRuntimeAssets(manifest: RuntimeAssetManifest): void {
  declared = manifest;
}

export function runtimeAssetUrl(name: RuntimeAssetName): string {
  if (!declared) {
    throw new Error(`The runtime asset ${name} is requested before the asset manifest was declared.`);
  }
  return declared[name];
}

export function declaredRuntimeAssets(): RuntimeAssetManifest {
  if (!declared) throw new Error('The runtime asset manifest is not declared in this context.');
  return declared;
}

export function isRuntimeAssetManifest(value: unknown): value is RuntimeAssetManifest {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return RUNTIME_ASSET_NAMES.every((name) => typeof record[name] === 'string');
}

/** The same manifest with every URL moved to `origin`; the assets are the same build there. */
export function runtimeAssetsOnOrigin(
  manifest: RuntimeAssetManifest,
  origin: string | undefined
): RuntimeAssetManifest {
  if (!origin) return manifest;
  const moved: Record<string, string> = {};
  for (const name of RUNTIME_ASSET_NAMES) {
    const url = new URL(manifest[name]);
    moved[name] = `${origin}${url.pathname}${url.search}`;
  }
  return moved as Record<RuntimeAssetName, string>;
}

export function createExecutionContextWorker(): Worker {
  return new Worker(runtimeAssetUrl('node-process-worker.js'), {
    type: 'module',
    name: 'mimic-js-process'
  });
}

export function createWasiExecutionWorker(): Worker {
  return new Worker(runtimeAssetUrl('wasi-runtime-worker.js'), {
    type: 'module',
    name: 'mimic-wasi-process'
  });
}

export function createRuntimeArtifactCompilerWorker(): Worker {
  return new Worker(runtimeAssetUrl('runtime-artifact-compiler-worker.js'), {
    type: 'module',
    name: 'mimic-compiler'
  });
}
