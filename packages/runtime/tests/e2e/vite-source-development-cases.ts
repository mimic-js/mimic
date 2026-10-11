import type { ViteDevCase } from './vite-dev-suite';

type ViteSourceCaseRegistration = Pick<ViteDevCase, 'claim' | 'app'> & Readonly<{
  optimizedResponseProof?: 'vite-produced-files';
}>;

type ViteSourceCaseRegistrations = Readonly<{
  vanilla: ViteSourceCaseRegistration;
  typescript: ViteSourceCaseRegistration;
}>;

const viteSourceDevelopmentScenarios = [
  {
    id: 'vanilla',
    appFile: 'App.js',
    expectedHeading: 'Vanilla Vite compatibility receipt',
    sourceHeading: 'Vanilla JavaScript HMR applied',
    recoveredHeading: 'Vanilla syntax recovery applied',
    framework: 'Vanilla JavaScript',
    transformErrorSource: "import { broken from './missing.js';"
  },
  {
    id: 'typescript',
    appFile: 'App.ts',
    expectedHeading: 'TypeScript compatibility claim rendered',
    sourceHeading: 'TypeScript HMR update applied',
    recoveredHeading: 'TypeScript transform recovery applied',
    framework: 'TypeScript source',
    transformErrorSource: 'const transformFailure: string = ;'
  }
] as const;

export function createViteSourceDevelopmentCases(
  registrations: ViteSourceCaseRegistrations
): readonly ViteDevCase[] {
  return viteSourceDevelopmentScenarios.map((scenario) => {
    const registration = registrations[scenario.id];
    return {
      claim: registration.claim,
      ...(registration.app === undefined ? {} : { app: registration.app }),
      reboot: 'workflow',
      driver: {
        expectedHeading: scenario.expectedHeading,
        framework: scenario.framework,
        resourcePath: `/src/${scenario.appFile}`,
        optimizedDependencyPaths: ['/node_modules/.vite/deps/picocolors.js'],
        ...(registration.optimizedResponseProof === undefined
          ? {}
          : { optimizedResponseProof: registration.optimizedResponseProof }),
        workflow: {
          appPath: `src/${scenario.appFile}`,
          sourceHeading: scenario.sourceHeading,
          recoveredHeading: scenario.recoveredHeading,
          applicationState: {
            sourceUpdateState: 'initialize-after-update',
            triggerSelector: '[data-workflow-increment]',
            valueSelector: '[data-workflow-state]'
          },
          transformErrorSource: scenario.transformErrorSource
        }
      }
    } satisfies ViteDevCase;
  });
}
