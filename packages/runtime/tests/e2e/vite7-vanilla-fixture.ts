import type { NpmExactGraphCompatibilityTarget } from './compatibility-claim';
import type { ViteDevVersionInputs } from './vite-dev-suite';

export const vanillaVite7ExactGraphTarget = {
  kind: 'exact-graph',
  packages: {
    '@rollup/wasm-node': '4.62.4',
    esbuild: '0.28.2',
    picocolors: '1.1.1',
    rollup: '4.62.4',
    vite: '7.3.6'
  },
  packageManager: { name: 'npm', version: '11.18.0' },
  lockfile: {
    format: 'npm',
    version: 3,
    path: 'compatibility/fixtures/vanilla-vite-7.3.6/package-lock.json'
  },
  virtualPlatform: { operatingSystem: 'linux', architecture: 'wasm32', runtime: 'browser', nodeVersion: '22.22.3' },
  replacements: {
    rollup: '@rollup/wasm-node@4.62.4'
  },
  execution: { command: 'npm', entrypoint: 'run dev' }
} as const satisfies NpmExactGraphCompatibilityTarget;

export const vite7DevSuiteVersionInputs = {
  viteVersion: '7.3.6',
  installed: {
    picocolors: 'picocolors@1.1.1',
    vite: 'vite@7.3.6',
    esbuild: 'esbuild@0.28.2',
    rollup: '@rollup/wasm-node@4.62.4'
  },
  esbuild: { version: '0.28.2' }
} as const satisfies ViteDevVersionInputs;
