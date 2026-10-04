/**
 * Jail invariants (v12 §J).
 *
 * Properties under test:
 *  - RE-JAIL CARRY-FORWARD: the chain's ORIGINAL captured set survives re-jail
 *  - EXPIRY IDENTITY: a superseded operation/version no-ops and mutates nothing
 *  - EFFECTIVE PERMISSIONS: a channel DENY beats any other role's ALLOW
 *  - HONEST PARTIAL RESTORATION: vanished roles are reported, never hidden
 */

import { describe, expect, it } from 'vitest';
import {
  canViewChannel,
  computeInaccessibleChannels,
  evaluateExpiry,
  planJail,
  planRestoration,
  type ChannelOverwriteView,
  type JailRecord,
  type RolePermissionView,
} from '../../src/features/moderation/jail/domain.js';

function jail(overrides: Partial<JailRecord> = {}): JailRecord {
  return {
    guildId: '1',
    userId: '2',
    jailId: 'jail-1',
    status: 'ACTIVE',
    operationId: 'op-1',
    version: 1,
    chainId: 'chain-1',
    supersedesOperationId: null,
    capturedRoleIds: ['member', 'mod', 'nitro'],
    capturedManagedRoleIds: [],
    inaccessibleChannelIds: [],
    ...overrides,
  };
}

describe('re-jail carries the original captured roles forward', () => {
  it('inherits the chain set instead of re-capturing', () => {
    // While jailed the member holds only @Jailed. Re-capturing now would
    // snapshot that, and releasing would leave them stuck as @Jailed forever.
    const plan = planJail({
      guildId: '1',
      userId: '2',
      jailId: 'jail-2',
      operationId: 'op-2',
      now: Date.now(),
      existing: jail({ capturedRoleIds: ['member', 'mod', 'nitro'] }),
      freshCapture: ['jailed'],
    });

    expect(plan.capturedRoleIds).toEqual(['member', 'mod', 'nitro']);
    expect(plan.capturedRoleIds).not.toContain('jailed');
    expect(plan.isReJail).toBe(true);
    expect(plan.chainId).toBe('chain-1');
  });

  it('advances the version so the older expiry job cannot fire', () => {
    const plan = planJail({
      guildId: '1',
      userId: '2',
      jailId: 'jail-2',
      operationId: 'op-2',
      now: Date.now(),
      existing: jail({ version: 3 }),
      freshCapture: ['jailed'],
    });
    expect(plan.version).toBe(4);
    expect(plan.supersedesOperationId).toBe('op-1');
  });

  it('captures fresh roles on a FIRST jail and starts a new chain', () => {
    const plan = planJail({
      guildId: '1',
      userId: '2',
      jailId: 'jail-1',
      operationId: 'op-1',
      now: Date.now(),
      existing: null,
      freshCapture: ['member', 'mod'],
    });
    expect(plan.capturedRoleIds).toEqual(['member', 'mod']);
    expect(plan.isReJail).toBe(false);
    expect(plan.version).toBe(1);
    expect(plan.chainId).toBe('op-1');
  });

  it('keeps the carried-forward set identical across many re-jails', () => {
    let current: Partial<JailRecord> = { capturedRoleIds: ['member', 'mod'], chainId: 'chain-1' };
    for (let i = 0; i < 5; i += 1) {
      const plan = planJail({
        guildId: '1',
        userId: '2',
        jailId: `jail-${i}`,
        operationId: `op-${i}`,
        now: Date.now(),
        existing: jail(current),
        // Every re-jail "captures" whatever the member holds mid-jail.
        freshCapture: ['jailed'],
      });
      current = { capturedRoleIds: [...plan.capturedRoleIds], chainId: plan.chainId };
    }
    // Never drifts toward the jail role.
    expect(current.capturedRoleIds).toEqual(['member', 'mod']);
  });

  it('does not alias the caller array when carrying forward', () => {
    const original = ['member', 'mod'];
    const plan = planJail({
      guildId: '1',
      userId: '2',
      jailId: 'j2',
      operationId: 'op-2',
      now: Date.now(),
      existing: jail({ capturedRoleIds: original }),
      freshCapture: ['jailed'],
    });
    // The plan owns a copy, so a later edit of the persisted set cannot
    // retroactively rewrite what this operation captured.
    expect(plan.capturedRoleIds).not.toBe(original);
    expect(plan.capturedRoleIds).toEqual(original);
  });
});

describe('a stale expiry job performs no mutation', () => {
  it('proceeds only when operation id AND version match', () => {
    const record = jail({ operationId: 'op-2', version: 2 });
    expect(evaluateExpiry(record, { operationId: 'op-2', version: 2 }).kind).toBe('PROCEED');
  });

  it('no-ops for a superseded operation id', () => {
    const outcome = evaluateExpiry(jail({ operationId: 'op-2', version: 1 }), {
      operationId: 'op-1',
      version: 1,
    });
    expect(outcome.kind).toBe('STALE');
  });

  it('no-ops for a stale version even when the operation matches', () => {
    const outcome = evaluateExpiry(jail({ operationId: 'op-1', version: 5 }), {
      operationId: 'op-1',
      version: 1,
    });
    expect(outcome.kind).toBe('STALE');
  });

  it('reports an already-resolved jail instead of releasing twice', () => {
    for (const status of ['EXPIRED', 'RELEASED', 'RECOVERY_REQUIRED'] as const) {
      const outcome = evaluateExpiry(jail({ status }), { operationId: 'op-1', version: 1 });
      expect(outcome).toEqual({ kind: 'ALREADY_RESOLVED', status });
    }
  });

  it('returns the chain captured set when it does proceed', () => {
    const outcome = evaluateExpiry(jail({ capturedRoleIds: ['member', 'mod'] }), {
      operationId: 'op-1',
      version: 1,
    });
    expect(outcome).toEqual({ kind: 'PROCEED', capturedRoleIds: ['member', 'mod'] });
  });
});

