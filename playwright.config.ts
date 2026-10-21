import { defineConfig } from '@playwright/test'
export default defineConfig({ testDir: './tests/desktop', timeout: 60000, workers: 1, globalSetup: './scripts/check-desktop-ready.mjs',
  // Hosted Windows cold starts and native disk operations can exceed the
  // default 5 s assertion window. Keep the test and measured performance
  // budgets unchanged while waiting for the actual UI/backend result.
  expect: { timeout: process.platform === 'win32' && process.env.CI === 'true' ? 15_000 : 5_000 },
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  reporter: process.env.PLAYWRIGHT_JUNIT_OUTPUT_FILE ? [['list'], ['junit']] : 'list' })
