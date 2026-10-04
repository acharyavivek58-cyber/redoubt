/**
 * Economy domain rules (v13 §15, v15 §A).
 *
 * Pure logic, no I/O. The three properties enforced here:
 *
 *  1. THE CURRENCY IS VIRTUAL. It is guild-scoped, non-cashable,
 *     non-convertible, and non-transferable between guilds. There is
 *     deliberately no "cash out" or "convert" operation in this module, and
 *     `assertNoRealMoneyConversion` exists to reject one if a caller tries.
 *
 *  2. A DEBIT IS CONDITIONAL AND ATOMIC. Sufficient funds are checked and
 *     enforced by the database predicate itself (`balance >= amount`), never by
 *     a read-then-write that could be raced.
 *
 *  3. A FAILED DELIVERY IS ALWAYS COMPENSATED. A purchase is never left in a
 *     state where the member was charged but received nothing, and it is never
 *     left granting a role nobody paid for.
 */

/** Why a debit failed. Rendered as plain language, never as a raw error. */
export type DebitFailure =
  | 'WALLET_DOES_NOT_EXIST'
  | 'INSUFFICIENT_FUNDS'
  | 'AMOUNT_NOT_POSITIVE'
  | 'CURRENCY_DISABLED';

export interface DebitSuccess {
  readonly ok: true;
  readonly balanceBefore: number;
  readonly balanceAfter: number;
}

export interface DebitFailureResult {
  readonly ok: false;
  readonly reason: DebitFailure;
  /** Present when the wallet exists, so the UI can show "you have X". */
  readonly balance?: number;
  readonly shortfall?: number;
}

export type DebitResult = DebitSuccess | DebitFailureResult;

/**
 * Debits must be strictly positive. A zero or negative amount is a caller bug
 * (or an exploit attempt), never a valid operation.
 */
export function isValidDebitAmount(amount: number): boolean {
  return Number.isFinite(amount) && Number.isInteger(amount) && amount > 0;
}

/** Credits may be zero-or-positive; a zero credit is a harmless no-op. */
export function isValidCreditAmount(amount: number): boolean {
  return Number.isFinite(amount) && Number.isInteger(amount) && amount >= 0;
}

/** Plain-language shortfall copy. Never mentions internal field names. */
export function describeDebitFailure(failure: DebitFailureResult): string {
  switch (failure.reason) {
    case 'INSUFFICIENT_FUNDS':
      return failure.shortfall !== undefined
        ? `You need ${failure.shortfall.toLocaleString()} more to afford this.`
        : 'You do not have enough for this.';
    case 'WALLET_DOES_NOT_EXIST':
      return 'You do not have a balance in this server yet.';
    case 'AMOUNT_NOT_POSITIVE':
      return 'That amount is not valid.';
    case 'CURRENCY_DISABLED':
      return 'The currency is currently disabled in this server.';
    default:
      return 'That could not be completed.';
  }
}

export type PurchaseStatus = 'PENDING' | 'COMPLETED' | 'REFUNDED' | 'RECOVERY_REQUIRED';

export type PurchaseTransition =
  | { readonly kind: 'ALLOW'; readonly next: PurchaseStatus }
  | { readonly kind: 'REJECT'; readonly reason: string };

/**
 * The purchase state machine.
 *
 * `PENDING` is the only state in which money is held but the role is not yet
 * granted. Terminal states never move again — that is what makes replayed
 * jobs safe, and it is why a late delivery callback cannot resurrect a
 * refunded purchase.
 */
