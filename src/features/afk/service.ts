/**
 * AFK service (v18–v21).
 *
 * Persistence-backed AFK. The decisions live in `./domain.ts`; this file owns
 * the SQL and the guarantees that cannot be expressed in pure functions:
 *
 *  - THE RETURN CLAIM IS A SINGLE ATOMIC UPDATE. `claimReturn` issues one
 *    `UPDATE ... WHERE period_status = 'ACTIVE' AND afk_period_id = $id` and
 *    treats the returned row count as the ownership token. Two shards racing
 *    on the same return produce exactly one winner; the loser gets zero rows
 *    and does nothing. No pre-read, no check-then-act window.
 *
 *  - EVERY MUTATION IS GUILD-SCOPED. The composite identity
 *    (guild_id, afk_period_id) appears in each WHERE clause, so an artifact
 *    from one guild can never address another's period.
 *
 *  - PERIOD IDS NEVER LEAVE THIS LAYER. Callers receive durations and counts;
 *    `afkPeriodId` is passed around internally and rendered only as a
 *    diagnostic log field.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../../core/db/client.js';
import {
  afkBackNotifications,
  afkIgnoredChannels,
  afkMessages,
  afkReturnActions,
  afkSettings,
  afkStatus,
} from '../../core/db/schema/features.js';
import { UserFacingError } from '../../core/errors.js';
import { lazyLogger } from '../../core/logging/logger.js';
import {
  acceptsMessages,
  canFinalize,
  claimSucceeded,
  clearReasonFor,
  decideStart,
  formatAwayDuration,
  mayChangeAfkState,
  mayMutatePeriod,
  pendingReturnWork,
  returnActionKey,
  shouldClearAfk,
  type AfkPeriod,
  type AfkPeriodStatus,
  type ClearReason,
  type MessageProvenance,
} from './domain.js';

const log = lazyLogger({ module: 'afk', operation: 'service' });

export interface AfkSnapshot {
  readonly isAfk: boolean;
  /** Duration since the current period started; null when not AFK. */
  readonly awayFor: string | null;
  readonly message: string | null;
  readonly startedAt: Date | null;
  /** INTERNAL — do not render. */
  readonly afkPeriodId: string | null;
}

export interface StartAfkInput {
  readonly guildId: string;
  readonly userId: string;
  readonly message?: string | null;
}

export type StartAfkResult =
  | { readonly kind: 'STARTED'; readonly period: AfkPeriod }
  | { readonly kind: 'ALREADY_AFK'; readonly period: AfkPeriod };

export interface IncomingMessage {
  readonly guildId: string;
  readonly userId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly content: string;
  readonly provenance: MessageProvenance;
  readonly mentionsAfkUser: boolean;
  readonly isDirectMessage: boolean;
  readonly commandClear?: boolean;
}

/** A message from `senderId` directed at `afkUserId`. */
export interface QueuedMessageInput {
  readonly guildId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly afkUserId: string;
  readonly senderId: string;
  readonly content: string;
}

export interface AfkReturnResult {
  /** True when THIS call won the claim and therefore owns the side effects. */
  readonly claimed: boolean;
  readonly period: AfkPeriod | null;
  readonly duration: string | null;
  readonly queuedMessageCount: number;
  readonly obligations: {
    readonly deliverQueuedMessages: boolean;
    readonly announceReturn: boolean;
    readonly notifySubscribers: boolean;
  } | null;
}

export interface AfkChannelPolicy {
  readonly ignored: boolean;
  readonly clearsOwnAfk: boolean;
}

export interface AfkService {
  current(guildId: string, userId: string): Promise<AfkSnapshot>;
  start(input: StartAfkInput): Promise<StartAfkResult>;
  recordMessage(input: IncomingMessage): Promise<{ cleared: boolean; snapshot: AfkSnapshot | null }>;
  /** Queues a message addressed TO an AFK member. */
  queueMessageForAfkUser(input: QueuedMessageInput): Promise<boolean>;
  claimReturn(guildId: string, userId: string): Promise<AfkReturnResult>;
  finalize(guildId: string, afkPeriodId: string): Promise<boolean>;
  subscribe(guildId: string, afkUserId: string, subscriberId: string): Promise<void>;
  reconcilePendingJobs(): Promise<number>;
}

export interface AfkServiceOptions {
  readonly defaultMessage?: string;
}

