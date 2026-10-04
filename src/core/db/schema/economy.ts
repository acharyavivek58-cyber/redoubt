/**
 * Economy and leveling schema.
 *
 * Load-bearing constraints (v13 §14):
 *  - `economy_wallets` UNIQUE (guild_id, user_id) — one wallet per member
 *  - `role_purchases` partial UNIQUE on active — ACTIVE ENTITLEMENT, not history,
 *    so a refunded purchase never blocks a legitimate re-purchase (v15)
 *  - `reward_deliveries` UNIQUE per (guild, user, source, reward) — one LOGICAL
 *    operation. Per v21 §A this is exactly-once ORCHESTRATION plus at-least-once
 *    DELIVERY, never a literal exactly-once external send.
 *  - `level_rewards_granted` UNIQUE per (guild, user, reward_id, season_id) —
 *    per REWARD, not per level, so Level 25 can grant both a role AND currency.
 *  - `level_profiles` holds CURRENT-SEASON progression; `season_leaderboards`
 *    holds FROZEN history so a rollover never destroys final standings.
 */

import {
  pgTable,
  pgEnum,
  text,
  timestamp,
  uuid,
  bigint,
  integer,
  jsonb,
  primaryKey,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { guilds, users } from './core.js';



export const transactionTypeEnum = pgEnum('economy_transaction_type', [
  'DAILY_REWARD',
  'WORK_REWARD',
  'QUEST_REWARD',
  'LEVEL_REWARD',
  'STAFF_GRANT',
  'ROLE_PURCHASE',
  'SHOP_PURCHASE',
  'USER_TRANSFER',
  'REFUND',
  'ADMIN_ADJUSTMENT',
]);

/** Per-guild currency identity. Default name is "Coins" (v13 §15). */
export const guildCurrency = pgTable('guild_currency', {
  guildId: bigint('guild_id', { mode: 'number' })
    .primaryKey()
    .references(() => guilds.id, { onDelete: 'cascade' }),
  name: text('name').default('Coins').notNull(),
  symbol: text('symbol').default('◈').notNull(),
  /** Highest value a staff grant may set without a super-staff role. */
  grantCeiling: bigint('grant_ceiling', { mode: 'number' }),
});

export const economyWallets = pgTable(
  'economy_wallets',
  {
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    balance: bigint('balance', { mode: 'number' }).default(0).notNull(),
    lifetimeEarned: bigint('lifetime_earned', { mode: 'number' }).default(0).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.guildId, table.userId] }),
    guildIdx: index('economy_wallets_guild_idx').on(table.guildId),
  }),
);

/** Append-only. balance_before/after come from the atomic debit RETURNING. */
export const economyTransactions = pgTable(
  'economy_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    type: transactionTypeEnum('type').notNull(),
    source: text('source'),
    destinationId: bigint('destination_id', { mode: 'number' }),
    referenceId: text('reference_id'),
    balanceBefore: bigint('balance_before', { mode: 'number' }).notNull(),
    balanceAfter: bigint('balance_after', { mode: 'number' }).notNull(),
    actorId: bigint('actor_id', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    guildUserIdx: index('economy_tx_guild_user_idx').on(table.guildId, table.userId),
    typeIdx: index('economy_tx_type_idx').on(table.type),
  }),
);

export const economyItems = pgTable(
  'economy_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // ROLE | COSMETIC | CONSUMABLE
    roleId: bigint('role_id', { mode: 'number' }),
    name: text('name').notNull(),
    description: text('description'),
    icon: text('icon'),
  },
  (table) => ({ guildIdx: index('economy_items_guild_idx').on(table.guildId) }),
);

export const economyShopItems = pgTable(
  'economy_shop_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => economyItems.id, { onDelete: 'cascade' }),
    price: bigint('price', { mode: 'number' }).notNull(),
    description: text('description'),
    groupName: text('group_name'),
    stock: integer('stock'),
    cooldownSeconds: integer('cooldown_seconds'),
    maxPurchases: integer('max_purchases'),
    /** Null = permanent. Non-null schedules an idempotent expiry job. */
    durationSeconds: integer('duration_seconds'),
    repeatPurchasable: integer('repeat_purchasable').default(0).notNull(),
    active: integer('active').default(1).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    guildIdx: index('economy_shop_items_guild_idx').on(table.guildId, table.active),
    itemIdx: index('economy_shop_items_item_idx').on(table.itemId),
  }),
);

/** Immutable purchase HISTORY. Deliberately no uniqueness that could block a re-purchase. */
export const economyPurchases = pgTable(
  'economy_purchases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    shopItemId: uuid('shop_item_id')
      .notNull()
      .references(() => economyShopItems.id, { onDelete: 'cascade' }),
    transactionId: uuid('transaction_id'),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    status: text('status').default('PENDING').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => ({
    pendingIdx: index('economy_purchases_pending_idx').on(table.status),
    guildUserIdx: index('economy_purchases_guild_user_idx').on(table.guildId, table.userId),
  }),
);

