/**
 * Core schema: guilds, modules, users, members, prefixes, jobs.
 *
 * v13 §14: every guild-scoped table is indexed on guild_id, and UNIQUE
 * constraints are the CONCURRENCY CONTROL — load-bearing, not decoration.
 */

import {
  pgTable,
  pgEnum,
  text,
  timestamp,
  uuid,
  bigint,
  boolean,
  integer,
  jsonb,
  primaryKey,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

export const moduleNameEnum = pgEnum('module_name', [
  'moderation',
  'automod',
  'security',
  'tickets',
  'giveaways',
  'applications',
  'reports',
  'appeals',
  'roles',
  'temporaryVoice',
  'leveling',
  'economy',
  'welcome',
  'inviteRewards',
  'honeypot',
  'logging',
  'ai',
  'utility',
  'afk',
]);

export const guilds = pgTable('guilds', {
  id: bigint('id', { mode: 'number' }).primaryKey(),
  name: text('name').notNull(),
  ownerId: bigint('owner_id', { mode: 'number' }).notNull(),
  locale: text('locale').default('en-US'),
  shard: integer('shard'),
  active: boolean('active').default(true).notNull(),
  joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/** v13 §3: default prefix is `$`. Per-guild, UNIQUE on guild_id. */
export const prefixes = pgTable(
  'prefixes',
  {
    guildId: bigint('guild_id', { mode: 'number' })
      .primaryKey()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    prefix: text('prefix').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // Redundant with the PK but documents the invariant explicitly and makes
    // the one-prefix-per-guild rule greppable.
    guildUnique: uniqueIndex('prefixes_guild_unique').on(table.guildId),
  }),
);

export const guildModules = pgTable(
  'guild_modules',
  {
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    module: moduleNameEnum('module').notNull(),
    enabled: boolean('enabled').default(false).notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().default({}).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.guildId, table.module] }),
  }),
);

export const guildSettings = pgTable('guild_settings', {
  guildId: bigint('guild_id', { mode: 'number' })
    .primaryKey()
    .references(() => guilds.id, { onDelete: 'cascade' }),
  accent: text('accent').default('azure').notNull(),
  serverIconUrl: text('server_icon_url'),
  data: jsonb('data').$type<Record<string, unknown>>().default({}).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const users = pgTable('users', {
  id: bigint('id', { mode: 'number' }).primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
});

export const guildMembers = pgTable(
  'guild_members',
  {
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.guildId, table.userId] }),
    guildIdx: index('guild_members_guild_idx').on(table.guildId),
  }),
);

/**
 * Idempotency ledger for pg-boss handlers (v13 §11).
 *
 * UNIQUE (job_name, idempotency_key) is what makes re-delivery a safe no-op —
 * the constraint, not counting logic, is the guarantee.
 */
export const jobRuns = pgTable(
  'job_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobName: text('job_name').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status').notNull().default('RUNNING'),
    attempts: integer('attempts').default(1).notNull(),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => ({
    unique: uniqueIndex('job_runs_name_key_unique').on(table.jobName, table.idempotencyKey),
    statusIdx: index('job_runs_status_idx').on(table.status),
  }),
);

/**
 * Migration gate (v13 §7): workers poll for a row here before starting, so no
 * worker ever boots against a half-migrated schema.
 */
export const schemaMigrations = pgTable('schema_migrations', {
  version: text('version').primaryKey(),
  appliedAt: timestamp('applied_at', { withTimezone: true }).defaultNow().notNull(),
});

export const i18nStrings = pgTable(
  'i18n_strings',
  {
    locale: text('locale').notNull(),
    key: text('key').notNull(),
    value: text('value').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.locale, table.key] }),
  }),
);