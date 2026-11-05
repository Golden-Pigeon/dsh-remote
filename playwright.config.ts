import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './test/playwright',
  timeout: 120_000,
  workers: 1,
  reporter: [['line']],
  use: {
    headless: true,
    trace: 'retain-on-failure',
  },
})
