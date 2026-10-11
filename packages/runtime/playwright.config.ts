import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 240_000,
  expect: {
    timeout: 30_000
  },
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: 'http://127.0.0.1:4179',
    trace: process.env.CI ? 'on-first-retry' : 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  webServer: [
    {
      command: 'pnpm build:package && pnpm exec vite --host 127.0.0.1 --port 4179 --strictPort',
      url: 'http://127.0.0.1:4179/mimic-test-host.html',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000
    },
    {
      // The e2e demo application resolves the package the first server
      // builds; Playwright waits for both before a claim navigates.
      command: 'pnpm --dir ../../apps/e2e-demo exec vite --host 127.0.0.1 --port 4180 --strictPort',
      url: 'http://127.0.0.1:4180',
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
