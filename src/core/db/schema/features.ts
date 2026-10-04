/**
 * Tickets, invites, AFK, giveaways, roles, logging, AutoMod, backup/templates.
 *
 * Two constraint patterns worth noting:
 *  - v21 §B: composite (guild_id, afk_period_id) uniqueness plus composite FKs
 *    so an artifact can NEVER reference another guild's AFK period.
 *  - v14 §15: `operations` records initiating_owner_id (informational) and
 *    current_executor_id separately — authorization always uses the CURRENT
 *    guild owner, never the recorded creator.
 */

import {
  pgTable,
  pgEnum,
  text,
  timestamp,
  uuid,
  bigint,
  integer,
  boolean,
  jsonb,
  primaryKey,
  uniqueIndex,
  index,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { guilds, users } from './core.js';

/**
 * Partial-index predicate: `col = 'VALUE'`.
 *
 * The value is INLINED, not parameterized: PostgreSQL index predicates require
 * a literal, and a bind parameter (`$1`) is invalid there. Callers pass
 * internal constants only — never user input.
 */
const enumEq = (column: AnyPgColumn, value: string) =>
  sql`${column} = '${sql.raw(value)}'`;

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

export const ticketStateEnum = pgEnum('ticket_state', [
  'OPEN',
  'CLAIMED',
  'WAITING_FOR_USER',
  'WAITING_FOR_STAFF',
  'CLOSED',
  'REOPENED',
]);

export const ticketPriorityEnum = pgEnum('ticket_priority', ['LOW', 'NORMAL', 'HIGH', 'URGENT']);

export const tickets = pgTable(
  'tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    ticketTypeId: uuid('ticket_type_id'),
    channelId: bigint('channel_id', { mode: 'number' }).notNull(),
    requesterId: bigint('requester_id', { mode: 'number' }).notNull(),
    categoryId: bigint('category_id', { mode: 'number' }),
    state: ticketStateEnum('state').default('OPEN').notNull(),
    priority: ticketPriorityEnum('priority').default('NORMAL').notNull(),
    assignedTo: bigint('assigned_to', { mode: 'number' }),
    subject: text('subject'),
    formAnswers: jsonb('form_answers').$type<Record<string, unknown>>().default({}).notNull(),
    slaDueAt: timestamp('sla_due_at', { withTimezone: true }),
    satisfaction: integer('satisfaction'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closeReason: text('close_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    channelUnique: uniqueIndex('tickets_channel_unique').on(table.guildId, table.channelId),
    guildStateIdx: index('tickets_guild_state_idx').on(table.guildId, table.state),
    requesterIdx: index('tickets_requester_idx').on(table.guildId, table.requesterId),
  }),
);

export const ticketTypes = pgTable(
  'ticket_types',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    categoryId: bigint('category_id', { mode: 'number' }),
    staffRoleIds: jsonb('staff_role_ids').$type<string[]>().default([]).notNull(),
    formId: uuid('form_id'),
    slaMinutes: integer('sla_minutes'),
    active: boolean('active').default(true).notNull(),
  },
  (table) => ({ guildIdx: index('ticket_types_guild_idx').on(table.guildId) }),
);

export const ticketPanels = pgTable(
  'ticket_panels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    channelId: bigint('channel_id', { mode: 'number' }).notNull(),
    messageId: bigint('message_id', { mode: 'number' }),
    typeIds: jsonb('type_ids').$type<string[]>().default([]).notNull(),
    active: boolean('active').default(true).notNull(),
  },
  (table) => ({
    channelUnique: uniqueIndex('ticket_panels_channel_unique').on(table.guildId, table.channelId),
  }),
);

export const ticketMembers = pgTable(
  'ticket_members',
  {
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    isStaff: boolean('is_staff').default(false).notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.ticketId, table.userId] }) }),
);

export const ticketNotes = pgTable(
  'ticket_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    authorId: bigint('author_id', { mode: 'number' }).notNull(),
    note: text('note').notNull(),
    internal: boolean('internal').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({ ticketIdx: index('ticket_notes_ticket_idx').on(table.ticketId) }),
);

/**
 * Rule-driven auto-replies (v13 §11). NEVER Gemini-dependent: ordinary ticket
 * instructions must work from config alone.
 */
