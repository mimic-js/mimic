import { defineCompatibilityClaim } from './compatibility-claim';
import { ViteDevSuite, type ViteDevCase } from './vite-dev-suite';
import {
  vanillaVite8ExactGraphTarget,
  vite8DevSuiteVersionInputs
} from './vite8-vanilla-fixture';

const reactExactGraphTarget = {
  ...vanillaVite8ExactGraphTarget,
  packages: {
    ...vanillaVite8ExactGraphTarget.packages,
    '@vitejs/plugin-react': '6.1.0',
    react: '19.2.8',
    'react-dom': '19.2.8'
  },
  lockfile: {
    format: 'npm',
    version: 3,
    path: 'compatibility/fixtures/react-19-vite-8.1.4/package-lock.json'
  }
} as const;

const reactCompatibilityClaim = defineCompatibilityClaim({
  id: 'react-19-vite-8-1-4-fast-refresh',
  statement:
    'React 19.2.8 with plugin-react 6.1.0 preserves state through the upstream Vite 8.1.4 Fast Refresh session',
  target: reactExactGraphTarget
});

const reactCase = {
  claim: reactCompatibilityClaim,
  driver: {
    expectedHeading: 'React 19 Vite 8 Fast Refresh initial render',
    framework: 'React 19.2.8',
    resourcePath: '/src/App.jsx',
    optimizedDependencyPaths: [
      '/node_modules/.vite/deps/react.js',
      '/node_modules/.vite/deps/react-dom_client.js'
    ],
    optimizedResponseProof: 'vite-produced-files',
    expectedResourcePaths: [
      '/src/App.jsx',
      '/node_modules/.vite/deps/react.js',
      '/node_modules/.vite/deps/react-dom_client.js'
    ],
    workflow: {
      appPath: 'src/App.jsx',
      sourceHeading: 'React 19 Vite 8 Fast Refresh update applied',
      recoveredHeading: 'React 19 Vite 8 Fast Refresh recovered',
      applicationState: {
        sourceUpdateState: 'preserve-existing',
        triggerSelector: 'button',
        valueSelector: '[data-refresh-count]'
      },
      transformErrorSource: 'export default function App() { return <main>; }'
    }
  }
} as const satisfies ViteDevCase;

const vite8ReactDevSuite = new ViteDevSuite({
  ...vite8DevSuiteVersionInputs,
  installed: {
    '@vitejs/plugin-react': '@vitejs/plugin-react@6.1.0',
    react: 'react@19.2.8',
    'react-dom': 'react-dom@19.2.8',
    ...vite8DevSuiteVersionInputs.installed
  }
});

vite8ReactDevSuite.register(reactCase);
