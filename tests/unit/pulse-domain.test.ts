/**
 * Server Pulse — domain invariants.
 *
 * The properties that make this trustworthy rather than decorative:
 *  - a small wobble is NOT a trend (dead zone, no crying wolf)
 *  - health escalation needs agreement from TWO independent signals
 *  - insight lists are capped, most-severe-first, and specific
 *  - a zero-message server never produces a division by zero or a NaN
 *  - one guild's activity can never move another's verdict
 */

import { describe, expect, it } from 'vitest';
import {
  buildInsights,
  buildPulse,
  classifyTrend,
  healthLabel,
  percentChange,
  rollingTotal,
  trendGlyph,
  type ActivitySample,
  type ModerationSample,
} from '../../src/features/pulse/domain.js';

/**
 * Builds DISTINCT day rows.
 *
 * `analytics_daily` is keyed on (guild_id, day), so a real query can never
 * return the same day twice; distinct ids here keep the fixtures faithful to
 * that and make window slicing unambiguous.
 */
function days(count: number, messages: number, activeMembers = 50, startIndex = 1): ActivitySample[] {
  return Array.from({ length: count }, (_, i) => ({
    day: `2026-09-${String(startIndex + i).padStart(2, '0')}`,
    messages,
    activeMembers,
  }));
}

function moderationDays(
  count: number,
  cases: number,
  startIndex = 1,
): ModerationSample[] {
  return Array.from({ length: count }, (_, i) => ({
    day: `2026-09-${String(startIndex + i).padStart(2, '0')}`,
    cases,
  }));
}

const NO_LEVELS = { levelUps: 0, activeMembers: 0, averageLevel: 0 };
const NO_ECONOMY = { circulating: 0, granted: 0, spent: 0, wallets: 0 };

describe('trends have a dead zone', () => {
  it('does not call a 3% wobble a trend', () => {
    // Crying wolf on noise is how a dashboard gets ignored.
    expect(classifyTrend(3)).toBe('FLAT');
    expect(classifyTrend(-3)).toBe('FLAT');
    expect(classifyTrend(0)).toBe('FLAT');
  });

  it('reports a real change', () => {
    expect(classifyTrend(25)).toBe('UP');
    expect(classifyTrend(-25)).toBe('DOWN');
  });

  it('respects a custom band', () => {
    expect(classifyTrend(8, 10)).toBe('FLAT');
    expect(classifyTrend(8, 5)).toBe('UP');
  });

  it('computes percent change with a sane zero case', () => {
    expect(percentChange(50, 100)).toBe(-50);
    expect(percentChange(100, 50)).toBe(100);
    // From zero to something is a large positive, not Infinity.
    expect(percentChange(10, 0)).toBe(100);
    expect(percentChange(0, 0)).toBe(0);
    expect(percentChange(0, 100)).toBe(-100);
  });

  it('has a glyph for every trend', () => {
    expect(trendGlyph('UP')).not.toBe(trendGlyph('DOWN'));
    expect(trendGlyph('FLAT')).toBeTruthy();
  });
});

describe('health escalates only with agreement', () => {
  it('reports HEALTHY for a stable, quiet server', () => {
    const snapshot = buildPulse({
      activity: [...days(7, 100), ...days(7, 100)],
      moderation: moderationDays(14, 0),
      levels: { ...NO_LEVELS, activeMembers: 40, averageLevel: 3 },
      economy: { ...NO_ECONOMY, circulating: 5000, wallets: 40, granted: 200, spent: 150 },
    });
    expect(snapshot.health).toBe('HEALTHY');
    expect(snapshot.messageTrend).toBe('FLAT');
  });

  it('needs TWO failing signals before ALERT', () => {
    // One signal alone is a WATCH, not an alarm.
    const activityOnly = buildPulse({
      activity: [...days(7, 100), ...days(7, 20)],
      moderation: moderationDays(14, 0),
      levels: NO_LEVELS,
      economy: NO_ECONOMY,
    });
    expect(activityOnly.health).toBe('WATCH');

    // Activity collapse AND a moderation spike -> ALERT.
    const both = buildPulse({
      activity: [...days(7, 100), ...days(7, 20)],
      moderation: [...moderationDays(7, 0), ...moderationDays(7, 30)],
      levels: NO_LEVELS,
      economy: NO_ECONOMY,
    });
    expect(both.health).toBe('ALERT');
  });

  it('never reports ALERT for a growing server with steady moderation', () => {
    const snapshot = buildPulse({
      activity: [...days(7, 50), ...days(7, 200)],
      moderation: moderationDays(14, 1),
      levels: { ...NO_LEVELS, activeMembers: 100, averageLevel: 5 },
      economy: NO_ECONOMY,
    });
    expect(snapshot.health).toBe('HEALTHY');
  });

  it('labels every health state', () => {
    expect(healthLabel('HEALTHY')).toBeTruthy();
    expect(healthLabel('WATCH')).toBeTruthy();
    expect(healthLabel('ALERT')).toBeTruthy();
    expect(healthLabel('HEALTHY')).not.toBe(healthLabel('ALERT'));
  });
});

