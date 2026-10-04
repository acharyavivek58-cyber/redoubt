/**
 * Economy invariants (v13 §15, v15 §A).
 *
 * Properties under test:
 *  - currency is VIRTUAL: no cash-out, no cross-guild movement
 *  - debits are strictly positive and conditional on sufficient funds
 *  - a purchase either COMPLETES or COMPENSATES — never "charged, nothing given"
 *  - terminal purchase states never transition again
 */

import { describe, expect, it } from 'vitest';
import {
  assertNoRealMoneyConversion,
  canTransfer,
  decideReconciliation,
  describeDebitFailure,
  isTerminalPurchaseStatus,
  isValidCreditAmount,
  isValidDebitAmount,
  nextPurchaseStatus,
  shouldReleaseEntitlement,
  MAX_DELIVERY_ATTEMPTS,
  type PurchaseStatus,
} from '../../src/features/economy/domain.js';

describe('currency is virtual', () => {
  it('rejects every cash-out and conversion path', () => {
    for (const target of ['CASH_OUT', 'CONVERT', 'TRANSFER_OUT_OF_GUILD'] as const) {
      expect(() => assertNoRealMoneyConversion({ target, crossGuild: false })).toThrow();
    }
  });

  it('rejects cross-guild movement explicitly', () => {
    expect(() =>
      assertNoRealMoneyConversion({ target: 'TRANSFER_BETWEEN_GUILDS', crossGuild: true }),
    ).toThrow(/virtual, guild-scoped, non-cashable/);
    // Even a same-guild-labelled cross-guild attempt is refused.
    expect(() =>
      assertNoRealMoneyConversion({ target: 'TRANSFER_BETWEEN_GUILDS', crossGuild: false }),
    ).toThrow();
  });

  it('refuses to send currency to yourself', () => {
    expect(
      canTransfer({
        amount: 10,
        senderBalance: 100,
        senderId: 'u1',
        recipientId: 'u1',
      }),
    ).toEqual({ ok: false, reason: 'You cannot send currency to yourself.' });
  });

  it('allows a same-guild transfer when the sender can afford it', () => {
    expect(
      canTransfer({ amount: 40, senderBalance: 100, senderId: 'u1', recipientId: 'u2' }),
    ).toEqual({ ok: true });
  });

  it('refuses a transfer the sender cannot afford', () => {
    expect(
      canTransfer({ amount: 500, senderBalance: 100, senderId: 'u1', recipientId: 'u2' }),
    ).toEqual({ ok: false, reason: 'You do not have enough for that.' });
  });
});

