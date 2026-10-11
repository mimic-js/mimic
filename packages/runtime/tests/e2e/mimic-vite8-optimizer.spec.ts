import { defineCompatibilityClaim } from './compatibility-claim';
import { ViteDevSuite, type ViteDevCase } from './vite-dev-suite';
import {
  vanillaVite8ExactGraphTarget,
  vite8DevSuiteVersionInputs
} from './vite8-vanilla-fixture';

const claim = defineCompatibilityClaim({
  id: 'vanilla-vite-8-1-4-dependency-optimizer-lifecycle',
  statement:
    'Vanilla Vite 8.1.4 preserves its generated dependency optimizer cache across a development-server restart and coherently discovers a later bare import',
  target: vanillaVite8ExactGraphTarget
});

const optimizerCase = {
  claim,
  app: 'optimizer',
  driver: {
    expectedHeading: 'Vite 8 optimizer initial generation',
    framework: 'Vite 8 dependency optimizer',
    resourcePath: '/src/App.js',
    optimizedDependencyPaths: ['/node_modules/.vite/deps/picocolors.js'],
    optimizedResponseProof: 'vite-produced-files',
    workflow: null,
    optimizerLifecycle: {
      lateHeading: 'Vite 8 optimizer late dependency rendered',
      allowReloadDuringLateDiscovery: true
    }
  }
} as const satisfies ViteDevCase;

const vite8DevSuite = new ViteDevSuite(vite8DevSuiteVersionInputs);

vite8DevSuite.register(optimizerCase);
