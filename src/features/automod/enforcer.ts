/**
 * AutoMod enforcement contract (v16 §T.11).
 *
 * This is the mechanism that makes "AutoMod can NEVER Kick/Ban/Jail"
 * STRUCTURAL rather than a review convention:
 *
 *   - `kick`, `ban`, and `jail` DO NOT EXIST on this interface, so calling one
 *     from AutoMod is a COMPILE ERROR, not a lint finding.
 *   - There is deliberately no `applySevereAction()`-style helper, no generic
 *     punishment facade, and no workflow/job/AI/recovery path that can resolve
 *     into Kick/Ban/Jail from AutoMod context.
 *   - eslint.config.js additionally blocks direct imports of moderation
 *     jail/ban/kick services from `features/automod/**`, closing the indirect
 *     path the type system cannot see.
 *
 * The ceiling is MUTE. High-severity detections alert staff with an
 * INFORMATIONAL recommendation; no destructive staff action ever occurs
 * automatically.
 */

export const AUTOMOD_ACTIONS = ['LOG', 'DELETE', 'WARN', 'MUTE'] as const;

export type AutoModAction = (typeof AUTOMOD_ACTIONS)[number];

/** Confidence gate (v14 §R.3). */
export type AutoModConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export const CONFIDENCE_RANK: Readonly<Record<AutoModConfidence, number>> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
};

export type AutoModMode = 'ACTIVE' | 'DRY_RUN' | 'DISABLED';

/** What an evaluation concluded. Records WHY it did not act (v14 §R.23). */
export type AutoModResult =
  | 'ALLOWED'
  | 'ACTIONED'
  | 'BLOCKED_BY_EXEMPTION'
  | 'SUPPRESSED_LOW_CONFIDENCE'
  | 'DRY_RUN'
  | 'ERROR';

export interface AutoModEventContext {
  readonly guildId: string;
  readonly ruleId: string;
  readonly userId: string;
  readonly channelId?: string;
  readonly messageId?: string;
  readonly confidence: AutoModConfidence;
  readonly severity: number;
  /** ORIGINAL vs NORMALIZED — v14 §R.5 requires recording which matched. */
  readonly matchSource: 'ORIGINAL' | 'NORMALIZED';
  readonly reason: string;
  readonly context?: Record<string, unknown>;
}

export interface AutoModEnforcementResult {
  readonly action: AutoModAction;
  readonly executed: boolean;
}

/**
 * The ONLY enforcement surface available to AutoMod.
 *
 * Note what is absent: no kick, no ban, no jail, no generic punish helper.
 */
export interface AutoModEnforcer {
  log(event: AutoModEventContext): Promise<void>;
  delete(event: AutoModEventContext): Promise<void>;
  warn(event: AutoModEventContext): Promise<void>;
  mute(event: AutoModEventContext, durationSeconds: number): Promise<void>;
}

/** Staff-facing alert. Recommendations are INFORMATIONAL ONLY (v16 §T.5). */
export interface AutoModStaffAlert {
  readonly guildId: string;
  readonly ruleName: string;
  readonly userId: string;
  readonly confidence: AutoModConfidence;
  readonly automaticAction: AutoModAction;
  /** e.g. 'Possible KICK / BAN / JAIL'. Never executed automatically. */
  readonly recommendedReview: string;
  readonly reason: string;
  readonly caseId?: string;
}

/** True when the configured action is one AutoMod is permitted to take. */
export function isValidAutoModAction(value: string): value is AutoModAction {
  return (AUTOMOD_ACTIONS as readonly string[]).includes(value);
}

/**
 * Rejects an unsupported action with the user-facing configuration error
 * (v16 §T.2). Used at rule-save time AND by the schema validator.
 */
export function assertValidAutoModAction(value: string, referenceId: string): AutoModAction {
  if (isValidAutoModAction(value)) return value;

  const shown = value.toUpperCase();
  throw new Error(
    [
      'AUTOMOD CONFIGURATION ERROR',
      `"${shown}" is not a valid AutoMod action.`,
      '',
      'AutoMod can automatically:  LOG · DELETE · WARN · MUTE',
      'Kick, Ban, and Jail require explicit moderation workflows.',
      `Reference: ${referenceId}`,
    ].join('\n'),
  );
}