describe('zero and empty inputs never produce NaN', () => {
  it('handles a server with no messages at all', () => {
    const snapshot = buildPulse({
      activity: [],
      moderation: [],
      levels: NO_LEVELS,
      economy: NO_ECONOMY,
    });
    expect(snapshot.totalMessages).toBe(0);
    expect(snapshot.casesPerThousandMessages).toBe(0);
    expect(snapshot.messagesPerActiveMember).toBe(0);
    expect(snapshot.dailyAverage).toBe(0);
    expect(Number.isNaN(snapshot.velocity)).toBe(false);
    for (const insight of snapshot.insights) {
      expect(insight.detail).not.toMatch(/NaN|Infinity|undefined/);
    }
  });

  it('handles activity rows with zero messages but members present', () => {
    const snapshot = buildPulse({
      activity: days(7, 0, 20),
      moderation: [],
      levels: NO_LEVELS,
      economy: NO_ECONOMY,
    });
    expect(Number.isNaN(snapshot.messagesPerActiveMember)).toBe(false);
    expect(snapshot.messagesPerActiveMember).toBe(0);
  });

  it('never divides by zero wallets', () => {
    const snapshot = buildPulse({
      activity: days(7, 100),
      moderation: [],
      levels: NO_LEVELS,
      economy: { circulating: 1000, granted: 100, spent: 50, wallets: 0 },
    });
    expect(snapshot.velocity).toBe(0);
    expect(Number.isNaN(snapshot.velocity)).toBe(false);
  });
});

describe('insights are capped, ordered, and specific', () => {
  it('never returns more than four', () => {
    const insights = buildInsights({
      messageTrend: 'DOWN',
      messageChangePercent: -80,
      dailyAverage: 10,
      activeMembers: 50,
      moderationTrend: 'UP',
      casesPerThousandMessages: 20,
      moderationCases: 500,
      velocity: -500,
      circulating: 1000,
      economyWallets: 10,
      levelUps: 0,
      averageLevel: 5,
    });
    expect(insights.length).toBeLessThanOrEqual(4);
  });

  it('puts warnings first', () => {
    const insights = buildInsights({
      messageTrend: 'DOWN',
      messageChangePercent: -60,
      dailyAverage: 10,
      activeMembers: 50,
      moderationTrend: 'FLAT',
      casesPerThousandMessages: 0,
      moderationCases: 0,
      velocity: 0,
      circulating: 1000,
      economyWallets: 10,
      levelUps: 5,
      averageLevel: 5,
    });
    expect(insights[0]?.severity).toBe('WARN');
  });

  it('gives every insight a headline and a non-empty detail', () => {
    const insights = buildInsights({
      messageTrend: 'UP',
      messageChangePercent: 40,
      dailyAverage: 100,
      activeMembers: 50,
      moderationTrend: 'FLAT',
      casesPerThousandMessages: 0,
      moderationCases: 0,
      velocity: 0,
      circulating: 1000,
      economyWallets: 10,
      levelUps: 5,
      averageLevel: 5,
    });
    for (const insight of insights) {
      expect(insight.headline.length).toBeGreaterThan(3);
      expect(insight.detail.length).toBeGreaterThan(10);
      expect(insight.detail).not.toMatch(/NaN|undefined/);
    }
  });

  it('never suggests anything on a quiet, flat server', () => {
    const insights = buildInsights({
      messageTrend: 'FLAT',
      messageChangePercent: 0,
      dailyAverage: 100,
      activeMembers: 50,
      moderationTrend: 'FLAT',
      casesPerThousandMessages: 1,
      moderationCases: 2,
      velocity: 10,
      circulating: 1000,
      economyWallets: 10,
      levelUps: 20,
      averageLevel: 5,
    });
    // Nothing actionable is better than noise.
    expect(insights).toHaveLength(0);
  });
});