export const ticketAutoReplies = pgTable(
  'ticket_auto_replies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    ticketTypeId: uuid('ticket_type_id'),
    matchType: text('match_type').notNull(), // EXACT | KEYWORD | TYPE
    pattern: text('pattern').notNull(),
    reply: text('reply').notNull(),
    channelIds: jsonb('channel_ids').$type<string[]>().default([]).notNull(),
    cooldownSeconds: integer('cooldown_seconds'),
    maxPerTicket: integer('max_per_ticket').default(1).notNull(),
    active: boolean('active').default(true).notNull(),
  },
  (table) => ({ guildIdx: index('ticket_auto_replies_guild_idx').on(table.guildId) }),
);

/** Advisory-only AI output, deliberately separate from staff decisions (v13 §11). */
export const ticketAiReplies = pgTable(
  'ticket_ai_replies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    model: text('model'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({ ticketIdx: index('ticket_ai_replies_ticket_idx').on(table.ticketId) }),
);

// ---------------------------------------------------------------------------
// Invite tracking (v17)
// ---------------------------------------------------------------------------

export const attributionStateEnum = pgEnum('attribution_state', [
  'CONFIRMED',
  'PROBABLE',
  'UNKNOWN',
  'UNAVAILABLE',
]);

export const inviteJoins = pgTable(
  'invite_joins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    inviteCode: text('invite_code'),
    inviterId: bigint('inviter_id', { mode: 'number' }),
    attribution: attributionStateEnum('attribution').default('UNKNOWN').notNull(),
    source: text('source').default('NORMAL').notNull(),
    isBot: boolean('is_bot').default(false).notNull(),
    isRejoin: boolean('is_rejoin').default(false).notNull(),
    eligible: boolean('eligible').default(false).notNull(),
    joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
    leftAt: timestamp('left_at', { withTimezone: true }),
  },
  (table) => ({
    guildIdx: index('invite_joins_guild_idx').on(table.guildId, table.joinedAt),
    inviterIdx: index('invite_joins_inviter_idx').on(table.guildId, table.inviterId),
  }),
);

export const inviteSnapshots = pgTable(
  'invite_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    inviteCode: text('invite_code').notNull(),
    channelId: bigint('channel_id', { mode: 'number' }),
    inviterId: bigint('inviter_id', { mode: 'number' }),
    uses: integer('uses').default(0).notNull(),
    maxUses: integer('max_uses'),
    temporary: boolean('temporary').default(false).notNull(),
    snapshotAt: timestamp('snapshot_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    codeIdx: uniqueIndex('invite_snapshots_code_unique').on(table.guildId, table.inviteCode),
  }),
);

export const inviteCounters = pgTable(
  'invite_counters',
  {
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    inviterId: bigint('inviter_id', { mode: 'number' }).notNull(),
    total: integer('total').default(0).notNull(),
    current: integer('current').default(0).notNull(),
    left: integer('left').default(0).notNull(),
    rejoins: integer('rejoins').default(0).notNull(),
    ineligible: integer('ineligible').default(0).notNull(),
    rewardEligible: integer('reward_eligible').default(0).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.guildId, table.inviterId] }) }),
);

export const inviteRewardRules = pgTable(
  'invite_reward_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    threshold: integer('threshold').notNull(),
    rewardType: text('reward_type').notNull(),
    roleId: bigint('role_id', { mode: 'number' }),
    amount: bigint('amount', { mode: 'number' }),
    itemId: uuid('item_id'),
    active: boolean('active').default(true).notNull(),
  },
  (table) => ({ guildIdx: index('invite_reward_rules_guild_idx').on(table.guildId) }),
);

// ---------------------------------------------------------------------------
// AFK (v18-v21)
// ---------------------------------------------------------------------------

export const afkStatusEnum = pgEnum('afk_status', ['CLEAR', 'AFK']);
export const afkPeriodStatusEnum = pgEnum('afk_period_status', [
  'ACTIVE',
  'RETURNED',
  'FINALIZED',
]);

/**
 * `afk_period_id` is UNIQUE globally (v21 §4) AND uniqee per
 * (guild_id, afk_period_id) so cross-guild association is impossible.
 */
