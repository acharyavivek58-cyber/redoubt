/**
 * Command manifest.
 *
 * The single list both transports read and Help renders from. A command that
 * exists here is reachable as `$name`, as `/name`, and appears in Help — there
 * is no second list to fall out of sync.
 *
 * NOTE ON OWNERSHIP: `/backup` and `/template` carry `ownerOnly: true`. That
 * flag is checked against the CURRENT `guild.ownerId` at request start AND
 * re-verified immediately before mutation. `created_by` on a backup or template
 * row is informational and never grants authorization — if ownership transfers,
 * the new owner gains the surface and the old owner loses it.
 */

import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { registry, type CommandDefinition, type CommandResult } from './command-registry.js';
import { helpCommand, helpIndex } from '../../features/help/help.js';
import { pulseActions, pulseEmpty, pulseEmbed } from '../../features/pulse/render.js';
import type { PulseService } from '../../features/pulse/service.js';
import type { Theme } from '../ui/themes/theme.js';

/**
 * Services handlers depend on.
 *
 * Populated by `setHandlerServices()` during boot. Until then, a handler that
 * needs one reports that the feature is unavailable rather than throwing — the
 * registry can be imported (and tested) without a database connection.
 */
let services: HandlerServices = {};

export function setHandlerServices(next: HandlerServices): void {
  services = next;
}

const STAFF = [
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ModerateMembers,
];

const EVERYONE: readonly bigint[] = [];

/**
 * Placeholder for a command whose backing feature is not yet wired.
 *
 * HONEST BY CONSTRUCTION: it says the feature is not available rather than
 * pretending to succeed. Each is replaced by a real handler as that feature
 * lands, and a command is only left here while it genuinely does not work.
 */
function unavailable(feature: string): () => Promise<CommandResult> {
  // eslint-disable-next-line @typescript-eslint/require-await -- async to match CommandHandler; returns a fixed result
  return async () => ({
    content: `\`${feature}\` is not available in this server yet. Ask an administrator to finish setup.`,
  });
}

function define(definition: CommandDefinition): CommandDefinition {
  registry.register(definition);
  return definition;
}

/**
 * Services the handlers need, injected once at boot.
 *
 * Handlers read from here rather than constructing their own, so a command can
 * never silently run against a different database than the rest of the bot.
 */
