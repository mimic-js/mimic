import { configureSqliteEngineAssets } from '../../src/runtime/modules/node-compatibility/sqlite-engine-assets';

// In a browser the embedding page resolves the SQLite engine's assets and the
// process worker names them (ADR-0033); a unit test reads the publisher's
// package from node_modules directly.
configureSqliteEngineAssets({
  glue: new URL('../../node_modules/node-sqlite3-wasm/dist/node-sqlite3-wasm.js', import.meta.url).href,
  wasm: new URL('../../node_modules/node-sqlite3-wasm/dist/node-sqlite3-wasm.wasm', import.meta.url).href
});
