/**
 * Jail domain rules (v12 §J).
 *
 * Pure logic. Four properties this file exists to enforce:
 *
 *  1. RE-JAIL CARRY-FORWARD (v12 §J.5). A member jailed again while already
 *     jailed must INHERIT the original captured-role set, never re-capture.
 *     Re-capturing would snapshot only @Jailed plus whatever roles exist during
 *     the jail, so on release they would keep @Jailed and permanently lose
 *     their real roles.
 *
 *  2. OPERATION IDENTITY (v12 §J.6). Every jail carries an `operationId` and a
 *     `version`. An expiry job for a superseded operation must no-op. Without
 *     this, a re-jail's old timer would release the NEW jail early.
 *
 *  3. EFFECTIVE PERMISSIONS, NOT RAW ROLE LISTS (v12 §J.7). Restoration checks
 *     what the member can actually reach. A `VIEW_CHANNEL` DENY on one role
 *     cannot be overridden by a `VIEW_CHANNEL` ALLOW on another — Discord
 *     resolves channel overwrites before role permissions, so a naive "any
 *     role allows it" check would wrongly restore access they never had.
 *
 *  4. HONEST PARTIAL RESTORATION. When some roles cannot be restored, the
 *     outcome says so explicitly. Never report a clean unjail that silently
 *     dropped roles.
 */

export type JailStatus = 'ACTIVE' | 'EXPIRED' | 'RELEASED' | 'RECOVERY_REQUIRED';

export interface JailRecord {
  readonly guildId: string;
  readonly userId: string;
  readonly jailId: string;
  readonly status: JailStatus;
  readonly operationId: string;
  readonly version: number;
  readonly chainId: string;
  readonly supersedesOperationId: string | null;
  /** The authoritative restoration set for the WHOLE chain. */
  readonly capturedRoleIds: readonly string[];
  /** Detected managed roles; NOT removed while jailed. */
  readonly capturedManagedRoleIds: readonly string[];
  /** Channels deliberately kept reachable (verification, appeals). */
  readonly inaccessibleChannelIds: readonly string[];
}

/** Outcome of deciding what to do when a jail request arrives. */
export interface JailPlan {
  readonly jailId: string;
  readonly operationId: string;
  readonly version: number;
  readonly chainId: string;
  /** INHERITED from the chain, or freshly captured on a first jail. */
  readonly capturedRoleIds: readonly string[];
  readonly capturedManagedRoleIds: readonly string[];
  readonly isReJail: boolean;
  readonly supersedesOperationId: string | null;
}

/**
 * Builds the plan for a new jail.
 *
 * On a re-jail the ORIGINAL captured set is carried forward verbatim — this is
 * the single most important line in the module. `freshCapture` is ignored when
 * a chain already exists.
 */
export function planJail(input: {
  guildId: string;
  userId: string;
  jailId: string;
  operationId: string;
  now: number;
  existing?: JailRecord | null;
  freshCapture: readonly string[];
  freshManagedCapture?: readonly string[];
}): JailPlan {
  const existing = input.existing;

  if (existing && existing.status === 'ACTIVE') {
    return {
      jailId: input.jailId,
      operationId: input.operationId,
      // The chain advances, so the older expiry job no longer matches.
      version: existing.version + 1,
      chainId: existing.chainId,
      // CARRY FORWARD — never re-capture (v12 §J.5).
      capturedRoleIds: [...existing.capturedRoleIds],
      capturedManagedRoleIds: [...existing.capturedManagedRoleIds],
      isReJail: true,
      supersedesOperationId: existing.operationId,
    };
  }

  return {
    jailId: input.jailId,
    operationId: input.operationId,
    version: 1,
    chainId: input.operationId,
    capturedRoleIds: [...input.freshCapture],
    capturedManagedRoleIds: [...input.freshManagedCapture ?? []],
    isReJail: false,
    supersedesOperationId: null,
  };
}

export type ExpiryOutcome =
  | { readonly kind: 'PROCEED'; readonly capturedRoleIds: readonly string[] }
  /** Superseded by a newer jail: the stale job must do NOTHING. */
  | { readonly kind: 'STALE'; readonly reason: string }
  | { readonly kind: 'ALREADY_RESOLVED'; readonly status: JailStatus };

/**
 * Decides whether a scheduled expiry may proceed.
 *
 * Both the operation id and the version must match. Comparing only one would
 * let a replayed job from the same operation re-run after a partial failure.
 */
export function evaluateExpiry(
  jail: JailRecord,
  job: { operationId: string; version: number },
): ExpiryOutcome {
  if (jail.status !== 'ACTIVE') {
    return { kind: 'ALREADY_RESOLVED', status: jail.status };
  }
  if (jail.operationId !== job.operationId) {
    return {
      kind: 'STALE',
      reason: `operation ${job.operationId} was superseded by ${jail.operationId}`,
    };
  }
  if (jail.version !== job.version) {
    return {
      kind: 'STALE',
      reason: `version ${job.version} is behind current version ${jail.version}`,
    };
  }
  return { kind: 'PROCEED', capturedRoleIds: jail.capturedRoleIds };
}

