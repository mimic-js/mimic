import { defineCompatibilityClaim } from './compatibility-claim';
import { ViteDevSuite, type ViteDevCase } from './vite-dev-suite';
import { vite6DevSuiteVersionInputs } from './vite6-vanilla-fixture';

const claim = defineCompatibilityClaim({
  id: 'vanilla-vite-6-4-3-dependency-optimizer-lifecycle',
  statement:
    'Vanilla Vite 6.4.3 preserves its generated dependency optimizer cache across a development-server restart and coherently discovers a later bare import',
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

const optimizerCase = {
  claim,
  app: 'optimizer',
  driver: {
    expectedHeading: 'Vite 6 optimizer initial generation',
    framework: 'Vite 6 dependency optimizer',
    resourcePath: '/src/App.js',
    optimizedDependencyPaths: ['/node_modules/.vite/deps/picocolors.js'],
    workflow: null,
    optimizerLifecycle: {
      lateHeading: 'Vite 6 optimizer late dependency rendered'
    }
  }
} as const satisfies ViteDevCase;

const vite6DevSuite = new ViteDevSuite(vite6DevSuiteVersionInputs);

vite6DevSuite.register(optimizerCase);