/** Renders the rule-not-saved panel (v16 §T.15). */
export function ruleNotSavedPanel(action: string): string {
  return [
    'AUTOMOD RULE NOT SAVED',
    '',
    `Action    ${action.toUpperCase()}`,
    'Reason    AutoMod cannot perform Kick, Ban, or Jail actions.',
    'Allowed   LOG · DELETE · WARN · MUTE',
  ].join('\n');
}

export interface EscalationLadder {
  /** Ordered rungs. The MAXIMUM rung must be MUTE (v16 §T.4). */
  readonly ladder: readonly AutoModAction[];
  readonly decayMode: 'NONE' | 'FIXED_WINDOW' | 'ROLLING_WINDOW';
  readonly windowSeconds?: number;
}

/** True when the ladder never exceeds MUTE. Asserted at rule-save time. */
export function ladderCeilingIsMute(ladder: EscalationLadder): boolean {
  return ladder.ladder.every((action) => isValidAutoModAction(action));
}

/**
 * Resolves the action for a strike count.
 *
 * Stops at the last rung, so strikes beyond the ladder remain at MUTE rather
 * than escalating past it (v16 §T.11). An empty ladder means no enforcement.
 */
export function resolveLadderAction(ladder: EscalationLadder, activeStrikes: number): AutoModAction | null {
  if (ladder.ladder.length === 0) return null;
  const index = Math.min(Math.max(activeStrikes - 1, 0), ladder.ladder.length - 1);
  const action = ladder.ladder[index];
  return action && isValidAutoModAction(action) ? action : null;
}

export interface EnforcementDecision {
  readonly action: AutoModAction | null;
  readonly result: AutoModResult;
  /** What DRY_RUN would have done. Null when it would have done nothing. */
  readonly wouldHave: AutoModAction | null;
  readonly suppressedReason?: string;
}

/**
 * THE CORE DECISION (v14 §R.1 — precision before punishment).
 *
 * Order matters:
 *   1. Disabled rules do nothing.
 *   2. A rule below its confidence threshold never punishes — LOG or ignore.
 *   3. DRY_RUN detects and reports but never acts.
 *   4. Only then is the ladder consulted.
 *
 * Severe actions (KICK/BAN) are unreachable by construction: the ladder is
 * typed to AutoModAction and validated by ladderCeilingIsMute.
 */
export function decideEnforcement(input: {
  readonly mode: AutoModMode;
  readonly minConfidence: AutoModConfidence;
  readonly confidence: AutoModConfidence;
  readonly ladder: EscalationLadder;
  readonly activeStrikes: number;
  readonly exempted: boolean;
}): EnforcementDecision {
  // 2. Exemptions win outright — no record of action.
  if (input.exempted) {
    return { action: null, result: 'BLOCKED_BY_EXEMPTION', wouldHave: null };
  }

  const configured = resolveLadderAction(input.ladder, input.activeStrikes);

  // 1. Disabled: detect only, never act.
  if (input.mode === 'DISABLED') {
    return { action: null, result: 'ALLOWED', wouldHave: configured };
  }

  // 2. Confidence gate. A single low-confidence match must NOT punish
  //    (v14 §R.2) — this is the check that makes precision-before-punishment real.
  const meetsThreshold =
    CONFIDENCE_RANK[input.confidence] >= CONFIDENCE_RANK[input.minConfidence];
  if (!meetsThreshold) {
    return {
      action: null,
      result: 'SUPPRESSED_LOW_CONFIDENCE',
      wouldHave: configured,
      suppressedReason: `confidence ${input.confidence} below threshold ${input.minConfidence}`,
    };
  }

  // 3. Dry run: report, never act.
  if (input.mode === 'DRY_RUN') {
    return { action: null, result: 'DRY_RUN', wouldHave: configured };
  }

  if (configured === null) {
    return { action: null, result: 'ALLOWED', wouldHave: null };
  }

  return { action: configured, result: 'ACTIONED', wouldHave: configured };
}