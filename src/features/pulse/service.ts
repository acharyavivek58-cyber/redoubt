/**
 * Server Pulse — data service.
 *
 * Reads ONLY tables REDOUBT ALREADY HAS: `analytics_daily`, `message_analytics`,
 * `mod_cases`, `level_profiles`, `economy_wallets`, and `economy_transactions`.
 * No new tables, no new infrastructure.
 *
 * GUILD SCOPING IS THE POINT. Every query is filtered on `guild_id` supplied by
 * the RESOLVED interaction, never by anything a caller could invent. Two
 * guilds' Pulse must never mix, and the cache key includes the guild id for the
 * same reason.
 */

import { and, eq, gte, sql } from 'drizzle-orm';
import type { Database } from '../../core/db/client.js';
import { analyticsDaily } from '../../core/db/schema/modules.js';
import { lazyLogger } from '../../core/logging/logger.js';
import {
  buildPulse,
  type ActivitySample,
  type ModerationSample,
  type PulseSnapshot,
} from './domain.js';

const log = lazyLogger({ module: 'pulse', operation: 'service' });

interface CachedSnapshot {
  readonly expiresAt: number;
  readonly snapshot: PulseSnapshot;
}

export interface PulseService {
  snapshot(input: {
    readonly guildId: string;
    readonly windowDays?: number;
  }): Promise<PulseSnapshot | null>;
  invalidate(guildId: string): void;
}

export interface PulseServiceOptions {
  readonly ttlMs?: number;
}

export function createPulseService(
  db: Database,
  options: PulseServiceOptions = {},
): PulseService {
  const ttlMs = options.ttlMs ?? 60_000;
  const cache = new Map<string, CachedSnapshot>();
  const pending = new Map<string, Promise<PulseSnapshot | null>>();

  function dayString(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  async function load(guildId: string, windowDays: number): Promise<PulseSnapshot | null> {
    const numeric = Number(guildId);
    if (!Number.isFinite(numeric)) return null;

    // Fetch twice the window so a previous-period comparison is possible.
    const since = new Date(Date.now() - windowDays * 2 * 86_400_000);
    const sinceDay = dayString(since);

    const [activityRows, moderationRows, levelRow, walletRow, flowRow] = await Promise.all([
      db
        .select({
          day: analyticsDaily.day,
          messages: analyticsDaily.messages,
          activeMembers: analyticsDaily.activeMembers,
        })
        .from(analyticsDaily)
        .where(and(eq(analyticsDaily.guildId, numeric), gte(analyticsDaily.day, sinceDay)))
        .orderBy(analyticsDaily.day),

      // Cases are counted per day from the existing case table rather than a
      // new rollup, so Pulse adds no storage.
      db.execute<{ day: string; cases: number }>(sql`
        SELECT to_char(created_at, 'YYYY-MM-DD') AS day, count(*)::int AS cases
          FROM mod_cases
         WHERE guild_id = ${numeric}
           AND created_at >= ${since}
         GROUP BY 1
         ORDER BY 1
      `),

      db.execute<{ level_ups: number; avg_level: number; members: number }>(sql`
        SELECT count(*)::int AS members,
               COALESCE(avg(level), 0)::numeric(6,2) AS avg_level,
               count(*) FILTER (WHERE season_xp > 0)::int AS level_ups
          FROM level_profiles
         WHERE guild_id = ${numeric}
      `),

      db.execute<{ circulating: number; wallets: number }>(sql`
        SELECT COALESCE(sum(balance), 0)::bigint AS circulating,
               count(*)::int AS wallets
          FROM economy_wallets
         WHERE guild_id = ${numeric}
      `),

      db.execute<{ granted: number; spent: number }>(sql`
        SELECT COALESCE(sum(amount) FILTER (WHERE amount > 0), 0)::bigint AS granted,
               COALESCE(-sum(amount) FILTER (WHERE amount < 0), 0)::bigint AS spent
          FROM economy_transactions
         WHERE guild_id = ${numeric}
           AND created_at >= ${since}
      `),
    ]);

    const activity: ActivitySample[] = activityRows.map((row) => ({
      day: row.day,
      messages: row.messages,
      activeMembers: row.activeMembers,
    }));

    // Nothing recorded yet: the caller renders the empty state rather than a
    // dashboard full of zeros.
    if (activity.length === 0) return null;

    const moderation: ModerationSample[] = moderationRows.map((row) => ({
      day: row.day,
      cases: row.cases,
    }));

    const level = levelRow[0];
    const wallet = walletRow[0];
    const flow = flowRow[0];

    return buildPulse({
      activity,
      moderation,
      levels: {
        levelUps: level?.level_ups ?? 0,
        activeMembers: level?.members ?? 0,
        averageLevel: Number(level?.avg_level ?? 0),
      },
      economy: {
        circulating: Number(wallet?.circulating ?? 0),
        wallets: wallet?.wallets ?? 0,
        granted: Number(flow?.granted ?? 0),
        spent: Number(flow?.spent ?? 0),
      },
      windowDays,
    });
  }

  return {
    async snapshot({ guildId, windowDays = 7 }) {
      const key = `${guildId}:${windowDays}`;
      const hit = cache.get(key);
      if (hit && hit.expiresAt > Date.now()) return hit.snapshot;

      const inFlight = pending.get(key);
      if (inFlight) return inFlight;

      const task = load(guildId, windowDays)
        .then((snapshot) => {
          if (snapshot) cache.set(key, { expiresAt: Date.now() + ttlMs, snapshot });
          return snapshot;
        })
        .catch((error: unknown) => {
          // A dashboard outage must not break the command; degrade to empty.
          log().error({ err: error, guildId }, 'pulse snapshot failed');
          return null;
        })
        .finally(() => {
          pending.delete(key);
        });

      pending.set(key, task);
      return task;
    },

    invalidate(guildId) {
      // Drop every window variant for this guild.
      for (const key of [...cache.keys()]) {
        if (key.startsWith(`${guildId}:`)) cache.delete(key);
      }
    },
  };
}

/** Days currently inside the persisted analytics window. */
export function analyticsRetentionDays(): number {
  // Kept as a named constant so retention is a single decision, not a literal
  // repeated across queries.
  return 90;
}

/** Re-exported so the command layer does not import two modules for one type. */
export type { PulseSnapshot };
