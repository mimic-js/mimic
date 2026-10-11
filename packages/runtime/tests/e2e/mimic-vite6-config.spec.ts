import { defineCompatibilityClaim } from './compatibility-claim';
import { ViteDevSuite, type ViteDevCase } from './vite-dev-suite';
import { vite6DevSuiteVersionInputs } from './vite6-vanilla-fixture';

const claim = defineCompatibilityClaim({
  id: 'vanilla-vite-6-4-3-configuration-resource-pipeline',
  statement:
    'Vanilla Vite 6.4.3 applies bundled TypeScript configuration and serves transformed TypeScript, JSON, imported assets, public assets, and VITE environment values',
  target: {
    kind: 'exact-graph',
    packages: {
      picocolors: '1.1.1',
      vite: '6.4.3'
    },
    packageManager: { name: 'npm', version: '11.18.0' },
    lockfile: {
      format: 'npm',
      version: 3,
      path: 'compatibility/fixtures/vanilla-vite-6.4.3/package-lock.json'
    },
    virtualPlatform: { operatingSystem: 'linux', architecture: 'wasm32', runtime: 'browser', nodeVersion: '22.22.3' },
    replacements: {
      rollup: '@rollup/wasm-node@4.62.3'
    },
    execution: { command: 'npm', entrypoint: 'run dev' }
  }
});

// The heading joins what `vite.config.ts` defines, what `resource.json` holds and what `.env` exposes.
const expectedHeading = 'Bundled Vite 6 config applied: JSON imported: environment exposed';

const configResourceCase = {
  claim,
  app: 'config',
  driver: {
    expectedHeading,
    framework: 'Vite 6 config and resource pipeline',
    resourcePath: '/src/main.ts',
    optimizedDependencyPaths: ['/node_modules/.vite/deps/picocolors.js'],
    expectedResourcePaths: [
      '/src/main.ts',
      '/src/imported-resource.svg',
      '/public-resource.svg'
    ],
    workflow: null
  }
} as const satisfies ViteDevCase;

const vite6DevSuite = new ViteDevSuite(vite6DevSuiteVersionInputs);

vite6DevSuite.register(configResourceCase);
