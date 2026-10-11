import { fileURLToPath } from 'node:url';
import { build, type Alias, type InlineConfig } from 'vite';

import { nodeCompatibilityPortAliases } from '../vite.node-compatibility';

/**
 * The runtime's prebuilt assets (ADR-0033): the Runtime Host document's
 * script and every worker, each a self-contained ES module. A consumer's
 * bundler copies a file it sees behind `new URL(…, import.meta.url)` without
 * following the imports or workers inside it, so nothing here may import
 * another file: every URL a worker needs arrives in the asset manifest.
 */
export const RUNTIME_HOST_ASSET_ENTRIES = {
  'runtime-host-document.js': 'src/runtime/modules/runtime-host/runtime-host-document.ts',
  'runtime-host-worker.js': 'src/runtime/modules/runtime-host/worker.ts',
  'node-process-worker.js': 'src/runtime/modules/runtime-host/node-process-worker.ts',
  'wasi-runtime-worker.js': 'src/runtime/modules/runtime-host/wasi-runtime-worker.ts',
  'runtime-artifact-compiler-worker.js':
    'src/runtime/modules/runtime-host/runtime-artifact-compiler-worker.ts'
} as const;

export const RUNTIME_HOST_ASSET_DIRECTORY = new URL('../generated/runtime-host/', import.meta.url);

const packageRoot = fileURLToPath(new URL('../', import.meta.url));

const compilerDependency = (name: string) =>
  fileURLToPath(
    new URL(`../src/runtime/modules/runtime-host/runtime-artifact-compiler-babel-${name}.ts`, import.meta.url)
  );

/**
 * Babel's packages name two Node builtins (ADR-0034): `path`, which the
 * browser build of `@babel/core` still joins file names with, and `assert`,
 * which its module transforms call. Each resolves to a browser module here.
 * Only the compiler worker imports Babel; in Node, the unit tests resolve
 * both to the builtins.
 */
const runtimeArtifactCompilerAliases: Alias[] = [
  { find: /^path$/, replacement: 'path-browserify' },
  { find: /^assert$/, replacement: compilerDependency('assert') }
];

/**
 * Node Compatibility's entry point re-exports every builtin. A context that
 * imports one value from it must not carry every builtin and the maintained
 * ports they load: the module's own files are pure at top level, except the
 * one that provides the ports' dependencies for its effect.
 */
export const runtimeTreeshake = {
  moduleSideEffects: (id: string, external: boolean): boolean => {
    if (external || !id.includes('/src/runtime/modules/node-compatibility/')) return true;
    return id.includes('/port-dependencies/provide.ts');
  }
};

export async function buildRuntimeHostAssets(): Promise<void> {
  for (const [fileName, entry] of Object.entries(RUNTIME_HOST_ASSET_ENTRIES)) {
    await build(runtimeHostAssetConfig(fileName, entry));
  }
}

function runtimeHostAssetConfig(fileName: string, entry: string): InlineConfig {
  return {
    configFile: false,
    root: packageRoot,
    logLevel: 'warn',
    publicDir: false,
    resolve: { alias: [...nodeCompatibilityPortAliases, ...runtimeArtifactCompilerAliases] },
    build: {
      lib: {
        entry: fileURLToPath(new URL(entry, `file://${packageRoot}`)),
        formats: ['es'],
        fileName: () => fileName
      },
      outDir: fileURLToPath(RUNTIME_HOST_ASSET_DIRECTORY),
      emptyOutDir: false,
      minify: 'esbuild',
      sourcemap: false,
      target: 'es2022',
      // One file per asset: nothing is shared between them on disk.
      rollupOptions: {
        output: { inlineDynamicImports: true },
        treeshake: runtimeTreeshake
      }
    }
  };
}
