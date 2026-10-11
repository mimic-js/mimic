import { defineCompatibilityClaim } from './compatibility-claim';
import { ViteDevSuite, type ViteDevCase } from './vite-dev-suite';

const reactCompatibilityClaim = defineCompatibilityClaim({
  id: 'react-18-vite-6-4-3-fast-refresh',
  statement:
    'React 18.3.1 with plugin-react 4.7.0 preserves state through the upstream Vite 6.4.3 Fast Refresh session',
  target: {
    kind: 'exact-graph',
    packages: {
      '@vitejs/plugin-react': '4.7.0',
      react: '18.3.1',
      'react-dom': '18.3.1',
      vite: '6.4.3'
    },
    packageManager: { name: 'npm', version: '11.18.0' },
    lockfile: {
      format: 'npm',
      version: 3,
      path: 'compatibility/fixtures/react-18-vite-6.4.3/package-lock.json'
    },
    virtualPlatform: { operatingSystem: 'linux', architecture: 'wasm32', runtime: 'browser', nodeVersion: '22.22.3' },
    replacements: {
      rollup: '@rollup/wasm-node@4.62.3'
    },
    execution: { command: 'npm', entrypoint: 'run dev' }
  }
});

const reactCase = {
  claim: reactCompatibilityClaim,
  driver: {
    expectedHeading: 'React Fast Refresh initial render',
    framework: 'React 18.3.1',
    resourcePath: '/src/App.jsx',
    optimizedDependencyPaths: [
      '/node_modules/.vite/deps/react.js',
      '/node_modules/.vite/deps/react-dom_client.js'
    ],
    expectedResourcePaths: [
      '/src/App.jsx',
      '/node_modules/.vite/deps/react.js',
      '/node_modules/.vite/deps/react-dom_client.js'
    ],
    workflow: {
      appPath: 'src/App.jsx',
      sourceHeading: 'React Fast Refresh update applied',
      recoveredHeading: 'React Fast Refresh recovered',
      applicationState: {
        sourceUpdateState: 'preserve-existing',
        triggerSelector: 'button',
        valueSelector: '[data-refresh-count]'
      },
      transformErrorSource: 'export default function App() { return <main>; }'
    }
  }
} as const satisfies ViteDevCase;

const vite6ReactDevSuite = new ViteDevSuite({
  viteVersion: '6.4.3',
  installed: {
    '@vitejs/plugin-react': '@vitejs/plugin-react@4.7.0',
    react: 'react@18.3.1',
    'react-dom': 'react-dom@18.3.1',
    vite: 'vite@6.4.3',
    esbuild: 'esbuild@0.25.12',
    rollup: '@rollup/wasm-node@4.62.3'
  }
});

vite6ReactDevSuite.register(reactCase);