// ---------------------------------------------------------------------------
// Effective-permission restoration (v12 §J.7)
// ---------------------------------------------------------------------------

export interface RolePermissionView {
  readonly roleId: string;
  /** Explicit allow. */
  readonly viewChannel: boolean;
  /** Explicit deny — beats every allow from any other role. */
  readonly viewChannelDenied: boolean;
}

export interface ChannelOverwriteView {
  readonly channelId: string;
  /** roleId -> allowed / null when unset. */
  readonly allows: Readonly<Record<string, boolean | null>>;
  readonly denies: Readonly<Record<string, boolean | null>>;
}

/**
 * Whether the member can actually see a channel, given their CURRENT roles.
 *
 * Discord resolves per-channel overwrites FIRST: an explicit DENY on any
 * overwriting role wins outright, and only then are base role permissions
 * consulted. Modelling it any other way would grant access the member never
 * had, turning an unjail into a permission escalation.
 */
export function canViewChannel(
  channelId: string,
  view: {
    readonly roles: readonly RolePermissionView[];
    readonly overwrite: ChannelOverwriteView | undefined;
  },
): boolean {
  const overwrite = view.overwrite;

  if (overwrite && overwrite.channelId === channelId) {
    // An explicit deny on ANY role beats every allow.
    const denied = Object.values(overwrite.denies).some((value) => value === false);
    if (denied) return false;
    // An explicit allow on any role wins outright.
    const allowed = Object.values(overwrite.allows).some((value) => value === true);
    if (allowed) return true;
  }

  // Base permissions: the same deny-beats-allow rule applies across roles.
  if (view.roles.some((role) => role.viewChannelDenied)) return false;
  return view.roles.some((role) => role.viewChannel);
}

export interface RestorationPlanInput {
  readonly capturedRoleIds: readonly string[];
  /** Roles the member holds RIGHT NOW. */
  readonly currentRoleIds: readonly string[];
  /** Roles that still exist in the guild and are assignable. */
  readonly assignableRoleIds: readonly string[];
  /** Roles deleted while the member was jailed. */
  readonly deletedRoleIds?: readonly string[];
  /** Roles the bot is not hoisted above. */
  readonly unassignableRoleIds?: readonly string[];
}

export interface RestorationPlan {
  readonly rolesToRestore: readonly string[];
  readonly alreadyHeld: readonly string[];
  readonly missingRoleIds: readonly string[];
  /** Set when restoration was incomplete; rendered honestly to staff. */
  readonly partialRestoreReason: string | null;
  readonly complete: boolean;
}

/**
 * Decides exactly which roles to restore, and reports honestly what could not
 * be restored.
 *
 * A role that was deleted mid-jail can never come back, so claiming a clean
 * unjail would be a lie the member discovers later.
 */
export function planRestoration(input: RestorationPlanInput): RestorationPlan {
  const current = new Set(input.currentRoleIds);
  const assignable = new Set(input.assignableRoleIds);
  const deleted = new Set(input.deletedRoleIds ?? []);
  const unassignable = new Set(input.unassignableRoleIds ?? []);

  const rolesToRestore: string[] = [];
  const alreadyHeld: string[] = [];
  const missingRoleIds: string[] = [];

  for (const roleId of input.capturedRoleIds) {
    if (deleted.has(roleId)) {
      missingRoleIds.push(roleId);
      continue;
    }
    if (!assignable.has(roleId) || unassignable.has(roleId)) {
      missingRoleIds.push(roleId);
      continue;
    }
    // Already present: no API call needed, and counting it as restored keeps
    // the outcome honest.
    if (current.has(roleId)) alreadyHeld.push(roleId);
    else rolesToRestore.push(roleId);
  }

  const complete = missingRoleIds.length === 0;
  const partialRestoreReason = complete
    ? null
    : `${missingRoleIds.length} role(s) could not be restored because they were deleted or are no longer assignable.`;

  return { rolesToRestore, alreadyHeld, missingRoleIds, partialRestoreReason, complete };
}

/**
 * How many channels became unreachable by the jail.
 *
 * Channels deliberately kept reachable (verification, appeals) are excluded so
 * the count reflects real impact.
 */
export function computeInaccessibleChannels(input: {
  readonly allChannelIds: readonly string[];
  readonly keptReachable: readonly string[];
  readonly roles: readonly RolePermissionView[];
  readonly overwrites: readonly ChannelOverwriteView[];
}): string[] {
  const kept = new Set(input.keptReachable);
  const overwriteByChannel = new Map(input.overwrites.map((o) => [o.channelId, o]));

  return input.allChannelIds.filter((channelId) => {
    if (kept.has(channelId)) return false;
    const reachable = canViewChannel(channelId, {
      roles: input.roles,
      overwrite: overwriteByChannel.get(channelId),
    });
    return !reachable;
  });
}
