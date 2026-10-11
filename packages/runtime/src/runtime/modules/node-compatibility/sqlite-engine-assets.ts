/**
 * Where this context loads the SQLite engine from: the publisher's glue script
 * and the WebAssembly binary. The embedding page resolves both and the
 * process worker names them before any program runs (ADR-0033). A leaf
 * module, so that a test may configure it without loading the builtin.
 */
export type SqliteEngineAssets = { readonly glue: string; readonly wasm: string };

let configured: SqliteEngineAssets | undefined;

export function configureSqliteEngineAssets(assets: SqliteEngineAssets): void {
  configured = assets;
}

export function sqliteEngineAssets(): SqliteEngineAssets {
  if (!configured) {
    throw new Error('node:sqlite cannot load its SQLite engine: the asset URLs are not configured in this context.');
  }
  return configured;
}
