/**
 * Process environment, validated once at boot with Zod (v13 §0).
 *
 * Fails fast: a missing or malformed value stops startup rather than surfacing
 * as a confusing runtime error later. AI is OPTIONAL (v13 §2) — when
 * GEMINI_API_KEY is absent the AI module disables itself cleanly and the other
 * modules operate normally.
 */

import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) =>
    typeof value === 'boolean' ? value : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase()),
  );

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // --- Discord ---
  DISCORD_TOKEN: z.string().min(50, 'DISCORD_TOKEN looks malformed'),
  DISCORD_CLIENT_ID: z.string().min(10, 'DISCORD_CLIENT_ID looks malformed'),

  // --- Database ---
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  // --- Jobs (pg-boss, PostgreSQL-backed; no Redis per v13 §1) ---
  JOBS_ENABLED: booleanish.default(true),
  JOBS_CONCURRENCY: z.coerce.number().int().positive().max(50).default(5),

  // --- Sharding (v13 §E.5 seams) ---
  SHARD_ID: z.coerce.number().int().nonnegative().optional(),
  SHARD_COUNT: z.coerce.number().int().nonnegative().default(0),
  SHARD_TOTAL: z.coerce.number().int().nonnegative().default(0),
  DISCORD_CLUSTER: z.enum(['manager', 'worker']).optional(),
  RUN_MIGRATIONS: booleanish.default(true),

  // --- AI (OPTIONAL — free tier only, v13 §2) ---
  GEMINI_API_KEY: z.string().min(1).optional(),
  AI_MODEL: z.string().default('gemini-2.5-flash'),
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(1_000),

  // --- Observability ---
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_PRETTY: booleanish.default(false),
});

export type Env = z.infer<typeof EnvSchema>;

export type AppConfig = {
  readonly env: 'development' | 'production' | 'test';
  readonly isProduction: boolean;
  readonly discord: {
    readonly token: string;
    readonly clientId: string;
  };
  readonly database: {
    readonly url: string;
    readonly poolMax: number;
    readonly statementTimeoutMs: number;
  };
  readonly jobs: {
    readonly enabled: boolean;
    readonly concurrency: number;
  };
  readonly sharding: {
    readonly shardId: number | undefined;
    readonly shardCount: number;
    readonly shardTotal: number;
    readonly cluster: 'manager' | 'worker' | undefined;
    readonly isManager: boolean;
    readonly isWorker: boolean;
    readonly isSingleProcess: boolean;
  };
  readonly ai: {
    /** False when no key is configured. AI features disable themselves. */
    readonly available: boolean;
    readonly model: string;
    readonly maxOutputTokens: number;
  };
  readonly logging: {
    readonly level: string;
    readonly pretty: boolean;
  };
  readonly runMigrations: boolean;
};

let cached: AppConfig | undefined;
let envFileLoaded = false;

/** Placeholder shipped in `.env`; never a usable token. */
export const TOKEN_PLACEHOLDER = 'YOUR_DISCORD_BOT_TOKEN_HERE';

/**
 * Loads `.env` using Node's BUILT-IN loader (Node >= 20.12).
 *
 * No `dotenv` dependency: the project already has one configuration system,
 * and adding a second would create two sources of truth for the same values.
 *
 * NON-OVERRIDING BY DESIGN. A variable already present in `process.env` is left
 * alone, so a real shell export or a test fixture always beats the file. This
 * matters concretely: `.env` ships a placeholder token, and an overriding load
 * would clobber a working value and then fail validation.
 */
export function loadEnvFile(path = '.env'): void {
  if (envFileLoaded) return;
  envFileLoaded = true;

  if (!existsSync(path)) return;

  const contents = readFileSync(path, 'utf8');
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    if (key === '' || key in process.env) continue;

    let value = line.slice(separator + 1).trim();
    // Strip a trailing inline comment only when it is clearly separated, so a
    // value containing '#' (a URL fragment, a password) survives intact.
    if (!/^["'].*["']$/.test(value)) {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    value = value.replace(/^["'](.*)["']$/, '$1');

    process.env[key] = value;
  }
}

/**
 * Pre-flight check for the Discord token.
 *
 * Runs BEFORE schema parsing so an operator sees one clear sentence rather
 * than a Zod issue list. The VALUE is never included in the message, the path
 * is never included, and nothing is logged.
 */
function assertDiscordTokenConfigured(source: NodeJS.ProcessEnv): void {
  const token = source.DISCORD_TOKEN?.trim();

  if (!token || token === TOKEN_PLACEHOLDER) {
    throw new Error(
      'DISCORD_TOKEN is not configured. Set it in your environment or in .env, then restart.',
    );
  }
}

/** Parses and caches config. Throws with an actionable message on failure. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  // Explicit callers (tests, tools) pass their own object and must not have a
  // file read pulled in underneath them.
  if (source === process.env) loadEnvFile();

  assertDiscordTokenConfigured(source);

  const parsed = EnvSchema.safeParse(source);

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }

  const value = parsed.data;
  const cluster = value.DISCORD_CLUSTER;
  const shardTotal = value.SHARD_TOTAL;

  const config: AppConfig = {
    env: value.NODE_ENV,
    isProduction: value.NODE_ENV === 'production',
    discord: {
      token: value.DISCORD_TOKEN,
      clientId: value.DISCORD_CLIENT_ID,
    },
    database: {
      url: value.DATABASE_URL,
      poolMax: value.DATABASE_POOL_MAX,
      statementTimeoutMs: value.DATABASE_STATEMENT_TIMEOUT_MS,
    },
    jobs: {
      enabled: value.JOBS_ENABLED,
      concurrency: value.JOBS_CONCURRENCY,
    },
    sharding: {
      shardId: value.SHARD_ID,
      shardCount: value.SHARD_COUNT,
      shardTotal,
      cluster,
      isManager: cluster === 'manager',
      isWorker: cluster === 'worker',
      isSingleProcess: shardTotal === 0 && cluster !== 'manager',
    },
    ai: {
      // v13 §2: AI is strictly optional. No key => no AI, but the bot runs.
      available: Boolean(value.GEMINI_API_KEY),
      model: value.AI_MODEL,
      maxOutputTokens: value.AI_MAX_OUTPUT_TOKENS,
    },
    logging: {
      level: value.LOG_LEVEL,
      pretty: value.LOG_PRETTY,
    },
    runMigrations: value.RUN_MIGRATIONS,
  };

  cached = config;
  return config;
}

/** Returns the cached config, loading it on first use. */
export function getConfig(): AppConfig {
  return cached ?? loadConfig();
}

/** Test helper: clears the cache. */
export function resetConfig(): void {
  cached = undefined;
  envFileLoaded = false;
}