import { defineCompatibilityClaim } from './compatibility-claim';
import { ViteDevSuite, type ViteDevCase } from './vite-dev-suite';
import {
  vanillaVite8ExactGraphTarget,
  vite8DevSuiteVersionInputs
} from './vite8-vanilla-fixture';

const claim = defineCompatibilityClaim({
  id: 'vanilla-vite-8-1-4-lightningcss-development-workflow',
  statement:
    'Vanilla Vite 8.1.4 transforms and hot-updates CSS through logical Lightning CSS, recovers from malformed CSS, and preserves its upstream client session',
  target: vanillaVite8ExactGraphTarget
});

const expectedHeading = 'Lightning CSS initial transform rendered';
const updatedHeading = 'Lightning CSS source update applied';

const lightningCssCase = {
  claim,
  app: 'lightningcss',
  driver: {
    expectedHeading,
    framework: 'Vanilla JavaScript',
    resourcePath: '/src/workflow.css',
    optimizedDependencyPaths: ['/node_modules/.vite/deps/picocolors.js'],
    optimizedResponseProof: 'vite-produced-files',
    workflow: {
      appPath: 'src/App.js',
      sourceHeading: updatedHeading,
      recoveredHeading: updatedHeading,
      applicationState: {
        sourceUpdateState: 'initialize-after-update',
        triggerSelector: '[data-workflow-increment]',
        valueSelector: '[data-workflow-state]'
      },
      transformErrorPath: 'src/workflow.css',
      transformErrorSource: '@media ( { a{}',
      recoveredSource: '.workflow-card { color: rgb(0, 128, 0); }'
    }
  }
} as const satisfies ViteDevCase;

new ViteDevSuite(vite8DevSuiteVersionInputs).register(lightningCssCase);
