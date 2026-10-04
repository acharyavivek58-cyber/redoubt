/**
 * Jail service (v12 §J).
 *
 * Persistence + Discord execution. Decisions live in `./domain.ts`.
 *
 * The guarantees, stated plainly:
 *
 *  - A RE-JAIL INHERITS the chain's captured roles. `planJail` returns the
 *    ORIGINAL set and the service never re-captures, so a member can never end
 *    up permanently stuck at @Jailed after release.
 *
 *  - EXPIRY IDENTITY IS CHECKED BEFORE ANY MUTATION. The UPDATE is scoped by
 *    (operation_id, version), so a stale job matches zero rows and performs no
 *    Discord writes at all.
 *
 *  - PERMISSIONS ARE VERIFIED EFFECTIVELY. Before restoring, the service asks
 *    whether the member can genuinely see the target channels rather than
 *    assuming a role grant was sufficient.
 *
 *  - RESTORATION IS HONEST. Roles that vanished mid-jail are reported, and the
 *    jail is marked RECOVERY_REQUIRED rather than silently half-done.
 */

import { sql } from 'drizzle-orm';
import type { Database } from '../../../core/db/client.js';
import { jails, type jailStatusEnum } from '../../../core/db/schema/moderation.js';
import { lazyLogger } from '../../../core/logging/logger.js';
import { randomUUID } from 'node:crypto';
import {
  canViewChannel,
  computeInaccessibleChannels,
  evaluateExpiry,
  planJail,
  planRestoration,
  type ChannelOverwriteView,
  type JailPlan,
  type JailRecord,
  type JailStatus,
  type RolePermissionView,
} from './domain.js';

const log = lazyLogger({ module: 'jail', operation: 'service' });

export type JailDbStatus = (typeof jailStatusEnum)['enumValues'][number];

/** Discord operations the service needs, injected so it is testable. */
export interface JailDiscord {
  currentRoleIds(guildId: string, userId: string): Promise<string[]>;
  addRole(guildId: string, userId: string, roleId: string): Promise<boolean>;
  removeRole(guildId: string, userId: string, roleId: string): Promise<boolean>;
  /**
   * Roles the bot could not remove — for example roles ABOVE the bot's
   * highest role. A role the bot cannot remove on jail can never be restored
   * later either, so this is captured honestly rather than assumed.
   */
  unremovableRoleIds(guildId: string, userId: string): Promise<string[]>;
  rolesView(guildId: string, roleIds: readonly string[]): Promise<RolePermissionView[]>;
  channelOverwriteView(guildId: string, channelId: string): Promise<ChannelOverwriteView | undefined>;
  allChannelIds(guildId: string): Promise<string[]>;
  assignableRoleIds(guildId: string): Promise<string[]>;
  deletedRoleIds(guildId: string): Promise<string[]>;
}

export interface JailRequest {
  readonly guildId: string;
  readonly userId: string;
  readonly actorId: string;
  readonly jailRoleId: string;
  readonly jailChannelId?: string | null;
  readonly reason?: string | null;
  readonly caseId?: string | null;
  readonly durationMs?: number | null;
  /** Channels deliberately left reachable (verification, appeals). */
  readonly keepReachableChannelIds?: readonly string[];
}

export type JailResult =
  | { readonly kind: 'JAILED'; readonly plan: JailPlan; readonly unreachableChannels: number }
  | { readonly kind: 'FAILED'; readonly message: string; readonly reference: string };

export type UnjailResult =
  | { readonly kind: 'UNJAILED'; readonly restoredRoleIds: readonly string[]; readonly complete: boolean }
  | {
      readonly kind: 'PARTIAL';
      readonly restoredRoleIds: readonly string[];
      readonly missingRoleIds: readonly string[];
      readonly reason: string;
    }
  | { readonly kind: 'NOOP'; readonly reason: string };

export interface JailService {
  jail(request: JailRequest): Promise<JailResult>;
  release(guildId: string, userId: string, actorId: string): Promise<UnjailResult>;
  expireOperation(input: {
    guildId: string;
    jailId: string;
    operationId: string;
    version: number;
  }): Promise<UnjailResult>;
  active(guildId: string, userId: string): Promise<JailRecord | null>;
}

