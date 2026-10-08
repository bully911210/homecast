import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:8097',
    viewport: { width: 1920, height: 1080 },
    // Google Chrome, not bundled Chromium: the TV path needs H.264/AAC, which Chromium builds omit.
    channel: 'chrome',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node e2e/serve.ts',
    url: 'http://127.0.0.1:8097/api/health',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { HOMECAST_QUIET: '1', HOMECAST_NO_TRAY: '1' },
  },
});
