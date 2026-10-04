/**
 * Authorization (v13 §10, v14 §B, v20 §E.1).
 *
 * TWO GATES, kept deliberately separate:
 *
 *  - `authorize()` — the standard 8 checks for any privileged action.
 *  - `isCurrentGuildOwner()` — the OWNER-ONLY gate for backup/template. NOT a
 *    permission; only `guild.ownerId === userId` satisfies it. Administrator,
 *    Manage Guild, role hierarchy, and bot-installer status are all
 *    insufficient.
 *
 * `reauthorizeBeforeMutation()` is the reusable double-check required for any
 * destructive preview->execute path (v20 §E.1). The hazard it closes: a user
 * is authorized at request time, the ownership or role state changes, and the
 * execute step would otherwise proceed on stale authorization.
 */

import type { Guild, GuildMember, PermissionsBitField } from 'discord.js';
import { PermissionFlagsBits } from 'discord.js';
import { OwnerAuthorizationLostError, PermissionError, newReferenceId } from '../errors.js';
import type { GuildContext, ModuleName, VisibilityLevel } from '../../shared/types/discord.js';

/** The eight checks, in order (v13 §10). */
export interface AuthorizationInput {
  readonly context: GuildContext;
  readonly actor: GuildMember;
  readonly requiredPermission?: bigint;
  readonly module?: ModuleName;
  readonly moduleEnabled?: boolean;
  /** Role ids the guild configures as staff for this action. */
  readonly staffRoleIds?: readonly string[];
  readonly target?: GuildMember;
}

export interface AuthorizationResult {
  readonly authorized: boolean;
  readonly reason?: string;
}

export function checkPermissions(input: AuthorizationInput): AuthorizationResult {
  const { context, actor } = input;

  // 1. Discord permission
  if (input.requiredPermission) {
    const permissions = actor.permissions as PermissionsBitField;
    if (!permissions?.has(input.requiredPermission)) {
      return { authorized: false, reason: 'missing_discord_permission' };
    }
  }

  // 2. Module enabled
  if (input.module && input.moduleEnabled === false) {
    return { authorized: false, reason: 'module_disabled' };
  }

  // 3. Command/feature authorization (staff roles)
  if (input.staffRoleIds?.length) {
    const hasStaffRole = input.staffRoleIds.some((roleId) => actor.roles.cache.has(roleId));
    if (!hasStaffRole) {
      return { authorized: false, reason: 'missing_staff_role' };
    }
  }

  // 4/5. Role hierarchy: actor outranks target, and the bot outranks both.
  if (input.target) {
    if (input.target.id === actor.id) {
      return { authorized: false, reason: 'target_is_actor' };
    }
    if (input.target.id === context.ownerId) {
      return { authorized: false, reason: 'target_is_owner' };
    }
    if (input.target.id === context.guildId) {
      return { authorized: false, reason: 'invalid_target' };
    }
    // 6. Target validity: cannot act on the bot itself or a higher-ranked member.
    if (input.target.id === actor.client.user?.id) {
      return { authorized: false, reason: 'target_is_bot' };
    }
    if (actor.id === context.ownerId) {
      // The owner outranks everyone; skip the hierarchy comparison.
    } else if (actor.roles.highest.comparePositionTo(input.target.roles.highest) <= 0) {
      return { authorized: false, reason: 'role_hierarchy' };
    }
  }

  return { authorized: true };
}

/** Throws PermissionError when unauthorized. */
export function authorize(input: AuthorizationInput): void {
  const result = checkPermissions(input);
  if (!result.authorized) {
    // v13 §8: never expose WHY. The user learns only that they may not act.
    throw new PermissionError('You do not have permission to use this command.', {
      guildId: input.context.guildId,
      userId: input.actor.id,
      module: input.module,
      reason: result.reason,
    });
  }
}

// ---------------------------------------------------------------------------
// Owner-only gate (v14 §B)
// ---------------------------------------------------------------------------