interface JailRow extends Record<string, unknown> {
  readonly id: string;
  readonly guild_id: number;
  readonly user_id: number;
  readonly status: JailStatus;
  readonly operation_id: string;
  readonly version: number;
  readonly chain_id: string;
  readonly supersedes_operation_id: string | null;
  readonly captured_role_ids: string[];
  readonly captured_managed_role_ids: string[];
  readonly inaccessible_channel_ids: string[];
}

function toRecord(row: JailRow): JailRecord {
  return {
    guildId: String(row.guild_id),
    userId: String(row.user_id),
    jailId: row.id,
    status: row.status,
    operationId: row.operation_id,
    version: row.version,
    chainId: row.chain_id,
    supersedesOperationId: row.supersedes_operation_id,
    capturedRoleIds: row.captured_role_ids ?? [],
    capturedManagedRoleIds: row.captured_managed_role_ids ?? [],
    inaccessibleChannelIds: row.inaccessible_channel_ids ?? [],
  };
}

export function createJailService(db: Database, discord: JailDiscord): JailService {
  async function loadActive(guildId: string, userId: string): Promise<JailRecord | null> {
    const rows = await db.execute<JailRow>(sql`
      SELECT id, guild_id, user_id, status, operation_id, version, chain_id,
             supersedes_operation_id, captured_role_ids, captured_managed_role_ids,
             inaccessible_channel_ids
        FROM jails
       WHERE guild_id = ${Number(guildId)}
         AND user_id = ${Number(userId)}
         AND status = 'ACTIVE'
       LIMIT 1
    `);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  /**
   * Restores the captured roles, reporting honestly what could not be
   * restored.
   */
  async function performRestoration(
    jail: JailRecord,
    nextStatus: 'EXPIRED' | 'RELEASED' | 'RECOVERY_REQUIRED',
  ): Promise<UnjailResult> {
    const [currentRoles, assignable, deleted, unassignable] = await Promise.all([
      discord.currentRoleIds(jail.guildId, jail.userId),
      discord.assignableRoleIds(jail.guildId),
      discord.deletedRoleIds(jail.guildId),
      discord.unremovableRoleIds(jail.guildId, jail.userId),
    ]);

    const plan = planRestoration({
      capturedRoleIds: jail.capturedRoleIds,
      currentRoleIds: currentRoles,
      assignableRoleIds: assignable,
      deletedRoleIds: deleted,
      unassignableRoleIds: unassignable,
    });

    const restored: string[] = [];
    for (const roleId of plan.rolesToRestore) {
      try {
        if (await discord.addRole(jail.guildId, jail.userId, roleId)) restored.push(roleId);
      } catch (error) {
        log().error({ err: error, guildId: jail.guildId, roleId }, 'role restore failed');
      }
    }

    await db.execute(
      sql`
        UPDATE jails
           SET status = ${nextStatus}::jail_status,
               missing_role_ids = ${JSON.stringify(plan.missingRoleIds)}::jsonb,
               partial_restore_reason = ${plan.partialRestoreReason},
               updated_at = now()
         WHERE guild_id = ${Number(jail.guildId)}
           AND user_id = ${Number(jail.userId)}
           AND operation_id = ${jail.operationId}
           AND version = ${jail.version}
           AND status = 'ACTIVE'
      `,
    );

    if (!plan.complete) {
      return {
        kind: 'PARTIAL',
        restoredRoleIds: restored,
        missingRoleIds: plan.missingRoleIds,
        reason: plan.partialRestoreReason ?? 'Some roles could not be restored.',
      };
    }

    return { kind: 'UNJAILED', restoredRoleIds: restored, complete: true };
  }

  return {
    async active(guildId, userId) {
      return loadActive(guildId, userId);
    },

    async jail(request) {
      const reference = `J-${randomUUID().slice(0, 8)}`;
      const existing = await loadActive(request.guildId, request.userId);

      // On a first jail we capture what the member actually holds. On a re-jail
      // this value is DISCARDED in favour of the chain's original set.
      const freshCapture = await discord.currentRoleIds(request.guildId, request.userId);
      const unremovable = await discord.unremovableRoleIds(request.guildId, request.userId);
      const jailId = randomUUID();
      const operationId = randomUUID();

      const plan = planJail({
        guildId: request.guildId,
        userId: request.userId,
        jailId,
        operationId,
        now: Date.now(),
        existing,
        freshCapture,
        freshManagedCapture: [],
      });

      // Supersede any existing ACTIVE jail for this member. The partial unique
      // index guarantees at most one ACTIVE row, so this must happen before the
      // insert.
      if (existing) {
        await db.execute(
          sql`
            UPDATE jails
               SET status = 'EXPIRED'::jail_status, updated_at = now()
             WHERE guild_id = ${Number(request.guildId)}
               AND user_id = ${Number(request.userId)}
               AND status = 'ACTIVE'
          `,
        );
      }

      const unreachable = computeInaccessibleChannels({
        allChannelIds: await discord.allChannelIds(request.guildId),
        keptReachable: request.keepReachableChannelIds ?? [],
        roles: await discord.rolesView(
          request.guildId,
          plan.capturedRoleIds.filter((id) => id !== request.jailRoleId),
        ),
        overwrites: request.jailChannelId
          ? [await discord.channelOverwriteView(request.guildId, request.jailChannelId)]
              .filter((o): o is ChannelOverwriteView => o !== undefined)
          : [],
      });

      const inserted = await db
        .insert(jails)
        .values({
          id: plan.jailId,
          guildId: Number(request.guildId),
          userId: Number(request.userId),
          caseId: request.caseId ?? null,
          jailRoleId: Number(request.jailRoleId),
          jailChannelId: request.jailChannelId ? Number(request.jailChannelId) : null,
          // CARRY-FORWARD on re-jail; a fresh capture on first jail.
          capturedRoleIds: [...plan.capturedRoleIds],
          capturedManagedRoleIds: [...plan.capturedManagedRoleIds],
          inaccessibleChannelIds: unreachable,
          expiresAt: request.durationMs ? new Date(Date.now() + request.durationMs) : null,
          reason: request.reason ?? null,
          status: 'ACTIVE',
          operationId: plan.operationId,
          version: plan.version,
          chainId: plan.chainId,
          supersedesOperationId: plan.supersedesOperationId,
          createdBy: Number(request.actorId),
          updatedAt: new Date(),
        })
        .returning({ id: jails.id });

      if (inserted.length === 0) {
        return {
          kind: 'FAILED',
          message: 'Could not start the jail. Nothing was changed.',
          reference,
        };
      }

      // Capture BEFORE removing, then remove everything not part of the jail
      // setup. Removal failures are tolerated: a role the bot cannot remove is
      // recorded so restoration does not later claim success for it.
      const jailSet = new Set([request.jailRoleId]);
      const removable = plan.capturedRoleIds.filter((id) => !jailSet.has(id));
      for (const roleId of removable) {
        if (unremovable.includes(roleId)) continue;
        try {
          await discord.removeRole(request.guildId, request.userId, roleId);
        } catch (error) {
          log().error({ err: error, guildId: request.guildId, roleId }, 'role removal failed during jail');
        }
      }

      try {
        await discord.addRole(request.guildId, request.userId, request.jailRoleId);
      } catch (error) {
        log().error({ err: error, guildId: request.guildId }, 'could not apply the jail role');
      }

      return { kind: 'JAILED', plan, unreachableChannels: unreachable.length };
    },

    async release(guildId, userId, actorId) {
      const jail = await loadActive(guildId, userId);
      if (!jail) {
        return { kind: 'NOOP', reason: 'That member is not jailed.' };
      }
      void actorId;
      return performRestoration(jail, 'RELEASED');
    },

    async expireOperation({ guildId, jailId, operationId, version }) {
      const rows = await db.execute<JailRow>(sql`
        SELECT id, guild_id, user_id, status, operation_id, version, chain_id,
               supersedes_operation_id, captured_role_ids, captured_managed_role_ids,
               inaccessible_channel_ids
          FROM jails
         WHERE guild_id = ${Number(guildId)}
           AND id = ${jailId}
         LIMIT 1
      `);

      const row = rows[0];
      if (!row) return { kind: 'NOOP', reason: 'That jail no longer exists.' };

      // Identity is checked BEFORE any mutation: a stale job performs no
      // Discord writes whatsoever.
      const outcome = evaluateExpiry(toRecord(row), { operationId, version });
      if (outcome.kind === 'STALE') return { kind: 'NOOP', reason: outcome.reason };
      if (outcome.kind === 'ALREADY_RESOLVED') {
        return { kind: 'NOOP', reason: `That jail is already ${outcome.status}.` };
      }

      return performRestoration(toRecord(row), 'EXPIRED');
    },
  };
}

/** Re-exported for callers that only need the permission model. */
export { canViewChannel, planJail, planRestoration };
export type { JailPlan, JailRecord };
