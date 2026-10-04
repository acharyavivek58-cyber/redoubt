/**
 * Leveling service (v13 §16).
 *
 * THE PROGRESSION INVARIANT, stated precisely:
 *
 *   level === levelFromSeasonXp(season_xp)  AND  xp_in_level === xpIntoLevel(season_xp)
 *
 * All three values are derived from the NEW season_xp inside ONE transaction
 * that holds `SELECT ... FOR UPDATE` on the member's row. They are never
 * incremented independently. Two concurrent XP awards therefore serialize on
 * that lock, and the second computes from the first's committed total — so the
 * invariant cannot drift no matter how many messages land at once.
 *
 * `lifetime_xp` NEVER RESETS. A season rollover starts `season_xp` at zero but
 * leaves lifetime_xp untouched, so total progress is never lost.
 *
 * REWARDS ARE PROCESSED ONLY AFTER COMMIT. A reward row is inserted by the
 * committed transaction, and the delivery job is enqueued afterwards. An
 * award that rolls back must not have granted anything.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../../core/db/client.js';
import {
  levelEvents,
  levelProfiles,
  levelRewards,
  levelRewardsGranted,
  levelSettings,
  rewardDeliveries,
  seasons,
} from '../../core/db/schema/economy.js';
import { lazyLogger } from '../../core/logging/logger.js';
import {
  applyRateCap,
  clampXp,
  crossedLevels,
  deriveProgression,
  progressionInvariantHolds,
  shouldCreditXp,
  type CurveConfig,
} from './level-curve.js';

const log = lazyLogger({ module: 'leveling', operation: 'service' });

export interface XpAwardInput {
  readonly guildId: string;
  readonly userId: string;
  readonly amount: number;
  readonly source: string;
  readonly channelId?: string;
  /** Used for the minimum-length eligibility gate. */
  readonly contentLength?: number;
}

export interface XpAward {
  readonly levelBefore: number;
  readonly levelAfter: number;
  readonly xpGained: number;
  readonly xpIntoLevel: number;
  readonly xpToNextLevel: number | null;
  readonly levelsCrossed: readonly number[];
  readonly lifetimeXp: number;
  /** Rewards that became claimable, keyed by reward id. */
  readonly rewardIds: readonly string[];
}

export interface LevelingService {
  award(input: XpAwardInput): Promise<XpAward>;
  profile(guildId: string, userId: string): Promise<{
    readonly level: number;
    readonly seasonXp: number;
    readonly lifetimeXp: number;
    readonly xpIntoLevel: number;
    readonly xpToNextLevel: number | null;
  } | null>;
  /** Startup backfill: repairs any row whose invariant does not hold. */
  backfillProgression(): Promise<number>;
  freezeSeasonLeaderboard(seasonId: string): Promise<number>;
}

export interface LevelingServiceOptions {
  /** Where reward-delivery jobs are enqueued. Called AFTER commit. */
  readonly enqueueRewardDelivery?: (input: {
    guildId: string;
    userId: string;
    rewardId: string;
    level: number;
    seasonId: string;
  }) => void;
}

