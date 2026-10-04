/**
 * Role assignment workflows (v-plan).
 *
 * THE FIVE WORKFLOWS. A member's roles may change in exactly these five ways,
 * and this module makes that EXHAUSTIVE at the type level:
 *
 *   1. VERIFICATION      — the member clicked a verification button
 *   2. APPLICATION       — staff approved an application
 *   3. ROLE_PURCHASE     — the member paid the guild's virtual currency
 *   4. SELF_ASSIGN       — the member picked it in a self-assign channel
 *   5. LEVEL_REWARD      — the member earned it by levelling
 *
 * There is deliberately NO `ON_JOIN` member. Adding one is a COMPILE ERROR,
 * which is what makes "no auto-role-on-join" structural rather than a review
 * convention someone can quietly reintroduce.
 *
 * Each workflow also declares whether it may REMOVE roles, because removal is
 * riskier than granting: verification and levelling should never take
 * something away, whereas a staff action and a self-deselect both can.
 */

export const ROLE_WORKFLOWS = [
  'VERIFICATION',
  'APPLICATION_APPROVAL',
  'ROLE_PURCHASE',
  'SELF_ASSIGN',
  'LEVEL_REWARD',
] as const;

export type RoleWorkflow = (typeof ROLE_WORKFLOWS)[number];

export const GRANTING_WORKFLOWS: readonly RoleWorkflow[] = ROLE_WORKFLOWS;

/** The exhaustive set of workflows allowed to REMOVE roles. */
export const REVOKING_WORKFLOWS: readonly RoleWorkflow[] = [
  'APPLICATION_APPROVAL',
  'SELF_ASSIGN',
];

export function canGrantRole(workflow: RoleWorkflow): boolean {
  return GRANTING_WORKFLOWS.includes(workflow);
}

export function canRevokeRole(workflow: RoleWorkflow): boolean {
  return REVOKING_WORKFLOWS.includes(workflow);
}

/**
 * The role a workflow may touch.
 *
 * `VERIFICATION` and `APPLICATION_APPROVAL` operate on the guild's configured
 * "verified" / "accepted" role. The rest name a specific item role.
 */
export interface RoleAssignment {
  readonly guildId: string;
  readonly userId: string;
  readonly roleId: string;
  readonly workflow: RoleWorkflow;
  /** Durable identity for this logical assignment. */
  readonly idempotencyKey: string;
}

export type RoleAssignmentDecision =
  | { readonly allowed: true; readonly assignment: RoleAssignment }
  | { readonly allowed: false; readonly reason: string };

/**
 * Validates an assignment before any Discord call.
 *
 * Returning a decision rather than mutating directly keeps this checkable
 * without a Discord connection, and keeps the forbidden case impossible to
 * express rather than merely discouraged.
 */
export function authorizeRoleAssignment(input: {
  readonly guildId: string;
  readonly userId: string;
  readonly roleId: string;
  readonly workflow: RoleWorkflow;
  readonly intent: 'GRANT' | 'REVOKE';
}): RoleAssignmentDecision {
  if (input.intent === 'GRANT' && !canGrantRole(input.workflow)) {
    return { allowed: false, reason: `${input.workflow} cannot grant roles.` };
  }
  if (input.intent === 'REVOKE' && !canRevokeRole(input.workflow)) {
    return { allowed: false, reason: `${input.workflow} cannot remove roles.` };
  }
  if (input.roleId.trim() === '') {
    return { allowed: false, reason: 'A role is required.' };
  }

  return {
    allowed: true,
    assignment: {
      guildId: input.guildId,
      userId: input.userId,
      roleId: input.roleId,
      workflow: input.workflow,
      idempotencyKey: `${input.guildId}:${input.userId}:${input.roleId}:${input.workflow}`,
    },
  };
}

/** Plain-language copy for the workflows, shown in staff-facing panels. */
export const WORKFLOW_LABELS: Readonly<Record<RoleWorkflow, string>> = {
  VERIFICATION: 'Verification',
  APPLICATION_APPROVAL: 'Application approval',
  ROLE_PURCHASE: 'Role purchase',
  SELF_ASSIGN: 'Self-assign',
  LEVEL_REWARD: 'Level reward',
};

/** Explains, in one sentence, why join-time granting does not exist. */
export const NO_JOIN_ASSIGNMENT_NOTICE =
  'Roles are never granted automatically on join. A role is applied only after an explicit ' +
  'action: verifying, an approved application, a purchase, a self-assign selection, or a level reward.';
