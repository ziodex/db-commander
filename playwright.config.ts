import { defineConfig } from '@playwright/test'
export default defineConfig({ testDir: './tests/desktop', timeout: 60000, workers: 1, globalSetup: './scripts/check-desktop-ready.mjs',
  reporter: process.env.PLAYWRIGHT_JUNIT_OUTPUT_FILE ? [['list'], ['junit']] : 'list' })
