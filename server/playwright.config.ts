import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './src',
  testMatch: '**/*.e2e.ts',
  timeout: 30_000,
  workers: 1,
  use: {
    headless: true,
  },
});
