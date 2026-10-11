import { defineCompatibilityClaim } from './compatibility-claim';
import { ViteDevSuite, type ViteDevCase } from './vite-dev-suite';
import {
  vanillaVite7ExactGraphTarget,
  vite7DevSuiteVersionInputs
} from './vite7-vanilla-fixture';

const claim = defineCompatibilityClaim({
  id: 'vanilla-vite-7-3-6-configuration-resource-pipeline',
  statement:
    'Vanilla Vite 7.3.6 applies bundled TypeScript configuration and serves transformed TypeScript, JSON, imported assets, public assets, and VITE environment values',
  target: vanillaVite7ExactGraphTarget
});

// The heading joins what `vite.config.ts` defines, what `resource.json` holds and what `.env` exposes.
const expectedHeading = 'Bundled Vite 7 config applied: JSON imported: environment exposed';

const configResourceCase = {
  claim,
  app: 'config',
  driver: {
    expectedHeading,
    framework: 'Vite 7 config and resource pipeline',
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

const vite7DevSuite = new ViteDevSuite(vite7DevSuiteVersionInputs);

vite7DevSuite.register(configResourceCase);
