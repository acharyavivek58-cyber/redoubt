/**
 * Role-assignment workflow invariants.
 *
 * The central claim: roles are granted ONLY through five explicit workflows,
 * and auto-role-on-join does not exist. These tests pin that at the type level
 * (a compile-time exclusion fixture) and at runtime (the decision function).
 */

import { describe, expect, it } from 'vitest';
import {
  authorizeRoleAssignment,
  canGrantRole,
  canRevokeRole,
  GRANTING_WORKFLOWS,
  NO_JOIN_ASSIGNMENT_NOTICE,
  REVOKING_WORKFLOWS,
  ROLE_WORKFLOWS,
  WORKFLOW_LABELS,
  type RoleWorkflow,
} from '../../src/features/roles/workflows.js';

describe('the workflow set is exactly five', () => {
  it('contains only the permitted workflows', () => {
    expect([...ROLE_WORKFLOWS]).toEqual([
      'VERIFICATION',
      'APPLICATION_APPROVAL',
      'ROLE_PURCHASE',
      'SELF_ASSIGN',
      'LEVEL_REWARD',
    ]);
  });

  it('has no auto-role-on-join workflow', () => {
    // The forbidden case must not be expressible.
    expect(ROLE_WORKFLOWS).not.toContain('ON_JOIN');
    expect(ROLE_WORKFLOWS).not.toContain('AUTO_ROLE');
    expect(ROLE_WORKFLOWS).not.toContain('MEMBER_JOIN');
  });

  it('labels every workflow for staff-facing surfaces', () => {
    for (const workflow of ROLE_WORKFLOWS) {
      expect(WORKFLOW_LABELS[workflow], `${workflow} needs a label`).toBeTruthy();
    }
  });

  it('explains the absence of join-time granting', () => {
    expect(NO_JOIN_ASSIGNMENT_NOTICE).toMatch(/never granted automatically on join/);
  });
});

describe('grant and revoke permissions differ per workflow', () => {
  it('lets every workflow grant', () => {
    for (const workflow of ROLE_WORKFLOWS) {
      expect(canGrantRole(workflow), `${workflow} should grant`).toBe(true);
    }
  });

  it('lets only a subset revoke', () => {
    // Verification and levelling must never take a role away.
    expect(canRevokeRole('VERIFICATION')).toBe(false);
    expect(canRevokeRole('LEVEL_REWARD')).toBe(false);
    expect(canRevokeRole('APPLICATION_APPROVAL')).toBe(true);
    expect(canRevokeRole('SELF_ASSIGN')).toBe(true);
    expect([...REVOKING_WORKFLOWS]).toHaveLength(2);
  });

  it('keeps revoking workflows a strict subset of granting ones', () => {
    for (const workflow of REVOKING_WORKFLOWS) {
      expect(GRANTING_WORKFLOWS).toContain(workflow);
    }
  });
});

describe('assignment decisions', () => {
  const base = { guildId: '1', userId: '2', roleId: '3' };

  it('allows a valid grant and produces a stable idempotency key', () => {
    const first = authorizeRoleAssignment({ ...base, workflow: 'SELF_ASSIGN', intent: 'GRANT' });
    const second = authorizeRoleAssignment({ ...base, workflow: 'SELF_ASSIGN', intent: 'GRANT' });
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    // Stable keys are what make a retried delivery safe.
    if (first.allowed && second.allowed) {
      expect(first.assignment.idempotencyKey).toBe(second.assignment.idempotencyKey);
    }
  });

  it('produces distinct keys per workflow', () => {
    const keys = ROLE_WORKFLOWS.map((workflow) => {
      const decision = authorizeRoleAssignment({ ...base, workflow, intent: 'GRANT' });
      return decision.allowed ? decision.assignment.idempotencyKey : '';
    });
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('refuses to revoke through a grant-only workflow', () => {
    for (const workflow of ['VERIFICATION', 'LEVEL_REWARD'] as const) {
      const decision = authorizeRoleAssignment({ ...base, workflow, intent: 'REVOKE' });
      expect(decision.allowed, `${workflow} must not revoke`).toBe(false);
    }
  });

  it('allows self-deselect', () => {
    const decision = authorizeRoleAssignment({ ...base, workflow: 'SELF_ASSIGN', intent: 'REVOKE' });
    expect(decision.allowed).toBe(true);
  });

  it('rejects an empty role id', () => {
    const decision = authorizeRoleAssignment({
      guildId: '1',
      userId: '2',
      roleId: '   ',
      workflow: 'VERIFICATION',
      intent: 'GRANT',
    });
    expect(decision.allowed).toBe(false);
  });

  it('never accepts a workflow outside the union', () => {
    // Runtime backstop for data that did not come through the type system.
    const forged = { ...base, workflow: 'ON_JOIN', intent: 'GRANT' } as unknown as {
      workflow: RoleWorkflow;
      intent: 'GRANT';
      guildId: string;
      userId: string;
      roleId: string;
    };
    const decision = authorizeRoleAssignment(forged);
    // GRANTING_WORKFLOWS.includes('ON_JOIN') is false, so this is refused.
    expect(decision.allowed).toBe(false);
  });
});
