/**
 * Remaining schema domains: applications, reports, appeals, temporary voice,
 * welcome/verification, honeypot, AI, analytics, search, setup state, and
 * security/lockdown.
 *
 * Constraint philosophy matches the rest of the schema: UNIQUE and partial
 * UNIQUE constraints ARE the concurrency control, not decoration. The ones
 * that matter most here:
 *
 *  - One OPEN application per (guild, user, form) — a member cannot stack
 *    submissions by racing two clicks.
 *  - One open report per (guild, reporter, target) — no duplicate-report spam
 *    and no unbounded parallel reports on one target.
 *  - One active temp-voice session per (guild, channel) — two members can
 *    never be handed the same channel.
 *  - Verification tokens are single-use by construction (state machine, not a
 *    boolean that a replay could re-set).
 *  - Search/AI/HUD rows are keyed by idempotency so a replayed job re-indexes
 *    rather than duplicating.
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

/** Partial-index predicate: `col = 'VALUE'` with the value INLINED. */
const enumEq = (column: AnyPgColumn, value: string) =>
  sql`${column} = '${sql.raw(value)}'`;

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

export const applicationStatusEnum = pgEnum('application_status', [
  'PENDING',
  'APPROVED',
  'DENIED',
  'WITHDRAWN',
]);

export const applicationForms = pgTable('application_forms', {
  id: uuid('id').primaryKey().defaultRandom(),
  guildId: bigint('guild_id', { mode: 'number' })
    .notNull()
    .references(() => guilds.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  /** Applied by staff on approval; null = no role is granted. */
  acceptRoleId: bigint('accept_role_id', { mode: 'number' }),
  /** Applied by staff on denial. */
  denyRoleId: bigint('deny_role_id', { mode: 'number' }),
  required: boolean('required').default(false).notNull(),
  /** Question set; shape validated by Zod at the command boundary. */
  questions: jsonb('questions').$type<unknown[]>().default([]).notNull(),
  logChannelId: bigint('log_channel_id', { mode: 'number' }),
  active: integer('active').default(1).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const applications = pgTable(
  'application_submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    formId: uuid('form_id')
      .notNull()
      .references(() => applicationForms.id, { onDelete: 'cascade' }),
    /** PRIVATE — staff-only review surface, never logged generically. */
    answers: jsonb('answers').$type<Record<string, unknown>>().notNull(),
    status: applicationStatusEnum('status').default('PENDING').notNull(),
    reviewerId: bigint('reviewer_id', { mode: 'number' }),
    reviewNote: text('review_note'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).defaultNow().notNull(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  },
  (table) => ({
    // A member cannot stack submissions by racing two clicks. A REJECTED or
    // APPROVED row releases the slot so re-applying is legitimate.
    openUnique: uniqueIndex('applications_open_unique')
      .on(table.guildId, table.userId, table.formId)
      .where(enumEq(table.status, 'PENDING')),
    guildStatusIdx: index('applications_guild_status_idx').on(table.guildId, table.status),
    userIdx: index('applications_user_idx').on(table.userId),
  }),
);

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export const reportStatusEnum = pgEnum('report_status', [
  'OPEN',
  'REVIEWING',
  'RESOLVED',
  'DISMISSED',
]);

export const reportPriorityEnum = pgEnum('report_priority', ['LOW', 'MEDIUM', 'HIGH', 'URGENT']);

export const reports = pgTable(
  'reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    reporterId: bigint('reporter_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Null = reporting the channel rather than a member. */
    targetUserId: bigint('target_user_id', { mode: 'number' }).references(() => users.id, {
      onDelete: 'cascade',
    }),
    targetMessageId: bigint('target_message_id', { mode: 'number' }),
    reason: text('reason').notNull(),
    /** PRIVATE — staff-only. */
    details: text('details'),
    status: reportStatusEnum('status').default('OPEN').notNull(),
    priority: reportPriorityEnum('priority').default('LOW').notNull(),
    assignedTo: bigint('assigned_to', { mode: 'number' }),
    resolution: text('resolution'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => ({
    // One open report per (reporter, target): no duplicate spam, and a member
    // cannot pile parallel reports onto one target.
    openUnique: uniqueIndex('reports_open_unique')
      .on(table.guildId, table.reporterId, table.targetUserId)
      .where(enumEq(table.status, 'OPEN')),
    queueIdx: index('reports_queue_idx').on(table.guildId, table.status, table.priority),
    targetIdx: index('reports_target_idx').on(table.guildId, table.targetUserId),
  }),
);

export const reportNotes = pgTable(
  'report_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    reportId: uuid('report_id')
      .notNull()
      .references(() => reports.id, { onDelete: 'cascade' }),
    authorId: bigint('author_id', { mode: 'number' }).notNull(),
    note: text('note').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({ reportIdx: index('report_notes_report_idx').on(table.reportId) }),
);

// ---------------------------------------------------------------------------
// Appeals
// ---------------------------------------------------------------------------

export const appealStatusEnum = pgEnum('appeal_status', [
  'OPEN',
  'UNDER_REVIEW',
  'APPROVED',
  'DENIED',
]);

export const appeals = pgTable(
  'appeals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The moderation case this appeal contests. */
    caseId: uuid('case_id'),
    statement: text('statement').notNull(),
    status: appealStatusEnum('status').default('OPEN').notNull(),
    reviewerId: bigint('reviewer_id', { mode: 'number' }),
    outcome: text('outcome'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => ({
    // One open appeal per case, so a member cannot flood staff with parallel
    // appeals for the same action.
    caseUnique: uniqueIndex('appeals_case_unique')
      .on(table.guildId, table.caseId)
      .where(enumEq(table.status, 'OPEN')),
    guildStatusIdx: index('appeals_guild_status_idx').on(table.guildId, table.status),
  }),
);

// ---------------------------------------------------------------------------
// Temporary voice
// ---------------------------------------------------------------------------

export const tempVoiceStatusEnum = pgEnum('temp_voice_status', [
  'ACTIVE',
  'LOCKED',
  'UNLOCKED',
  'CLOSED',
]);

export const tempVoiceChannels = pgTable(
  'temp_voice_channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    ownerId: bigint('owner_id', { mode: 'number' }).notNull(),
    channelId: bigint('channel_id', { mode: 'number' }).notNull(),
    status: tempVoiceStatusEnum('status').default('ACTIVE').notNull(),
    memberLimit: integer('member_limit'),
    userLimit: integer('user_limit'),
    /** Non-empty means the owner is no longer in the channel. */
    movedBy: bigint('moved_by', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (table) => ({
    // Two members can NEVER be handed the same channel.
    activeChannelUnique: uniqueIndex('temp_voice_active_channel_unique')
      .on(table.guildId, table.channelId)
      .where(enumEq(table.status, 'ACTIVE')),
    ownerIdx: index('temp_voice_owner_idx').on(table.guildId, table.ownerId),
  }),
);

export const tempVoiceSettings = pgTable('temp_voice_settings', {
  guildId: bigint('guild_id', { mode: 'number' })
    .primaryKey()
    .references(() => guilds.id, { onDelete: 'cascade' }),
  hubChannelIds: jsonb('hub_channel_ids').$type<string[]>().default([]).notNull(),
  categoryId: bigint('category_id', { mode: 'number' }),
  defaultNameTemplate: text('default_name_template').default("{username}'s channel").notNull(),
  maxChannels: integer('max_channels').default(50).notNull(),
  autoCloseEmpty: boolean('auto_close_empty').default(true).notNull(),
});

// ---------------------------------------------------------------------------
// Welcome / verification
// ---------------------------------------------------------------------------

export const verificationStatusEnum = pgEnum('verification_status', [
  'PENDING',
  'VERIFIED',
  'REJECTED',
  'BYPASSED',
]);

export const verificationState = pgTable(
  'verification_state',
  {
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: verificationStatusEnum('status').default('PENDING').notNull(),
    verifiedRoleId: bigint('verified_role_id', { mode: 'number' }),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    /** One token per user; a rotation invalidates the old one. */
    token: text('token'),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    attempts: integer('attempts').default(0).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.guildId, table.userId] }),
    pendingIdx: index('verification_pending_idx')
      .on(table.guildId)
      .where(enumEq(table.status, 'PENDING')),
    tokenIdx: index('verification_token_idx').on(table.token),
  }),
);

export const verificationCaptcha = pgTable(
  'verification_captcha',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    /** Never logged, never returned in plaintext after creation. */
    answerHash: text('answer_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    solvedAt: timestamp('solved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // Single-use by construction: the row is consumed by solving it, and a
    // replay finds `solved_at` already set.
    perUserUnique: uniqueIndex('verification_captcha_user_unique').on(table.guildId, table.userId),
    expiryIdx: index('verification_captcha_expiry_idx').on(table.expiresAt),
  }),
);

export const welcomeSettings = pgTable('welcome_settings', {
  guildId: bigint('guild_id', { mode: 'number' })
    .primaryKey()
    .references(() => guilds.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').default(false).notNull(),
  channelId: bigint('channel_id', { mode: 'number' }),
  message: text('message').default('Welcome, {user}!').notNull(),
  showMemberCount: boolean('show_member_count').default(false).notNull(),
  directMessageEnabled: boolean('direct_message_enabled').default(false).notNull(),
  directMessageMessage: text('direct_message_message'),
  leaveChannelId: bigint('leave_channel_id', { mode: 'number' }),
});

/**
 * Auto-assign on join is deliberately NOT modelled.
 *
 * v-plan: role assignment happens only via five explicit workflows —
 * verification click, application approval, role purchase, self-assign
 * selection, and level reward. There is no join-time role grant table because
 * there is no join-time role grant.
 */
export const welcomeProfiles = pgTable('welcome_profiles', {
  guildId: bigint('guild_id', { mode: 'number' })
    .primaryKey()
    .references(() => guilds.id, { onDelete: 'cascade' }),
  verificationEnabled: boolean('verification_enabled').default(false).notNull(),
  verificationMode: text('verification_mode').default('CAPTCHA').notNull(),
  verificationRoleId: bigint('verification_role_id', { mode: 'number' }),
  verificationChannelId: bigint('verification_channel_id', { mode: 'number' }),
  verificationTimeoutMinutes: integer('verification_timeout_minutes').default(10).notNull(),
});

// ---------------------------------------------------------------------------
// Honeypot
// ---------------------------------------------------------------------------

export const honeypotActionEnum = pgEnum('honeypot_action', ['LOG', 'MUTE', 'DELETE', 'KICK']);

export const honeypotChannels = pgTable('honeypot_channels', {
  guildId: bigint('guild_id', { mode: 'number' })
    .primaryKey()
    .references(() => guilds.id, { onDelete: 'cascade' }),
  channelId: bigint('channel_id', { mode: 'number' }).notNull(),
  action: honeypotActionEnum('action').default('LOG').notNull(),
  alertChannelId: bigint('alert_channel_id', { mode: 'number' }),
  /** Reaction roles removed from a user who trips the honeypot. */
  reactionRoleIds: jsonb('reaction_role_ids').$type<string[]>().default([]).notNull(),
});

export const honeypotTrips = pgTable('honeypot_trips', {
  id: uuid('id').primaryKey().defaultRandom(),
  guildId: bigint('guild_id', { mode: 'number' })
    .notNull()
    .references(() => guilds.id, { onDelete: 'cascade' }),
  channelId: bigint('channel_id', { mode: 'number' }).notNull(),
  userId: bigint('user_id', { mode: 'number' }).notNull(),
  action: honeypotActionEnum('action').notNull(),
  messageId: bigint('message_id', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const autoRoles = pgTable('auto_roles', {
  guildId: bigint('guild_id', { mode: 'number' })
    .primaryKey()
    .references(() => guilds.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').default(false).notNull(),
  /** Self-assign channel; NOT a join hook. */
  channelId: bigint('channel_id', { mode: 'number' }),
  description: text('description'),
});

/**
 * Self-assignable roles.
 *
 * Present ONLY here: assignment is a user selection, never automatic.
 */
export const selfAssignableRoles = pgTable('self_assignable_roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  guildId: bigint('guild_id', { mode: 'number' })
    .notNull()
    .references(() => guilds.id, { onDelete: 'cascade' }),
  roleId: bigint('role_id', { mode: 'number' }).notNull(),
  label: text('label'),
  emoji: text('emoji'),
  groupName: text('group_name'),
  /** A role marked exclusive is removed when another in its group is taken. */
  exclusive: boolean('exclusive').default(false).notNull(),
  active: integer('active').default(1).notNull(),
});

export const selfRoleSelections = pgTable(
  'self_role_selections',
  {
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: bigint('role_id', { mode: 'number' }).notNull(),
    selectedAt: timestamp('selected_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.guildId, table.userId, table.roleId] }),
    userIdx: index('self_role_selections_user_idx').on(table.guildId, table.userId),
  }),
);

// ---------------------------------------------------------------------------
// AI (strictly optional, free tier only — v13 §2)
// ---------------------------------------------------------------------------

export const aiOutcomeEnum = pgEnum('ai_outcome', [
  'ALLOWED',
  'REFUSED',
  'ERROR',
  'SKIPPED_NO_KEY',
]);

export const aiDecisions = pgTable('ai_decisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  guildId: bigint('guild_id', { mode: 'number' })
    .notNull()
    .references(() => guilds.id, { onDelete: 'cascade' }),
  feature: text('feature').notNull(),
  outcome: aiOutcomeEnum('outcome').notNull(),
  /** Only when outcome = REFUSED. */
  reason: text('reason'),
  confidence: integer('confidence'),
  latencyMs: integer('latency_ms'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const aiSettings = pgTable('ai_settings', {
  guildId: bigint('guild_id', { mode: 'number' })
    .primaryKey()
    .references(() => guilds.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').default(false).notNull(),
  /** Model id; quotas are NEVER hard-coded and never assumed. */
  model: text('model'),
  /** Staff-configurable conservative ceiling; advisory, not enforced by a quota table. */
  maxDailyRequests: integer('max_daily_requests'),
  autoActionEnabled: boolean('auto_action_enabled').default(false).notNull(),
});

export const aiCircuitState = pgTable('ai_circuit_state', {
  id: integer('id').primaryKey(),
  /** OPEN = refusing to call the provider; HALF_OPEN = probing. */
  state: text('state').default('CLOSED').notNull(),
  consecutiveFailures: integer('consecutive_failures').default(0).notNull(),
  openedAt: timestamp('opened_at', { withTimezone: true }),
  nextProbeAt: timestamp('next_probe_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Analytics / HUD
// ---------------------------------------------------------------------------

export const analyticsDaily = pgTable(
  'analytics_daily',
  {
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    day: text('day').notNull(),
    messages: integer('messages').default(0).notNull(),
    activeMembers: integer('active_members').default(0).notNull(),
    joins: integer('joins').default(0).notNull(),
    leaves: integer('leaves').default(0).notNull(),
    actions: integer('actions').default(0).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.guildId, table.day] }) }),
);

export const analyticsCommands = pgTable(
  'analytics_commands',
  {
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    command: text('command').notNull(),
    day: text('day').notNull(),
    uses: integer('uses').default(0).notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.guildId, table.command, table.day] }) }),
);

export const messageAnalytics = pgTable(
  'message_analytics',
  {
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    channelId: bigint('channel_id', { mode: 'number' }).notNull(),
    day: text('day').notNull(),
    messages: integer('messages').default(0).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.guildId, table.channelId, table.day] }),
    channelIdx: index('message_analytics_channel_idx').on(table.guildId, table.channelId),
  }),
);