export const afkStatus = pgTable(
  'afk_status',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    afkPeriodId: uuid('afk_period_id').notNull().defaultRandom(),
    /** PRIVATE content — excluded from logs/analytics at the repository layer. */
    message: text('message'),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    status: afkStatusEnum('status').default('CLEAR').notNull(),
    periodStatus: afkPeriodStatusEnum('period_status').default('FINALIZED').notNull(),
    returnedAt: timestamp('returned_at', { withTimezone: true }),
    clearedAt: timestamp('cleared_at', { withTimezone: true }),
    clearedBy: bigint('cleared_by', { mode: 'number' }),
    clearReason: text('clear_reason'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // v21 §4: period ids are globally unique and guild-scoped.
    periodUnique: uniqueIndex('afk_status_period_unique').on(table.afkPeriodId),
    guildPeriodUnique: uniqueIndex('afk_status_guild_period_unique').on(
      table.guildId,
      table.afkPeriodId,
    ),
    // At most one ACTIVE AFK per member per guild.
    activeUnique: uniqueIndex('afk_status_active_unique')
      .on(table.guildId, table.userId)
      .where(enumEq(table.status, 'AFK')),
    hotIdx: index('afk_status_hot_idx').on(table.guildId, table.userId, table.status),
  }),
);

export const afkDeliveryStatusEnum = pgEnum('afk_delivery_status', [
  'PENDING',
  'DELIVERED',
  'FAILED',
]);

export const afkMessages = pgTable(
  'afk_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' }).notNull(),
    afkUserId: bigint('afk_user_id', { mode: 'number' }).notNull(),
    /** Composite identity prevents cross-guild period association (v21 §4). */
    afkPeriodId: uuid('afk_period_id').notNull(),
    senderId: bigint('sender_id', { mode: 'number' }).notNull(),
    /** PRIVATE — never surfaced in public channels or general logs. */
    message: text('message').notNull(),
    deliveryStatus: afkDeliveryStatusEnum('delivery_status').default('PENDING').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (table) => ({
    pendingIdx: index('afk_messages_pending_idx')
      .on(table.guildId, table.afkPeriodId)
      .where(enumEq(table.deliveryStatus, 'PENDING')),
  }),
);

export const afkBackNotificationStatusEnum = pgEnum('afk_notification_status', [
  'ACTIVE',
  'NOTIFIED',
  'CANCELLED',
  'FAILED',
]);

export const afkBackNotifications = pgTable(
  'afk_back_notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' }).notNull(),
    afkUserId: bigint('afk_user_id', { mode: 'number' }).notNull(),
    subscriberId: bigint('subscriber_id', { mode: 'number' }).notNull(),
    afkPeriodId: uuid('afk_period_id').notNull(),
    status: afkBackNotificationStatusEnum('status').default('ACTIVE').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
  },
  (table) => ({
    // Repeated button presses are idempotent BY CONSTRUCTION (v19 §Y.6).
    unique: uniqueIndex('afk_back_notifications_unique').on(
      table.guildId,
      table.afkUserId,
      table.subscriberId,
      table.afkPeriodId,
    ),
    activeIdx: index('afk_back_notifications_active_idx')
      .on(table.guildId, table.afkPeriodId)
      .where(enumEq(table.status, 'ACTIVE')),
  }),
);

export const afkReturnActionStatusEnum = pgEnum('afk_return_action_status', [
  'PENDING',
  'PROCESSING',
  'DELIVERED',
  'FAILED',
  'FAILED_FINAL',
]);

/** Durable post-return operation identity (v21 §2). */
export const afkReturnActions = pgTable(
  'afk_return_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' }).notNull(),
    afkPeriodId: uuid('afk_period_id').notNull(),
    actionType: text('action_type').default('RETURN_ANNOUNCEMENT').notNull(),
    status: afkReturnActionStatusEnum('status').default('PENDING').notNull(),
    attempts: integer('attempts').default(0).notNull(),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => ({
    // No duplicate logical operation rows, ever.
    unique: uniqueIndex('afk_return_actions_unique').on(
      table.guildId,
      table.afkPeriodId,
      table.actionType,
    ),
    recoveryIdx: index('afk_return_actions_recovery_idx').on(table.status),
  }),
);