describe('debit amounts are validated before they touch the database', () => {
  it('accepts only strictly positive integers for debits', () => {
    expect(isValidDebitAmount(1)).toBe(true);
    expect(isValidDebitAmount(0)).toBe(false);
    expect(isValidDebitAmount(-5)).toBe(false);
    expect(isValidDebitAmount(1.5)).toBe(false);
    expect(isValidDebitAmount(Number.NaN)).toBe(false);
    expect(isValidDebitAmount(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('allows a zero credit but not a negative one', () => {
    expect(isValidCreditAmount(0)).toBe(true);
    expect(isValidCreditAmount(10)).toBe(true);
    expect(isValidCreditAmount(-1)).toBe(false);
  });

  it('tells the member exactly how much more they need', () => {
    expect(
      describeDebitFailure({ ok: false, reason: 'INSUFFICIENT_FUNDS', balance: 40, shortfall: 60 }),
    ).toBe('You need 60 more to afford this.');
  });

  it('never leaks an internal field name to the member', () => {
    for (const reason of [
      'WALLET_DOES_NOT_EXIST',
      'INSUFFICIENT_FUNDS',
      'AMOUNT_NOT_POSITIVE',
      'CURRENCY_DISABLED',
    ] as const) {
      const message = describeDebitFailure({ ok: false, reason });
      expect(message).not.toMatch(/WALLET|AMOUNT_NOT|reason|balance=/i);
    }
  });
});

describe('the purchase state machine', () => {
  it('moves PENDING to COMPLETED on successful delivery', () => {
    expect(nextPurchaseStatus('PENDING', 'DELIVERED')).toEqual({
      kind: 'ALLOW',
      next: 'COMPLETED',
    });
  });

  it('moves PENDING to RECOVERY_REQUIRED on failed delivery, never to COMPLETED', () => {
    const transition = nextPurchaseStatus('PENDING', 'DELIVERY_FAILED');
    expect(transition).toEqual({ kind: 'ALLOW', next: 'RECOVERY_REQUIRED' });
    // A failed delivery must never be recorded as a success.
    expect(transition.kind === 'ALLOW' && transition.next).not.toBe('COMPLETED');
  });

  it('lets a retried recovery complete', () => {
    expect(nextPurchaseStatus('RECOVERY_REQUIRED', 'DELIVERED')).toEqual({
      kind: 'ALLOW',
      next: 'COMPLETED',
    });
  });

  it('never reverts a recovery back to PENDING', () => {
    const transition = nextPurchaseStatus('RECOVERY_REQUIRED', 'DELIVERY_FAILED');
    expect(transition.kind === 'ALLOW' && transition.next).not.toBe('PENDING');
  });

  it('refuses to move a terminal state forward', () => {
    expect(nextPurchaseStatus('COMPLETED', 'DELIVERED').kind).toBe('REJECT');
    expect(nextPurchaseStatus('REFUNDED', 'DELIVERED').kind).toBe('REJECT');
    // A late delivery callback cannot resurrect a refunded purchase.
    expect(nextPurchaseStatus('REFUNDED', 'DELIVERED')).toEqual({
      kind: 'REJECT',
      reason: 'This purchase has already been refunded.',
    });
  });

  it('identifies the terminal states', () => {
    expect(isTerminalPurchaseStatus('COMPLETED')).toBe(true);
    expect(isTerminalPurchaseStatus('REFUNDED')).toBe(true);
    expect(isTerminalPurchaseStatus('PENDING')).toBe(false);
    expect(isTerminalPurchaseStatus('RECOVERY_REQUIRED')).toBe(false);
  });

  it('releases the entitlement only on refund', () => {
    // Releasing `active` is what frees the partial unique index for a re-buy.
    expect(shouldReleaseEntitlement('REFUNDED')).toBe(true);
    expect(shouldReleaseEntitlement('COMPLETED')).toBe(false);
    expect(shouldReleaseEntitlement('RECOVERY_REQUIRED')).toBe(false);
  });

  it('has no reachable state that is neither terminal nor observable', () => {
    const all: PurchaseStatus[] = ['PENDING', 'COMPLETED', 'REFUNDED', 'RECOVERY_REQUIRED'];
    for (const from of all) {
      const reachable = (['DELIVERED', 'DELIVERY_FAILED', 'REFUNDED'] as const)
        .map((event) => nextPurchaseStatus(from, event))
        .filter((t) => t.kind === 'ALLOW')
        .map((t) => (t.kind === 'ALLOW' ? t.next : from));
      for (const to of reachable) {
        expect(all, `${from} -> ${to} must be a known state`).toContain(to);
      }
    }
  });
});

describe('reconciliation never loses a member’s money', () => {
  it('keeps retrying while attempts remain', () => {
    expect(decideReconciliation({ attempts: 1, stillGrantable: true, price: 500 })).toEqual({
      kind: 'COMPLETE',
      amount: 500,
    });
  });

  it('escalates once attempts are exhausted rather than dropping the purchase', () => {
    const outcome = decideReconciliation({
      attempts: MAX_DELIVERY_ATTEMPTS,
      stillGrantable: true,
      price: 500,
    });
    expect(outcome).toEqual({ kind: 'ESCALATE', openCount: 1 });
  });

  it('escalates immediately when the role can no longer be granted', () => {
    // Attempts remaining but the grant is impossible: waiting longer cannot
    // help, so it escalates now.
    const outcome = decideReconciliation({ attempts: 0, stillGrantable: false, price: 250 });
    expect(outcome.kind).toBe('ESCALATE');
  });

  it('exhausts attempts exactly at the configured limit', () => {
    expect(
      decideReconciliation({
        attempts: MAX_DELIVERY_ATTEMPTS - 1,
        stillGrantable: true,
        price: 100,
      }).kind,
    ).toBe('COMPLETE');
    expect(
      decideReconciliation({ attempts: MAX_DELIVERY_ATTEMPTS, stillGrantable: true, price: 100 })
        .kind,
    ).toBe('ESCALATE');
  });
});
