/**
 * Moderation, mute/jail, and AutoMod schema.
 *
 * Two invariants encoded here rather than left to application discipline:
 *
 *  1. v12 §J.5 RE-JAIL CARRY-FORWARD — `captured_role_ids` is the AUTHORITATIVE
 *     restoration set. A re-jail must inherit it; if a re-jail re-captured,
 *     the member would only hold @Jailed at capture time and their real roles
 *     would be lost forever on release. `chain_id` groups the chain so
 *     release resolves every period in it.
 *
 *  2. v12 §J.11 OPERATION/VERSION IDENTITY — a stale expiry job (from a
 *     superseded jail) must not release a newer jail. Every expiry handler
 *     re-reads the row and verifies its own operationId is still current.
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
  uniqueIndex,
  index,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { guilds, users } from './core.js';

/** Partial-index predicate: `col = true`. Used for active-state uniqueness. */
const whereActive = (column: AnyPgColumn) => sql`${column} = true`;

export const modCaseTypeEnum = pgEnum('mod_case_type', [
  'WARN',
  'MUTE',
  'UNMUTE',
  'KICK',
  'BAN',
  'SOFTBAN',
  'JAIL',
  'UNJAIL',
  'PURGE',
]);

export const modCaseStatusEnum = pgEnum('mod_case_status', ['OPEN', 'CLOSED']);

/**
 * Numbered moderation cases. UNIQUE (guild_id, case_number) prevents two
 * concurrent punishments claiming the same case number.
 */
export const modCases = pgTable(
  'mod_cases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    caseNumber: integer('case_number').notNull(),
    type: modCaseTypeEnum('type').notNull(),
    status: modCaseStatusEnum('status').default('OPEN').notNull(),
    targetId: bigint('target_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    moderatorId: bigint('moderator_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reason: text('reason'),
    durationSeconds: integer('duration_seconds'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    numberUnique: uniqueIndex('mod_cases_guild_number_unique').on(table.guildId, table.caseNumber),
    guildIdx: index('mod_cases_guild_idx').on(table.guildId),
    targetIdx: index('mod_cases_target_idx').on(table.guildId, table.targetId),
  }),
);

export const modCaseEvidence = pgTable(
  'mod_case_evidence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => modCases.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    content: text('content'),
    url: text('url'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({ caseIdx: index('mod_case_evidence_case_idx').on(table.caseId) }),
);

export const modCaseEvents = pgTable(
  'mod_case_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => modCases.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    actorId: bigint('actor_id', { mode: 'number' }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({ caseIdx: index('mod_case_events_case_idx').on(table.caseId) }),
);

export const warnings = pgTable(
  'warnings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    caseId: uuid('case_id').references(() => modCases.id, { onDelete: 'set null' }),
    reason: text('reason'),
    active: boolean('active').default(true).notNull(),
    createdBy: bigint('created_by', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    guildUserIdx: index('warnings_guild_user_idx').on(table.guildId, table.userId),
  }),
);

export const staffNotes = pgTable(
  'staff_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    note: text('note').notNull(),
    authorId: bigint('author_id', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({ guildUserIdx: index('staff_notes_guild_user_idx').on(table.guildId, table.userId) }),
);

export const modActionLog = pgTable(
  'mod_action_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    action: text('action').notNull(),
    actorId: bigint('actor_id', { mode: 'number' }).notNull(),
    targetId: bigint('target_id', { mode: 'number' }),
    caseId: uuid('case_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({ guildIdx: index('mod_action_log_guild_idx').on(table.guildId) }),
);

export const mutes = pgTable(
  'mutes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    caseId: uuid('case_id').references(() => modCases.id, { onDelete: 'set null' }),
    reason: text('reason'),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    active: boolean('active').default(true).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdBy: bigint('created_by', { mode: 'number' }).notNull(),
  },
  (table) => ({
    // At most one active mute per member per guild.
    activeUnique: uniqueIndex('mutes_guild_user_active_unique')
      .on(table.guildId, table.userId)
      .where(whereActive(table.active)),
    expiryIdx: index('mutes_expiry_idx').on(table.active, table.expiresAt),
  }),
);

export const jailStatusEnum = pgEnum('jail_status', [
  'ACTIVE',
  'EXPIRED',
  'RELEASED',
  'RECOVERY_REQUIRED',
]);

/**
 * Active jails.
 *
 * - `captured_role_ids` is the authoritative restoration set (v12 §J.4).
 * - `chain_id` links a re-jail chain; only the EARLIEST active jail in a chain
 *   holds the real captured roles, and a re-jail inherits them rather than
 *   re-capturing (v12 §J.5).
 * - `version` lets an expiry job detect that it has been superseded.
 * - Partial unique index allows at most one ACTIVE jail per member per guild.
 */
export const jails = pgTable(
  'jails',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    caseId: uuid('case_id').references(() => modCases.id, { onDelete: 'set null' }),
    jailRoleId: bigint('jail_role_id', { mode: 'number' }),
    jailChannelId: bigint('jail_channel_id', { mode: 'number' }),
    /** Authoritative restoration set. */
    capturedRoleIds: jsonb('captured_role_ids').$type<string[]>().default([]).notNull(),
    /** Detected but NOT removed (v12 §J.6). */
    capturedManagedRoleIds: jsonb('captured_managed_role_ids').$type<string[]>().default([]).notNull(),
    /** v12 §J.8: channels still reachable after jail, from verification. */
    inaccessibleChannelIds: jsonb('inaccessible_channel_ids').$type<string[]>().default([]).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    reason: text('reason'),
    status: jailStatusEnum('status').default('ACTIVE').notNull(),
    /** Unique per jail operation; a stale job sees a mismatch and no-ops. */
    operationId: uuid('operation_id').notNull().defaultRandom(),
    version: integer('version').default(1).notNull(),
    /** Groups a re-jail chain. */
    chainId: uuid('chain_id').notNull().defaultRandom(),
    /** Set when this jail superseded an earlier one. */
    supersedesOperationId: uuid('supersedes_operation_id'),
    partialRestoreReason: text('partial_restore_reason'),
    missingRoleIds: jsonb('missing_role_ids').$type<string[]>().default([]).notNull(),
    createdBy: bigint('created_by', { mode: 'number' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // At most ONE active jail per member per guild.
    activeUnique: uniqueIndex('jails_guild_user_active_unique')
      .on(table.guildId, table.userId)
      .where(sql`${table.status} = 'ACTIVE'`),
    chainIdx: index('jails_chain_idx').on(table.chainId),
    expiryIdx: index('jails_expiry_idx').on(table.status, table.expiresAt),
  }),
);

export const blacklistEntries = pgTable(
  'blacklist_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    reason: text('reason'),
    createdBy: bigint('created_by', { mode: 'number' }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    unique: uniqueIndex('blacklist_guild_user_unique').on(table.guildId, table.userId),
  }),
);

export const purgeAudit = pgTable(
  'purge_audit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    actorId: bigint('actor_id', { mode: 'number' }).notNull(),
    channelId: bigint('channel_id', { mode: 'number' }).notNull(),
    count: integer('count').notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({ guildIdx: index('purge_audit_guild_idx').on(table.guildId) }),
);