export const afkSettings = pgTable('afk_settings', {
  guildId: bigint('guild_id', { mode: 'number' })
    .primaryKey()
    .references(() => guilds.id, { onDelete: 'cascade' }),
  defaultMessage: text('default_message').default('Away from keyboard').notNull(),
  noticesEnabled: boolean('notices_enabled').default(true).notNull(),
  returnAnnouncementEnabled: boolean('return_announcement_enabled').default(false).notNull(),
  returnAnnouncementChannelId: bigint('return_announcement_channel_id', { mode: 'number' }),
  showReason: boolean('show_reason').default(true).notNull(),
  leaveMessageEnabled: boolean('leave_message_enabled').default(true).notNull(),
  backNotificationEnabled: boolean('back_notification_enabled').default(true).notNull(),
  noticeCooldownSeconds: integer('notice_cooldown_seconds').default(30).notNull(),
});

export const afkIgnoredChannels = pgTable(
  'afk_ignored_channels',
  {
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    channelId: bigint('channel_id', { mode: 'number' }).notNull(),
    /** Default true: own message still clears AFK in an ignored channel. */
    clearsOwnAfk: boolean('clears_own_afk').default(true).notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.guildId, table.channelId] }) }),
);

// ---------------------------------------------------------------------------
// Giveaways
// ---------------------------------------------------------------------------

export const giveaways = pgTable(
  'giveaways',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    channelId: bigint('channel_id', { mode: 'number' }).notNull(),
    messageId: bigint('message_id', { mode: 'number' }),
    prize: text('prize').notNull(),
    winnerCount: integer('winner_count').default(1).notNull(),
    minimumRoleId: bigint('minimum_role_id', { mode: 'number' }),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    status: text('status').default('ACTIVE').notNull(),
    createdBy: bigint('created_by', { mode: 'number' }).notNull(),
  },
  (table) => ({ guildIdx: index('giveaways_guild_idx').on(table.guildId, table.status) }),
);

export const giveawayEntries = pgTable(
  'giveaway_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    giveawayId: uuid('giveaway_id')
      .notNull()
      .references(() => giveaways.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    entryCount: integer('entry_count').default(1).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({ unique: uniqueIndex('giveaway_entries_unique').on(table.giveawayId, table.userId) }),
);

/** Persisted CSPRNG draw results for auditability (v13 §12). */
export const giveawayRerolls = pgTable(
  'giveaway_rerolls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    giveawayId: uuid('giveaway_id')
      .notNull()
      .references(() => giveaways.id, { onDelete: 'cascade' }),
    winnerIds: jsonb('winner_ids').$type<string[]>().default([]).notNull(),
    entryCount: integer('entry_count').notNull(),
    actorId: bigint('actor_id', { mode: 'number' }),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({ giveawayIdx: index('giveaway_rerolls_giveaway_idx').on(table.giveawayId) }),
);

/**
 * Claims are ALWAYS staff-authorized (v13 §12).
 *
 * `recommendedOutcome` is informational and may be produced by rules or AI;
 * only `staffDecision` + `decidedBy` records a human decision. Automated
 * systems must never finalize a claim.
 */
export const giveawayClaims = pgTable(
  'giveaway_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    giveawayId: uuid('giveaway_id')
      .notNull()
      .references(() => giveaways.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    evidence: text('evidence'),
    recommendedOutcome: text('recommended_outcome'),
    staffDecision: text('staff_decision'),
    decidedBy: bigint('decided_by', { mode: 'number' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    unique: uniqueIndex('giveaway_claims_unique').on(table.giveawayId, table.userId),
    pendingIdx: index('giveaway_claims_pending_idx')
      .on(table.giveawayId)
      .where(sql`${table.staffDecision} IS NULL`),
  }),
);

// ---------------------------------------------------------------------------
// Roles (self-assign only — no autorole)
// ---------------------------------------------------------------------------

export const rolePanels = pgTable(
  'role_panels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    channelId: bigint('channel_id', { mode: 'number' }).notNull(),
    messageId: bigint('message_id', { mode: 'number' }),
    title: text('title'),
    active: boolean('active').default(true).notNull(),
  },
  (table) => ({
    channelUnique: uniqueIndex('role_panels_channel_unique').on(table.guildId, table.channelId),
  }),
);

export const rolePanelOptions = pgTable(
  'role_panel_options',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    panelId: uuid('panel_id')
      .notNull()
      .references(() => rolePanels.id, { onDelete: 'cascade' }),
    roleId: bigint('role_id', { mode: 'number' }).notNull(),
    label: text('label').notNull(),
    emoji: text('emoji'),
    groupName: text('group_name'),
    removable: boolean('removable').default(true).notNull(),
  },
  (table) => ({ panelIdx: index('role_panel_options_panel_idx').on(table.panelId) }),
);

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export const logChannels = pgTable(
  'log_channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    channelId: bigint('channel_id', { mode: 'number' }).notNull(),
    enabled: boolean('enabled').default(true).notNull(),
  },
  (table) => ({
    unique: uniqueIndex('log_channels_event_unique').on(table.guildId, table.eventType),
  }),
);

