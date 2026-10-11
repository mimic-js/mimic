import { posix } from 'node:path';
import { defineConfig, transformWithEsbuild, type Plugin } from 'vite';
import { nodeCompatibilityPortAliases } from './vite.node-compatibility';
import { runtimeTreeshake as treeshake } from './scripts/runtime-host-assets';

/**
 * Scripts the runtime locates with `new URL(..., import.meta.url)` and loads
 * outside the module graph are copied as assets, which the bundle's own
 * minification does not reach: the committed Service Worker is minified here;
 * the prebuilt document and worker bundles already are (ADR-0033).
 */
function minifyScriptAssets(): Plugin {
  return {
    name: 'mimic:minify-script-assets',
    async generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== 'asset' || !file.fileName.endsWith('.js')) continue;
        const source =
          typeof file.source === 'string' ? file.source : new TextDecoder().decode(file.source);
        file.source = (
          await transformWithEsbuild(source, file.fileName, {
            loader: 'js',
            minify: true,
            sourcemap: false,
            target: 'es2022'
          })
        ).code;
      }
    }
  };
}

export default defineConfig({
  base: './',
  publicDir: false,
  plugins: [minifyScriptAssets()],
  experimental: {
    // Names every worker and asset as `new URL('./relative', import.meta.url)`
    // with a literal path: the one form a browser resolves by itself and a
    // consumer's bundler recognises and rewrites. The default wraps the path
    // in a second, computed URL that webpack cannot follow.
    renderBuiltUrl(filename, { hostId, hostType }) {
      if (hostType !== 'js') return undefined;
      const path = posix.relative(posix.dirname(hostId), filename);
      return path.startsWith('.') ? path : `./${path}`;
    }
  },
  resolve: {
    alias: nodeCompatibilityPortAliases
  },
  build: {
    assetsInlineLimit: 0,
    emptyOutDir: true,
    manifest: true,
    minify: 'esbuild',
    outDir: 'dist',
    rollupOptions: {
      input: 'src/runtime/index.ts',
      preserveEntrySignatures: 'strict',
      treeshake,
      output: {
        assetFileNames: 'assets/[name]-[hash][extname]',
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'mimic.js'
      }
    },
    sourcemap: true,
    target: 'es2022'
  }
});