export interface HandlerServices {
  readonly pulse?: PulseService;
  readonly themeFor?: (guildId: string) => Promise<Theme>;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

for (const name of ['ping', 'invite', 'afk'] as const) {
  define({
    name,
    aliases: [],
    description:
      name === 'afk'
        ? 'Mark yourself as away, or clear your AFK status.'
        : `Redoubt utility: ${name}.`,
    category: 'Utility',
    // `usage` is mandatory (the registry enforces it), so zero-argument
    // commands say so explicitly rather than leaving it blank.
    usage: name === 'afk' ? '[reason]' : '(no arguments)',
    examples: name === 'afk' ? ['$afk', '$afk back in 10'] : ['$' + name],
    module: 'utility',
    permissions: EVERYONE,
    staffRoleIds: [],
    ownerOnly: false,
    relatedCommands: ['help', 'pulse'],
    visibility: 'PUBLIC',
    handler: unavailable(name),
  });
}

// --- help: real handler, rendered from the registry itself ---

define({
  name: 'help',
  aliases: ['h'],
  description: 'Browse every command and how to use it.',
  category: 'Utility',
  usage: '[command]',
  examples: ['$help', '$help balance'],
  module: 'utility',
  permissions: EVERYONE,
  staffRoleIds: [],
  ownerOnly: false,
  relatedCommands: ['pulse'],
  visibility: 'PUBLIC',
  handler: async (args, ctx) => {
    const theme = await services.themeFor?.(ctx.guildId);
    const viewer = {
      userId: ctx.userId,
      isOwner: ctx.ownerId === ctx.userId,
      // A bare bitfield: Help visibility only ever tests OWNER_ONLY vs the
      // rest, and the executor has already enforced real permissions.
      permissions: new PermissionsBitField(0n),
      staffRoleIds: [] as string[],
    };

    const target = args.positional[0];
    const embed =
      target === undefined
        ? helpIndex({ viewer, guildName: ctx.guildName, theme })
        : helpCommand(target, { viewer, guildName: ctx.guildName, theme });

    return { embeds: [embed] };
  },
});

// --- pulse: the Server Pulse dashboard ---

define({
  name: 'pulse',
  aliases: ['health', 'serverpulse'],
  description:
    'A weekly read on your server: activity trend, moderation pressure, progression, and economy — with the one thing worth acting on.',
  category: 'Utility',
  usage: '[days]',
  examples: ['$pulse', '$pulse 14'],
  module: 'logging',
  permissions: STAFF,
  staffRoleIds: [],
  ownerOnly: false,
  relatedCommands: ['stats', 'level', 'modcases', 'help'],
  visibility: 'STAFF',
  handler: async (args, ctx) => {
    const service = services.pulse;
    if (!service) return { content: 'Server Pulse is not enabled in this build.' };

    // Clamped so a caller cannot ask for a window wider than the data.
    const requested = Number(args.positional[0] ?? '7');
    const windowDays =
      Number.isFinite(requested) && requested >= 1 && requested <= 30
        ? Math.floor(requested)
        : 7;

    const snapshot = await service.snapshot({ guildId: ctx.guildId, windowDays });
    const theme = await services.themeFor?.(ctx.guildId);

    if (!snapshot) {
      return { embeds: [pulseEmpty({ theme, guildName: ctx.guildName })] };
    }

    const { components } = pulseActions({ windowDays, page: 0, hasNextPage: false });
    return {
      embeds: [pulseEmbed(snapshot, { theme, guildName: ctx.guildName, windowDays })],
      components,
    };
  },
});

// ---------------------------------------------------------------------------
// Moderation — public vocabulary is Mute/Unmute only
// ---------------------------------------------------------------------------

for (const name of ['warn', 'mute', 'unmute', 'kick', 'ban', 'softban'] as const) {
  define({
    name,
    aliases: [],
    description:
      name === 'warn'
        ? 'Warn a member and record it in their case history.'
        : `${name.charAt(0).toUpperCase()}${name.slice(1)} a member.`,
    category: 'Moderation',
    usage: '<member> [reason]',
    examples: [`$${name} <@member> spamming`],
    module: 'moderation',
    permissions: STAFF,
    staffRoleIds: [],
    ownerOnly: false,
    relatedCommands: ['modcases', 'jail', 'unjail'],
    visibility: 'STAFF',
    handler: unavailable(name),
  });
}

define({
  name: 'jail',
  aliases: [],
  description: 'Move a member into the jail role, holding their other roles.',
  category: 'Moderation',
  usage: '<member> <duration> [reason]',
  examples: ['$jail <@member> 2h flooding chat'],
  module: 'moderation',
  permissions: STAFF,
  staffRoleIds: [],
  ownerOnly: false,
  relatedCommands: ['unjail', 'modcases'],
  visibility: 'STAFF',
  handler: unavailable('jail'),
});

define({
  name: 'unjail',
  aliases: [],
  description: 'Release a jailed member and restore their roles.',
  category: 'Moderation',
  usage: '<member> [reason]',
  examples: ['$unjail <@member> served time'],
  module: 'moderation',
  permissions: STAFF,
  staffRoleIds: [],
  ownerOnly: false,
  relatedCommands: ['jail'],
  visibility: 'STAFF',
  handler: unavailable('unjail'),
});

define({
  name: 'purge',
  aliases: ['clear'],
  description: 'Bulk-delete recent messages, with an audit record.',
  category: 'Moderation',
  usage: '<amount> [reason]',
  examples: ['$purge 50 off-topic'],
  module: 'moderation',
  permissions: [PermissionFlagsBits.ManageMessages],
  staffRoleIds: [],
  ownerOnly: false,
  relatedCommands: ['modcases'],
  visibility: 'STAFF',
  handler: unavailable('purge'),
});

define({
  name: 'modcases',
  aliases: ['cases'],
  description: 'Search the moderation case history for a member.',
  category: 'Moderation',
  usage: '<member> [page]',
  examples: ['$modcases <@member>'],
  module: 'moderation',
  permissions: STAFF,
  staffRoleIds: [],
  ownerOnly: false,
  relatedCommands: ['warn', 'mute', 'jail'],
  visibility: 'STAFF',
  handler: unavailable('mod cases'),
});

// ---------------------------------------------------------------------------
// Owner-only surface (v14 §B) — ENTIRELY gated on the CURRENT guild owner
// ---------------------------------------------------------------------------

for (const name of ['backup', 'template'] as const) {
  define({
    name,
    aliases: [],
    description:
      name === 'backup'
        ? 'Export this server’s configuration. Owner-only.'
        : 'Save, load, and share configuration templates. Owner-only.',
    category: 'Owner',
    usage: name === 'backup' ? 'create|list|restore <id>' : 'save|load|list|share <id>',
    examples: [`$${name} create`, `$${name} list`],
    module: 'utility',
    // Owner-only is checked FIRST and is not satisfiable by any permission bit
    // or staff role. The permission list below is belt-and-braces only.
    permissions: [],
    staffRoleIds: [],
    ownerOnly: true,
    relatedCommands: ['backup', 'template'],
    visibility: 'OWNER_ONLY',
    handler: unavailable(name),
  });
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

define({
  name: 'setup',
  aliases: [],
  description: 'Guided setup for modules, channels, and roles.',
  category: 'Configuration',
  usage: '[start|status|reset]',
  examples: ['$setup start'],
  module: 'utility',
  permissions: [PermissionFlagsBits.Administrator],
  staffRoleIds: [],
  ownerOnly: false,
  relatedCommands: ['modules', 'prefix'],
  visibility: 'ADMIN',
  handler: unavailable('setup'),
});

define({
  name: 'prefix',
  aliases: [],
  description: 'View or change this server’s command prefix.',
  category: 'Configuration',
  usage: '[new-prefix]',
  examples: ['$prefix', '$prefix !'],
  module: 'utility',
  permissions: [PermissionFlagsBits.ManageGuild],
  staffRoleIds: [],
  ownerOnly: false,
  relatedCommands: ['setup'],
  visibility: 'ADMIN',
  handler: unavailable('prefix'),
});

define({
  name: 'modules',
  aliases: [],
  description: 'Enable or disable modules for this server.',
  category: 'Configuration',
  usage: 'list|enable <module>|disable <module>',
  examples: ['$modules list', '$modules enable leveling'],
  module: 'utility',
  permissions: [PermissionFlagsBits.ManageGuild],
  staffRoleIds: [],
  ownerOnly: false,
  relatedCommands: ['setup'],
  visibility: 'ADMIN',
  handler: unavailable('modules'),
});

define({
  name: 'config',
  aliases: [],
  description: 'View and change module settings.',
  category: 'Configuration',
  usage: '<module> [key] [value]',
  examples: ['$config automod caps on'],
  module: 'utility',
  permissions: [PermissionFlagsBits.ManageGuild],
  staffRoleIds: [],
  ownerOnly: false,
  relatedCommands: ['modules', 'accent'],
  visibility: 'ADMIN',
  handler: unavailable('config'),
});

define({
  name: 'accent',
  aliases: [],
  description: 'Change this server’s embed accent colour.',
  category: 'Configuration',
  usage: '[colour]',
  examples: ['$accent', '$accent violet'],
  module: 'utility',
  permissions: [PermissionFlagsBits.ManageGuild],
  staffRoleIds: [],
  ownerOnly: false,
  relatedCommands: ['config'],
  visibility: 'ADMIN',
  handler: unavailable('accent'),
});

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

define({
  name: 'pay',
  aliases: [],
  description: 'Send virtual currency to another member.',
  category: 'Economy',
  usage: '<member> <amount>',
  examples: ['$pay <@member> 100'],
  module: 'economy',
  permissions: EVERYONE,
  staffRoleIds: [],
  ownerOnly: false,
  relatedCommands: ['balance'],
  visibility: 'PUBLIC',
  handler: unavailable('currency transfer'),
});

define({
  name: 'daily',
  aliases: [],
  description: 'Claim your daily virtual currency reward.',
  category: 'Economy',
  usage: '(no arguments)',
  examples: ['$daily'],
  module: 'economy',
  permissions: EVERYONE,
  staffRoleIds: [],
  ownerOnly: false,
  relatedCommands: ['balance', 'work'],
  visibility: 'PUBLIC',
  handler: unavailable('daily claim'),
});

define({
  name: 'work',
  aliases: [],
  description: 'Work a job for a small virtual currency reward.',
  category: 'Economy',
  usage: '[job]',
  examples: ['$work', '$work miner'],
  module: 'economy',
  permissions: EVERYONE,
  staffRoleIds: [],
  ownerOnly: false,
  relatedCommands: ['daily', 'balance'],
  visibility: 'PUBLIC',
  handler: unavailable('work'),
});

define({
  name: 'rewards',
  aliases: [],
  description: 'View the level rewards configured for this server.',
  category: 'Leveling',
  usage: '(no arguments)',
  examples: ['$rewards'],
  module: 'leveling',
  permissions: EVERYONE,
  staffRoleIds: [],
  ownerOnly: false,
  relatedCommands: ['level', 'leaderboard'],
  visibility: 'PUBLIC',
  handler: unavailable('level rewards'),
});

define({
  name: 'balance',
  aliases: ['bal'],
  description: 'Check a member’s currency balance.',
  category: 'Economy',
  usage: '[member]',
  examples: ['$balance', '$balance <@member>'],
  module: 'economy',
  permissions: EVERYONE,
  staffRoleIds: [],
  ownerOnly: false,
  relatedCommands: ['shop', 'pay', 'daily', 'work'],
  visibility: 'PUBLIC',
  handler: unavailable('balance'),
});

define({
  name: 'shop',
  aliases: ['store'],
  description: 'Browse and buy roles and items with virtual currency.',
  category: 'Economy',
  usage: '[item]',
  examples: ['$shop', '$shop VIP'],
  module: 'economy',
  permissions: EVERYONE,
  staffRoleIds: [],
  ownerOnly: false,
  relatedCommands: ['balance', 'roles'],
  visibility: 'PUBLIC',
  handler: unavailable('shop'),
});

define({
  name: 'roles',
  aliases: ['color'],
  description: 'Manage your self-assignable roles.',
  category: 'Roles',
  usage: 'list|add <role>|remove <role>',
  examples: ['$roles list', '$roles add Blue'],
  module: 'roles',
  permissions: EVERYONE,
  staffRoleIds: [],
  ownerOnly: false,
  relatedCommands: ['shop', 'verify'],
  visibility: 'PUBLIC',
  handler: unavailable('self-assign'),
});

define({
  name: 'verify',
  aliases: [],
  description: 'Verify your account to unlock the server.',
  category: 'Utility',
  usage: '[code]',
  examples: ['$verify'],
  module: 'welcome',
  permissions: EVERYONE,
  staffRoleIds: [],
  ownerOnly: false,
  relatedCommands: ['roles'],
  visibility: 'PUBLIC',
  handler: unavailable('verification'),
});

define({
  name: 'level',
  aliases: ['rank', 'lvl'],
  description: 'View your level, or another member’s.',
  category: 'Leveling',
  usage: '[member]',
  examples: ['$level', '$level <@member>'],
  module: 'leveling',
  permissions: EVERYONE,
  staffRoleIds: [],
  ownerOnly: false,
  relatedCommands: ['leaderboard', 'rewards'],
  visibility: 'PUBLIC',
  handler: unavailable('level'),
});

define({
  name: 'leaderboard',
  aliases: ['top', 'lb'],
  description: 'This season’s top members.',
  category: 'Leveling',
  usage: '[page]',
  examples: ['$leaderboard'],
  module: 'leveling',
  permissions: EVERYONE,
  staffRoleIds: [],
  ownerOnly: false,
  relatedCommands: ['level'],
  visibility: 'PUBLIC',
  handler: unavailable('leaderboard'),
});

define({
  name: 'invites',
  aliases: [],
  description: 'View invite attribution for this server.',
  category: 'Utility',
  usage: '[member]',
  examples: ['$invites <@member>'],
  module: 'inviteRewards',
  permissions: STAFF,
  staffRoleIds: [],
  ownerOnly: false,
  relatedCommands: ['security'],
  visibility: 'STAFF',
  handler: unavailable('invite tracking'),
});

define({
  name: 'ticket',
  aliases: [],
  description: 'Open a support ticket.',
  category: 'Tickets',
  usage: '[subject]',
  examples: ['$ticket my account is locked'],
  module: 'tickets',
  permissions: EVERYONE,
  staffRoleIds: [],
  ownerOnly: false,
  relatedCommands: ['close'],
  visibility: 'PUBLIC',
  handler: unavailable('tickets'),
});

define({
  name: 'close',
  aliases: ['ticketclose'],
  description: 'Close one of your open support tickets.',
  category: 'Tickets',
  usage: '[reason]',
  examples: ['$close resolved my issue'],
  module: 'tickets',
  permissions: EVERYONE,
  staffRoleIds: [],
  ownerOnly: false,
  relatedCommands: ['ticket'],
  visibility: 'PUBLIC',
  handler: unavailable('ticket close'),
});

define({
  name: 'giveaway',
  aliases: ['give'],
  description: 'Run a giveaway.',
  category: 'Engagement',
  usage: 'start|end|reroll',
  examples: ['$giveaway start 3:00:00 2 winners'],
  module: 'giveaways',
  permissions: STAFF,
  staffRoleIds: [],
  ownerOnly: false,
  relatedCommands: [],
  visibility: 'STAFF',
  handler: unavailable('giveaways'),
});

define({
  name: 'report',
  aliases: [],
  description: 'Report a member or message to the staff team.',
  category: 'Moderation',
  usage: '<member> [reason]',
  examples: ['$report <@member> being abusive'],
  module: 'reports',
  permissions: EVERYONE,
  staffRoleIds: [],
  ownerOnly: false,
  relatedCommands: ['appeal'],
  visibility: 'PUBLIC',
  handler: unavailable('reports'),
});

define({
  name: 'appeal',
  aliases: [],
  description: 'Appeal a moderation action.',
  category: 'Moderation',
  usage: '<statement>',
  examples: ['$appeal I was misunderstood'],
  module: 'appeals',
  permissions: EVERYONE,
  staffRoleIds: [],
  ownerOnly: false,
  relatedCommands: ['report', 'modcases'],
  visibility: 'PUBLIC',
  handler: unavailable('appeals'),
});

define({
  name: 'security',
  aliases: [],
  description: 'Configure anti-raid, raid mode, and lockdown.',
  category: 'Security',
  usage: 'raid|l lockdown on|off',
  examples: ['$security raid on', '$security lockdown on'],
  module: 'security',
  permissions: [PermissionFlagsBits.Administrator],
  staffRoleIds: [],
  ownerOnly: false,
  relatedCommands: ['automod', 'invites'],
  visibility: 'ADMIN',
  handler: unavailable('security'),
});

define({
  name: 'automod',
  aliases: ['am'],
  description: 'Configure AutoMod rules and their escalation ladder.',
  category: 'Security',
  usage: 'list|add <rule> <action>',
  examples: ['$automod list'],
  module: 'automod',
  permissions: [PermissionFlagsBits.ManageGuild],
  staffRoleIds: [],
  ownerOnly: false,
  relatedCommands: ['security', 'config'],
  visibility: 'ADMIN',
  handler: unavailable('automod'),
});

define({
  name: 'stats',
  aliases: ['analytics', 'dashboard'],
  description: 'Server activity and moderation statistics.',
  category: 'Utility',
  usage: '[days]',
  examples: ['$stats 7'],
  module: 'logging',
  permissions: STAFF,
  staffRoleIds: [],
  ownerOnly: false,
  relatedCommands: ['leaderboard'],
  visibility: 'STAFF',
  handler: unavailable('analytics'),
});

/** Verifies manifest integrity at boot. Throws rather than serving a gap. */
export function assertManifestIntegrity(): void {
  registry.assertIntegrity();
}

/** Number of registered commands. */
export function commandCount(): number {
  return registry.size;
}
