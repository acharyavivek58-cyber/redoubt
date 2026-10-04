/**
 * Performance budget harness.
 *
 * Run with `npm run perf`. This is a SEPARATE suite from the correctness tests
 * on purpose: these assert LATENCY BUDGETS on the hot paths, and they are
 * deliberately allowed to be noisy, so they do not gate ordinary development.
 *
 * The budgets target pure functions that run on every message — prefix
 * parsing, policy resolution, level derivation, AutoMod detection, and rate
 * limiting. None of them touch the database, so the numbers measure real work
 * rather than network variance.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/perf/**/*.perf.test.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
  },
});