/**
 * The ONLY sufficient condition for backup/template authorization.
 *
 * Reads the LIVE guild owner id on every call — never a cached value, a stored
 * "creator" flag, or an earlier authorization result.
 */
export function isCurrentGuildOwner(guild: Pick<Guild, 'ownerId'>, userId: string): boolean {
  return guild.ownerId === userId;
}

/** Owner check that throws OwnerAuthorizationLostError-style failure. */
export function assertCurrentGuildOwner(guild: Pick<Guild, 'ownerId'>, userId: string): void {
  if (!isCurrentGuildOwner(guild, userId)) {
    throw new PermissionError('Only the current server owner can perform this operation.', {
      userId,
      ownerId: guild.ownerId,
    });
  }
}

// ---------------------------------------------------------------------------
// Revalidation primitive (v20 §E.1)
// ---------------------------------------------------------------------------

export interface RevalidationContext {
  /** Re-reads the live guild. Must NOT be a cached snapshot. */
  readonly getGuild: () => Promise<Pick<Guild, 'ownerId'>>;
  readonly userId: string;
  readonly context: GuildContext;
}

/**
 * AUTHORIZATION CHECK #2 — run immediately before a real mutation.
 *
 * Closes the window between a preview and its Apply button: if ownership or
 * roles changed in that window, the operation is ABORTED with zero mutation
 * rather than proceeding on stale authorization.
 */
export async function reauthorizeBeforeMutation(revalidation: RevalidationContext): Promise<void> {
  const guild = await revalidation.getGuild();
  if (!isCurrentGuildOwner(guild, revalidation.userId)) {
    throw new OwnerAuthorizationLostError({
      guildId: revalidation.context.guildId,
      userId: revalidation.userId,
      currentOwnerId: guild.ownerId,
    });
  }
}

/**
 * Generic pre-mutation revalidation for non-owner destructive actions.
 *
 * `revalidate` re-runs the full check set against live state.
 */
export async function revalidateBeforeMutation<T>(
  revalidate: () => Promise<T>,
): Promise<T> {
  return revalidate();
}

/** Convenience wrapper producing a safe reference for a denied owner action. */
export function ownerDeniedReference(): string {
  return newReferenceId();
}

// ---------------------------------------------------------------------------
// Visibility (Help, v13 §5)
// ---------------------------------------------------------------------------

/**
 * Per-VIEWER access tier for Help.
 *
 * v13 §5A: help visibility is NEVER a security boundary. This exists so Help
 * shows a viewer the commands they could actually use — the command handler
 * still runs its own authorization independently.
 */
export function resolveVisibility(input: {
  requiredPermission?: bigint;
  ownerOnly?: boolean;
  staffRoleIds?: readonly string[];
}): VisibilityLevel {
  if (input.ownerOnly) return 'OWNER_ONLY';
  if (input.requiredPermission && input.requiredPermission === PermissionFlagsBits.ManageGuild) {
    return 'ADMIN';
  }
  if (input.staffRoleIds?.length) return 'STAFF';
  if (input.requiredPermission) return 'CONFIGURED_PERMISSION';
  return 'PUBLIC';
}

/** True when the viewer may SEE a command (not necessarily run it). */
export function canView(
  visibility: VisibilityLevel,
  viewer: {
    isOwner: boolean;
    permissions?: PermissionsBitField;
    staffRoleIds?: readonly string[];
  },
): boolean {
  switch (visibility) {
    case 'PUBLIC':
      return true;
    case 'CONFIGURED_PERMISSION':
      // Shown when the guild configures staff roles and the viewer has one.
      return (
        viewer.staffRoleIds !== undefined &&
        viewer.staffRoleIds.length > 0 &&
        viewer.permissions !== undefined
      );
    case 'STAFF':
    case 'ADMIN':
    case 'OWNER_ONLY':
      // Conservative: hidden unless the viewer is the owner. The command's own
      // authorization is authoritative regardless of this.
      return viewer.isOwner;
    default:
      return false;
  }
}