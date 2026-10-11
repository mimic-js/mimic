import { defineCompatibilityClaim } from './compatibility-claim';
import { createViteSourceDevelopmentCases } from './vite-source-development-cases';
import { ViteDevSuite } from './vite-dev-suite';
import {
  vanillaVite7ExactGraphTarget,
  vite7DevSuiteVersionInputs
} from './vite7-vanilla-fixture';

const vanillaCompatibilityClaim = defineCompatibilityClaim({
  id: 'vanilla-vite-7-3-6-development-workflow',
  statement:
    'Vanilla Vite 7.3.6 preserves its upstream client session across JavaScript, CSS, syntax-error recovery, hard reload, stop, teardown, and reboot',
  target: vanillaVite7ExactGraphTarget
});

const typescriptCompatibilityClaim = defineCompatibilityClaim({
  id: 'typescript-vite-7-3-6-development-workflow',
  statement:
    'TypeScript with Vite 7.3.6 preserves its upstream client session across typed transforms, updates, transform-error recovery, hard reload, stop, teardown, and reboot',
  target: vanillaVite7ExactGraphTarget
});

const viteSourceClaims = createViteSourceDevelopmentCases({
  vanilla: {
    claim: vanillaCompatibilityClaim,
    app: 'vanilla'
  },
  typescript: {
    claim: typescriptCompatibilityClaim,
    app: 'typescript'
  }
});

const vite7DevSuite = new ViteDevSuite(vite7DevSuiteVersionInputs);

for (const claimCase of viteSourceClaims) vite7DevSuite.register(claimCase);
