import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'server',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // On a real PostgreSQL server (NEXUS_TEST_PG_URL) every test database is a fresh schema migrated
    // from scratch; with the whole suite in parallel the first test of a file can need more than the
    // default 5 s (seen on PostgreSQL 16). Outcomes are what the tests check, not speed.
    testTimeout: process.env.NEXUS_TEST_PG_URL ? 30_000 : 5_000,
  },
});
