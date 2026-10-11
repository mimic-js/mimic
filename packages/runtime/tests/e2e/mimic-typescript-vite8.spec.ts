import { defineCompatibilityClaim } from './compatibility-claim';
import { createViteSourceDevelopmentCases } from './vite-source-development-cases';
import { ViteDevSuite } from './vite-dev-suite';
import {
  vanillaVite8ExactGraphTarget,
  vite8DevSuiteVersionInputs
} from './vite8-vanilla-fixture';

const vanillaCompatibilityClaim = defineCompatibilityClaim({
  id: 'vanilla-vite-8-1-4-development-workflow',
  statement:
    'Vanilla Vite 8.1.4 preserves its upstream client session across JavaScript, CSS, syntax-error recovery, hard reload, stop, teardown, and reboot',
  target: vanillaVite8ExactGraphTarget
});

const typescriptCompatibilityClaim = defineCompatibilityClaim({
  id: 'typescript-vite-8-1-4-development-workflow',
  statement:
    'TypeScript with Vite 8.1.4 preserves its upstream client session across typed transforms, updates, transform-error recovery, hard reload, stop, teardown, and reboot',
  target: vanillaVite8ExactGraphTarget
});

const viteSourceClaims = createViteSourceDevelopmentCases({
  vanilla: {
    claim: vanillaCompatibilityClaim,
    app: 'vanilla',
    optimizedResponseProof: 'vite-produced-files'
  },
  typescript: {
    claim: typescriptCompatibilityClaim,
    app: 'typescript',
    optimizedResponseProof: 'vite-produced-files'
  }
});

const vite8DevSuite = new ViteDevSuite(vite8DevSuiteVersionInputs);

for (const claimCase of viteSourceClaims) vite8DevSuite.register(claimCase);