export const logSettings = pgTable('log_settings', {
  guildId: bigint('guild_id', { mode: 'number' })
    .primaryKey()
    .references(() => guilds.id, { onDelete: 'cascade' }),
  ignoredRoleIds: jsonb('ignored_role_ids').$type<string[]>().default([]).notNull(),
  ignoredChannelIds: jsonb('ignored_channel_ids').$type<string[]>().default([]).notNull(),
  ignoredUserIds: jsonb('ignored_user_ids').$type<string[]>().default([]).notNull(),
  retentionDays: integer('retention_days').default(30),
});

// ---------------------------------------------------------------------------
// AutoMod (v14-v16)
// ---------------------------------------------------------------------------

export const confidenceEnum = pgEnum('confidence', ['HIGH', 'MEDIUM', 'LOW']);
export const automodModeEnum = pgEnum('automod_mode', ['ACTIVE', 'DRY_RUN', 'DISABLED']);
export const decayModeEnum = pgEnum('strike_decay_mode', [
  'NONE',
  'FIXED_WINDOW',
  'ROLLING_WINDOW',
]);

export const automodRules = pgTable(
  'automod_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    triggerType: text('trigger_type').notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().default({}).notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    mode: automodModeEnum('mode').default('ACTIVE').notNull(),
    minConfidence: confidenceEnum('min_confidence').default('MEDIUM').notNull(),
    /** Bounded ladder; MAX rung is always MUTE (v16 §T.4). */
    escalation: jsonb('escalation').$type<unknown[]>().default([]).notNull(),
    ruleAware: boolean('rule_aware').default(true).notNull(),
    strikeDecayMode: decayModeEnum('strike_decay_mode').default('ROLLING_WINDOW').notNull(),
    windowSeconds: integer('window_seconds').default(1800),
    decaySeconds: integer('decay_seconds'),
    /** ERROR disables enforcement entirely (v16 §T.3). */
    actionState: text('action_state').default('OK').notNull(),
    errorReason: text('error_reason'),
    createdBy: bigint('created_by', { mode: 'number' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({ guildIdx: index('automod_rules_guild_idx').on(table.guildId) }),
);

export const automodEvents = pgTable(
  'automod_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' }).notNull(),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => automodRules.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    channelId: bigint('channel_id', { mode: 'number' }),
    messageId: bigint('message_id', { mode: 'number' }),
    confidence: confidenceEnum('confidence').notNull(),
    severity: integer('severity').default(1).notNull(),
    matchSource: text('match_source').default('ORIGINAL').notNull(),
    context: jsonb('context').$type<Record<string, unknown>>().default({}).notNull(),
    /** null in DRY_RUN and TEST mode (v14 §R.18). */
    actionTaken: text('action_taken'),
    wouldHave: text('would_have'),
    result: text('result').notNull(),
    ruleVersion: integer('rule_version').default(1).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    ruleIdx: index('automod_events_rule_idx').on(table.guildId, table.ruleId, table.createdAt),
    userIdx: index('automod_events_user_idx').on(table.guildId, table.userId, table.createdAt),
  }),
);

export const automodStrikes = pgTable(
  'automod_strikes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' }).notNull(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    ruleId: uuid('rule_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    decayMode: decayModeEnum('decay_mode').default('ROLLING_WINDOW').notNull(),
    windowSeconds: integer('window_seconds').default(1800),
    active: boolean('active').default(true).notNull(),
    ruleAware: boolean('rule_aware').default(true).notNull(),
    escalationLevel: integer('escalation_level').default(0).notNull(),
    actionApplied: text('action_applied'),
    caseId: uuid('case_id'),
    /** Set by reconciliation; the ROW IS NEVER DELETED (v15 §R.22.11). */
    expiredAt: timestamp('expired_at', { withTimezone: true }),
  },
  (table) => ({
    escalateIdx: index('automod_strikes_escalate_idx').on(table.guildId, table.userId, table.ruleId),
  }),
);

