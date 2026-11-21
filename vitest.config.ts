import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts', 'test/conformance/**/*.test.ts'],
          testTimeout: 20_000,
          // Memory tests force collections with gc().
          execArgv: ['--expose-gc'],
        },
      },
      {
        test: {
          name: 'dist',
          include: ['test/dist/**/*.test.ts'],
          testTimeout: 30_000,
        },
      },
      {
        // Real API calls: skipped unless BAKBAK_API_KEY and BAKBAK_BASE_URL are set. Serial,
        // because staging serves each model one request at a time.
        test: {
          name: 'live',
          include: ['test/live/**/*.test.ts'],
          testTimeout: 120_000,
          fileParallelism: false,
          sequence: { concurrent: false },
        },
      },
    ],
  },
});