/**
 * ACTIVE ROLE ENTITLEMENTS — the uniqueness anchor for "do not already own it".
 *
 * A refund sets active=false, which releases the partial unique index and
 * permits a legitimate re-purchase while purchase history is preserved.
 */
export const rolePurchases = pgTable(
  'role_purchases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => economyItems.id, { onDelete: 'cascade' }),
    roleId: bigint('role_id', { mode: 'number' }),
    acquiredAt: timestamp('acquired_at', { withTimezone: true }).defaultNow().notNull(),
    /** Null = permanent; non-null schedules expiry (v15 §A.8). */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    active: integer('active').default(1).notNull(),
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
    deactivatedReason: text('deactivated_reason'),
    sourcePurchaseId: uuid('source_purchase_id'),
  },
  (table) => ({
    activeUnique: uniqueIndex('role_purchases_active_unique')
      .on(table.guildId, table.userId, table.itemId)
      .where(sql`${table.active} = 1`),
    expiryIdx: index('role_purchases_expiry_idx').on(table.active, table.expiresAt),
  }),
);

export const economyRecoveryEvents = pgTable(
  'economy_recovery_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purchaseId: uuid('purchase_id'),
    transactionId: uuid('transaction_id'),
    shopItemId: uuid('shop_item_id'),
    failureType: text('failure_type').notNull(),
    attemptCount: integer('attempt_count').default(0).notNull(),
    status: text('status').default('OPEN').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
    originalAmount: bigint('original_amount', { mode: 'number' }),
    compensatedAmount: bigint('compensated_amount', { mode: 'number' }),
    resolution: text('resolution'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => ({
    openIdx: index('economy_recovery_open_idx').on(table.status),
    guildIdx: index('economy_recovery_guild_idx').on(table.guildId),
  }),
);

export const economyQuests = pgTable(
  'economy_quests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    reward: bigint('reward', { mode: 'number' }).notNull(),
    period: text('period').default('ONCE').notNull(),
    active: integer('active').default(1).notNull(),
  },
  (table) => ({ guildIdx: index('economy_quests_guild_idx').on(table.guildId) }),
);

export const economyQuestProgress = pgTable(
  'economy_quest_progress',
  {
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    questId: uuid('quest_id')
      .notNull()
      .references(() => economyQuests.id, { onDelete: 'cascade' }),
    periodKey: text('period_key').notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.guildId, table.userId, table.questId, table.periodKey] }),
  }),
);

export const economyDailyClaims = pgTable(
  'economy_daily_claims',
  {
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    claimDate: text('claim_date').notNull(), // YYYY-MM-DD
    streak: integer('streak').default(1).notNull(),
    reward: bigint('reward', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // The DB-level guarantee against duplicate daily claims.
    pk: primaryKey({ columns: [table.guildId, table.userId, table.claimDate] }),
  }),
);

export const economyWorkCooldowns = pgTable(
  'economy_work_cooldowns',
  {
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    lastWorkedAt: timestamp('last_worked_at', { withTimezone: true }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.guildId, table.userId] }),
  }),
);

export const economyInventory = pgTable(
  'economy_inventory',
  {
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => economyItems.id, { onDelete: 'cascade' }),
    quantity: integer('quantity').default(1).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.guildId, table.userId, table.itemId] }),
  }),
);

export const rewardSourceEnum = pgEnum('reward_source', [
  'LEVEL',
  'INVITE',
  'GIVEAWAY',
  'APPLICATION',
  'SHOP',
]);

export const rewardTypeEnum = pgEnum('reward_type', ['CURRENCY', 'ROLE', 'ITEM']);

export const rewardStatusEnum = pgEnum('reward_status', [
  'PENDING',
  'DELIVERED',
  'FAILED',
  'RECOVERING',
  'FAILED_FINAL',
  'BLOCKED',
]);

/**
 * UNIFIED reward delivery (v17 §W.16).
 *
 * One logical delivery operation per (guild, user, source, reward). Per v21 §A
 * this guarantees exactly-once ORCHESTRATION; the Discord send itself is
 * at-least-once with durable idempotency, NOT a literal exactly-once.
 */
export const rewardDeliveries = pgTable(
  'reward_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    source: rewardSourceEnum('source').notNull(),
    sourceId: uuid('source_id').notNull(),
    rewardId: uuid('reward_id').notNull(),
    rewardType: rewardTypeEnum('reward_type').notNull(),
    amount: bigint('amount', { mode: 'number' }),
    roleId: bigint('role_id', { mode: 'number' }),
    status: rewardStatusEnum('status').default('PENDING').notNull(),
    attempts: integer('attempts').default(0).notNull(),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (table) => ({
    unique: uniqueIndex('reward_deliveries_unique').on(
      table.guildId,
      table.userId,
      table.source,
      table.sourceId,
      table.rewardId,
    ),
    statusIdx: index('reward_deliveries_status_idx').on(table.status),
  }),
);

export const seasonStatusEnum = pgEnum('season_status', ['ACTIVE', 'FINALIZED', 'ARCHIVED']);

