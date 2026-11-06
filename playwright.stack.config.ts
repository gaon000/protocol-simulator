import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/stack-e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  outputDir: 'test-results/stack',
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4174', trace: 'retain-on-failure' },
  projects: [
    { name: 'stack-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'stack-firefox', use: { ...devices['Desktop Firefox'] } },
  ],
  webServer: {
    command: 'pnpm dev --port 4174 --strictPort',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: false,
    timeout: 30000,
  },
});