/** Row shape returned by the period lookup. */
interface PeriodRow extends Record<string, unknown> {
  readonly guild_id: number;
  readonly user_id: number;
  readonly afk_period_id: string;
  readonly period_status: AfkPeriodStatus;
  readonly started_at: Date;
  readonly returned_at: Date | null;
  readonly message: string | null;
  readonly status: 'CLEAR' | 'AFK';
}

function toPeriod(row: PeriodRow): AfkPeriod {
  return {
    guildId: String(row.guild_id),
    userId: String(row.user_id),
    afkPeriodId: row.afk_period_id,
    periodStatus: row.period_status,
    startedAt: row.started_at,
    returnedAt: row.returned_at,
  };
}

export function createAfkService(db: Database, options: AfkServiceOptions = {}): AfkService {
  const fallbackMessage = options.defaultMessage ?? 'Away from keyboard';

  async function settings(guildId: string): Promise<{
    defaultMessage: string;
    noticesEnabled: boolean;
    showReason: boolean;
    returnAnnouncementChannelId: string | null;
  }> {
    const rows = await db
      .select({
        defaultMessage: afkSettings.defaultMessage,
        noticesEnabled: afkSettings.noticesEnabled,
        showReason: afkSettings.showReason,
        returnAnnouncementChannelId: afkSettings.returnAnnouncementChannelId,
      })
      .from(afkSettings)
      .where(eq(afkSettings.guildId, Number(guildId)))
      .limit(1);
    const row = rows[0];
    return {
      defaultMessage: row?.defaultMessage || fallbackMessage,
      noticesEnabled: row?.noticesEnabled ?? true,
      showReason: row?.showReason ?? true,
      returnAnnouncementChannelId:
        row?.returnAnnouncementChannelId !== null && row?.returnAnnouncementChannelId !== undefined
          ? String(row.returnAnnouncementChannelId)
          : null,
    };
  }

  async function loadPeriod(
    guildId: string,
    userId: string,
  ): Promise<{ period: AfkPeriod; message: string | null; status: 'CLEAR' | 'AFK' } | null> {
    const rows = await db.execute<PeriodRow>(sql`
      SELECT guild_id, user_id, afk_period_id, period_status, started_at,
             returned_at, message, status
        FROM afk_status
       WHERE guild_id = ${Number(guildId)}
         AND user_id = ${Number(userId)}
         AND status = 'AFK'
         AND period_status IN ('ACTIVE', 'RETURNED')
       ORDER BY started_at DESC
       LIMIT 1
    `);
    const row = rows[0];
    if (!row) return null;
    return { period: toPeriod(row), message: row.message, status: row.status };
  }

  async function channelPolicy(guildId: string, channelId: string): Promise<AfkChannelPolicy> {
    const rows = await db
      .select({ clearsOwnAfk: afkIgnoredChannels.clearsOwnAfk })
      .from(afkIgnoredChannels)
      .where(
        and(
          eq(afkIgnoredChannels.guildId, Number(guildId)),
          eq(afkIgnoredChannels.channelId, Number(channelId)),
        ),
      )
      .limit(1);
    const row = rows[0];
    // Not listed = a normal channel: notices on, own message clears.
    return { ignored: row === undefined, clearsOwnAfk: row?.clearsOwnAfk ?? true };
  }

  function snapshotOf(loaded: Awaited<ReturnType<typeof loadPeriod>>): AfkSnapshot {
    if (!loaded) {
      return { isAfk: false, awayFor: null, message: null, startedAt: null, afkPeriodId: null };
    }
    return {
      isAfk: true,
      awayFor: formatAwayDuration(loaded.period.startedAt, new Date()),
      message: loaded.message,
      startedAt: loaded.period.startedAt,
      afkPeriodId: loaded.period.afkPeriodId,
    };
  }

  return {
    async current(guildId, userId) {
      return snapshotOf(await loadPeriod(guildId, userId));
    },

    async start({ guildId, userId, message }) {
      const config = await settings(guildId);
      const existing = await loadPeriod(guildId, userId);
      // decideStart is deterministic: repeated `$afk` returns the SAME period
      // rather than minting a second one.
      const decision = decideStart(existing?.period, 'new');

      if (decision.kind === 'ALREADY_AFK' && existing) {
        return { kind: 'ALREADY_AFK' as const, period: existing.period };
      }

      const inserted = await db
        .insert(afkStatus)
        .values({
          guildId: Number(guildId),
          userId: Number(userId),
          message: message ?? config.defaultMessage,
          status: 'AFK',
          periodStatus: 'ACTIVE',
        })
        .returning({
          afkPeriodId: afkStatus.afkPeriodId,
          startedAt: afkStatus.startedAt,
          periodStatus: afkStatus.periodStatus,
          returnedAt: afkStatus.returnedAt,
        });

      const row = inserted[0];
      if (!row) throw new UserFacingError('Could not start your AFK session. Try again.');

      return {
        kind: 'STARTED' as const,
        period: {
          guildId,
          userId,
          afkPeriodId: row.afkPeriodId,
          periodStatus: row.periodStatus,
          startedAt: row.startedAt,
          returnedAt: row.returnedAt,
        },
      };
    },

    async recordMessage(input) {
      // Loop protection: only a human's message may change AFK state.
      if (!mayChangeAfkState(input.provenance)) {
        return { cleared: false, snapshot: null };
      }

      const loaded = await loadPeriod(input.guildId, input.userId);
      if (!loaded) return { cleared: false, snapshot: null };

      const policy = await channelPolicy(input.guildId, input.channelId);

      const shouldClear = shouldClearAfk({
        provenance: input.provenance,
        isAfkUser: true,
        mentionsAfkUser: input.mentionsAfkUser,
        isDirectMessage: input.isDirectMessage,
        clearsOwnAfk: policy.clearsOwnAfk,
        commandClear: input.commandClear ?? false,
      });

      if (!shouldClear) {
        return { cleared: false, snapshot: snapshotOf(loaded) };
      }

      const reason: ClearReason = clearReasonFor({
        commandClear: input.commandClear ?? false,
        isAfkUser: true,
        mentionsAfkUser: input.mentionsAfkUser,
        isDirectMessage: input.isDirectMessage,
      });

      await db.execute(
        sql`
          UPDATE afk_status
             SET status = 'CLEAR',
                 cleared_at = now(),
                 cleared_by = ${Number(input.userId)},
                 clear_reason = ${reason},
                 updated_at = now()
           WHERE guild_id = ${Number(input.guildId)}
             AND user_id = ${Number(input.userId)}
             AND afk_period_id = ${loaded.period.afkPeriodId}
             AND period_status = 'ACTIVE'
        `,
      );

      // The claim and the period-status advance are separate durable steps;
      // both are idempotent, so a crash between them is recoverable.
      const claim = await this.claimReturn(input.guildId, input.userId);
      const snapshot: AfkSnapshot = {
        isAfk: false,
        awayFor: claim.duration,
        message: loaded.message,
        startedAt: loaded.period.startedAt,
        afkPeriodId: loaded.period.afkPeriodId,
      };
      return { cleared: true, snapshot };
    },

    async queueMessageForAfkUser(input) {
      const loaded = await loadPeriod(input.guildId, input.afkUserId);
      if (!loaded || !acceptsMessages(loaded.period)) return false;

      // The queued artifact carries BOTH ids, matching the composite uniqueness
      // in afk_messages, so delivery can never cross guilds.
      const inserted = await db
        .insert(afkMessages)
        .values({
          guildId: Number(input.guildId),
          afkUserId: Number(input.afkUserId),
          afkPeriodId: loaded.period.afkPeriodId,
          senderId: Number(input.senderId),
          message: input.content,
          deliveryStatus: 'PENDING',
        })
        .onConflictDoNothing()
        .returning({ id: afkMessages.id });

      return inserted.length > 0;
    },

    async claimReturn(guildId, userId) {
      const loaded = await loadPeriod(guildId, userId);
      if (!loaded) {
        return {
          claimed: false,
          period: null,
          duration: null,
          queuedMessageCount: 0,
          obligations: null,
        };
      }

      // ONE statement. The row count is the ownership token.
      const claimed = await db.execute<{ afk_period_id: string; returned_at: Date }>(sql`
        UPDATE afk_status
           SET period_status = 'RETURNED',
               returned_at = now(),
               updated_at = now()
         WHERE guild_id = ${Number(guildId)}
           AND user_id = ${Number(userId)}
           AND afk_period_id = ${loaded.period.afkPeriodId}
           AND period_status = 'ACTIVE'
        RETURNING afk_period_id, returned_at
      `);

      if (!claimSucceeded(claimed.length)) {
        // Someone else already owns this return. Do nothing — including not
        // announcing, not delivering messages, not notifying subscribers.
        log().debug({ guildId, userId }, 'afk return claim lost the race');
        return {
          claimed: false,
          period: loaded.period,
          duration: null,
          queuedMessageCount: 0,
          obligations: null,
        };
      }

      const pending = await db
        .select({ id: afkMessages.id })
        .from(afkMessages)
        .where(
          and(
            eq(afkMessages.guildId, Number(guildId)),
            eq(afkMessages.afkPeriodId, loaded.period.afkPeriodId),
            eq(afkMessages.deliveryStatus, 'PENDING'),
          ),
        );

      // RETURNED is durable and resumable, so the winner's obligations are
      // recorded up front and re-derivable after a crash.
      const won: AfkPeriod = {
        ...loaded.period,
        periodStatus: 'RETURNED',
        returnedAt: claimed[0]?.returned_at ?? new Date(),
      };

      await db
        .insert(afkReturnActions)
        .values({
          guildId: Number(guildId),
          afkPeriodId: loaded.period.afkPeriodId,
          actionType: 'RETURN_ANNOUNCEMENT',
          status: 'PENDING',
        })
        .onConflictDoNothing();

      return {
        claimed: true,
        period: won,
        duration: formatAwayDuration(loaded.period.startedAt, claimed[0]?.returned_at ?? new Date()),
        queuedMessageCount: pending.length,
        obligations: pendingReturnWork(won),
      };
    },

    async finalize(guildId, afkPeriodId) {
      const rows = await db.execute<{ afk_period_id: string }>(sql`
        UPDATE afk_status
           SET period_status = 'FINALIZED',
               status = 'CLEAR',
               updated_at = now()
         WHERE guild_id = ${Number(guildId)}
           AND afk_period_id = ${afkPeriodId}
           AND period_status = 'RETURNED'
        RETURNING afk_period_id
      `);
      const finalized = claimSucceeded(rows.length);

      await db.execute(
        sql`
          UPDATE afk_return_actions
             SET status = 'DELIVERED', completed_at = now(), updated_at = now()
           WHERE guild_id = ${Number(guildId)}
             AND afk_period_id = ${afkPeriodId}
             AND status IN ('PENDING', 'PROCESSING')
        `,
      );

      return finalized;
    },

    async subscribe(guildId, afkUserId, subscriberId) {
      const loaded = await loadPeriod(guildId, afkUserId);
      if (!loaded) {
        throw new UserFacingError('That member is no longer AFK, so there is nothing to notify about.');
      }

      // ON CONFLICT DO NOTHING is what makes a double-click idempotent, and
      // afkPeriodId ties the subscription to THIS period rather than the
      // member — returning from a later AFK does not notify old subscribers.
      await db
        .insert(afkBackNotifications)
        .values({
          guildId: Number(guildId),
          afkUserId: Number(afkUserId),
          subscriberId: Number(subscriberId),
          afkPeriodId: loaded.period.afkPeriodId,
          status: 'ACTIVE',
        })
        .onConflictDoNothing();
    },

    async reconcilePendingJobs() {
      const rows = await db.execute<{ afk_period_id: string }>(sql`
        SELECT afk_period_id
          FROM afk_return_actions
         WHERE status IN ('PENDING', 'PROCESSING')
           AND updated_at < now() - interval '5 minutes'
         ORDER BY updated_at
         LIMIT 100
      `);

      let recovered = 0;
      for (const row of rows) {
        const period = await db.execute<PeriodRow>(sql`
          SELECT guild_id, user_id, afk_period_id, period_status, started_at,
                 returned_at, message, status
            FROM afk_status
           WHERE afk_period_id = ${row.afk_period_id}
             AND period_status = 'RETURNED'
           LIMIT 1
        `);
        const found = period[0];
        if (!found) continue;

        // Only re-drive work the state still owes. A FINALIZED period has
        // nothing left and must never be reopened.
        if (!mayMutatePeriod(toPeriod(found))) continue;
        if (!canFinalize(toPeriod(found))) continue;

        await db.execute(
          sql`
            UPDATE afk_return_actions
               SET status = 'PROCESSING', attempts = attempts + 1, updated_at = now()
             WHERE guild_id = ${found.guild_id}
               AND afk_period_id = ${row.afk_period_id}
               AND status = 'PENDING'
          `,
        );
        recovered += 1;
      }

      if (recovered > 0) log().info({ recovered }, 'recovered stalled afk return actions');
      return recovered;
    },
  };
}

/** Whether a period is still mutable — re-exported so callers need one import. */
export { mayMutatePeriod, returnActionKey };
