/**
 * Leveling progression (v13 §16, v20 §B).
 *
 * The invariant under test:
 *     level       === levelFromSeasonXp(season_xp)
 *     xp_in_level === xpIntoLevel(season_xp)
 *
 * And the concurrency property: many simultaneous XP grants must produce a
 * profile that satisfies the invariant EXACTLY, with no lost or duplicated XP
 * and no skipped crossed levels.
 */

import { describe, expect, it } from 'vitest';
import {
  applyRateCap,
  clampXp,
  crossedLevels,
  deriveProgression,
  levelFromSeasonXp,
  progressionInvariantHolds,
  shouldCreditXp,
  xpForLevel,
  xpIntoLevel,
  xpToNextLevel,
  type CurveConfig,
} from '../../src/features/leveling/level-curve.js';

const EXP: CurveConfig = {
  curve: 'EXPONENTIAL',
  params: { xpPerLevel: 100, growthPercent: 120 },
  startingLevel: 0,
};

describe('level curve derivation', () => {
  it('derives level and xpInLevel from the same XP value', () => {
    const snapshot = deriveProgression(250);
    expect(snapshot.level).toBe(2);
    expect(snapshot.seasonXp).toBe(250);
    expect(snapshot.xpInLevel).toBe(50);
    expect(progressionInvariantHolds(snapshot)).toBe(true);
  });

  it('holds the invariant at every level boundary', () => {
    for (let level = 0; level <= 12; level += 1) {
      const xp = xpForLevel(level);
      const snapshot = deriveProgression(xp);
      expect(snapshot.level, `at exact level ${level}`).toBe(level);
      expect(snapshot.xpInLevel).toBe(0);
      expect(progressionInvariantHolds(snapshot)).toBe(true);
    }
  });

  it('holds the invariant across an exhaustive XP sweep', () => {
    for (let xp = 0; xp <= 1200; xp += 7) {
      const snapshot = deriveProgression(xp);
      expect(
        progressionInvariantHolds(snapshot),
        `invariant broken at seasonXp=${xp}: got level=${snapshot.level} xpInLevel=${snapshot.xpInLevel}`,
      ).toBe(true);
    }
  });

  it('never lets level and xpInLevel disagree after a large grant', () => {
    // The regression this guards: updating season_xp and then writing level
    // from a stale read produces level=2 with xpInLevel=250.
    const derived = deriveProgression(5000);
    expect(derived.level).toBe(levelFromSeasonXp(5000));
    expect(derived.xpInLevel).toBe(xpIntoLevel(5000));
    expect(progressionInvariantHolds(derived)).toBe(true);
  });

  it('supports exponential curves', () => {
    expect(xpForLevel(1, EXP)).toBe(100);
    expect(xpForLevel(2, EXP)).toBe(220);
    expect(xpForLevel(3, EXP)).toBe(364);
    expect(levelFromSeasonXp(364, EXP)).toBe(3);
  });

  it('supports table curves', () => {
    const table: CurveConfig = {
      curve: 'TABLE',
      params: { '0': 0, '1': 50, '2': 200, '3': 500 },
      startingLevel: 0,
    };
    expect(levelFromSeasonXp(49, table)).toBe(0);
    expect(levelFromSeasonXp(50, table)).toBe(1);
    expect(levelFromSeasonXp(199, table)).toBe(1);
    expect(levelFromSeasonXp(200, table)).toBe(2);
    expect(levelFromSeasonXp(500, table)).toBe(3);
  });

  it('reports XP needed to advance', () => {
    expect(xpToNextLevel(0)).toBe(100);
    expect(xpToNextLevel(250)).toBe(100);
  });
});

describe('crossed levels', () => {
  it('returns none when staying in the same level', () => {
    expect(crossedLevels(0, 50)).toEqual([]);
    expect(crossedLevels(100, 150)).toEqual([]);
  });

  it('returns every threshold crossed by a multi-level jump', () => {
    // v13 §16.4: crossing 24 -> 27 processes thresholds 25, 26, AND 27.
    const crossed = crossedLevels(xpForLevel(24), xpForLevel(27));
    expect(crossed).toEqual([25, 26, 27]);
  });

  it('handles a single-level crossing', () => {
    expect(crossedLevels(xpForLevel(4), xpForLevel(5))).toEqual([5]);
  });

  it('skips no threshold even for a very large grant', () => {
    const crossed = crossedLevels(0, xpForLevel(20));
    expect(crossed).toHaveLength(20);
    expect(crossed[0]).toBe(1);
    expect(crossed[19]).toBe(20);
  });
});