// ---------------------------------------------------------------------------
// Policies (centralized exclusion engine, v13 §7.2)
// ---------------------------------------------------------------------------

export const policySubjectEnum = pgEnum('policy_subject', ['USER', 'ROLE', 'CHANNEL', 'CATEGORY']);
export const policyEffectEnum = pgEnum('policy_effect', ['SKIP', 'QUIET', 'ALLOW']);

export const policies = pgTable(
  'policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    domain: text('domain').notNull(), // AUTOMOD | LEVELING | INVITES | LOGGING | ECONOMY
    enabled: boolean('enabled').default(true).notNull(),
    createdBy: bigint('created_by', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({ domainIdx: index('policies_guild_domain_idx').on(table.guildId, table.domain) }),
);

export const policyRules = pgTable(
  'policy_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    policyId: uuid('policy_id')
      .notNull()
      .references(() => policies.id, { onDelete: 'cascade' }),
    subject: policySubjectEnum('subject').notNull(),
    subjectId: text('subject_id').notNull(),
    /** NULL = applies to all rules in the policy's domain. */
    ruleScope: text('rule_scope'),
    effect: policyEffectEnum('effect').default('SKIP').notNull(),
    priority: integer('priority').default(0).notNull(),
  },
  (table) => ({ policyIdx: index('policy_rules_policy_idx').on(table.policyId) }),
);

// ---------------------------------------------------------------------------
// Backup / templates — OWNER ONLY (v14)
// ---------------------------------------------------------------------------

export const operationStatusEnum = pgEnum('operation_status', [
  'AUTHORIZED',
  'RUNNING',
  'COMPLETED',
  'ABORTED',
  'OWNER_AUTHORIZATION_LOST',
]);

export const backups = pgTable(
  'backups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    schemaVersion: text('schema_version').notNull(),
    /** Configuration ONLY — never member data. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    checksum: text('checksum').notNull(),
    sizeBytes: integer('size_bytes').default(0).notNull(),
    /** INFORMATIONAL ONLY — never grants authorization (v14 §F.1). */
    createdBy: bigint('created_by', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({ guildIdx: index('backups_guild_idx').on(table.guildId, table.createdAt) }),
);

export const templates = pgTable(
  'templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Null = shared/imported. Loading still requires the CURRENT owner (v14 §B.9). */
    guildId: bigint('guild_id', { mode: 'number' }).references(() => guilds.id, {
      onDelete: 'cascade',
    }),
    name: text('name').notNull(),
    description: text('description'),
    schemaVersion: text('schema_version').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    sourceTemplateId: uuid('source_template_id'),
    /** INFORMATIONAL ONLY. */
    createdBy: bigint('created_by', { mode: 'number' }).notNull(),
    checksum: text('checksum').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({ guildIdx: index('templates_guild_idx').on(table.guildId) }),
);

export const operations = pgTable(
  'operations',
  {
    operationId: uuid('operation_id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' }).notNull(),
    /** Who STARTED it. Informational only. */
    initiatingOwnerId: bigint('initiating_owner_id', { mode: 'number' }).notNull(),
    /** Authorization always uses the CURRENT guild owner, not this. */
    currentExecutorId: bigint('current_executor_id', { mode: 'number' }),
    currentOwnerId: bigint('current_owner_id', { mode: 'number' }),
    status: operationStatusEnum('status').default('AUTHORIZED').notNull(),
    backupId: uuid('backup_id'),
    templateId: uuid('template_id'),
    referenceId: text('reference_id').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => ({
    guildIdx: index('operations_guild_idx').on(table.guildId, table.startedAt),
    statusIdx: index('operations_status_idx').on(table.status),
  }),
);

export const operationEvents = pgTable(
  'operation_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    operationId: uuid('operation_id')
      .notNull()
      .references(() => operations.operationId, { onDelete: 'cascade' }),
    guildId: bigint('guild_id', { mode: 'number' }).notNull(),
    actorId: bigint('actor_id', { mode: 'number' }).notNull(),
    currentOwnerId: bigint('current_owner_id', { mode: 'number' }),
    resourceId: uuid('resource_id'),
    event: text('event').notNull(),
    result: text('result').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
    referenceId: text('reference_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({ opIdx: index('operation_events_op_idx').on(table.operationId) }),
);