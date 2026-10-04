/**
 * Dependency container.
 *
 * A hand-rolled lazy container rather than a DI framework: every dependency is
 * an explicit function, so the object graph is readable in one screen and there
 * is no decorator magic to trace at 3am.
 *
 * Construction order is the boot order. `boot()` builds the pieces that must
 * exist before anything can serve traffic — config, database, schema gate,
 * caches, queue — and everything else resolves lazily from them.
 */

import { createDb, waitForSchema, type DbHandle } from './db/client.js';
import { createGuildConfigStore, type GuildConfigStore } from './config/guild-config.js';
import { createJobQueue, type JobQueue } from './jobs/queue.js';
import { createPolicyRepository, type PolicyRepository } from './policies/exclusions/repository.js';
import { lazyLogger } from './logging/logger.js';
import type { AppConfig } from './config/env.js';
import { createAfkService, type AfkService } from '../features/afk/service.js';
import { createEconomyService, type EconomyService } from '../features/economy/service.js';
import { createPulseService, type PulseService } from '../features/pulse/service.js';
import { buildTheme, type Theme } from './ui/themes/theme.js';
import { setHandlerServices } from './registry/manifest.js';

const log = lazyLogger({ module: 'container', operation: 'boot' });

export interface Container {
  readonly config: AppConfig;
  readonly db: DbHandle;
  readonly guildConfig: GuildConfigStore;
  readonly policies: PolicyRepository;
  readonly afk: AfkService;
  readonly economy: EconomyService;
  readonly pulse: PulseService;
  readonly jobs: JobQueue;
  shutdown(): Promise<void>;
}

export interface BootOptions {
  /** Skip the schema gate (the migration process itself must). */
  readonly skipSchemaGate?: boolean;
  /** Start the job queue. Disabled processes still enqueue. */
  readonly startJobs?: boolean;
}

export async function createContainer(
  config: AppConfig,
  options: BootOptions = {},
): Promise<Container> {
  const db = await createDb();

  if (!options.skipSchemaGate) {
    // Workers never migrate. They refuse to start against a half-migrated
    // schema rather than failing every query with an obscure error.
    await waitForSchema(db.db);
    log().info('schema gate passed');
  }

  const guildConfig = createGuildConfigStore(db.db);
  const policies = createPolicyRepository(db.db);
  const afk = createAfkService(db.db);
  const economy = createEconomyService(db.db);

  const jobs = createJobQueue({
    databaseUrl: config.database.url,
    db: db.db,
    concurrency: config.jobs.concurrency,
  });

  const pulse = createPulseService(db.db);

  // The guild accent is the ONLY guild-customizable visual value, so resolving
  // a theme is a cache read rather than a computation.
  async function themeFor(guildId: string): Promise<Theme> {
    const cfg = await guildConfig.get(guildId);
    return buildTheme(cfg.accent);
  }

  // Handlers reach services through here, so a command can never silently run
  // against a different database than the rest of the bot.
  setHandlerServices({ pulse, themeFor });

  if (config.jobs.enabled && (options.startJobs ?? true)) {
    await jobs.start();
  }

  return {
    config,
    db,
    guildConfig,
    policies,
    afk,
    economy,
    pulse,
    jobs,
    async shutdown() {
      // Order matters: stop accepting work before closing the database the
      // workers write through.
      if (config.jobs.enabled && (options.startJobs ?? true)) {
        await jobs.stop({ graceful: true });
      }
      await db.close();
      log().info('container shut down');
    },
  };
}
