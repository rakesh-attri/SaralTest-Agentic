import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/unit/**/*.test.ts'],
    exclude: ['tests/integration/**', 'tests/generated/**', 'node_modules/**'],
    environment: 'node',
    testTimeout: 30_000,
    pool: 'forks',
  },
});
