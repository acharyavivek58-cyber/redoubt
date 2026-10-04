/**
 * Migration CLI.
 *
 * The ONLY process permitted to migrate. Workers call `waitForSchema()` and
 * refuse to start until the version recorded here exists (v13 §7).
 *
 * Usage:
 *   npm run db:migrate            apply pending migrations
 *   npm run db:migrate -- --status  report the applied/latest versions
 */

import { loadConfig } from '../config/env.js';
import { getLogger } from '../logging/logger.js';
import {
  createDb,
  getAppliedSchemaVersion,
  latestMigrationVersion,
  runMigrations,
} from './client.js';

const logger = getLogger();

async function main(): Promise<void> {
  const config = loadConfig();
  const statusOnly = process.argv.includes('--status');

  const handle = await createDb();

  try {
    const latest = latestMigrationVersion();

    if (statusOnly) {
      const applied = await getAppliedSchemaVersion(handle.db).catch(() => null);
      logger.info({ applied: applied ?? '(none)', latest }, 'schema status');
      return;
    }

    const { applied, version } = await runMigrations(handle.db, handle.sql);
    logger.info({ applied, version, latest }, applied ? 'migrations applied' : 'already up to date');
  } finally {
    await handle.close();
  }

  logger.info({ env: config.env }, 'migration run complete');
}

main().catch((error: unknown) => {
  // A failed migration must be loud and non-zero: the supervisor needs to know
  // the schema may be inconsistent.
  logger.fatal({ err: error }, 'migration failed');
  process.exit(1);
});
