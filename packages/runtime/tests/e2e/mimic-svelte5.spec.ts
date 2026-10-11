import { defineCompatibilityClaim } from './compatibility-claim';
import { createSvelteDevDriver } from './svelte-dev-driver';
import { ViteDevSuite, type ViteDevCase } from './vite-dev-suite';

const svelteCompatibilityClaim = defineCompatibilityClaim({
  id: 'svelte-5-vite-6-4-3-hmr',
  statement:
    'Svelte 5.37.3 with plugin-svelte 5.1.1 replaces a compatible component through the upstream Vite 6.4.3 HMR session',
  target: {
    kind: 'exact-graph',
    packages: {
      '@sveltejs/vite-plugin-svelte': '5.1.1',
      svelte: '5.37.3',
      vite: '6.4.3'
    },
    packageManager: { name: 'npm', version: '11.18.0' },
    lockfile: {
      format: 'npm',
      version: 3,
      path: 'compatibility/fixtures/svelte-5-vite-6.4.3/package-lock.json'
    },
    virtualPlatform: { operatingSystem: 'linux', architecture: 'wasm32', runtime: 'browser', nodeVersion: '22.22.3' },
    replacements: {
      rollup: '@rollup/wasm-node@4.62.3'
    },
    execution: { command: 'npm', entrypoint: 'run dev' }
  }
});

const svelteCase = {
  claim: svelteCompatibilityClaim,
  driver: createSvelteDevDriver({
    svelteVersion: '5.37.3',
    initialHeading: 'Svelte HMR initial render',
    workflow: {
      updatedHeading: 'Svelte HMR update applied',
      recoveredHeading: 'Svelte HMR recovered'
    }
  })
} as const satisfies ViteDevCase;

const vite6SvelteDevSuite = new ViteDevSuite({
  viteVersion: '6.4.3',
  installed: {
    '@sveltejs/vite-plugin-svelte': '@sveltejs/vite-plugin-svelte@5.1.1',
    svelte: 'svelte@5.37.3',
    vite: 'vite@6.4.3',
    esbuild: 'esbuild@0.25.12',
    rollup: '@rollup/wasm-node@4.62.3'
  }
});

vite6SvelteDevSuite.register(svelteCase);
