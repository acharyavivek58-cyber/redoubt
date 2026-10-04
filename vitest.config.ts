import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
      '@features': fileURLToPath(new URL('./src/features', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Perf budgets are TIMING-SENSITIVE and belong to `npm run perf` only.
    // Without this exclusion they also match `*.test.ts` and run in the
    // correctness suite, where a busy CI machine would fail them at random.
    exclude: ['tests/perf/**', 'node_modules/**', 'dist/**'],
    // Supplies a minimal valid environment before any module resolves a logger.
    setupFiles: ['tests/setup.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    pool: 'forks',
  },
});