export function createLevelingService(
  db: Database,
  curve: CurveConfig,
  options: LevelingServiceOptions = {},
): LevelingService {
  async function activeSeasonId(guildId: string): Promise<string | null> {
    const rows = await db
      .select({ id: seasons.id })
      .from(seasons)
      .where(and(eq(seasons.guildId, Number(guildId)), eq(seasons.status, 'ACTIVE')))
      .limit(1);
    return rows[0]?.id ?? null;
  }

  return {
    async award(input) {
      const seasonId = await activeSeasonId(input.guildId);
      if (!seasonId) {
        // No active season: nothing accrues, and that is not an error.
        log().debug({ guildId: input.guildId }, 'no active season; xp not credited');
        return {
          levelBefore: 0,
          levelAfter: 0,
          xpGained: 0,
          xpIntoLevel: 0,
          xpToNextLevel: null,
          levelsCrossed: [],
          lifetimeXp: 0,
          rewardIds: [],
        };
      }

      const settingsRows = await db
        .select({
          perMessageClamp: levelSettings.perMessageClamp,
          rateCapXp: levelSettings.rateCapXp,
          rateCapMinutes: levelSettings.rateCapMinutes,
          minMessageLength: levelSettings.minMessageLength,
          minIntervalSeconds: levelSettings.minIntervalSeconds,
        })
        .from(levelSettings)
        .where(eq(levelSettings.guildId, Number(input.guildId)))
        .limit(1);
      const settings = settingsRows[0];

      // ONE transaction: read the row under a lock, derive all three values
      // from the new total, and write them together.
      const result = await db.transaction(async (tx) => {
        const existing = await tx.execute<{
          id: string;
          season_xp: number;
          level: number;
          xp_in_level: number;
          lifetime_xp: number;
          last_xp_at: Date | null;
        }>(sql`
          SELECT id, season_xp, level, xp_in_level, lifetime_xp, last_xp_at
            FROM level_profiles
           WHERE guild_id = ${Number(input.guildId)}
             AND user_id = ${Number(input.userId)}
             AND season_id = ${seasonId}
           FOR UPDATE
        `);

        const row = existing[0];
        const seasonXpBefore = row?.season_xp ?? 0;
        const levelBefore = row?.level ?? curve.startingLevel;
        const lifetimeBefore = row?.lifetime_xp ?? 0;
        const lastXpAt = row?.last_xp_at ?? null;

        // Anti-farm gating: eligibility first, then clamp, then the rolling cap.
        // The cap is evaluated INSIDE this transaction against the locked row,
        // so concurrent messages cannot collectively exceed it.
        const secondsSinceLastXp = lastXpAt
          ? Math.floor((Date.now() - new Date(lastXpAt).getTime()) / 1000)
          : null;

        const eligible = shouldCreditXp({
          isDm: false,
          isBot: false,
          isWebhook: false,
          isNoXpChannel: false,
          contentLength: input.contentLength ?? Number.MAX_SAFE_INTEGER,
          minMessageLength: settings?.minMessageLength ?? 0,
          secondsSinceLastXp,
          minIntervalSeconds: settings?.minIntervalSeconds ?? 0,
        });
        if (!eligible) return null;

        const clamped = clampXp(input.amount, settings?.perMessageClamp ?? 25);
        // XP already earned inside the rolling window, read under the same lock.
        const windowStart = new Date(
          Date.now() - (settings?.rateCapMinutes ?? 30) * 60_000,
        );
        const recent = await tx.execute<{ total: number }>(sql`
          SELECT COALESCE(sum(amount), 0)::int AS total
            FROM level_events
           WHERE guild_id = ${Number(input.guildId)}
             AND user_id = ${Number(input.userId)}
             AND created_at >= ${windowStart}
        `);
        const earnedInWindow = recent[0]?.total ?? 0;

        const { granted: capped } = applyRateCap(
          earnedInWindow,
          clamped,
          settings?.rateCapXp ?? 200,
        );
        if (capped <= 0) return null;

        const seasonXpAfter = seasonXpBefore + capped;
        // All three derived from the SAME new total — never incremented apart.
        const progression = deriveProgression(seasonXpAfter, curve);

        if (
          !progressionInvariantHolds(
            {
              seasonXp: seasonXpAfter,
              level: progression.level,
              xpInLevel: progression.xpInLevel,
            },
            curve,
          )
        ) {
          // Never write a row that violates the invariant.
          throw new Error(
            `progression invariant violated at ${seasonXpAfter}xp: level=${progression.level} xpInLevel=${progression.xpInLevel}`,
          );
        }

        if (row) {
          await tx.execute(
            sql`
              UPDATE level_profiles
                 SET season_xp = ${seasonXpAfter},
                     level = ${progression.level},
                     xp_in_level = ${progression.xpInLevel},
                     lifetime_xp = ${lifetimeBefore + capped},
                     last_xp_at = now(),
                     updated_at = now()
               WHERE id = ${row.id}
            `,
          );
        } else {
          await tx.insert(levelProfiles).values({
            guildId: Number(input.guildId),
            userId: Number(input.userId),
            seasonId,
            seasonXp: seasonXpAfter,
            level: progression.level,
            xpInLevel: progression.xpInLevel,
            lifetimeXp: capped,
            lastXpAt: new Date(),
          });
        }

        await tx.insert(levelEvents).values({
          guildId: Number(input.guildId),
          userId: Number(input.userId),
          seasonId,
          amount: capped,
          source: input.source,
          channelId: input.channelId ? Number(input.channelId) : null,
        });

        const levels = crossedLevels(seasonXpBefore, seasonXpAfter, curve);

        // Reward rows are claimed INSIDE the transaction (backed by the unique
        // constraint), but DELIVERED only after commit.
        const claimedRewardIds: string[] = [];
        if (levels.length > 0) {
          const rewards = await tx
            .select({
              id: levelRewards.id,
              level: levelRewards.level,
              rewardType: levelRewards.type,
            })
            .from(levelRewards)
            .where(eq(levelRewards.guildId, Number(input.guildId)));

          for (const reward of rewards) {
            if (!levels.includes(reward.level)) continue;

            // The unique constraint on (guild, user, reward_id, season) is what
            // makes this idempotent — re-deriving never double-grants.
            const inserted = await tx
              .insert(levelRewardsGranted)
              .values({
                guildId: Number(input.guildId),
                userId: Number(input.userId),
                rewardId: reward.id,
                seasonId,
                status: 'PENDING',
              })
              .onConflictDoNothing()
              .returning({ id: levelRewardsGranted.id });

            if (inserted.length === 0) continue;

            // One logical delivery per (guild, user, source, sourceId, reward),
            // so a replayed grant enqueues at most one delivery.
            await tx
              .insert(rewardDeliveries)
              .values({
                guildId: Number(input.guildId),
                userId: Number(input.userId),
                source: 'LEVEL',
                sourceId: seasonId,
                rewardId: reward.id,
                rewardType: reward.rewardType,
                status: 'PENDING',
              })
              .onConflictDoNothing();

            claimedRewardIds.push(reward.id);
          }
        }

        return {
          levelBefore,
          levelAfter: progression.level,
          xpGained: capped,
          xpIntoLevel: progression.xpInLevel,
          xpToNextLevel: progression.xpToNext,
          levelsCrossed: levels,
          lifetimeXp: lifetimeBefore + capped,
          rewardIds: claimedRewardIds,
        };
      });

      if (!result) {
        const current = await this.profile(input.guildId, input.userId);
        return {
          levelBefore: current?.level ?? 0,
          levelAfter: current?.level ?? 0,
          xpGained: 0,
          xpIntoLevel: current?.xpIntoLevel ?? 0,
          xpToNextLevel: current?.xpToNextLevel ?? null,
          levelsCrossed: [],
          lifetimeXp: current?.lifetimeXp ?? 0,
          rewardIds: [],
        };
      }

      // AFTER COMMIT ONLY. A rolled-back award must never enqueue delivery.
      for (const rewardId of result.rewardIds) {
        options.enqueueRewardDelivery?.({
          guildId: input.guildId,
          userId: input.userId,
          rewardId,
          level: result.levelAfter,
          seasonId,
        });
      }

      return result;
    },

    async profile(guildId, userId) {
      const seasonId = await activeSeasonId(guildId);
      if (!seasonId) return null;

      const rows = await db
        .select({
          seasonXp: levelProfiles.seasonXp,
          level: levelProfiles.level,
          xpInLevel: levelProfiles.xpInLevel,
          lifetimeXp: levelProfiles.lifetimeXp,
        })
        .from(levelProfiles)
        .where(
          and(
            eq(levelProfiles.guildId, Number(guildId)),
            eq(levelProfiles.userId, Number(userId)),
            eq(levelProfiles.seasonId, seasonId),
          ),
        )
        .limit(1);

      const row = rows[0];
      if (!row) return null;

      // Derived, never read from the row: the displayed value is always
      // consistent with season_xp even if the row were ever stale.
      const progression = deriveProgression(row.seasonXp, curve);
      return {
        level: progression.level,
        seasonXp: row.seasonXp,
        lifetimeXp: row.lifetimeXp,
        xpIntoLevel: progression.xpInLevel,
        xpToNextLevel: progression.xpToNext,
      };
    },

    async backfillProgression() {
      const rows = await db.execute<{
        id: string;
        season_xp: number;
        level: number;
        xp_in_level: number;
      }>(sql`
        SELECT id, season_xp, level, xp_in_level
          FROM level_profiles
         WHERE season_xp <> 0
         LIMIT 5000
      `);

      let repaired = 0;
      for (const row of rows) {
        const progression = deriveProgression(row.season_xp, curve);
        if (progression.level === row.level && progression.xpInLevel === row.xp_in_level) {
          continue;
        }
        await db.execute(
          sql`
            UPDATE level_profiles
               SET level = ${progression.level},
                   xp_in_level = ${progression.xpInLevel},
                   updated_at = now()
             WHERE id = ${row.id}
          `,
        );
        repaired += 1;
      }

      if (repaired > 0) log().warn({ repaired }, 'repaired rows violating the progression invariant');
      return repaired;
    },

    async freezeSeasonLeaderboard(seasonId) {
      // Snapshots are written BEFORE the rollover so final standings are
      // preserved even after the season starts counting from zero again.
      const inserted = await db.execute<{ frozen: number }>(sql`
        WITH frozen AS (
          INSERT INTO season_leaderboards (season_id, user_id, level, season_xp)
          SELECT season_id, user_id, level, season_xp
            FROM level_profiles
           WHERE season_id = ${seasonId}
          ON CONFLICT DO NOTHING
          RETURNING 1
        )
        SELECT count(*)::int AS frozen FROM frozen
      `);
      const count = inserted[0]?.frozen ?? 0;
      log().info({ seasonId, count }, 'season leaderboard frozen');
      return count;
    },
  };
}

/** Stable job key so a replayed delivery enqueues at most once. */
export function rewardDeliveryKey(input: {
  guildId: string;
  userId: string;
  rewardId: string;
  seasonId: string;
}): string {
  return `reward:${input.guildId}:${input.userId}:${input.rewardId}`;
}
