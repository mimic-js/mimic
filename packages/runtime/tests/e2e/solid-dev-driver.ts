import type { ViteDevDriver } from './vite-dev-suite';

type SolidDevWorkflow = Readonly<{
  updatedHeading: string;
  recoveredHeading: string;
  sourceUpdateState: 'initialize-after-update' | 'preserve-existing';
}>;

type SolidDevDriverInputs = Readonly<{
  solidVersion: string;
  initialHeading: string;
  workflow: SolidDevWorkflow;
}>;

export function createSolidDevDriver(inputs: SolidDevDriverInputs): ViteDevDriver {
  return {
    expectedHeading: inputs.initialHeading,
    framework: `Solid ${inputs.solidVersion}`,
    resourcePath: '/src/Message.jsx',
    optimizedDependencyPaths: ['/node_modules/.vite/deps/solid-js_web.js'],
    optimizedResponseProof: 'vite-produced-files',
    expectedResourcePaths: [
      '/src/App.jsx',
      '/src/Message.jsx',
      '/node_modules/.vite/deps/solid-js_web.js'
    ],
    workflow: {
      appPath: 'src/Message.jsx',
      sourceHeading: inputs.workflow.updatedHeading,
      recoveredHeading: inputs.workflow.recoveredHeading,
      applicationState: {
        sourceUpdateState: inputs.workflow.sourceUpdateState,
        triggerSelector: 'button',
        valueSelector: '[data-refresh-count]'
      },
      transformErrorSource: 'export default function Message() { return <h1>; }',
      transformErrorDocument: 'replace',
      transformErrorReloadPaths: ['/src/Message.jsx', '/src/App.jsx']
    }
  };
}
