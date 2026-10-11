import type { ViteDevDriver } from './vite-dev-suite';

type VueDevWorkflow = Readonly<{
  updatedHeading: string;
  recoveredHeading: string;
}>;

type VueDevDriverInputs = Readonly<{
  vueVersion: string;
  initialHeading: string;
  workflow: VueDevWorkflow | null;
}>;

export function createVueDevDriver(inputs: VueDevDriverInputs): ViteDevDriver {
  const driver = {
    expectedHeading: inputs.initialHeading,
    framework: `Vue ${inputs.vueVersion}`,
    resourcePath: '/src/App.vue',
    optimizedDependencyPaths: ['/node_modules/.vite/deps/vue.js'],
    optimizedResponseProof: 'vite-produced-files',
    expectedResourcePaths: ['/src/App.vue', '/node_modules/.vite/deps/vue.js']
  } as const;

  if (inputs.workflow === null) return { ...driver, workflow: null };

  return {
    ...driver,
    workflow: {
      appPath: 'src/App.vue',
      sourceHeading: inputs.workflow.updatedHeading,
      recoveredHeading: inputs.workflow.recoveredHeading,
      applicationState: {
        sourceUpdateState: 'preserve-existing',
        triggerSelector: '[data-increment]',
        valueSelector: '[data-count]'
      },
      transformErrorSource: [
        '<script setup>',
        'const broken =',
        '</script>',
        '<template><main><h1>Vue transform error</h1></main></template>'
      ].join('\n'),
      transformErrorHttpResponse: 'absent'
    }
  };
}
