import { defineCompatibilityClaim } from './compatibility-claim';
import { createSolidDevDriver } from './solid-dev-driver';
import { ViteDevSuite, type ViteDevCase } from './vite-dev-suite';
import {
  vanillaVite8ExactGraphTarget,
  vite8DevSuiteVersionInputs
} from './vite8-vanilla-fixture';

const solidExactGraphTarget = {
  ...vanillaVite8ExactGraphTarget,
  packages: {
    ...vanillaVite8ExactGraphTarget.packages,
    'babel-preset-solid': '1.9.15',
    'solid-js': '1.9.15',
    'vite-plugin-solid': '2.11.14'
  },
  lockfile: {
    format: 'npm',
    version: 3,
    path: 'compatibility/fixtures/solid-1-vite-8.1.4/package-lock.json'
  }
} as const;

const solidCompatibilityClaim = defineCompatibilityClaim({
  id: 'solid-1-vite-8-1-4-hmr',
  statement:
    'Solid 1.9.15 with vite-plugin-solid 2.11.14 replaces a component through the upstream Vite 8.1.4 HMR session',
  target: solidExactGraphTarget
});

const solidCase = {
  claim: solidCompatibilityClaim,
  driver: createSolidDevDriver({
    solidVersion: '1.9.15',
    initialHeading: 'Solid Vite 8 HMR initial render',
    workflow: {
      updatedHeading: 'Solid Vite 8 HMR update applied',
      recoveredHeading: 'Solid Vite 8 HMR recovered',
      sourceUpdateState: 'initialize-after-update'
    }
  })
} as const satisfies ViteDevCase;

const vite8SolidDevSuite = new ViteDevSuite({
  ...vite8DevSuiteVersionInputs,
  installed: {
    'babel-preset-solid': 'babel-preset-solid@1.9.15',
    'solid-js': 'solid-js@1.9.15',
    'vite-plugin-solid': 'vite-plugin-solid@2.11.14',
    ...vite8DevSuiteVersionInputs.installed
  }
});

vite8SolidDevSuite.register(solidCase);