describe('restoration verifies effective permissions, not role names', () => {
  const role = (id: string, allow: boolean, deny = false): RolePermissionView => ({
    roleId: id,
    viewChannel: allow,
    viewChannelDenied: deny,
  });

  it('lets an explicit channel DENY beat another role ALLOW', () => {
    // The exact bug v12 §J.7 guards against: member holds @mod which allows
    // VIEW_CHANNEL, but an overwrite DENIES it. They cannot see the channel.
    const overwrite: ChannelOverwriteView = {
      channelId: 'staff',
      allows: { '2': true },
      denies: { '3': false },
    };
    expect(
      canViewChannel('staff', {
        roles: [role('2', true)],
        overwrite,
      }),
    ).toBe(false);
  });

  it('honours an explicit channel ALLOW', () => {
    expect(
      canViewChannel('general', {
        roles: [role('2', false)],
        overwrite: { channelId: 'general', allows: { '2': true }, denies: {} },
      }),
    ).toBe(true);
  });

  it('falls back to base permissions when no overwrite exists', () => {
    expect(canViewChannel('general', { roles: [role('2', true)], overwrite: undefined })).toBe(true);
    expect(canViewChannel('general', { roles: [role('2', false)], overwrite: undefined })).toBe(false);
  });

  it('treats a base DENY as beating a base ALLOW from another role', () => {
    expect(
      canViewChannel('general', {
        roles: [role('2', true), role('3', false, true)],
        overwrite: undefined,
      }),
    ).toBe(false);
  });

  it('ignores an overwrite belonging to a different channel', () => {
    expect(
      canViewChannel('general', {
        roles: [role('2', false)],
        overwrite: { channelId: 'other', allows: {}, denies: { '2': false } },
      }),
    ).toBe(false);
  });

  it('counts only genuinely unreachable channels', () => {
    const overwrites: ChannelOverwriteView[] = [
      { channelId: 'hidden', allows: {}, denies: { '2': false } },
      { channelId: 'open', allows: { '2': true }, denies: {} },
    ];
    const unreachable = computeInaccessibleChannels({
      allChannelIds: ['hidden', 'open', 'unconfigured'],
      keptReachable: [],
      roles: [role('2', false)],
      overwrites,
    });
    expect(unreachable).toEqual(['hidden', 'unconfigured']);
  });

  it('never counts a deliberately kept-reachable channel', () => {
    // Verification must stay reachable while jailed.
    const unreachable = computeInaccessibleChannels({
      allChannelIds: ['verify', 'general'],
      keptReachable: ['verify'],
      roles: [role('2', false)],
      overwrites: [],
    });
    expect(unreachable).not.toContain('verify');
  });
});

describe('restoration reports honestly', () => {
  it('restores roles the member no longer holds', () => {
    const plan = planRestoration({
      capturedRoleIds: ['member', 'mod'],
      currentRoleIds: ['jailed'],
      assignableRoleIds: ['member', 'mod', 'jailed'],
    });
    expect(plan.rolesToRestore).toEqual(['member', 'mod']);
    expect(plan.complete).toBe(true);
    expect(plan.partialRestoreReason).toBeNull();
  });

  it('does not re-grant a role the member already has', () => {
    const plan = planRestoration({
      capturedRoleIds: ['member', 'mod'],
      currentRoleIds: ['member', 'jailed'],
      assignableRoleIds: ['member', 'mod'],
    });
    expect(plan.rolesToRestore).toEqual(['mod']);
    expect(plan.alreadyHeld).toEqual(['member']);
  });

  it('reports roles deleted while the member was jailed', () => {
    const plan = planRestoration({
      capturedRoleIds: ['member', 'deleted-role'],
      currentRoleIds: ['jailed'],
      assignableRoleIds: ['member'],
      deletedRoleIds: ['deleted-role'],
    });
    expect(plan.complete).toBe(false);
    expect(plan.missingRoleIds).toEqual(['deleted-role']);
    expect(plan.partialRestoreReason).toMatch(/could not be restored/);
  });

  it('reports roles the bot can no longer assign', () => {
    const plan = planRestoration({
      capturedRoleIds: ['member', 'above-bot'],
      currentRoleIds: ['jailed'],
      assignableRoleIds: ['member'],
      unassignableRoleIds: ['above-bot'],
    });
    expect(plan.complete).toBe(false);
    expect(plan.missingRoleIds).toEqual(['above-bot']);
  });

  it('never claims a clean restoration when anything is missing', () => {
    const plan = planRestoration({
      capturedRoleIds: ['member', 'gone'],
      currentRoleIds: [],
      assignableRoleIds: ['member'],
      deletedRoleIds: ['gone'],
    });
    // A clean report here would be a lie the member discovers later.
    expect(plan.complete).toBe(false);
    expect(plan.partialRestoreReason).not.toBeNull();
  });

  it('treats an empty capture set as a complete no-op', () => {
    const plan = planRestoration({
      capturedRoleIds: [],
      currentRoleIds: ['jailed'],
      assignableRoleIds: [],
    });
    expect(plan).toEqual({
      rolesToRestore: [],
      alreadyHeld: [],
      missingRoleIds: [],
      partialRestoreReason: null,
      complete: true,
    });
  });
});
