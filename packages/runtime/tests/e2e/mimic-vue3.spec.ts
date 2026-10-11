import { defineCompatibilityClaim } from './compatibility-claim';
import { createVueDevDriver } from './vue-dev-driver';
import { ViteDevSuite, type ViteDevCase } from './vite-dev-suite';

const vueExactGraphTarget = {
  kind: 'exact-graph',
  packages: {
    '@vitejs/plugin-vue': '5.2.4',
    vue: '3.5.0',
    vite: '6.4.3'
  },
  packageManager: { name: 'npm', version: '11.18.0' },
  lockfile: {
    format: 'npm',
    version: 3,
    path: 'compatibility/fixtures/vue-3-vite-6.4.3/package-lock.json'
  },
  virtualPlatform: { operatingSystem: 'linux', architecture: 'wasm32', runtime: 'browser', nodeVersion: '22.22.3' },
  replacements: {
    rollup: '@rollup/wasm-node@4.62.3'
  },
  execution: { command: 'npm', entrypoint: 'run dev' }
} as const;

const vueCompatibilityClaim = defineCompatibilityClaim({
  id: 'vue-3-vite-6-4-3-initial-render',
  statement:
    'Vue 3.5.0 with plugin-vue 5.2.4 and Vite 6.4.3 renders through complete Vite-produced optimized dependency exports',
  target: vueExactGraphTarget
});

const vueStatefulHmrClaim = defineCompatibilityClaim({
  id: 'vue-3-vite-6-4-3-stateful-hmr-frontier',
  statement:
    'Vue 3.5.0 with plugin-vue 5.2.4 preserves component state through the upstream Vite 6.4.3 HMR session',
  target: vueExactGraphTarget
});

const vueInitialRenderCase = {
  claim: vueCompatibilityClaim,
  driver: createVueDevDriver({
    vueVersion: '3.5.0',
    initialHeading: 'Vue compatibility claim rendered',
    workflow: null
  })
} as const satisfies ViteDevCase;

const vueStatefulHmrCase = {
  claim: vueStatefulHmrClaim,
  driver: createVueDevDriver({
    vueVersion: '3.5.0',
    initialHeading: 'Vue compatibility claim rendered',
    workflow: {
      updatedHeading: 'Vue stateful HMR update applied',
      recoveredHeading: 'Vue stateful HMR recovered'
    }
  })
} as const satisfies ViteDevCase;

const vite6VueDevSuite = new ViteDevSuite({
  viteVersion: '6.4.3',
  installed: {
    '@vitejs/plugin-vue': '@vitejs/plugin-vue@5.2.4',
    vue: 'vue@3.5.0',
    vite: 'vite@6.4.3',
    esbuild: 'esbuild@0.25.12',
    rollup: '@rollup/wasm-node@4.62.3'
  }
});

vite6VueDevSuite.register(vueInitialRenderCase);
vite6VueDevSuite.register(vueStatefulHmrCase);
