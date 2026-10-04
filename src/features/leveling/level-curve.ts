/**
 * Level curve service (v13 §16.3, v20 §B).
 *
 * THE ONLY source of `level` and `xp_in_level`. Both are pure functions of
 * `seasonXp`, which is what makes the invariant enforceable:
 *
 *     level       === levelFromSeasonXp(season_xp)
 *     xp_in_level === xpIntoLevel(season_xp)
 *
 * Because both derive from the SAME new value inside the same transaction that
 * updates `season_xp`, concurrent messages cannot produce a stale level or a
 * stale xp_in_level. An atomic increment on `season_xp` alone would NOT be
 * sufficient: a separate write of `level` would let two concurrent updates
 * clobber each other with stale values.
 */

export type LevelCurve = 'LINEAR' | 'EXPONENTIAL' | 'TABLE';

export interface CurveConfig {
  readonly curve: LevelCurve;
  /** XP required for LINEAR: xpPerLevel. For EXPONENTIAL: growth factor ×100. */
  readonly params: Readonly<Record<string, number>>;
  readonly startingLevel: number;
}

export const DEFAULT_CURVE: CurveConfig = {
  curve: 'LINEAR',
  params: { xpPerLevel: 100 },
  startingLevel: 0,
};

/**
 * Total XP required to REACH `level`. Monotonically increasing.
 *
 * Throws for a TABLE level beyond the configured table; use
 * `isDefinedLevel` to probe before calling.
 */
export function xpForLevel(level: number, config: CurveConfig = DEFAULT_CURVE): number {
  if (level <= config.startingLevel) return 0;

  switch (config.curve) {
    case 'LINEAR': {
      const per = config.params.xpPerLevel ?? 100;
      return (level - config.startingLevel) * per;
    }
    case 'EXPONENTIAL': {
      const per = config.params.xpPerLevel ?? 100;
      const growth = (config.params.growthPercent ?? 100) / 100;
      const steps = level - config.startingLevel;
      // Closed form of a geometric series. The previous implementation summed
      // term by term, which was O(level) on the hottest read path in leveling;
      // this is O(1) and exactly equal for growth === 1.
      if (growth === 1) return per * steps;
      return Math.floor((per * (growth ** steps - 1)) / (growth - 1));
    }
    case 'TABLE': {
      const value = config.params[String(level)];
      if (value === undefined) {
        throw new Error(`Level curve TABLE is missing an entry for level ${level}.`);
      }
      return value;
    }
    default:
      return (level - config.startingLevel) * (config.params.xpPerLevel ?? 100);
  }
}

/** True when the curve defines `level`. False past the end of a TABLE. */
export function isDefinedLevel(level: number, config: CurveConfig): boolean {
  if (level <= config.startingLevel) return true;
  if (config.curve === 'TABLE') return config.params[String(level)] !== undefined;
  return true;
}

/**
 * Derives the level from XP.
 *
 * Must be exact for every XP value — the invariant is asserted directly.
 */
