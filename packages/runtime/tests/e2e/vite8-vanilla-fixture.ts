import type { NpmExactGraphCompatibilityTarget } from './compatibility-claim';
import type { ViteDevVersionInputs } from './vite-dev-suite';

export const vanillaVite8ExactGraphTarget = {
  kind: 'exact-graph',
  packages: {
    '@oxc-project/types': '0.139.0',
    '@rolldown/binding-wasm32-wasi': '1.1.5',
    lightningcss: '1.33.0',
    picocolors: '1.1.1',
    rolldown: '1.1.5',
    vite: '8.1.4'
  },
  packageManager: { name: 'npm', version: '11.18.0' },
  lockfile: {
    format: 'npm',
    version: 3,
    path: 'compatibility/fixtures/vanilla-vite-8.1.4/package-lock.json'
  },
  virtualPlatform: { operatingSystem: 'linux', architecture: 'wasm32', runtime: 'browser', nodeVersion: '22.22.3' },
  replacements: {
    lightningcss: 'lightningcss-wasm@1.33.0'
  },
  execution: { command: 'npm', entrypoint: 'run dev' }
} as const satisfies NpmExactGraphCompatibilityTarget;

export const vite8DevSuiteVersionInputs = {
  viteVersion: '8.1.4',
  installed: {
    picocolors: 'picocolors@1.1.1',
    vite: 'vite@8.1.4',
    rolldown: 'rolldown@1.1.5',
    '@rolldown/binding-wasm32-wasi': '@rolldown/binding-wasm32-wasi@1.1.5',
    '@oxc-project/types': '@oxc-project/types@0.139.0',
    lightningcss: 'lightningcss-wasm@1.33.0'
  }
} as const satisfies ViteDevVersionInputs;
