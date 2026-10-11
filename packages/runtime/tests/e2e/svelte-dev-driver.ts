import type { ViteDevDriver } from './vite-dev-suite';

type SvelteDevWorkflow = Readonly<{
  updatedHeading: string;
  recoveredHeading: string;
}>;

type SvelteDevDriverInputs = Readonly<{
  svelteVersion: string;
  initialHeading: string;
  workflow: SvelteDevWorkflow;
}>;

export function createSvelteDevDriver(inputs: SvelteDevDriverInputs): ViteDevDriver {
  return {
    expectedHeading: inputs.initialHeading,
    framework: `Svelte ${inputs.svelteVersion}`,
    resourcePath: '/src/App.svelte',
    optimizedDependencyPaths: ['/node_modules/.vite/deps/svelte.js'],
    optimizedResponseProof: 'vite-produced-files',
    expectedResourcePaths: ['/src/App.svelte', '/node_modules/.vite/deps/svelte.js'],
    workflow: {
      appPath: 'src/App.svelte',
      sourceHeading: inputs.workflow.updatedHeading,
      recoveredHeading: inputs.workflow.recoveredHeading,
      applicationState: {
        sourceUpdateState: 'initialize-after-update',
        triggerSelector: 'button',
        valueSelector: '[data-refresh-count]'
      },
      transformErrorSource: '<script>const broken = ;</script>\n<h1>Svelte transform error</h1>',
      transformErrorHttpResponse: 'absent'
    }
  };
}
