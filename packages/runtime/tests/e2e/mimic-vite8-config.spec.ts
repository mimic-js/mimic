import { defineCompatibilityClaim } from './compatibility-claim';
import { ViteDevSuite, type ViteDevCase } from './vite-dev-suite';
import {
  vanillaVite8ExactGraphTarget,
  vite8DevSuiteVersionInputs
} from './vite8-vanilla-fixture';

const claim = defineCompatibilityClaim({
  id: 'vanilla-vite-8-1-4-configuration-resource-pipeline',
  statement:
    'Vanilla Vite 8.1.4 applies bundled TypeScript configuration and serves transformed TypeScript, JSON, imported assets, public assets, and VITE environment values',
  target: vanillaVite8ExactGraphTarget
});

// The heading joins what `vite.config.ts` defines, what `resource.json` holds and what `.env` exposes.
const expectedHeading = 'Bundled Vite 8 config applied: JSON imported: environment exposed';

const configResourceCase = {
  claim,
  app: 'config',
  driver: {
    expectedHeading,
    framework: 'Vite 8 config and resource pipeline',
    resourcePath: '/src/main.ts',
    optimizedDependencyPaths: ['/node_modules/.vite/deps/picocolors.js'],
    optimizedResponseProof: 'vite-produced-files',
    expectedResourcePaths: [
      '/src/main.ts',
      '/src/imported-resource.svg',
      '/public-resource.svg'
    ],
    workflow: null
  }
} as const satisfies ViteDevCase;

const vite8DevSuite = new ViteDevSuite(vite8DevSuiteVersionInputs);

vite8DevSuite.register(configResourceCase);
