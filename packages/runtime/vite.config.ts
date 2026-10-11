import { defineConfig } from 'vite';
import { nodeCompatibilityPortAliases, nodeCompatibilityPorts } from './vite.node-compatibility';
import { mimic } from './src/vite';

/**
 * The development server behind the browser claims: it serves the test host
 * page and the runtime's sources, so a claim imports `/src/runtime/index.ts`
 * without a package build in between. The claims run against
 * `http://127.0.0.1:4179`; the same server answers on `http://localhost:4179`,
 * which the preview-origin claim uses as its second origin (ADR-0032), and on
 * every `http://*.localhost:4179`, which the endpoint-origin claim uses as an
 * origin per port (ADR-0044); the wildcard's headers cover both.
 */
export default defineConfig({
  plugins: [mimic({ previewOrigin: 'http://*.localhost:4179' })],
  server: {
    // A published document's workers open their WebSockets on this origin
    // without the document's transport: Vite 8's client pings its server
    // from a SharedWorker at the origin's root. This server's own HMR socket
    // stays off that root, so it does not answer for a stopped container
    // server, as nothing would where that server had an origin of its own.
    hmr: { path: '/__claims-host-hmr' }
  },
  resolve: {
    alias: nodeCompatibilityPortAliases
  },
  optimizeDeps: {
    include: nodeCompatibilityPorts
  }
});
