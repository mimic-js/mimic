import { defineCompatibilityClaim } from './compatibility-claim';
import { createSvelteDevDriver } from './svelte-dev-driver';
import { ViteDevSuite, type ViteDevCase } from './vite-dev-suite';
import {
  vanillaVite8ExactGraphTarget,
  vite8DevSuiteVersionInputs
} from './vite8-vanilla-fixture';

const svelteExactGraphTarget = {
  ...vanillaVite8ExactGraphTarget,
  packages: {
    ...vanillaVite8ExactGraphTarget.packages,
    '@sveltejs/vite-plugin-svelte': '7.3.0',
    svelte: '5.56.10'
  },
  lockfile: {
    format: 'npm',
    version: 3,
    path: 'compatibility/fixtures/svelte-5-vite-8.1.4/package-lock.json'
  }
} as const;

const svelteCompatibilityClaim = defineCompatibilityClaim({
  id: 'svelte-5-vite-8-1-4-hmr',
  statement:
    'Svelte 5.56.10 with plugin-svelte 7.3.0 replaces a compatible component through the upstream Vite 8.1.4 HMR session',
  target: svelteExactGraphTarget
});

const svelteCase = {
  claim: svelteCompatibilityClaim,
  driver: createSvelteDevDriver({
    svelteVersion: '5.56.10',
    initialHeading: 'Svelte Vite 8 HMR initial render',
    workflow: {
      updatedHeading: 'Svelte Vite 8 HMR update applied',
      recoveredHeading: 'Svelte Vite 8 HMR recovered'
    }
  })
} as const satisfies ViteDevCase;

const vite8SvelteDevSuite = new ViteDevSuite({
  ...vite8DevSuiteVersionInputs,
  installed: {
    '@sveltejs/vite-plugin-svelte': '@sveltejs/vite-plugin-svelte@7.3.0',
    svelte: 'svelte@5.56.10',
    ...vite8DevSuiteVersionInputs.installed
  }
});

vite8SvelteDevSuite.register(svelteCase);