export function levelFromSeasonXp(seasonXp: number, config: CurveConfig = DEFAULT_CURVE): number {
  if (seasonXp <= 0) return config.startingLevel;

  // A TABLE curve is finite: once the highest entry is reached the user is at
  // MAX level. Probing one past the end must clamp, not throw — otherwise a
  // member who maxes out would crash every progression read.
  //
  // Binary search rather than a walk: this runs on every message from every
  // member, and a linear scan made a high-XP member cost milliseconds per read.
  if (config.curve === 'TABLE') {
    let lo = config.startingLevel;
    let hi = config.startingLevel;
    // Upper bound: the largest level the table defines.
    while (isDefinedLevel(hi + 1, config)) {
      hi += 1;
      if (hi - config.startingLevel > 100_000) break;
    }

    // Invariant: xpForLevel(lo) <= seasonXp, and the answer lies in [lo, hi].
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (xpForLevel(mid, config) <= seasonXp) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  if (config.curve === 'LINEAR') {
    // Closed form of the inverse: no search at all.
    const per = config.params.xpPerLevel ?? 100;
    if (per <= 0) return config.startingLevel;
    return config.startingLevel + Math.floor(seasonXp / per);
  }

  // EXPONENTIAL: estimate with logs, then correct. `xpForLevel` is monotone,
  // so at most a couple of corrections are ever needed regardless of how far
  // ahead the estimate landed.
  const per = config.params.xpPerLevel ?? 100;
  const growth = (config.params.growthPercent ?? 100) / 100;
  if (growth <= 1 || per <= 0) return config.startingLevel + Math.floor(seasonXp / per);

  // Solve n from: seasonXp = per * (g^n - 1) / (g - 1)
  const estimate = Math.floor(
    Math.log((seasonXp * (growth - 1)) / per + 1) / Math.log(growth),
  );
  let level = config.startingLevel + Math.max(0, estimate);

  while (xpForLevel(level + 1, config) <= seasonXp) level += 1;
  while (level > config.startingLevel && xpForLevel(level, config) > seasonXp) level -= 1;
  return level;
}

/** Derives XP accumulated within the current level. */
export function xpIntoLevel(seasonXp: number, config: CurveConfig = DEFAULT_CURVE): number {
  const level = levelFromSeasonXp(seasonXp, config);
  return Math.max(0, seasonXp - xpForLevel(level, config));
}

/** XP required to advance from `level` to the next. 0 at MAX level. */
export function xpToNextLevel(seasonXp: number, config: CurveConfig = DEFAULT_CURVE): number {
  const level = levelFromSeasonXp(seasonXp, config);
  if (!isDefinedLevel(level + 1, config)) return 0;
  return Math.max(1, xpForLevel(level + 1, config) - xpForLevel(level, config));
}

export interface ProgressionSnapshot {
  readonly seasonXp: number;
  readonly level: number;
  readonly xpInLevel: number;
  readonly xpToNext: number;
}

/**
 * Derives every progression field from ONE xp value.
 *
 * This is the function the progression transaction uses so the three stored
 * columns can never disagree.
 */
export function deriveProgression(
  seasonXp: number,
  config: CurveConfig = DEFAULT_CURVE,
): ProgressionSnapshot {
  // Computed ONCE and reused. The previous version called levelFromSeasonXp
  // here and again inside xpToNextLevel, doubling the cost of the single
  // hottest read path in leveling.
  const level = levelFromSeasonXp(seasonXp, config);
  const xpInLevel = Math.max(0, seasonXp - xpForLevel(level, config));
  const xpToNext = isDefinedLevel(level + 1, config)
    ? Math.max(1, xpForLevel(level + 1, config) - xpForLevel(level, config))
    : 0;

  return { seasonXp, level, xpInLevel, xpToNext };
}

/**
 * Levels strictly crossed by moving from `oldXp` to `newXp`.
 *
 * Used to select which reward thresholds to process. Strictly-between, so a
 * user exactly ON a threshold does not re-trigger it.
 */
export function crossedLevels(
  oldXp: number,
  newXp: number,
  config: CurveConfig = DEFAULT_CURVE,
): number[] {
  const oldLevel = levelFromSeasonXp(oldXp, config);
  const newLevel = levelFromSeasonXp(newXp, config);

  const crossed: number[] = [];
  for (let level = oldLevel + 1; level <= newLevel; level += 1) crossed.push(level);
  return crossed;
}

/** The invariant, as a reusable predicate. */
export function progressionInvariantHolds(
  snapshot: { seasonXp: number; level: number; xpInLevel: number },
  config: CurveConfig = DEFAULT_CURVE,
): boolean {
  return (
    snapshot.level === levelFromSeasonXp(snapshot.seasonXp, config) &&
    snapshot.xpInLevel === xpIntoLevel(snapshot.seasonXp, config)
  );
}

/**
 * Anti-farm clamp (v13 §16.2).
 *
 * A single message cannot award unbounded XP, so a wall of text cannot flood
 * the leaderboard.
 */
export function clampXp(rawXp: number, perMessageClamp: number): number {
  if (rawXp <= 0) return 0;
  return Math.min(Math.floor(rawXp), Math.max(0, perMessageClamp));
}

/**
 * Rolling rate cap (v13 §16.2).
 *
 * Caps total XP credit within a window. Evaluated INSIDE the progression
 * transaction against the locked profile row, so concurrent messages cannot
 * collectively exceed it.
 */
export function applyRateCap(
  earnedInWindow: number,
  requestedXp: number,
  capXp: number,
): { granted: number; capped: boolean } {
  const remaining = Math.max(0, capXp - earnedInWindow);
  if (requestedXp <= remaining) return { granted: requestedXp, capped: false };
  return { granted: remaining, capped: true };
}

/** True when a message should credit XP at all (v13 §16.2). */
export function shouldCreditXp(input: {
  isDm: boolean;
  isBot: boolean;
  isWebhook: boolean;
  isNoXpChannel: boolean;
  contentLength: number;
  minMessageLength: number;
  secondsSinceLastXp: number | null;
  minIntervalSeconds: number;
}): boolean {
  if (input.isDm || input.isBot || input.isWebhook) return false;
  if (input.isNoXpChannel) return false;
  if (input.contentLength < input.minMessageLength) return false;
  if (
    input.secondsSinceLastXp !== null &&
    input.secondsSinceLastXp < input.minIntervalSeconds
  ) {
    return false;
  }
  return true;
}