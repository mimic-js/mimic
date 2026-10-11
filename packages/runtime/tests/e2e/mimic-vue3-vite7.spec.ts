import { defineCompatibilityClaim } from './compatibility-claim';
import { createVueDevDriver } from './vue-dev-driver';
import { ViteDevSuite, type ViteDevCase } from './vite-dev-suite';
import {
  vanillaVite7ExactGraphTarget,
  vite7DevSuiteVersionInputs
} from './vite7-vanilla-fixture';

const vueExactGraphTarget = {
  ...vanillaVite7ExactGraphTarget,
  packages: {
    ...vanillaVite7ExactGraphTarget.packages,
    '@vitejs/plugin-vue': '6.0.8',
    vue: '3.5.41'
  },
  lockfile: {
    format: 'npm',
    version: 3,
    path: 'compatibility/fixtures/vue-3-vite-7.3.6/package-lock.json'
  }
} as const;

const vueCompatibilityClaim = defineCompatibilityClaim({
  id: 'vue-3-vite-7-3-6-stateful-hmr',
  statement:
    'Vue 3.5.41 with plugin-vue 6.0.8 preserves component state through the upstream Vite 7.3.6 HMR session',
  target: vueExactGraphTarget
});

const vueCase = {
  claim: vueCompatibilityClaim,
  driver: createVueDevDriver({
    vueVersion: '3.5.41',
    initialHeading: 'Vue 3 stateful HMR initial render',
    workflow: {
      updatedHeading: 'Vue 3 stateful HMR update applied',
      recoveredHeading: 'Vue 3 stateful HMR recovered'
    }
  })
} as const satisfies ViteDevCase;

const vite7VueDevSuite = new ViteDevSuite({
  ...vite7DevSuiteVersionInputs,
  installed: {
    '@vitejs/plugin-vue': '@vitejs/plugin-vue@6.0.8',
    vue: 'vue@3.5.41',
    ...vite7DevSuiteVersionInputs.installed
  }
});

vite7VueDevSuite.register(vueCase);
