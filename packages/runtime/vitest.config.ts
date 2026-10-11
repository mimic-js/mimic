import { defineConfig } from 'vitest/config';
import { nodeCompatibilityPortAliases, nodeCompatibilityPorts } from './vite.node-compatibility';

export default defineConfig({
  resolve: {
    alias: nodeCompatibilityPortAliases
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts', 'src/runtime/modules/**/*.test.ts'],
          environment: 'node',
          pool: 'threads',
          setupFiles: ['tests/support/configure-sqlite-engine.ts'],
          testTimeout: 10_000,
          deps: {
            optimizer: {
              ssr: { enabled: true, include: nodeCompatibilityPorts }
            }
          }
        }
      }
    ]
  }
});
