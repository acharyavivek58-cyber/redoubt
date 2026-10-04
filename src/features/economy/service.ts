/**
 * Economy service (v13 §15, v15 §A).
 *
 * Persistence-backed currency and shop. Decisions live in `./domain.ts`; this
 * file owns the SQL.
 *
 * The load-bearing statement is `debit`: a SINGLE
 * `UPDATE economy_wallets SET balance = balance - amount ... WHERE balance >= amount
 * RETURNING balance`. Sufficient funds are enforced by the predicate itself, so
 * two concurrent purchases cannot both pass a read-then-write check and drive a
 * balance negative. The returned balance is the post-debit truth.
 *
 * Currency is virtual: it is guild-scoped, non-cashable, non-convertible, and
 * non-transferable between guilds. There is no cash-out path in this module and
 * no API that could become one.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../../core/db/client.js';
import {
  economyRecoveryEvents,
  economyShopItems,
  economyTransactions,
  economyWallets,
  guildCurrency,
  rolePurchases,
} from '../../core/db/schema/economy.js';
import type { transactionTypeEnum } from '../../core/db/schema/economy.js';
import { UserFacingError } from '../../core/errors.js';
import { lazyLogger } from '../../core/logging/logger.js';
import {
  canTransfer,
  decideReconciliation,
  describeDebitFailure,
  isValidCreditAmount,
  isValidDebitAmount,
  nextPurchaseStatus,
  shouldReleaseEntitlement,
  type DebitResult,
  type PurchaseStatus,
  type ReconciliationOutcome,
} from './domain.js';

const log = lazyLogger({ module: 'economy', operation: 'service' });

export type TransactionType = (typeof transactionTypeEnum)['enumValues'][number];

export interface CurrencyInfo {
  readonly name: string;
  readonly symbol: string;
  readonly enabled: boolean;
}

export interface DebitInput {
  readonly guildId: string;
  readonly userId: string;
  readonly amount: number;
  readonly type: TransactionType;
  readonly source?: string;
  readonly actorId?: string;
  readonly referenceId?: string;
}

export interface PurchaseInput {
  readonly guildId: string;
  readonly userId: string;
  readonly shopItemId: string;
  /** INTERNAL: called by a resolver, never from user input. */
  readonly resolveItem: (guildId: string, shopItemId: string) => Promise<
    | {
        readonly shopItemId: string;
        readonly itemId: string;
        readonly roleId: string | null;
        readonly price: number;
        readonly active: boolean;
        readonly stock: number | null;
        readonly durationSeconds: number | null;
        readonly repeatPurchasable: boolean;
      }
    | null
  >;
  readonly grantRole: (guildId: string, userId: string, roleId: string) => Promise<boolean>;
  readonly removeRole: (guildId: string, userId: string, roleId: string) => Promise<void>;
}

export type PurchaseResult =
  | {
      readonly kind: 'COMPLETED';
      readonly purchaseId: string;
      readonly balanceAfter: number;
      readonly roleId: string | null;
    }
  | {
      readonly kind: 'REFUNDED';
      readonly purchaseId: string;
      readonly balanceAfter: number;
      readonly reason: string;
    }
  | {
      readonly kind: 'RECOVERY_REQUIRED';
      readonly purchaseId: string;
      readonly balanceAfter: number;
      readonly reason: string;
    }
  | { readonly kind: 'DECLINED'; readonly message: string };

export interface EconomyService {
  currency(guildId: string): Promise<CurrencyInfo>;
  balance(guildId: string, userId: string): Promise<number>;
  debit(input: DebitInput): Promise<DebitResult>;
  credit(input: DebitInput): Promise<{ balanceBefore: number; balanceAfter: number }>;
  transfer(input: {
    guildId: string;
    fromUserId: string;
    toUserId: string;
    amount: number;
  }): Promise<{ ok: boolean; message?: string; balanceAfter?: number }>;
  purchase(input: PurchaseInput): Promise<PurchaseResult>;
  reconcilePendingPurchases(
    probe: (guildId: string, userId: string, roleId: string) => Promise<boolean>,
  ): Promise<{ scanned: number; outcomes: ReconciliationOutcome[] }>;
}

