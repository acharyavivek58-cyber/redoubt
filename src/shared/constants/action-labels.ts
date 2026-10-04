/**
 * Centralized public action labels.
 *
 * v3 §1: the public vocabulary is Mute/Unmute. Discord's native timeout
 * mechanism is an INTERNAL implementation detail and must never leak into any
 * user- or staff-visible string. Every user-facing surface resolves its label
 * from here so terminology cannot drift between features.
 *
 * The terminology test asserts none of FORBIDDEN_PUBLIC_TERMS appear in any
 * rendered output, log line, case label, or documentation string.
 */

/** Canonical moderation action identity. */
export const MODERATION_ACTIONS = [
  'WARN',
  'MUTE',
  'UNMUTE',
  'KICK',
  'BAN',
  'SOFTBAN',
  'JAIL',
  'UNJAIL',
  'PURGE',
] as const;

export type ModerationAction = (typeof MODERATION_ACTIONS)[number];

interface LabelSpec {
  /** Public verb shown in embeds, logs, and case lists. */
  readonly label: string;
  /** Past-tense form for history rows. */
  readonly pastTense: string;
}

const LABELS: Readonly<Record<ModerationAction, LabelSpec>> = {
  WARN: { label: 'Warn', pastTense: 'Warned' },
  MUTE: { label: 'Mute', pastTense: 'Muted' },
  UNMUTE: { label: 'Unmute', pastTense: 'Unmuted' },
  KICK: { label: 'Kick', pastTense: 'Kicked' },
  BAN: { label: 'Ban', pastTense: 'Banned' },
  SOFTBAN: { label: 'Softban', pastTense: 'Softbanned' },
  JAIL: { label: 'Jail', pastTense: 'Jailed' },
  UNJAIL: { label: 'Unjail', pastTense: 'Unjailed' },
  PURGE: { label: 'Purge', pastTense: 'Purged' },
};

/**
 * Public label for a moderation action. e.g. actionLabel('MUTE') === 'Mute'.
 *
 * Throws on an unknown action rather than returning the raw token, so a typo
 * fails loudly in development instead of leaking internal vocabulary.
 */
export function actionLabel(action: ModerationAction): string {
  return LABELS[action].label;
}

/** Past-tense label, e.g. actionPastTense('MUTE') === 'Muted'. */
export function actionPastTense(action: ModerationAction): string {
  return LABELS[action].pastTense;
}

/** Short human summary, e.g. 'Mute • 30 minutes'. */
export function actionSummary(
  action: ModerationAction,
  durationLabel?: string,
): string {
  return durationLabel ? `${LABELS[action].label} • ${durationLabel}` : LABELS[action].label;
}

/** Tier used for escalation ladders and UI emphasis. */
export const ACTION_SEVERITY: Readonly<Record<ModerationAction, number>> = {
  WARN: 1,
  MUTE: 2,
  PURGE: 2,
  UNMUTE: 0,
  UNJAIL: 0,
  KICK: 3,
  SOFTBAN: 4,
  BAN: 5,
  JAIL: 3,
};

/**
 * Vocabulary that must NEVER appear in user-facing output.
 *
 * Kept here so the terminology test can assert their absence across the whole
 * rendered surface rather than grepping ad hoc in each feature.
 */
export const FORBIDDEN_PUBLIC_TERMS = [
  'timeout',
  'untimeout',
  'timed out',
  'untimed out',
  'time out',
  'time-out',
] as const;

/**
 * True when `text` contains forbidden public terminology.
 *
 * Deliberately substring-based (not word-bounded) so that variants such as
 * "Timeout" or "time-outs" are caught too.
 */
export function containsForbiddenPublicTerm(text: string): boolean {
  const haystack = text.toLowerCase();
  return FORBIDDEN_PUBLIC_TERMS.some((term) => haystack.includes(term));
}