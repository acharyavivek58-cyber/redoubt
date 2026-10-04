/**
 * Database client + migration safety (v13 §7).
 *
 * Two guarantees implemented here:
 *
 *  1. SINGLE WRITER — migrations run under a PostgreSQL advisory lock so
 *     multiple shards/workers starting at once can never race. The lock is
 *     released on completion OR failure.
 *
 *  2. WORKER BOOT GATE — workers never migrate. They poll for the schema
 *     marker and refuse to start until the required schema version exists, so
 *     no worker ever boots against a half-migrated schema.
 */

import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../config/env.js';
import { getLogger } from '../logging/logger.js';
import * as schema from './schema/index.js';

/**
 * Arbitrary but fixed key. Any process using the same key contends.
 *
 * Kept as a string because bigint is not a bindable parameter type; the value
 * is inlined into the SQL (it is an internal constant, never user input).
 */
const MIGRATION_LOCK_KEY = '8140237415902331';

export type Database = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  readonly db: Database;
  readonly sql: ReturnType<typeof postgres>;
  close(): Promise<void>;
}

export async function createDb(): Promise<DbHandle> {
  const config = getConfig();
  const client = postgres(config.database.url, {
    max: config.database.poolMax,
    // Keeps a pathological query from holding a pooled connection forever.
    connect_timeout: 10,
    idle_timeout: 20,
    onnotice: () => {
      /* notices are not actionable for operators here */
    },
  });

  // statement_timeout is a server GUC, not a client option. Set it per session
  // so a runaway query cannot pin a pooled connection (v20 Priority A).
  await client.unsafe(
    `SET statement_timeout = ${Number(config.database.statementTimeoutMs)}`,
  );

  const db = drizzle(client, { schema });

  return {
    db,
    sql: client,
    async close() {
      await client.end({ timeout: 5 });
    },
  };
}

function migrationsFolder(): string {
  const dir = join(process.cwd(), 'drizzle');
  if (!existsSync(dir)) {
    throw new Error(`Migrations folder not found at ${dir}. Run \`npm run db:generate\` first.`);
  }
  return dir;
}

/** Highest applied migration version recorded in schema_migrations. */
export async function getAppliedSchemaVersion(db: Database): Promise<string | null> {
  const rows = await db.execute<{ version: string }>(
    sql`SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1`,
  );
  return rows[0]?.version ?? null;
}

/** Records a migration version so workers know the schema is present. */
async function recordSchemaVersion(db: Database, version: string): Promise<void> {
  await db.execute(
    sql`INSERT INTO schema_migrations (version) VALUES (${version})
        ON CONFLICT (version) DO NOTHING`,
  );
}

function latestMigrationVersion(): string {
  const dir = migrationsFolder();
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const last = files[files.length - 1];
  if (!last) throw new Error('No SQL migrations found.');
  return last.replace(/\.sql$/, '');
}

/**
 * Runs migrations under an advisory lock.
 *
 * The lock is acquired with a bounded wait: a second process waits rather than
 * failing fast, but never blocks forever. Released in a finally block so a
 * failed migration does not deadlock the next deploy.
 *
 * Idempotent — re-running is a no-op once the schema version is recorded.
 */
export async function runMigrations(db: Database, sqlClient: ReturnType<typeof postgres>): Promise<{
  applied: boolean;
  version: string;
}> {
  const log = getLogger().child({ module: 'db', operation: 'migrate' });
  const version = latestMigrationVersion();

  const tryLock = async (): Promise<boolean> => {
    const rows = await sqlClient.unsafe<{ locked: boolean }[]>(
      `SELECT pg_try_advisory_lock(${MIGRATION_LOCK_KEY}) AS locked`,
    );
    return rows[0]?.locked === true;
  };

  if (!(await tryLock())) {
    // Another process holds the lock. Wait for it, then verify the schema.
    log.info('migration lock held by another process; waiting');
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (await tryLock()) {
        await recordSchemaVersion(db, version);
        await sqlClient.unsafe(`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`);
        return { applied: false, version };
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('Timed out waiting for the migration lock.');
  }

  try {
    await migrate(db, { migrationsFolder: migrationsFolder() });
    await recordSchemaVersion(db, version);
    log.info({ version }, 'migrations applied');
    return { applied: true, version };
  } finally {
    // Released on BOTH success and failure — a crashed migration must not
    // leave the lock held.
    await sqlClient.unsafe(`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`);
  }
}

/**
 * Worker boot gate (v13 §7): blocks until the required schema exists.
 *
 * Workers call this instead of migrating. Throws rather than proceeding, so a
 * misconfigured worker fails loudly instead of serving errors.
 */
export async function waitForSchema(
  db: Database,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 400;
  const required = latestMigrationVersion();
  const deadline = Date.now() + timeoutMs;
  const log = getLogger().child({ module: 'db', operation: 'schema-gate' });

  while (Date.now() < deadline) {
    try {
      const applied = await getAppliedSchemaVersion(db);
      if (applied === required) return applied;
    } catch {
      // Table may not exist yet on a brand-new database; keep waiting.
      log.debug({ required }, 'schema marker not readable yet');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    `Schema ${required} was not available within ${timeoutMs}ms. ` +
      'A migration process must run before workers start.',
  );
}

// Re-exported so the migrate CLI can introspect without importing internals.
export { latestMigrationVersion };