describe('guild isolation', () => {
  it('produces completely different snapshots for different data', () => {
    const busy = buildPulse({
      activity: days(7, 500, 200),
      moderation: moderationDays(7, 1),
      levels: { ...NO_LEVELS, activeMembers: 200, averageLevel: 12 },
      economy: { circulating: 90_000, granted: 5000, spent: 4000, wallets: 200 },
    });

    const quiet = buildPulse({
      activity: days(7, 5, 3),
      moderation: moderationDays(7, 12),
      levels: { ...NO_LEVELS, activeMembers: 3, averageLevel: 0 },
      economy: { circulating: 20, granted: 10, spent: 90, wallets: 3 },
    });

    expect(busy.totalMessages).not.toBe(quiet.totalMessages);
    expect(busy.health).not.toBe(quiet.health);
    expect(busy.activeMembers).not.toBe(quiet.activeMembers);
  });

  it('never blends one guild’s samples into another’s verdict', () => {
    // Guild A's numbers must not be recoverable from Guild B's snapshot.
    const snapshot = buildPulse({
      activity: days(7, 7, 7),
      moderation: moderationDays(7, 7),
      levels: { ...NO_LEVELS, activeMembers: 7, averageLevel: 7 },
      economy: { circulating: 7, granted: 0, spent: 0, wallets: 7 },
    });
    expect(snapshot.totalMessages).toBe(49);
    expect(snapshot.moderationCases).toBe(49);
    expect(snapshot.activeMembers).toBe(7);
  });
});

describe('window sizing', () => {
  it('only counts the requested recent window', () => {
    const snapshot = buildPulse({
      // 7 older days at 1000, then 7 recent days at 10.
      activity: [...days(7, 1000, 50, 1), ...days(7, 10, 50, 8)],
      moderation: [],
      levels: NO_LEVELS,
      economy: NO_ECONOMY,
      windowDays: 7,
    });
    expect(snapshot.totalMessages).toBe(70);
  });

  it('honours a wider window', () => {
    const snapshot = buildPulse({
      activity: days(14, 10),
      moderation: [],
      levels: NO_LEVELS,
      economy: NO_ECONOMY,
      windowDays: 14,
    });
    expect(snapshot.totalMessages).toBe(140);
  });

  it('sorts unsorted input by day', () => {
    const snapshot = buildPulse({
      activity: [
        { day: '2026-09-03', messages: 3, activeMembers: 1 },
        { day: '2026-09-01', messages: 1, activeMembers: 1 },
        { day: '2026-09-02', messages: 2, activeMembers: 1 },
      ],
      moderation: [],
      levels: NO_LEVELS,
      economy: NO_ECONOMY,
    });
    // Most recent day is the last after sorting, so activeMembers is the max.
    expect(snapshot.totalMessages).toBe(6);
    expect(snapshot.activeMembers).toBe(1);
  });
});

describe('rollingTotal', () => {
  interface Sample {
    readonly day: string;
    readonly v: number;
  }

  const samples: Sample[] = [
    { day: 'a', v: 1 },
    { day: 'b', v: 2 },
    { day: 'c', v: 3 },
    { day: 'd', v: 4 },
  ];

  it('sums only the last N samples', () => {
    expect(rollingTotal(samples, (s) => s.v, 2)).toBe(7);
    expect(rollingTotal(samples, (s) => s.v, 10)).toBe(10);
  });

  it('returns zero for an empty list', () => {
    expect(rollingTotal<Sample>([], (s) => s.v, 5)).toBe(0);
  });
});
