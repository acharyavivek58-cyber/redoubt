/**
 * Help rendering + Pulse wiring.
 *
 * Properties:
 *  - Help is built from the REGISTRY, so it cannot drift from what dispatches
 *  - Help never advertises a command the viewer cannot actually run
 *  - Pulse renders through `core/ui` and states honest empty/error states
 */

import { describe, expect, it } from 'vitest';
import {
  ButtonStyle,
  ComponentType,
  PermissionsBitField,
  type ActionRowBuilder,
  type APIButtonComponent,
  type ButtonBuilder,
} from 'discord.js';
import { registry } from '../../src/core/registry/command-registry.js';
import '../setup.js';
import '../../src/core/registry/manifest.js';
import { helpCommand, helpIndex, visibleCommands } from '../../src/features/help/help.js';
import {
  pulseActions,
  pulseEmpty,
  pulseEmbed,
  pulseUnavailable,
} from '../../src/features/pulse/render.js';
import { buildPulse } from '../../src/features/pulse/domain.js';

const NO_PERMS = new PermissionsBitField(0n);

/** Flattens action rows to their button components. */
function allButtons(
  components: readonly ActionRowBuilder<ButtonBuilder>[],
): APIButtonComponent[] {
  return components
    .flatMap((row) => row.toJSON().components ?? [])
    .filter((c): c is APIButtonComponent => c.type === ComponentType.Button);
}

function customIdOf(button: APIButtonComponent): string {
  return 'custom_id' in button ? String(button.custom_id) : '';
}

const member = { userId: 'u1', isOwner: false, permissions: NO_PERMS, staffRoleIds: [] };
const owner = { userId: 'u1', isOwner: true, permissions: NO_PERMS, staffRoleIds: [] };

function snapshot() {
  return buildPulse({
    activity: Array.from({ length: 14 }, (_, i) => ({
      day: `2026-09-${String(i + 1).padStart(2, '0')}`,
      messages: i < 7 ? 300 : 120,
      activeMembers: 80,
    })),
    moderation: Array.from({ length: 14 }, (_, i) => ({
      day: `2026-09-${String(i + 1).padStart(2, '0')}`,
      cases: i < 7 ? 1 : 2,
    })),
    levels: { levelUps: 12, activeMembers: 80, averageLevel: 6 },
    economy: { circulating: 12_000, granted: 900, spent: 700, wallets: 80 },
  });
}

describe('help renders from the registry', () => {
  it('lists commands a member can actually use', () => {
    const visible = visibleCommands(member);
    expect(visible.length).toBeGreaterThan(0);
    // Every visible entry is genuinely registered.
    for (const command of visible) {
      expect(registry.resolve(command.name)?.name).toBe(command.name);
    }
  });

  it('hides staff and owner commands from an ordinary member', () => {
    const visible = visibleCommands(member).map((c) => c.name);
    expect(visible).toContain('balance');
    // Advertised but unusable would be worse than hidden.
    expect(visible).not.toContain('backup');
    expect(visible).not.toContain('template');
    expect(visible).not.toContain('mute');
    expect(visible).not.toContain('pulse');
  });

  it('shows owner-only commands to the owner', () => {
    const visible = visibleCommands(owner).map((c) => c.name);
    expect(visible).toContain('backup');
    expect(visible).toContain('template');
  });

  it('builds an index embed from the filtered list', () => {
    const embed = helpIndex({ viewer: member, guildName: 'Test Guild' });
    const json = embed.toJSON();
    expect(json.title).toContain('Commands');
    expect(json.description).toBeTruthy();
  });

  it('never leaks owner-only commands into a member’s index', () => {
    const json = helpIndex({ viewer: member, guildName: 'Test Guild' }).toJSON();
    const text = JSON.stringify(json);
    expect(text).not.toContain('backup');
    expect(text).not.toContain('template');
  });

  it('renders a detail page for a command the viewer may use', () => {
    const json = helpCommand('balance', { viewer: member, guildName: 'Test Guild' }).toJSON();
    expect(JSON.stringify(json)).toContain('balance');
  });

  it('shows an unknown-command page rather than leaking owner commands', () => {
    const json = helpCommand('backup', { viewer: member, guildName: 'Test Guild' }).toJSON();
    // A non-owner must not learn the command exists via a detailed page.
    expect(JSON.stringify(json)).toContain('Unknown command');
  });

  it('shows the real detail page to the owner', () => {
    const json = helpCommand('backup', { viewer: owner, guildName: 'Test Guild' }).toJSON();
    expect(JSON.stringify(json)).toContain('Server owner only');
  });

  it('handles an unknown command name gracefully', () => {
    const json = helpCommand('definitely-not-a-command', { viewer: member }).toJSON();
    expect(JSON.stringify(json)).toContain('Unknown command');
  });
});

describe('pulse renders through core/ui', () => {
  it('produces an embed with a health-titled heading', () => {
    const json = pulseEmbed(snapshot(), { guildName: 'Test Guild', windowDays: 7 }).toJSON();
    expect(json.title).toContain('Server Pulse');
    expect(json.footer?.text).toContain('Redoubt');
  });

  it('includes the four stat fields', () => {
    const json = pulseEmbed(snapshot(), { guildName: 'Test Guild', windowDays: 7 }).toJSON();
    const names = (json.fields ?? []).map((f) => f.name);
    expect(names).toContain('Activity');
    expect(names).toContain('Moderation');
    expect(names).toContain('Progression');
    expect(names).toContain('Economy');
  });

  it('never renders NaN, Infinity, or undefined', () => {
    const json = pulseEmbed(snapshot(), { guildName: 'Test Guild', windowDays: 7 }).toJSON();
    const text = JSON.stringify(json);
    expect(text).not.toMatch(/NaN|Infinity|undefined|null/);
  });

  it('offers no more than the primary-action cap', () => {
    const { components } = pulseActions({ windowDays: 7, page: 0, hasNextPage: false });
    const buttons = allButtons(components);
    const primary = buttons.filter((b) => b.style === ButtonStyle.Primary || b.style === ButtonStyle.Success);
    expect(primary.length).toBeLessThanOrEqual(2);
  });

  it('includes navigation controls that actually do something', () => {
    const { components } = pulseActions({ windowDays: 7, page: 1, hasNextPage: true });
    const ids = allButtons(components).map((b) => customIdOf(b));
    expect(ids).toContain('pulse:home');
    expect(ids).toContain('pulse:next');
    // Nothing decorative.
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
  });

  it('disables Previous on the first page', () => {
    const { components } = pulseActions({ windowDays: 7, page: 0, hasNextPage: false });
    const previous = allButtons(components).find((b) => customIdOf(b) === 'pulse:prev');
    expect(previous?.disabled).toBe(true);
  });

  it('renders an honest empty state', () => {
    const json = pulseEmpty({ guildName: 'Test Guild' }).toJSON();
    const text = JSON.stringify(json);
    expect(text).toContain('No activity');
    // Not an error, and not a dashboard of zeros.
    expect(text).not.toMatch(/something went wrong|error/i);
  });

  it('renders an honest unavailable state with no raw error', () => {
    const json = pulseUnavailable({ guildName: 'Test Guild', referenceId: 'R-ABC123' }).toJSON();
    const text = JSON.stringify(json);
    expect(text).toContain('Nothing was changed');
    expect(text).not.toMatch(/SELECT|postgres|ECONNREFUSED|stack/i);
    expect(text).toContain('R-ABC123');
  });
});