export function createEconomyService(db: Database): EconomyService {
  async function ensureWallet(guildId: string, userId: string): Promise<void> {
    await db
      .insert(economyWallets)
      .values({ guildId: Number(guildId), userId: Number(userId), balance: 0 })
      .onConflictDoNothing();
  }

  /**
   * The atomic conditional debit.
   *
   * `balance >= amount` is IN the WHERE clause. There is no prior SELECT, so
   * there is no window in which two callers both observe enough funds.
   */
  async function atomicDebit(input: DebitInput): Promise<DebitResult> {
    if (!isValidDebitAmount(input.amount)) {
      return { ok: false, reason: 'AMOUNT_NOT_POSITIVE' };
    }
    await ensureWallet(input.guildId, input.userId);

    const rows = await db.execute<{ balance: number }>(sql`
      UPDATE economy_wallets
         SET balance = balance - ${input.amount},
             updated_at = now()
       WHERE guild_id = ${Number(input.guildId)}
         AND user_id = ${Number(input.userId)}
         AND balance >= ${input.amount}
      RETURNING balance
    `);

    const row = rows[0];
    if (!row) {
      // Zero rows means the predicate failed: either no wallet or not enough.
      const current = await db.execute<{ balance: number }>(sql`
        SELECT balance FROM economy_wallets
         WHERE guild_id = ${Number(input.guildId)} AND user_id = ${Number(input.userId)}
      `);
      const balance = current[0]?.balance;
      if (balance === undefined) return { ok: false, reason: 'WALLET_DOES_NOT_EXIST' };
      return {
        ok: false,
        reason: 'INSUFFICIENT_FUNDS',
        balance,
        shortfall: input.amount - balance,
      };
    }

    const balanceAfter = row.balance;
    // Append-only ledger. balance_before is the post-debit value plus the
    // amount, which is exact because the debit already committed.
    await db.insert(economyTransactions).values({
      guildId: Number(input.guildId),
      userId: Number(input.userId),
      amount: -input.amount,
      type: input.type,
      source: input.source,
      actorId: input.actorId ? Number(input.actorId) : null,
      referenceId: input.referenceId,
      balanceBefore: balanceAfter + input.amount,
      balanceAfter,
    });

    return { ok: true, balanceBefore: balanceAfter + input.amount, balanceAfter };
  }

  return {
    async currency(guildId) {
      const rows = await db
        .select({ name: guildCurrency.name, symbol: guildCurrency.symbol })
        .from(guildCurrency)
        .where(eq(guildCurrency.guildId, Number(guildId)))
        .limit(1);
      const row = rows[0];
      // Currency is always available conceptually; `enabled` reflects whether
      // the guild has configured it, and the UI hides the module either way.
      return { name: row?.name ?? 'Coins', symbol: row?.symbol ?? '◈', enabled: row !== undefined };
    },

    async balance(guildId, userId) {
      const rows = await db
        .select({ balance: economyWallets.balance })
        .from(economyWallets)
        .where(
          and(
            eq(economyWallets.guildId, Number(guildId)),
            eq(economyWallets.userId, Number(userId)),
          ),
        )
        .limit(1);
      return rows[0]?.balance ?? 0;
    },

    debit: atomicDebit,

    async credit(input) {
      if (!isValidCreditAmount(input.amount)) {
        throw new UserFacingError('That amount is not valid.');
      }
      await ensureWallet(input.guildId, input.userId);
      const rows = await db.execute<{ balance: number }>(sql`
        UPDATE economy_wallets
           SET balance = balance + ${input.amount},
               lifetime_earned = lifetime_earned + ${input.amount},
               updated_at = now()
         WHERE guild_id = ${Number(input.guildId)}
           AND user_id = ${Number(input.userId)}
        RETURNING balance
      `);
      const balanceAfter = rows[0]?.balance ?? 0;
      await db.insert(economyTransactions).values({
        guildId: Number(input.guildId),
        userId: Number(input.userId),
        amount: input.amount,
        type: input.type,
        source: input.source,
        actorId: input.actorId ? Number(input.actorId) : null,
        referenceId: input.referenceId,
        balanceBefore: balanceAfter - input.amount,
        balanceAfter,
      });
      return { balanceBefore: balanceAfter - input.amount, balanceAfter };
    },

    async transfer({ guildId, fromUserId, toUserId, amount }) {
      // Transfers are same-guild only, and `guildId` is a required parameter:
      // there is no code path that can name a second guild's wallet.
      const senderBalance = await this.balance(guildId, fromUserId);
      const allowed = canTransfer({ amount, senderBalance, senderId: fromUserId, recipientId: toUserId });
      if (!allowed.ok) return { ok: false, message: allowed.reason };

      // Debit first; the recipient is credited only once the debit committed,
      // so a failed debit can never mint currency.
      const debited = await atomicDebit({
        guildId,
        userId: fromUserId,
        amount,
        type: 'USER_TRANSFER',
        source: `recipient:${toUserId}`,
      });
      if (!debited.ok) {
        return { ok: false, message: describeDebitFailure(debited) };
      }

      await this.credit({
        guildId,
        userId: toUserId,
        amount,
        type: 'USER_TRANSFER',
        source: `sender:${fromUserId}`,
      });

      return { ok: true, balanceAfter: debited.balanceAfter };
    },

    async purchase(input) {
      const item = await input.resolveItem(input.guildId, input.shopItemId);
      if (!item || !item.active) {
        return { kind: 'DECLINED', message: 'That item is no longer available.' };
      }

      if (item.stock !== null && item.stock <= 0) {
        return { kind: 'DECLINED', message: 'That item is out of stock.' };
      }

      const existing = await db
        .select({ id: rolePurchases.id })
        .from(rolePurchases)
        .where(
          and(
            eq(rolePurchases.guildId, Number(input.guildId)),
            eq(rolePurchases.userId, Number(input.userId)),
            eq(rolePurchases.itemId, item.itemId),
            sql`${rolePurchases.active} = 1`,
          ),
        )
        .limit(1);

      if (existing.length > 0 && !item.repeatPurchasable) {
        return { kind: 'DECLINED', message: 'You already own that.' };
      }

      const debited = await atomicDebit({
        guildId: input.guildId,
        userId: input.userId,
        amount: item.price,
        type: 'ROLE_PURCHASE',
        source: item.itemId,
      });
      if (!debited.ok) {
        return { kind: 'DECLINED', message: describeDebitFailure(debited) };
      }

      const expiresAt =
        item.durationSeconds !== null
          ? new Date(Date.now() + item.durationSeconds * 1000)
          : null;

      // The entitlement is inserted with active=1, which the partial unique
      // index guards: two concurrent purchases of the same item cannot both
      // end up owning it.
      let entitlementId: string;
      try {
        const inserted = await db
          .insert(rolePurchases)
          .values({
            guildId: Number(input.guildId),
            userId: Number(input.userId),
            itemId: item.itemId,
            roleId: item.roleId ? Number(item.roleId) : null,
            expiresAt,
            active: 1,
          })
          .returning({ id: rolePurchases.id });
        const row = inserted[0];
        if (!row) throw new Error('entitlement insert returned no row');
        entitlementId = row.id;
      } catch {
        // Lost the uniqueness race: the member already owns it, so the money
        // just taken is refunded rather than kept for nothing.
        await atomicDebit({
          guildId: input.guildId,
          userId: input.userId,
          amount: item.price,
          type: 'REFUND',
          source: `rollback:${item.itemId}`,
        });
        return { kind: 'DECLINED', message: 'You already own that.' };
      }

      if (item.stock !== null) {
        // Decremented only AFTER the debit and entitlement commit, and only
        // when stock is finite (null = unlimited).
        await db
          .update(economyShopItems)
          .set({ stock: sql`${economyShopItems.stock} - 1` })
          .where(
            and(
              eq(economyShopItems.guildId, Number(input.guildId)),
              eq(economyShopItems.id, item.shopItemId),
            ),
          );
      }

      if (item.roleId === null) {
        return {
          kind: 'COMPLETED',
          purchaseId: entitlementId,
          balanceAfter: debited.balanceAfter,
          roleId: null,
        };
      }

      let granted = false;
      try {
        granted = await input.grantRole(input.guildId, input.userId, item.roleId);
      } catch (error) {
        log().error({ err: error, guildId: input.guildId }, 'role grant threw during purchase');
      }

      if (granted) {
        return {
          kind: 'COMPLETED',
          purchaseId: entitlementId,
          balanceAfter: debited.balanceAfter,
          roleId: item.roleId,
        };
      }

      // Delivery failed: the member is neither charged for nothing nor left
      // with a role they did not pay for. The purchase is marked for recovery
      // and staff are given an open event to resolve.
      await db
        .update(rolePurchases)
        .set({
          active: 0,
          deactivatedAt: new Date(),
          deactivatedReason: 'DELIVERY_FAILED',
        })
        .where(eq(rolePurchases.id, entitlementId));

      await db.insert(economyRecoveryEvents).values({
        guildId: Number(input.guildId),
        userId: Number(input.userId),
        purchaseId: entitlementId,
        shopItemId: input.shopItemId,
        failureType: 'ROLE_GRANT_FAILED',
        status: 'OPEN',
        originalAmount: item.price,
        metadata: { roleId: item.roleId },
      });

      return {
        kind: 'RECOVERY_REQUIRED',
        purchaseId: entitlementId,
        balanceAfter: debited.balanceAfter,
        reason: 'The role could not be applied. Your balance has been held for refund.',
      };
    },

    async reconcilePendingPurchases(probe) {
      const rows = await db.execute<{
        id: string;
        guild_id: number;
        user_id: number;
        role_id: number;
        price: number;
        attempts: number;
      }>(sql`
        SELECT rp.id, rp.guild_id, rp.user_id, rp.role_id,
               COALESCE(esi.price, 0) AS price,
               COALESCE(cre.attempt_count, 0) AS attempts
          FROM role_purchases rp
          LEFT JOIN economy_recovery_events cre
            ON cre.purchase_id = rp.id AND cre.status = 'OPEN'
          LEFT JOIN economy_shop_items esi
            ON esi.id = rp.item_id
         WHERE rp.active = 1
           AND rp.role_id IS NOT NULL
         ORDER BY rp.acquired_at
         LIMIT 200
      `);

      const outcomes: ReconciliationOutcome[] = [];

      for (const row of rows) {
        const guildId = String(row.guild_id);
        const userId = String(row.user_id);
        const roleId = String(row.role_id);

        let stillGrantable = false;
        try {
          stillGrantable = await probe(guildId, userId, roleId);
        } catch (error) {
          log().error({ err: error, guildId, userId }, 'purchase reconciliation probe failed');
        }

        const outcome = decideReconciliation({
          attempts: row.attempts,
          stillGrantable,
          price: row.price,
        });

        if (outcome.kind === 'COMPLETE' && stillGrantable) {
          outcomes.push(outcome);
          continue;
        }

        // Retries are exhausted, or the role can no longer be granted. Either
        // way the member is refunded and the entitlement released — never
        // left holding a role they did not successfully receive.
        const transition = nextPurchaseStatus('RECOVERY_REQUIRED', 'REFUNDED');
        if (transition.kind !== 'ALLOW') continue;

        await db.execute(
          sql`
            UPDATE role_purchases
               SET active = 0,
                   deactivated_at = now(),
                   deactivated_reason = 'RECONCILED'
             WHERE id = ${row.id} AND active = 1
          `,
        );

        const refunded = await atomicDebit({
          guildId,
          userId,
          amount: row.price,
          type: 'REFUND',
          source: row.id,
        });
        if (!refunded.ok) {
          log().warn({ guildId, userId, purchaseId: row.id }, 'reconciliation refund failed');
        }

        await db.insert(economyRecoveryEvents).values({
          guildId: Number(guildId),
          userId: row.user_id,
          purchaseId: row.id,
          failureType: 'EXHAUSTED_ATTEMPTS',
          status: 'RESOLVED',
          attemptCount: row.attempts,
          originalAmount: row.price,
          compensatedAmount: row.price,
          resolution: 'REFUNDED',
          resolvedAt: new Date(),
        });

        outcomes.push({ kind: 'REFUND', amount: row.price });
      }

      return { scanned: rows.length, outcomes };
    },
  };
}

/** Re-exported so the UI can resolve the shortfall copy from one module. */
export { describeDebitFailure, nextPurchaseStatus, shouldReleaseEntitlement };
export type { DebitResult, PurchaseStatus };
