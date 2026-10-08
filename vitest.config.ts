import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/**/*.test.ts', 'shared/**/*.test.ts', 'client/**/*.test.ts'],
    globalSetup: ['tools/fixtures/vitest-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    env: { HOMECAST_QUIET: '1', HOMECAST_NO_TRAY: '1' },
  },
});