/** v13 §16: CURRENT-SEASON progression only. `lifetime_xp` never resets. */
export const levelProfiles = pgTable(
  'level_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    seasonId: uuid('season_id').notNull(),
    seasonXp: bigint('season_xp', { mode: 'number' }).default(0).notNull(),
    level: integer('level').default(0).notNull(),
    xpInLevel: integer('xp_in_level').default(0).notNull(),
    lifetimeXp: bigint('lifetime_xp', { mode: 'number' }).default(0).notNull(),
    lastXpAt: timestamp('last_xp_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    unique: uniqueIndex('level_profiles_unique').on(table.guildId, table.userId, table.seasonId),
    guildIdx: index('level_profiles_guild_idx').on(table.guildId, table.seasonId),
  }),
);

export const levelEvents = pgTable(
  'level_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' }).notNull(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    seasonId: uuid('season_id').notNull(),
    amount: integer('amount').notNull(),
    source: text('source').notNull(),
    channelId: bigint('channel_id', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    userIdx: index('level_events_user_idx').on(table.guildId, table.userId),
  }),
);

export const levelRewards = pgTable(
  'level_rewards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    level: integer('level').notNull(),
    type: rewardTypeEnum('type').notNull(),
    roleId: bigint('role_id', { mode: 'number' }),
    amount: bigint('amount', { mode: 'number' }),
    itemId: uuid('item_id'),
    icon: text('icon'),
    description: text('description'),
    active: integer('active').default(1).notNull(),
  },
  (table) => ({
    levelIdx: index('level_rewards_level_idx').on(table.guildId, table.level),
  }),
);

/**
 * Per-REWARD delivery record (v15).
 *
 * UNIQUE per (guild, user, reward_id, season_id) — NOT per level — so a level
 * granting BOTH a role and currency delivers each exactly once independently,
 * and one failing reward never blocks the other.
 */
export const levelRewardsGranted = pgTable(
  'level_rewards_granted',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' }).notNull(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    rewardId: uuid('reward_id')
      .notNull()
      .references(() => levelRewards.id, { onDelete: 'cascade' }),
    seasonId: uuid('season_id').notNull(),
    status: rewardStatusEnum('status').default('PENDING').notNull(),
    attempts: integer('attempts').default(0).notNull(),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (table) => ({
    unique: uniqueIndex('level_rewards_granted_unique').on(
      table.guildId,
      table.userId,
      table.rewardId,
      table.seasonId,
    ),
    statusIdx: index('level_rewards_granted_status_idx').on(table.status),
  }),
);

export const levelRewardRecoveryEvents = pgTable(
  'level_reward_recovery_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    grantId: uuid('grant_id')
      .notNull()
      .references(() => levelRewardsGranted.id, { onDelete: 'cascade' }),
    guildId: bigint('guild_id', { mode: 'number' }).notNull(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    rewardId: uuid('reward_id').notNull(),
    rewardType: rewardTypeEnum('reward_type').notNull(),
    failureType: text('failure_type').notNull(),
    attemptCount: integer('attempt_count').default(0).notNull(),
    status: text('status').default('OPEN').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
    resolution: text('resolution'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => ({ openIdx: index('level_reward_recovery_open_idx').on(table.status) }),
);

export const seasons = pgTable(
  'seasons',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).defaultNow().notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    status: seasonStatusEnum('status').default('ACTIVE').notNull(),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
  },
  (table) => ({ activeIdx: index('seasons_active_idx').on(table.guildId, table.status) }),
);

/** FROZEN final standings, written BEFORE a rollover resets anything. */
export const seasonLeaderboards = pgTable(
  'season_leaderboards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    seasonId: uuid('season_id')
      .notNull()
      .references(() => seasons.id, { onDelete: 'cascade' }),
    guildId: bigint('guild_id', { mode: 'number' }).notNull(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    finalRank: integer('final_rank').notNull(),
    finalXp: bigint('final_xp', { mode: 'number' }).notNull(),
    finalLevel: integer('final_level').notNull(),
    rewardsGranted: jsonb('rewards_granted').$type<Record<string, unknown>>().default({}).notNull(),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    unique: uniqueIndex('season_leaderboards_unique').on(table.seasonId, table.userId),
    rankIdx: index('season_leaderboards_rank_idx').on(table.seasonId, table.finalRank),
  }),
);

export const levelSettings = pgTable('level_settings', {
  guildId: bigint('guild_id', { mode: 'number' })
    .primaryKey()
    .references(() => guilds.id, { onDelete: 'cascade' }),
  curve: text('curve').default('LINEAR').notNull(),
  curveParams: jsonb('curve_params').$type<Record<string, number>>().default({}).notNull(),
  minMessageLength: integer('min_message_length').default(12).notNull(),
  minIntervalSeconds: integer('min_interval_seconds').default(20).notNull(),
  perMessageClamp: integer('per_message_clamp').default(25).notNull(),
  rateCapMinutes: integer('rate_cap_minutes').default(30).notNull(),
  rateCapXp: integer('rate_cap_xp').default(200).notNull(),
  startingLevel: integer('starting_level').default(0).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});