import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'server',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Every `pg` test database is a fresh PGlite instance (or, with NEXUS_TEST_PG_URL, a fresh schema
    // on a real server) migrated from scratch; with the whole suite in parallel the first test of a
    // file can need more than the default 5 s (seen with PGlite and on PostgreSQL 16). Outcomes are
    // what the tests check, not speed.
    testTimeout: process.env.NEXUS_TEST_PG_URL ? 30_000 : 20_000,
  },
});
