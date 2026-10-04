/**
 * Test environment bootstrap.
 *
 * Modules that log resolve the process environment when the logger is first
 * created. Rather than making every module defensive about a missing
 * environment (which would weaken production error handling), the test run
 * supplies a minimal VALID one.
 *
 * These values are deliberately inert: no real token, no real database. Any
 * test that needs different config calls `resetConfig()` and sets its own.
 */

process.env.DISCORD_TOKEN ??=
  'test-token-not-a-real-credential-0000000000000000000000000000000';
process.env.DISCORD_CLIENT_ID ??= '000000000000000000';
process.env.DATABASE_URL ??= 'postgres://localhost:5432/redoubt_test';
process.env.NODE_ENV ??= 'test';
// Must be one of the levels the schema accepts.
process.env.LOG_LEVEL ??= 'fatal';
