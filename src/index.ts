/**
 * Process entrypoint.
 *
 * Runs in one of three shapes, chosen purely from configuration (v13 §E.5):
 *
 *   - MANAGER  — spawns shards via `ShardingManager`, owns the job queue, and
 *                is the ONLY process permitted to migrate (v13 §7).
 *   - WORKER   — one shard, spawned by the manager. Waits for the schema gate
 *                and never migrates.
 *   - SINGLE   — no cluster at all. The default for a one-guild install.
 *
 * SHUTDOWN IS EXPLICIT AND FAIL-LOUD. An uncaught exception logs with a
 * correlation ID, stops accepting work, releases resources, and exits non-zero
 * so the supervisor restarts into a known-good state (v14 §7). Nothing is
 * swallowed.
 */

import {
  Client,
  GatewayIntentBits,
  Options,
  Partials,
  ShardingManager,
  ShardClientUtil,
  type ClientOptions,
} from 'discord.js';
import { fileURLToPath } from 'node:url';
import { loadConfig, type AppConfig } from './core/config/env.js';
import { createContainer, type Container } from './core/container.js';
import { getLogger } from './core/logging/logger.js';

const logger = getLogger();

/**
 * Intents Redoubt needs; anything broader is an operational liability.
 *
 * `shard`/`shardCount` come from the environment the ShardingManager sets on
 * each spawned child. With neither set, the client runs unsharded.
 */
function clientOptions(): ClientOptions {
  const shardId = process.env.SHARD_ID;
  const shardCount = process.env.SHARD_COUNT;

  return {
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    // Members and reactions arrive as out-of-gateway events; without these
    // partials a cache miss on a large guild is an unhandled error.
    partials: [Partials.GuildMember, Partials.Channel, Partials.Message, Partials.Reaction],
    // Presence is never read, so its gateway traffic is pure cost.
    presence: { intents: 0 },
    failIfNotExists: false,
    rest: { timeout: 15_000, retries: 2 },
    ...(shardId !== undefined && shardCount !== undefined
      ? { shard: Number(shardId), shardCount: Number(shardCount) }
      : {}),
    sweepers: {
      ...Options.DefaultSweeperSettings,
      messages: { interval: 3600, lifetime: 1800 },
    },
  } as ClientOptions;
}

/** Installs handlers that must exist before login. */
function attachClientLogging(client: Client): void {
  client.on('error', (error: Error) => logger.error({ err: error }, 'client error'));
  client.on('shardError', (error: Error, shardId: number) =>
    logger.error({ err: error, shardId }, 'shard error'),
  );
  client.on('shardDisconnect', (event: { code: number }, shardId: number) =>
    logger.warn({ code: event.code, shardId }, 'shard disconnected'),
  );
  client.on('shardResume', (shardId: number, replayed: number) =>
    logger.info({ shardId, replayed }, 'shard resumed'),
  );
  client.on('ready', () => logger.info({ guilds: client.guilds.cache.size }, 'client ready'));
}

function installProcessGuards(onShutdown: (reason: string, code: number) => void): void {
  process.on('SIGINT', () => onShutdown('SIGINT', 0));
  process.on('SIGTERM', () => onShutdown('SIGTERM', 0));

  // v14 §7: uncaught failures are NOT swallowed. Log, drain, exit non-zero.
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception');
    onShutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled rejection');
    onShutdown('unhandledRejection', 1);
  });
}

async function runWorker(): Promise<void> {
  const config = loadConfig();

  // A worker must never migrate: it waits for the manager to publish the
  // schema version instead.
  const container = await createContainer(config, {
    skipSchemaGate: false,
    // Exactly one process runs the job queue, so shards do not duplicate work.
    startJobs: config.jobs.enabled && config.sharding.isManager,
  });

  const client = new Client(clientOptions());
  // Registers this process with its parent manager so shard lifecycle messages
  // (respawn, idle, eval) are routed correctly.
  ShardClientUtil.singleton(client as Client<true>, 'process');

  attachClientLogging(client);

  let shuttingDown = false;
  const shutdown = (reason: string, code: number): void => {
    // A second signal during shutdown must not start a second teardown.
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ reason }, 'shutting down');

    void (async () => {
      try {
        await client.destroy();
        await container.shutdown();
      } catch (error) {
        logger.error({ err: error }, 'error during shutdown');
        code = 1;
      }
      process.exit(code);
    })();
  };

  installProcessGuards(shutdown);

  await client.login(config.discord.token);
  logger.info({ user: client.user?.tag ?? 'unknown' }, 'logged in');
}

async function runManager(config: AppConfig): Promise<void> {
  const thisFile = fileURLToPath(import.meta.url);

  const manager = new ShardingManager(thisFile, {
    token: config.discord.token,
    totalShards: config.sharding.shardTotal > 0 ? config.sharding.shardTotal : 'auto',
    mode: 'process',
    // A crashed shard is restarted by the manager rather than left dead.
    respawn: true,
  });

  manager.on('shardCreate', (shard) => {
    logger.info({ shardId: shard.id }, 'shard created');
    shard.on('death', () => logger.error({ shardId: shard.id }, 'shard died'));
    shard.on('spawn', () => logger.info({ shardId: shard.id }, 'shard spawned'));
    shard.on('ready', () => logger.info({ shardId: shard.id }, 'shard ready'));
  });

  installProcessGuards((reason, code) => {
    logger.info({ reason }, 'manager shutting down');
    process.exit(code);
  });

  await manager.spawn();
  logger.info({ shards: manager.shards.size }, 'all shards spawned');
}

async function runSingleProcess(): Promise<void> {
  const config = loadConfig();
  const container = await createContainer(config, {
    skipSchemaGate: false,
    startJobs: config.jobs.enabled,
  });

  const client = new Client(clientOptions());
  attachClientLogging(client);

  let shuttingDown = false;
  const shutdown = (reason: string, code: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ reason }, 'shutting down');

    void (async () => {
      try {
        await client.destroy();
        await container.shutdown();
      } catch (error) {
        logger.error({ err: error }, 'error during shutdown');
        code = 1;
      }
      process.exit(code);
    })();
  };

  installProcessGuards(shutdown);

  await client.login(config.discord.token);
  logger.info({ user: client.user?.tag ?? 'unknown' }, 'logged in');
}

async function main(): Promise<void> {
  const config = loadConfig();

  if (process.env.SHARD_ID !== undefined) {
    // Spawned as a shard child process by the manager.
    await runWorker();
    return;
  }

  logger.info(
    {
      env: config.env,
      cluster: config.sharding.cluster ?? 'single',
      shardTotal: config.sharding.shardTotal,
      ai: config.ai.available,
    },
    'starting redoubt',
  );

  if (config.sharding.isManager) {
    await runManager(config);
    return;
  }

  await runSingleProcess();
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'fatal startup error');
  process.exit(1);
});

export type { Container };
