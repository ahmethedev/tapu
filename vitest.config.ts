import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // All database tests share one test database, so files run one at a time.
    fileParallelism: false,
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
