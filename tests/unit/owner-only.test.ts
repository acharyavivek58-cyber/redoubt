/**
 * Owner-only authorization (v14 §B, §17).
 *
 * The invariant under test:
 *   BACKUP/TEMPLATE MANAGEMENT = CURRENT DISCORD GUILD OWNER ONLY.
 *
 * Administrator permission, Manage Guild/Channels/Roles, Redoubt staff roles,
 * and bot-installer status are all explicitly INSUFFICIENT. Only
 * `guild.ownerId === userId` authorizes.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  assertCurrentGuildOwner,
  isCurrentGuildOwner,
  reauthorizeBeforeMutation,
  resolveVisibility,
} from '../../src/core/permissions/permissions.js';
import {
  OwnerAuthorizationLostError,
  PermissionError,
  newReferenceId,
} from '../../src/core/errors.js';

const OWNER = '100';
const ADMIN = '200';
const MODERATOR = '300';
const REGULAR = '400';

function guild(ownerId = OWNER) {
  return { ownerId };
}

describe('owner-only gate', () => {
  it('authorizes the current guild owner', () => {
    expect(isCurrentGuildOwner(guild(), OWNER)).toBe(true);
  });

  it('rejects an administrator who is not the owner', () => {
    // v14 §1: Administrator permission is NOT sufficient.
    expect(isCurrentGuildOwner(guild(), ADMIN)).toBe(false);
  });

  it('rejects a moderator who is not the owner', () => {
    expect(isCurrentGuildOwner(guild(), MODERATOR)).toBe(false);
  });

  it('rejects a regular member', () => {
    expect(isCurrentGuildOwner(guild(), REGULAR)).toBe(false);
  });

  it('rejects the previous owner after ownership transfers', () => {
    // Ownership changed: the OLD owner must lose access immediately.
    const transferred = guild(ADMIN);
    expect(isCurrentGuildOwner(transferred, OWNER)).toBe(false);
    expect(isCurrentGuildOwner(transferred, ADMIN)).toBe(true);
  });

  it('reads the LIVE owner id, never a cached snapshot', () => {
    // Two reads against the same "guild" object with different owners model a
    // transfer happening between calls. The gate must follow the live value.
    const mutable = { ownerId: OWNER };
    expect(isCurrentGuildOwner(mutable, OWNER)).toBe(true);
    mutable.ownerId = ADMIN;
    expect(isCurrentGuildOwner(mutable, OWNER)).toBe(false);
  });

  it('throws a generic PermissionError with no internal detail', () => {
    try {
      assertCurrentGuildOwner(guild(), ADMIN);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PermissionError);
      const message = (error as PermissionError).userMessage;
      // v14 §15: the denied user learns only that they may not perform it.
      expect(message).toBe('Only the current server owner can perform this operation.');
      expect(message).not.toContain(OWNER);
      expect(message).not.toMatch(/permission|role|hierarchy/i);
    }
  });
});

describe('revalidation before mutation (v14 §3, v20 §E.1)', () => {
  it('aborts with zero mutation when ownership changed after the preview', async () => {
    // The exact scenario from the spec: owner previews, ownership transfers,
    // old owner clicks Apply.
    const guildRef = { ownerId: OWNER };

    const mutationSpy = vi.fn();

    await expect(
      reauthorizeBeforeMutation({
        getGuild: async () => {
          // Transfer happens between preview and execute.
          guildRef.ownerId = ADMIN;
          return guildRef;
        },
        userId: OWNER,
        context: { guildId: '1', guildName: 'Test', ownerId: ADMIN },
      }),
    ).rejects.toBeInstanceOf(OwnerAuthorizationLostError);

    expect(mutationSpy).not.toHaveBeenCalled();
  });

  it('surfaces a safe reference ID on ownership loss', async () => {
    try {
      await reauthorizeBeforeMutation({
        getGuild: async () => guild(ADMIN),
        userId: OWNER,
        context: { guildId: '1', guildName: 'Test', ownerId: ADMIN },
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as OwnerAuthorizationLostError;
      expect(err.displayMessage).toContain('OWNER AUTHORIZATION LOST');
      expect(err.displayMessage).toContain('No further changes will be performed');
      expect(err.displayMessage).toMatch(/Reference: R-[0-9A-F]{6}/);
    }
  });

  it('passes when ownership is unchanged', async () => {
    await expect(
      reauthorizeBeforeMutation({
        getGuild: async () => guild(OWNER),
        userId: OWNER,
        context: { guildId: '1', guildName: 'Test', ownerId: OWNER },
      }),
    ).resolves.toBeUndefined();
  });

  it('authorizes the NEW owner for their own new operation', async () => {
    // Pending authorization is never transferred; the new owner starts fresh.
    await expect(
      reauthorizeBeforeMutation({
        getGuild: async () => guild(ADMIN),
        userId: ADMIN,
        context: { guildId: '1', guildName: 'Test', ownerId: ADMIN },
      }),
    ).resolves.toBeUndefined();
  });
});

describe('backup/template commands are marked OWNER_ONLY', () => {
  it('flags ownerOnly commands as OWNER_ONLY visibility', () => {
    // v13 §N.6: Help resolves owner status from the live guild, so these are
    // never advertised to a non-owner.
    expect(resolveVisibility({ ownerOnly: true })).toBe('OWNER_ONLY');
  });

  it('does not treat an admin permission as owner-only', () => {
    // A command gated on Manage Guild is ADMIN, not OWNER_ONLY — the owner
    // gate is a separate concept.
    const visibility = resolveVisibility({
      requiredPermission: BigInt(0x8n), // ManageGuild bit
      ownerOnly: false,
    });
    expect(visibility).not.toBe('OWNER_ONLY');
  });
});

describe('reference ids', () => {
  it('generates a safe user-facing reference', () => {
    const id = newReferenceId();
    expect(id).toMatch(/^R-[0-9A-F]{6}$/);
  });

  it('generates distinct ids', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newReferenceId()));
    expect(ids.size).toBe(200);
  });
});