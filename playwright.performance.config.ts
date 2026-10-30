import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/performance',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 60_000,
  outputDir: 'test-results/performance',
  reporter: [['list'], ['json', { outputFile: 'test-results/performance-report.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: 'chromium-performance', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm preview --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