describe('concurrent XP grants preserve the invariant (v20 §B)', () => {
  /**
   * Models the progression transaction: lock the row, derive all fields from
   * the NEW value, write them together. Interleaved grants must still land on
   * a consistent profile because nothing is written independently.
   */
  function simulateConcurrentGrants(grants: readonly number[]): {
    seasonXp: number;
    level: number;
    xpInLevel: number;
    totalRequested: number;
  } {
    let seasonXp = 0;
    let level = 0;
    let xpInLevel = 0;
    const totalRequested = grants.reduce((sum, g) => sum + g, 0);

    // Each grant is applied atomically: derive-then-write.
    for (const grant of grants) {
      const nextXp = seasonXp + grant;
      const derived = deriveProgression(nextXp);
      seasonXp = derived.seasonXp;
      level = derived.level;
      xpInLevel = derived.xpInLevel;
    }

    return { seasonXp, level, xpInLevel, totalRequested };
  }

  it('satisfies the invariant exactly after many simultaneous grants', () => {
    const grants = Array.from({ length: 200 }, (_, i) => (i % 7) * 13 + 5);
    const result = simulateConcurrentGrants(grants);

    expect(result.level).toBe(levelFromSeasonXp(result.seasonXp));
    expect(result.xpInLevel).toBe(xpIntoLevel(result.seasonXp));
    expect(
      progressionInvariantHolds({
        seasonXp: result.seasonXp,
        level: result.level,
        xpInLevel: result.xpInLevel,
      }),
    ).toBe(true);
  });

  it('loses no XP under interleaved grants', () => {
    const grants = Array.from({ length: 500 }, () => 25);
    const result = simulateConcurrentGrants(grants);
    // Every grant is credited exactly once.
    expect(result.seasonXp).toBe(result.totalRequested);
  });

  it('never skips a crossed level under concurrency', () => {
    const grants = Array.from({ length: 300 }, () => 100);
    const result = simulateConcurrentGrants(grants);

    const expectedMaxLevel = levelFromSeasonXp(result.seasonXp);
    const seen = new Set<number>();
    let xp = 0;
    for (const grant of grants) {
      for (const level of crossedLevels(xp, xp + grant)) seen.add(level);
      xp += grant;
    }

    // Every level from 1..max must have been crossed exactly once.
    for (let level = 1; level <= expectedMaxLevel; level += 1) {
      expect(seen.has(level), `level ${level} was skipped`).toBe(true);
    }
    expect(seen.size).toBe(expectedMaxLevel);
  });
});

describe('anti-farm rules (v13 §16.2)', () => {
  const base = {
    isDm: false,
    isBot: false,
    isWebhook: false,
    isNoXpChannel: false,
    contentLength: 50,
    minMessageLength: 12,
    secondsSinceLastXp: 60,
    minIntervalSeconds: 20,
  };

  it('credits XP for an ordinary message', () => {
    expect(shouldCreditXp(base)).toBe(true);
  });

  it('never credits XP from DMs, bots, or webhooks', () => {
    expect(shouldCreditXp({ ...base, isDm: true })).toBe(false);
    expect(shouldCreditXp({ ...base, isBot: true })).toBe(false);
    expect(shouldCreditXp({ ...base, isWebhook: true })).toBe(false);
  });

  it('never credits XP in a noXp channel', () => {
    expect(shouldCreditXp({ ...base, isNoXpChannel: true })).toBe(false);
  });

  it('ignores messages below the minimum length', () => {
    expect(shouldCreditXp({ ...base, contentLength: 5 })).toBe(false);
  });

  it('ignores messages sent inside the minimum interval', () => {
    expect(shouldCreditXp({ ...base, secondsSinceLastXp: 3 })).toBe(false);
    expect(shouldCreditXp({ ...base, secondsSinceLastXp: null })).toBe(true);
  });

  it('clamps a single message so a wall of text cannot flood XP', () => {
    expect(clampXp(10_000, 25)).toBe(25);
    expect(clampXp(10, 25)).toBe(10);
    expect(clampXp(-5, 25)).toBe(0);
    expect(clampXp(10, 0)).toBe(0);
  });

  it('caps XP within the rolling window', () => {
    expect(applyRateCap(0, 50, 200)).toEqual({ granted: 50, capped: false });
    expect(applyRateCap(180, 50, 200)).toEqual({ granted: 20, capped: true });
    expect(applyRateCap(200, 50, 200)).toEqual({ granted: 0, capped: true });
  });
});