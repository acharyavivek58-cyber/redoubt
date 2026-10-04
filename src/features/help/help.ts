/**
 * Help (v13 §N.4).
 *
 * Renders from `registry.all()` — the SAME list the transports dispatch from.
 * There is deliberately no second command list: a command cannot exist without
 * appearing here, and nothing can appear here without existing.
 *
 * Visibility is FILTERED, not hidden-then-shown. A staff-only command is
 * omitted entirely for a non-staff viewer rather than displayed and then
 * refused, so Help never advertises something the viewer cannot use.
 */

import type { EmbedBuilder, PermissionsBitField } from 'discord.js';
import { infoEmbed, neutralEmbed } from '../../core/ui/embeds/embed-factory.js';
import { canView } from '../../core/permissions/permissions.js';
import { registry, type CommandDefinition } from '../../core/registry/command-registry.js';
import type { VisibilityLevel } from '../../shared/types/discord.js';

/** Commands shown per Help page. Discord's 1024-char description is the cap. */
const PAGE_SIZE = 8;

export interface HelpViewer {
  readonly userId: string;
  readonly isOwner: boolean;
  /** Discord's resolved bitfield for the viewer. */
  readonly permissions: PermissionsBitField;
  readonly staffRoleIds: readonly string[];
}

export interface HelpOptions {
  readonly viewer: HelpViewer;
  readonly guildName?: string;
  readonly theme?: Parameters<typeof infoEmbed>[0]['theme'];
}

/**
 * Commands this viewer may actually use.
 *
 * `canView` is the shared visibility gate — Help does not reimplement it, so a
 * change to visibility rules applies here automatically.
 */
export function visibleCommands(viewer: HelpViewer): CommandDefinition[] {
  return registry.all().filter((command) => canView(command.visibility, viewer));
}

function groupByCategory(commands: readonly CommandDefinition[]): Map<string, CommandDefinition[]> {
  const groups = new Map<string, CommandDefinition[]>();
  for (const command of commands) {
    const bucket = groups.get(command.category) ?? [];
    bucket.push(command);
    groups.set(command.category, bucket);
  }
  return groups;
}

/** Page of the category index. */
export function helpIndex(options: HelpOptions): EmbedBuilder {
  const commands = visibleCommands(options.viewer);
  const groups = groupByCategory(commands);

  const lines: string[] = [];
  for (const category of registry.categories()) {
    const bucket = groups.get(category);
    // An empty category is omitted rather than rendered as a hollow heading.
    if (!bucket || bucket.length === 0) continue;
    const names = bucket.map((c) => `\`${c.name}\``).join('  ');
    lines.push(`**${category}**\n${names}`);
  }

  if (lines.length === 0) {
    return neutralEmbed({
      theme: options.theme,
      title: 'Commands',
      description: 'No commands are available to you in this server yet.',
    });
  }

  return infoEmbed({
    theme: options.theme,
    guildName: options.guildName,
    title: 'Redoubt — Commands',
    description: [
      'Use `$help <command>` for details on any one of these.',
      '',
      ...lines,
    ].join('\n'),
    footer: `${commands.length} available to you`,
  });
}

/** Detail page for a single command. */
export function helpCommand(name: string, options: HelpOptions): EmbedBuilder {
  const command = registry.resolve(name);

  if (!command) {
    return neutralEmbed({
      theme: options.theme,
      guildName: options.guildName,
      title: 'Unknown command',
      description: `There is no command called \`${name}\`. Use \`$help\` to see what is available.`,
    });
  }

  // Same gate as the executor: Help must not reveal a command the viewer
  // cannot actually run.
  if (!canView(command.visibility, options.viewer)) {
    return neutralEmbed({
      theme: options.theme,
      guildName: options.guildName,
      title: 'Unknown command',
      description: `There is no command called \`${name}\`. Use \`$help\` to see what is available.`,
    });
  }

  const fields: { name: string; value: string; inline?: boolean }[] = [
    { name: 'Usage', value: `\`$${command.name} ${command.usage}\``, inline: false },
  ];

  if (command.aliases.length > 0) {
    fields.push({
      name: 'Aliases',
      value: command.aliases.map((a) => `\`${a}\``).join(', '),
      inline: true,
    });
  }

  fields.push({
    name: 'Access',
    value: describeVisibility(command.visibility),
    inline: true,
  });

  if (command.relatedCommands.length > 0) {
    fields.push({
      name: 'Related',
      value: command.relatedCommands.map((r) => `\`$help ${r}\``).join('  '),
      inline: false,
    });
  }

  if (command.examples.length > 0) {
    fields.push({
      name: 'Examples',
      value: command.examples.map((e) => `\`${e}\``).join('\n'),
      inline: false,
    });
  }

  return infoEmbed({
    theme: options.theme,
    guildName: options.guildName,
    title: `$${command.name}`,
    description: command.description,
    fields,
  });
}

function describeVisibility(level: VisibilityLevel): string {
  switch (level) {
    case 'OWNER_ONLY':
      return 'Server owner only';
    case 'ADMIN':
      return 'Administrators';
    case 'STAFF':
      return 'Staff';
    case 'CONFIGURED_PERMISSION':
      return 'Configured staff roles';
    default:
      return 'Everyone';
  }
}

/** Splits a category's commands into pages that fit a Discord embed. */
export function paginate(
  commands: readonly CommandDefinition[],
  pageSize = PAGE_SIZE,
): CommandDefinition[][] {
  const pages: CommandDefinition[][] = [];
  for (let i = 0; i < commands.length; i += pageSize) {
    pages.push(commands.slice(i, i + pageSize));
  }
  return pages;
}
