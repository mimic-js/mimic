import { defineCompatibilityClaim } from './compatibility-claim';
import { createSvelteDevDriver } from './svelte-dev-driver';
import { ViteDevSuite, type ViteDevCase } from './vite-dev-suite';
import {
  vanillaVite7ExactGraphTarget,
  vite7DevSuiteVersionInputs
} from './vite7-vanilla-fixture';

const svelteExactGraphTarget = {
  ...vanillaVite7ExactGraphTarget,
  packages: {
    ...vanillaVite7ExactGraphTarget.packages,
    '@sveltejs/vite-plugin-svelte': '6.2.4',
    svelte: '5.56.8'
  },
  lockfile: {
    format: 'npm',
    version: 3,
    path: 'compatibility/fixtures/svelte-5-vite-7.3.6/package-lock.json'
  }
} as const;

const svelteCompatibilityClaim = defineCompatibilityClaim({
  id: 'svelte-5-vite-7-3-6-hmr',
  statement:
    'Svelte 5.56.8 with plugin-svelte 6.2.4 replaces a compatible component through the upstream Vite 7.3.6 HMR session',
  target: svelteExactGraphTarget
});

const svelteCase = {
  claim: svelteCompatibilityClaim,
  driver: createSvelteDevDriver({
    svelteVersion: '5.56.8',
    initialHeading: 'Svelte Vite 7 HMR initial render',
    workflow: {
      updatedHeading: 'Svelte Vite 7 HMR update applied',
      recoveredHeading: 'Svelte Vite 7 HMR recovered'
    }
  })
} as const satisfies ViteDevCase;

const vite7SvelteDevSuite = new ViteDevSuite({
  ...vite7DevSuiteVersionInputs,
  installed: {
    '@sveltejs/vite-plugin-svelte': '@sveltejs/vite-plugin-svelte@6.2.4',
    svelte: 'svelte@5.56.8',
    ...vite7DevSuiteVersionInputs.installed
  }
});

vite7SvelteDevSuite.register(svelteCase);
