import { defineCompatibilityClaim } from './compatibility-claim';
import { createSolidDevDriver } from './solid-dev-driver';
import { ViteDevSuite, type ViteDevCase } from './vite-dev-suite';

const solidCompatibilityClaim = defineCompatibilityClaim({
  id: 'solid-1-vite-6-4-3-hmr',
  statement:
    'Solid 1.9.0 with vite-plugin-solid 2.11.0 preserves ancestor state through the upstream Vite 6.4.3 HMR session',
  target: {
    kind: 'exact-graph',
    packages: {
      'babel-preset-solid': '1.9.0',
      'solid-js': '1.9.0',
      'vite-plugin-solid': '2.11.0',
      vite: '6.4.3'
    },
    packageManager: { name: 'npm', version: '11.18.0' },
    lockfile: {
      format: 'npm',
      version: 3,
      path: 'compatibility/fixtures/solid-1-vite-6.4.3/package-lock.json'
    },
    virtualPlatform: { operatingSystem: 'linux', architecture: 'wasm32', runtime: 'browser', nodeVersion: '22.22.3' },
    replacements: {
      rollup: '@rollup/wasm-node@4.62.4'
    },
    execution: { command: 'npm', entrypoint: 'run dev' }
  }
});

const solidCase = {
  claim: solidCompatibilityClaim,
  driver: createSolidDevDriver({
    solidVersion: '1.9.0',
    initialHeading: 'Solid HMR initial render',
    workflow: {
      updatedHeading: 'Solid HMR update applied',
      recoveredHeading: 'Solid HMR recovered',
      sourceUpdateState: 'preserve-existing'
    }
  })
} as const satisfies ViteDevCase;

const vite6SolidDevSuite = new ViteDevSuite({
  viteVersion: '6.4.3',
  installed: {
    'babel-preset-solid': 'babel-preset-solid@1.9.0',
    'solid-js': 'solid-js@1.9.0',
    'vite-plugin-solid': 'vite-plugin-solid@2.11.0',
    vite: 'vite@6.4.3',
    esbuild: 'esbuild@0.25.12',
    rollup: '@rollup/wasm-node@4.62.4'
  }
});

vite6SolidDevSuite.register(solidCase);
