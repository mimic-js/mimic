import { defineCompatibilityClaim } from './compatibility-claim';
import { ViteDevSuite, type ViteDevCase } from './vite-dev-suite';
import {
  vanillaVite7ExactGraphTarget,
  vite7DevSuiteVersionInputs
} from './vite7-vanilla-fixture';

const reactExactGraphTarget = {
  ...vanillaVite7ExactGraphTarget,
  packages: {
    ...vanillaVite7ExactGraphTarget.packages,
    '@vitejs/plugin-react': '5.2.0',
    react: '19.2.8',
    'react-dom': '19.2.8'
  },
  lockfile: {
    format: 'npm',
    version: 3,
    path: 'compatibility/fixtures/react-19-vite-7.3.6/package-lock.json'
  }
} as const;

const reactCompatibilityClaim = defineCompatibilityClaim({
  id: 'react-19-vite-7-3-6-fast-refresh',
  statement:
    'React 19.2.8 with plugin-react 5.2.0 preserves state through the upstream Vite 7.3.6 Fast Refresh session',
  target: reactExactGraphTarget
});

const reactCase = {
  claim: reactCompatibilityClaim,
  driver: {
    expectedHeading: 'React 19 Fast Refresh initial render',
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
      sourceHeading: 'React 19 Fast Refresh update applied',
      recoveredHeading: 'React 19 Fast Refresh recovered',
      applicationState: {
        sourceUpdateState: 'preserve-existing',
        triggerSelector: 'button',
        valueSelector: '[data-refresh-count]'
      },
      transformErrorSource: 'export default function App() { return <main>; }'
    }
  }
} as const satisfies ViteDevCase;

const vite7ReactDevSuite = new ViteDevSuite({
  ...vite7DevSuiteVersionInputs,
  installed: {
    '@vitejs/plugin-react': '@vitejs/plugin-react@5.2.0',
    react: 'react@19.2.8',
    'react-dom': 'react-dom@19.2.8',
    ...vite7DevSuiteVersionInputs.installed
  }
});

vite7ReactDevSuite.register(reactCase);
