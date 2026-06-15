import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Tests share one MongoDB; run files serially and isolate by collection name.
    fileParallelism: false,
    include: ['test/**/*.test.ts'],
  },
});
