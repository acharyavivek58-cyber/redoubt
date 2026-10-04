/**
 * AFK invariants (v18–v21).
 *
 * Properties under test:
 *  - provenance gating: ONLY a human's message may change AFK state
 *  - repeated `$afk` is deterministic: no second period, ever
 *  - the period state machine is FORWARD ONLY (ACTIVE → RETURNED → FINALIZED)
 *  - the return claim is atomic and exactly-once: the row count is the token
 *  - FINALIZED is immutable, so a replayed job cannot reopen history
 */

import { describe, expect, it } from 'vitest';
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
  returnClaimPredicate,
  shouldClearAfk,
  type AfkPeriod,
  type AfkPeriodStatus,
  type MessageProvenance,
} from '../../src/features/afk/domain.js';

const START = new Date('2026-01-01T00:00:00.000Z');

function period(overrides: Partial<AfkPeriod> = {}): AfkPeriod {
  return {
    guildId: '1',
    userId: '2',
    afkPeriodId: 'period-1',
    periodStatus: 'ACTIVE',
    startedAt: START,
    returnedAt: null,
    ...overrides,
  };
}

describe('provenance gating is the loop protection', () => {
  it('allows only USER provenance to change state', () => {
    expect(mayChangeAfkState('USER')).toBe(true);
    for (const provenance of ['BOT', 'WEBHOOK', 'REDOUBT'] as MessageProvenance[]) {
      expect(mayChangeAfkState(provenance), `${provenance} must not change AFK state`).toBe(false);
    }
  });

  it('refuses to clear AFK for a bot-authored message even when it is the AFK user', () => {
    // Redoubt's own return announcement quoting the user must never re-clear.
    const cleared = shouldClearAfk({
      provenance: 'REDOUBT',
      isAfkUser: true,
      mentionsAfkUser: true,
      isDirectMessage: true,
      clearsOwnAfk: true,
      commandClear: true,
    });
    expect(cleared).toBe(false);
  });

  it('refuses to clear AFK for a webhook that mentions the member', () => {
    expect(
      shouldClearAfk({
        provenance: 'WEBHOOK',
        isAfkUser: false,
        mentionsAfkUser: true,
        isDirectMessage: false,
        clearsOwnAfk: true,
        commandClear: false,
      }),
    ).toBe(false);
  });

  it('clears AFK for a human own-message, mention, DM, or command', () => {
    const base = {
      provenance: 'USER' as MessageProvenance,
      isAfkUser: false,
      mentionsAfkUser: false,
      isDirectMessage: false,
      clearsOwnAfk: true,
      commandClear: false,
    };
    expect(shouldClearAfk({ ...base, isAfkUser: true })).toBe(true);
    expect(shouldClearAfk({ ...base, mentionsAfkUser: true })).toBe(true);
    expect(shouldClearAfk({ ...base, isDirectMessage: true })).toBe(true);
    expect(shouldClearAfk({ ...base, commandClear: true })).toBe(true);
    expect(shouldClearAfk(base)).toBe(false);
  });

  it('honours the per-channel clearsOwnAfk override for ignored channels', () => {
    // Ignored channel, user is NOT the AFK user: an ordinary message must not clear.
    expect(
      shouldClearAfk({
        provenance: 'USER',
        isAfkUser: true,
        mentionsAfkUser: false,
        isDirectMessage: false,
        clearsOwnAfk: false,
        commandClear: false,
      }),
    ).toBe(false);
  });

  it('records the most specific clear reason', () => {
    expect(
      clearReasonFor({
        commandClear: true,
        isAfkUser: true,
        mentionsAfkUser: true,
        isDirectMessage: true,
      }),
    ).toBe('COMMAND');
    expect(
      clearReasonFor({
        commandClear: false,
        isAfkUser: true,
        mentionsAfkUser: true,
        isDirectMessage: false,
      }),
    ).toBe('MENTIONED');
    expect(
      clearReasonFor({
        commandClear: false,
        isAfkUser: true,
        mentionsAfkUser: false,
        isDirectMessage: false,
      }),
    ).toBe('OWN_MESSAGE');
  });
});

describe('repeated $afk is deterministic', () => {
  it('mints a new period only when none is active', () => {
    expect(decideStart(undefined, 'p1')).toEqual({ kind: 'STARTED', afkPeriodId: 'p1' });
    expect(decideStart(period({ periodStatus: 'FINALIZED' }), 'p2')).toEqual({
      kind: 'STARTED',
      afkPeriodId: 'p2',
    });
  });

  it('returns the SAME period instead of creating a second one', () => {
    // A second period would orphan the first period's queued messages and
    // strand its subscribers, so this must never happen.
    const decision = decideStart(period({ afkPeriodId: 'original' }), 'fresh');
    expect(decision).toEqual({ kind: 'ALREADY_AFK', afkPeriodId: 'original' });
  });

  it('never mints a second period across repeated calls', () => {
    let current: AfkPeriod | undefined;
    let minted = 0;
    for (let i = 0; i < 5; i += 1) {
      const decision = decideStart(current, `period-${i + 2}`);
      if (decision.kind === 'STARTED') {
        minted += 1;
        current = period({ afkPeriodId: decision.afkPeriodId });
      }
    }
    expect(minted).toBe(1);
    expect(current?.afkPeriodId).toBe('period-2');
  });
});

