import { defineCompatibilityClaim } from './compatibility-claim';
import { createVueDevDriver } from './vue-dev-driver';
import { ViteDevSuite, type ViteDevCase } from './vite-dev-suite';
import {
  vanillaVite8ExactGraphTarget,
  vite8DevSuiteVersionInputs
} from './vite8-vanilla-fixture';

const vueExactGraphTarget = {
  ...vanillaVite8ExactGraphTarget,
  packages: {
    ...vanillaVite8ExactGraphTarget.packages,
    '@vitejs/plugin-vue': '6.0.8',
    vue: '3.5.41'
  },
  lockfile: {
    format: 'npm',
    version: 3,
    path: 'compatibility/fixtures/vue-3-vite-8.1.4/package-lock.json'
  }
} as const;

const vueCompatibilityClaim = defineCompatibilityClaim({
  id: 'vue-3-vite-8-1-4-stateful-hmr',
  statement:
    'Vue 3.5.41 with plugin-vue 6.0.8 preserves component state through the upstream Vite 8.1.4 HMR session',
  target: vueExactGraphTarget
});

const vueCase = {
  claim: vueCompatibilityClaim,
  driver: createVueDevDriver({
    vueVersion: '3.5.41',
    initialHeading: 'Vue 3 Vite 8 stateful HMR initial render',
    workflow: {
      updatedHeading: 'Vue 3 Vite 8 stateful HMR update applied',
      recoveredHeading: 'Vue 3 Vite 8 stateful HMR recovered'
    }
  })
} as const satisfies ViteDevCase;

const vite8VueDevSuite = new ViteDevSuite({
  ...vite8DevSuiteVersionInputs,
  installed: {
    '@vitejs/plugin-vue': '@vitejs/plugin-vue@6.0.8',
    vue: 'vue@3.5.41',
    ...vite8DevSuiteVersionInputs.installed
  }
});

vite8VueDevSuite.register(vueCase);
