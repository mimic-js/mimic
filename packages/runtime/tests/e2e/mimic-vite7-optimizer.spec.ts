import { defineCompatibilityClaim } from './compatibility-claim';
import { ViteDevSuite, type ViteDevCase } from './vite-dev-suite';
import {
  vanillaVite7ExactGraphTarget,
  vite7DevSuiteVersionInputs
} from './vite7-vanilla-fixture';

const claim = defineCompatibilityClaim({
  id: 'vanilla-vite-7-3-6-dependency-optimizer-lifecycle',
  statement:
    'Vanilla Vite 7.3.6 preserves its generated dependency optimizer cache across a development-server restart and coherently discovers a later bare import',
  target: vanillaVite7ExactGraphTarget
});

const optimizerCase = {
  claim,
  app: 'optimizer',
  driver: {
    expectedHeading: 'Vite 7 optimizer initial generation',
    framework: 'Vite 7 dependency optimizer',
    resourcePath: '/src/App.js',
    optimizedDependencyPaths: ['/node_modules/.vite/deps/picocolors.js'],
    workflow: null,
    optimizerLifecycle: {
      lateHeading: 'Vite 7 optimizer late dependency rendered',
      allowReloadDuringLateDiscovery: true
    }
  }
} as const satisfies ViteDevCase;

const vite7DevSuite = new ViteDevSuite(vite7DevSuiteVersionInputs);

vite7DevSuite.register(optimizerCase);
