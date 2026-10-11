import { defineCompatibilityClaim } from './compatibility-claim';
import { createSolidDevDriver } from './solid-dev-driver';
import { ViteDevSuite, type ViteDevCase } from './vite-dev-suite';
import {
  vanillaVite7ExactGraphTarget,
  vite7DevSuiteVersionInputs
} from './vite7-vanilla-fixture';

const solidExactGraphTarget = {
  ...vanillaVite7ExactGraphTarget,
  packages: {
    ...vanillaVite7ExactGraphTarget.packages,
    'babel-preset-solid': '1.9.12',
    'solid-js': '1.9.14',
    'vite-plugin-solid': '2.11.14'
  },
  lockfile: {
    format: 'npm',
    version: 3,
    path: 'compatibility/fixtures/solid-1-vite-7.3.6/package-lock.json'
  }
} as const;

const solidCompatibilityClaim = defineCompatibilityClaim({
  id: 'solid-1-vite-7-3-6-hmr',
  statement:
    'Solid 1.9.14 with vite-plugin-solid 2.11.14 replaces a component through the upstream Vite 7.3.6 HMR session',
  target: solidExactGraphTarget
});

const solidCase = {
  claim: solidCompatibilityClaim,
  driver: createSolidDevDriver({
    solidVersion: '1.9.14',
    initialHeading: 'Solid Vite 7 HMR initial render',
    workflow: {
      updatedHeading: 'Solid Vite 7 HMR update applied',
      recoveredHeading: 'Solid Vite 7 HMR recovered',
      sourceUpdateState: 'initialize-after-update'
    }
  })
} as const satisfies ViteDevCase;

const vite7SolidDevSuite = new ViteDevSuite({
  ...vite7DevSuiteVersionInputs,
  installed: {
    'babel-preset-solid': 'babel-preset-solid@1.9.12',
    'solid-js': 'solid-js@1.9.14',
    'vite-plugin-solid': 'vite-plugin-solid@2.11.14',
    ...vite7DevSuiteVersionInputs.installed
  }
});

vite7SolidDevSuite.register(solidCase);
