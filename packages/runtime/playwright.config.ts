import { defineConfig, devices } from '@playwright/test';

// MIMIC_E2E_PORT lets two checkouts run the suite side by side; the e2e demo
// application takes the next port. The specs read the same variable.
const port = Number(process.env.MIMIC_E2E_PORT ?? 4179);
const demoPort = port + 1;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 240_000,
  expect: {
    timeout: 30_000
  },
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: process.env.CI ? 'on-first-retry' : 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  webServer: [
    {
      command: 'pnpm build:package && pnpm exec vite --host 127.0.0.1 --strictPort --port ' + port,
      url: `http://127.0.0.1:${port}/mimic-test-host.html`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000
    },
    {
      // The e2e demo application resolves the package the first server
      // builds; Playwright waits for both before a claim navigates.
      // Both servers start at once; this one waits for the build the first one makes.
      command:
        'until [ -f dist/vite/index.js ]; do sleep 1; done; pnpm --dir ../../apps/e2e-demo exec vite --host 127.0.0.1 --strictPort --port ' +
        demoPort,
      url: `http://127.0.0.1:${demoPort}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000
    }
  ],
  projects: [
    {
      name: 'browser-runtime',
      use: {
        ...devices['Desktop Chrome']
      }
    }
  ]
});
