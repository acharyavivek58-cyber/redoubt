/**
 * AFK domain model (v18–v21).
 *
 * Pure logic only — no database, no Discord. Everything here is a total
 * function over its inputs so the state machine can be tested exhaustively
 * without a live Postgres.
 *
 * The three invariants this file exists to enforce:
 *
 *  1. PROVENANCE GATING IS THE LOOP PROTECTION. A bot's own AFK announcement
 *     must never be able to re-AFK or clear the user, which is why only
 *     USER-provenance messages may change state at all.
 *
 *  2. THE RETURN CLAIM IS ATOMIC AND EXACTLY ONCE. Whoever flips
 *     ACTIVE -> RETURNED owns the return. A second claim matches zero rows
 *     and therefore loses. The winner is identified by the returned-row count,
 *     never by a pre-read check.
 *
 *  3. FORWARD ONLY. RETURNED never reverts to ACTIVE and FINALIZED is
 *     immutable, so a late message can never resurrect a completed period.
 */

/** Where a message came from. Determines whether it may change AFK state. */
export type MessageProvenance =
  | 'USER'
  | 'BOT'
  | 'WEBHOOK'
  | 'REDOUBT';

export type AfkPeriodStatus = 'ACTIVE' | 'RETURNED' | 'FINALIZED';

export interface AfkPeriod {
  readonly guildId: string;
  readonly userId: string;
  /** Globally unique; never rendered to ordinary users. */
  readonly afkPeriodId: string;
  readonly periodStatus: AfkPeriodStatus;
  readonly startedAt: Date;
  readonly returnedAt: Date | null;
}

/**
 * ONLY a human user may start or clear AFK.
 *
 * This is the loop-protection gate: Redoubt's own welcome/return messages and
 * any other bot's messages are ignored for state purposes, so a bot that
 * echoes AFK text cannot put the server into a loop.
 */
export function mayChangeAfkState(provenance: MessageProvenance): boolean {
  return provenance === 'USER';
}

export type ClearReason =
  | 'OWN_MESSAGE'
  | 'MENTIONED'
  | 'DIRECT_MESSAGE'
  | 'COMMAND'
  | 'MANUAL'
  | 'STAFF_CLEAR';

/**
 * Whether a message should clear AFK.
 *
 * `clearsOwnAfk` is the per-channel override for ignored channels: a channel
 * can stay out of the AFK game entirely (no notices) while a member's own
 * message still clears their state.
 */
export function shouldClearAfk(input: {
  readonly provenance: MessageProvenance;
  readonly isAfkUser: boolean;
  readonly mentionsAfkUser: boolean;
  readonly isDirectMessage: boolean;
  readonly clearsOwnAfk: boolean;
  readonly commandClear: boolean;
}): boolean {
  if (!mayChangeAfkState(input.provenance)) return false;
  if (input.commandClear) return true;
  if (input.isAfkUser && input.clearsOwnAfk) return true;
  if (input.mentionsAfkUser || input.isDirectMessage) return true;
  return false;
}

/** Resolves the reason a clear happened, for audit rows. */
export function clearReasonFor(input: {
  readonly commandClear: boolean;
  readonly isAfkUser: boolean;
  readonly mentionsAfkUser: boolean;
  readonly isDirectMessage: boolean;
}): ClearReason {
  if (input.commandClear) return 'COMMAND';
  if (input.mentionsAfkUser) return 'MENTIONED';
  if (input.isDirectMessage) return 'DIRECT_MESSAGE';
  if (input.isAfkUser) return 'OWN_MESSAGE';
  return 'MANUAL';
}

export type StartOutcome =
  | { readonly kind: 'STARTED'; readonly afkPeriodId: string }
  /** Already AFK — repeated `$afk` is deterministic and creates NO second period. */
  | { readonly kind: 'ALREADY_AFK'; readonly afkPeriodId: string };

/**
 * Deterministic start decision.
 *
 * Repeated `$afk` MUST NOT mint a second period: doing so would orphan the
 * first period's pending messages and leave notifications stranded. When a
 * period is already ACTIVE the existing id is returned instead.
 */
export function decideStart(
  current: AfkPeriod | undefined,
  nextPeriodId: string,
): StartOutcome {
  if (current && current.periodStatus === 'ACTIVE') {
    return { kind: 'ALREADY_AFK', afkPeriodId: current.afkPeriodId };
  }
  return { kind: 'STARTED', afkPeriodId: nextPeriodId };
}

/**
 * The compare-and-set predicate for the return claim.
 *
 * Rendered by the repository as a single UPDATE ... WHERE, so a concurrent
 * claimant matches zero rows and loses. Two conditions matter:
 *
 *  - period_status = 'ACTIVE'  -> only the first claimant proceeds
 *  - the period id matches     -> a stale claimant for an older period cannot
 *                                  touch a newer one
 */
export function returnClaimPredicate(period: AfkPeriod): {
  readonly afkPeriodId: string;
  readonly fromStatus: 'ACTIVE';
} {
  return { afkPeriodId: period.afkPeriodId, fromStatus: 'ACTIVE' };
}

/**
 * Interprets the row count returned by the claim UPDATE.
 *
 * The count IS the ownership token: 1 means this caller won and owns every
 * follow-up side effect, 0 means someone else already returned the user and
 * this caller must do nothing.
 */
export function claimSucceeded(rowsReturned: number): boolean {
  return rowsReturned === 1;
}

/**
 * Which follow-up work the winner owes.
 *
 * Derived from the persisted state rather than guessed, so a resumed worker
 * and a fresh worker agree on what is left to do.
 */
export function pendingReturnWork(period: AfkPeriod): {
  readonly deliverQueuedMessages: boolean;
  readonly announceReturn: boolean;
  readonly notifySubscribers: boolean;
} {
  // RETURNED is durable and resumable: a worker that crashed mid-return sees
  // the same set of obligations and finishes them.
  if (period.periodStatus === 'ACTIVE') {
    return { deliverQueuedMessages: true, announceReturn: true, notifySubscribers: true };
  }
  if (period.periodStatus === 'RETURNED') {
    // Only the not-yet-durable steps remain; announcements are already recorded
    // in afk_return_actions by their unique constraint.
    return { deliverQueuedMessages: false, announceReturn: false, notifySubscribers: true };
  }
  return { deliverQueuedMessages: false, announceReturn: false, notifySubscribers: false };
}

/** True when the period may still accept new queued messages. */
export function acceptsMessages(period: AfkPeriod): boolean {
  return period.periodStatus === 'ACTIVE';
}

/** Terminal transition. Idempotent: finalizing a FINALIZED period is a no-op. */
export function canFinalize(period: AfkPeriod): boolean {
  return period.periodStatus === 'RETURNED';
}

/**
 * Guards every period mutation.
 *
 * FINALIZED is immutable at the service boundary (and enforced again by the
 * repository), so a late-arriving message or a replayed job cannot rewrite
 * history.
 */
export function mayMutatePeriod(period: AfkPeriod): boolean {
  return period.periodStatus !== 'FINALIZED';
}

/** Stable idempotency key for the one logical return announcement per period. */
export function returnActionKey(guildId: string, afkPeriodId: string, actionType: string): string {
  return `${guildId}:${afkPeriodId}:${actionType}`;
}

/**
 * Duration formatting for AFK notices.
 *
 * Internal period ids stay internal; only this duration is ever user-facing.
 */
export function formatAwayDuration(from: Date, to: Date): string {
  const ms = Math.max(0, to.getTime() - from.getTime());
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return 'less than a minute';
}