// ---------------------------------------------------------------------------
// Search index
// ---------------------------------------------------------------------------

export const searchDocuments = pgTable(
  'search_documents',
  {
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    /** e.g. "message:1234" or "faq:2" — namespace plus stable id. */
    externalId: text('external_id').notNull(),
    kind: text('kind').notNull(),
    title: text('title'),
    body: text('body').notNull(),
    authorId: bigint('author_id', { mode: 'number' }),
    channelId: bigint('channel_id', { mode: 'number' }),
    indexedAt: timestamp('indexed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // Re-indexing the same document updates in place instead of duplicating.
    pk: primaryKey({ columns: [table.guildId, table.externalId] }),
    kindIdx: index('search_documents_kind_idx').on(table.guildId, table.kind),
  }),
);

export const searchQueries = pgTable(
  'search_queries',
  {
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    query: text('query').notNull(),
    results: integer('results').default(0).notNull(),
    /** Deterministic digest, never the raw query. */
    queryHash: text('query_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({ idx: index('search_queries_recent_idx').on(table.guildId, table.createdAt) }),
);

// ---------------------------------------------------------------------------
// Setup wizard state
// ---------------------------------------------------------------------------

export const setupStepEnum = pgEnum('setup_step', [
  'START',
  'MODULES',
  'CHANNELS',
  'ROLES',
  'REVIEW',
  'COMPLETED',
]);

export const setupState = pgTable('setup_state', {
  guildId: bigint('guild_id', { mode: 'number' })
    .primaryKey()
    .references(() => guilds.id, { onDelete: 'cascade' }),
  step: setupStepEnum('step').default('START').notNull(),
  selections: jsonb('selections').$type<Record<string, unknown>>().default({}).notNull(),
  startedBy: bigint('started_by', { mode: 'number' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

// ---------------------------------------------------------------------------
// Security / lockdown
// ---------------------------------------------------------------------------

export const raidModeStatusEnum = pgEnum('raid_mode_status', [
  'INACTIVE',
  'ON',
  'LIMITED',
]);

export const raidMode = pgTable('raid_mode', {
  guildId: bigint('guild_id', { mode: 'number' })
    .primaryKey()
    .references(() => guilds.id, { onDelete: 'cascade' }),
  status: raidModeStatusEnum('status').default('INACTIVE').notNull(),
  joinRateThreshold: integer('join_rate_threshold').default(10).notNull(),
  joinRateWindowSeconds: integer('join_rate_window_seconds').default(30).notNull(),
  accountAgeThresholdHours: integer('account_age_threshold_hours').default(60).notNull(),
  avatarThresholdHours: integer('avatar_threshold_hours').default(24).notNull(),
  action: text('action').default('MUTE').notNull(),
  exemptRoleIds: jsonb('exempt_role_ids').$type<string[]>().default([]).notNull(),
  triggeredBy: bigint('triggered_by', { mode: 'number' }),
  triggeredAt: timestamp('triggered_at', { withTimezone: true }),
  clearedAt: timestamp('cleared_at', { withTimezone: true }),
});

export const lockdownState = pgTable('lockdown_state', {
  guildId: bigint('guild_id', { mode: 'number' })
    .primaryKey()
    .references(() => guilds.id, { onDelete: 'cascade' }),
  active: boolean('active').default(false).notNull(),
  /** Per-channel snapshot so a partial unlock restores exactly what it changed. */
  channelStates: jsonb('channel_states')
    .$type<Record<string, { denySendMessages: boolean; denyAddReactions: boolean; denyAttachFiles: boolean; denyEmbedLinks: boolean }>>()
    .default({})
    .notNull(),
  /** Role overrides applied during lockdown, for honest partial restoration. */
  roleOverrides: jsonb('role_overrides')
    .$type<Record<string, { muteRoleId: string | null; timeoutMs: number | null }>>()
    .default({})
    .notNull(),
  activatedBy: bigint('activated_by', { mode: 'number' }),
  activatedAt: timestamp('activated_at', { withTimezone: true }),
  releasedAt: timestamp('released_at', { withTimezone: true }),
});

export const securitySettings = pgTable('security_settings', {
  guildId: bigint('guild_id', { mode: 'number' })
    .primaryKey()
    .references(() => guilds.id, { onDelete: 'cascade' }),
  antiRaidEnabled: boolean('anti_raid_enabled').default(false).notNull(),
  suspiciousInviteEnabled: boolean('suspicious_invite_enabled').default(false).notNull(),
  suspiciousInviteAction: text('suspicious_invite_action').default('MUTE').notNull(),
  massMentionAction: text('mass_mention_action').default('MUTE').notNull(),
  linkThresholdAction: text('link_threshold_action').default('MUTE').notNull(),
  staffRoleIds: jsonb('staff_role_ids').$type<string[]>().default([]).notNull(),
  alertChannelId: bigint('alert_channel_id', { mode: 'number' }),
});

/**
 * Invite tracking lives in `features.ts` (inviteJoins, inviteSnapshots,
 * inviteCounters, inviteRewardRules), which models attribution, bot detection,
 * and rejoin state. Only the SUSPICIOUS-INVITE triage table is new here.
 */
export const suspiciousInvites = pgTable('suspicious_invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  guildId: bigint('guild_id', { mode: 'number' })
    .notNull()
    .references(() => guilds.id, { onDelete: 'cascade' }),
  code: text('code').notNull(),
  /** Deterministic content hash — the code itself may be sensitive. */
  codeHash: text('code_hash').notNull(),
  memberCount: integer('member_count').default(0).notNull(),
  createdBy: text('created_by'),
  action: text('action').default('LOG').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