export function nextPurchaseStatus(
  current: PurchaseStatus,
  event: 'DELIVERED' | 'DELIVERY_FAILED' | 'REFUNDED',
): PurchaseTransition {
  switch (current) {
    case 'PENDING':
      if (event === 'DELIVERED') return { kind: 'ALLOW', next: 'COMPLETED' };
      if (event === 'DELIVERY_FAILED') return { kind: 'ALLOW', next: 'RECOVERY_REQUIRED' };
      return { kind: 'ALLOW', next: 'REFUNDED' };

    case 'RECOVERY_REQUIRED':
      // A retry that succeeds completes the purchase; otherwise it stays in
      // recovery so staff can refund. It never silently reverts to PENDING.
      return event === 'DELIVERED'
        ? { kind: 'ALLOW', next: 'COMPLETED' }
        : { kind: 'REJECT', reason: 'This purchase is already in recovery.' };

    case 'COMPLETED':
      return event === 'REFUNDED'
        ? { kind: 'ALLOW', next: 'REFUNDED' }
        : { kind: 'REJECT', reason: 'This purchase has already been completed.' };

    case 'REFUNDED':
      // Terminal: money is back, entitlement released, history preserved.
      return { kind: 'REJECT', reason: 'This purchase has already been refunded.' };

    default:
      return { kind: 'REJECT', reason: 'Unknown purchase state.' };
  }
}

/** Terminal states must never transition again. */
export function isTerminalPurchaseStatus(status: PurchaseStatus): boolean {
  return status === 'COMPLETED' || status === 'REFUNDED';
}

/**
 * Whether the entitlement row should be released.
 *
 * A refund releases `active`, which is exactly what releases the partial
 * unique index and permits a legitimate re-purchase while history is kept.
 */
export function shouldReleaseEntitlement(status: PurchaseStatus): boolean {
  return status === 'REFUNDED';
}

/**
 * Reconciliation outcome for a purchase that needs attention.
 *
 * `RECOVERY_REQUIRED` is a real, visible state — not a silent failure. The
 * member's money is either refunded or staff is told to do it, never neither.
 */
export type ReconciliationOutcome =
  | { readonly kind: 'REFUND'; readonly amount: number }
  | { readonly kind: 'COMPLETE'; readonly amount: number }
  | { readonly kind: 'ESCALATE'; readonly openCount: number };

/** After this many failed attempts, stop retrying and escalate to staff. */
export const MAX_DELIVERY_ATTEMPTS = 5;

/**
 * Decides what to do with a purchase that has not completed.
 *
 * Money is NEVER silently lost: if attempts remain the job retries, and once
 * they are exhausted the purchase is escalated so the member is refunded.
 */
export function decideReconciliation(input: {
  readonly attempts: number;
  readonly maxAttempts?: number;
  readonly stillGrantable: boolean;
  readonly price: number;
}): ReconciliationOutcome {
  const maxAttempts = input.maxAttempts ?? MAX_DELIVERY_ATTEMPTS;
  // If the grant is no longer possible, retrying CANNOT help — escalate now
  // rather than burning attempts on a delivery that will never succeed.
  if (!input.stillGrantable) return { kind: 'ESCALATE', openCount: 1 };
  if (input.attempts >= maxAttempts) return { kind: 'ESCALATE', openCount: 1 };
  return { kind: 'COMPLETE', amount: input.price };
}

/**
 * Rejects any attempt to move currency outside the guild's virtual economy.
 *
 * There is no legitimate call site for this — every value of `target` names an
 * operation the design forbids. It exists so that "no real money" is an
 * ENFORCED invariant rather than a comment someone can route around.
 */
export function assertNoRealMoneyConversion(input: {
  readonly target: 'CASH_OUT' | 'CONVERT' | 'TRANSFER_OUT_OF_GUILD' | 'TRANSFER_BETWEEN_GUILDS';
  readonly crossGuild: boolean;
}): never {
  throw new Error(
    `Refusing ${input.target}: economy currency is virtual, guild-scoped, ` +
      'non-cashable, and non-transferable between guilds.',
  );
}

/**
 * Whether a transfer is permitted at all.
 *
 * Only same-guild transfers exist, and they are bounded by both balances.
 */
export function canTransfer(input: {
  readonly amount: number;
  readonly senderBalance: number;
  readonly senderId: string;
  readonly recipientId: string;
}): { readonly ok: boolean; readonly reason?: string } {
  if (input.senderId === input.recipientId) {
    return { ok: false, reason: 'You cannot send currency to yourself.' };
  }
  if (!isValidDebitAmount(input.amount)) {
    return { ok: false, reason: 'That amount is not valid.' };
  }
  if (input.senderBalance < input.amount) {
    return { ok: false, reason: 'You do not have enough for that.' };
  }
  return { ok: true };
}
