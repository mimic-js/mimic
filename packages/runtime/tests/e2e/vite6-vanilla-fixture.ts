import type { ViteDevVersionInputs } from './vite-dev-suite';

export const vite6DevSuiteVersionInputs = {
  viteVersion: '6.4.3',
  installed: {
    picocolors: 'picocolors@1.1.1',
    vite: 'vite@6.4.3',
    esbuild: 'esbuild@0.25.12',
    rollup: '@rollup/wasm-node@4.62.3'
  }
} as const satisfies ViteDevVersionInputs;