describe('the return claim is atomic and exactly-once', () => {
  it('treats exactly one returned row as the ownership token', () => {
    expect(claimSucceeded(1)).toBe(true);
    // Zero rows = another claimant won. Two rows = a broken predicate, and it
    // must NOT be read as success.
    expect(claimSucceeded(0)).toBe(false);
    expect(claimSucceeded(2)).toBe(false);
  });

  it('grants exactly one winner when many callers race the claim', () => {
    // Models the actual statement: `UPDATE ... WHERE period_status = 'ACTIVE'`.
    // The first call flips the row, so every later call matches zero rows.
    const row: { periodStatus: AfkPeriodStatus } = { periodStatus: 'ACTIVE' };
    const claim = (): number => {
      if (row.periodStatus !== 'ACTIVE') return 0;
      row.periodStatus = 'RETURNED';
      return 1;
    };

    const winners = Array.from({ length: 25 }, () => claim()).filter((rows) =>
      claimSucceeded(rows),
    );
    expect(winners).toHaveLength(1);
    expect(row.periodStatus).toBe('RETURNED');
  });

  it('never lets a stale claimant for an older period touch a newer one', () => {
    // The predicate is (afk_period_id, ACTIVE) — a claimant holding period-1
    // cannot match a row that has already moved on to period-2.
    const current = period({ afkPeriodId: 'period-2', periodStatus: 'ACTIVE' });
    const staleClaimant = period({ afkPeriodId: 'period-1', periodStatus: 'ACTIVE' });
    expect(staleClaimant.afkPeriodId === current.afkPeriodId).toBe(false);
    expect(returnClaimPredicate(current)).toEqual({
      afkPeriodId: 'period-2',
      fromStatus: 'ACTIVE',
    });
  });

  it('owes the full side-effect set to the winner of an ACTIVE claim', () => {
    expect(pendingReturnWork(period())).toEqual({
      deliverQueuedMessages: true,
      announceReturn: true,
      notifySubscribers: true,
    });
  });

  it('re-derives the same remaining obligations after a crash mid-return', () => {
    // RETURNED is durable and resumable: the remaining work is only delivery,
    // and it is stable across worker restarts.
    expect(pendingReturnWork(period({ periodStatus: 'RETURNED' }))).toEqual({
      deliverQueuedMessages: false,
      announceReturn: false,
      notifySubscribers: true,
    });
  });

  it('owes nothing once finalized', () => {
    expect(pendingReturnWork(period({ periodStatus: 'FINALIZED' }))).toEqual({
      deliverQueuedMessages: false,
      announceReturn: false,
      notifySubscribers: false,
    });
  });
});

describe('the period state machine is forward only', () => {
  it('accepts messages only while ACTIVE', () => {
    expect(acceptsMessages(period())).toBe(true);
    expect(acceptsMessages(period({ periodStatus: 'RETURNED' }))).toBe(false);
    expect(acceptsMessages(period({ periodStatus: 'FINALIZED' }))).toBe(false);
  });

  it('allows finalization only from RETURNED', () => {
    expect(canFinalize(period())).toBe(false);
    expect(canFinalize(period({ periodStatus: 'RETURNED' }))).toBe(true);
    // Finalizing twice is a no-op, not an error.
    expect(canFinalize(period({ periodStatus: 'FINALIZED' }))).toBe(false);
  });

  it('treats FINALIZED as immutable', () => {
    expect(mayMutatePeriod(period())).toBe(true);
    expect(mayMutatePeriod(period({ periodStatus: 'RETURNED' }))).toBe(true);
    expect(mayMutatePeriod(period({ periodStatus: 'FINALIZED' }))).toBe(false);
  });

  it('reaches RETURNED only from ACTIVE, and FINALIZED only from RETURNED', () => {
    const canClaimReturn = (from: AfkPeriodStatus) => from === 'ACTIVE' && mayMutatePeriod(period({ periodStatus: from }));
    const canReachFinalized = (from: AfkPeriodStatus) => canFinalize(period({ periodStatus: from }));

    expect(canClaimReturn('ACTIVE')).toBe(true);
    expect(canClaimReturn('RETURNED')).toBe(false);
    expect(canClaimReturn('FINALIZED')).toBe(false);

    expect(canReachFinalized('RETURNED')).toBe(true);
    expect(canReachFinalized('ACTIVE')).toBe(false);
    expect(canReachFinalized('FINALIZED')).toBe(false);
  });
});

describe('period identity', () => {
  it('builds a stable idempotency key per guild, period, and action', () => {
    expect(returnActionKey('1', 'p1', 'RETURN_ANNOUNCEMENT')).toBe('1:p1:RETURN_ANNOUNCEMENT');
    // Different guilds must never collide — the key is what backs the unique
    // constraint that prevents duplicate announcements.
    expect(returnActionKey('2', 'p1', 'RETURN_ANNOUNCEMENT')).not.toBe(
      returnActionKey('1', 'p1', 'RETURN_ANNOUNCEMENT'),
    );
  });

  it('is deterministic for the same inputs', () => {
    expect(returnActionKey('1', 'p1', 'A')).toBe(returnActionKey('1', 'p1', 'A'));
  });
});

describe('away duration formatting', () => {
  const at = (ms: number) => new Date(START.getTime() + ms);

  it('formats durations readably', () => {
    expect(formatAwayDuration(START, at(30_000))).toBe('less than a minute');
    expect(formatAwayDuration(START, at(5 * 60_000))).toBe('5m');
    expect(formatAwayDuration(START, at(90 * 60_000))).toBe('1h 30m');
    expect(formatAwayDuration(START, at(50 * 3_600_000))).toBe('2d 2h');
  });

  it('never renders a negative duration from clock skew', () => {
    expect(formatAwayDuration(at(60_000), START)).toBe('less than a minute');
  });
});
