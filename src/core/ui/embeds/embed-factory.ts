/**
 * Embed factories (v13 §9.1) — the ONLY construction path for embeds.
 *
 * v13 §5A / v16 §K: every feature renders through here. No feature may invent
 * its own embed style. The factory enforces the visual contract structurally:
 *
 *  - a semantic color derived from the theme, never an ad hoc hex
 *  - a consistent field layout (title → description → fields → footer)
 *  - spacing rules so no embed looks like a text wall
 *  - a footer carrying identity, not decoration
 */

import { EmbedBuilder, type APIEmbedField } from 'discord.js';
import { DEFAULT_THEME, type SemanticColorName, type Theme } from '../themes/theme.js';

export interface EmbedContext {
  readonly theme?: Theme;
  readonly guildName?: string;
  /** Display name of the acting user, used in some footers. */
  readonly actorName?: string;
  /** Reference id shown on error surfaces. */
  readonly referenceId?: string;
}

export type FieldValue = string | { name: string; value: string; inline?: boolean };

function resolve(context: EmbedContext): { theme: Theme; footer: string[] } {
  const theme = context.theme ?? DEFAULT_THEME;
  const footer = ['Redoubt'];
  if (context.guildName) footer.push(context.guildName);
  return { theme, footer };
}

/** Converts loose input into the API field shape. */
function toFields(fields: readonly FieldValue[] | undefined): APIEmbedField[] {
  if (!fields?.length) return [];
  return fields.map((field) =>
    typeof field === 'string'
      ? { name: '', value: field, inline: false }
      : { name: field.name, value: field.value, inline: field.inline ?? true },
  );
}

export interface BaseEmbedOptions extends EmbedContext {
  title?: string;
  description?: string;
  fields?: readonly FieldValue[];
  footer?: string;
  thumbnail?: string;
  image?: string;
  url?: string;
}

/** Low-level builder. Prefer the semantic factories below. */
export function createEmbed(
  color: number,
  options: BaseEmbedOptions,
): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(color);

  if (options.title) embed.setTitle(options.title);
  if (options.description) embed.setDescription(options.description);
  if (options.url) embed.setURL(options.url);
  if (options.thumbnail) embed.setThumbnail(options.thumbnail);
  if (options.image) embed.setImage(options.image);

  const fields = toFields(options.fields);
  if (fields.length) embed.addFields(fields);

  const { footer } = resolve(options);
  if (options.footer) footer.unshift(options.footer);
  if (options.referenceId) footer.push(`Ref ${options.referenceId}`);
  embed.setFooter({ text: footer.join('  ·  '), iconURL: undefined });

  return embed;
}

export interface StatusEmbedOptions extends BaseEmbedOptions {
  /** Overrides the semantic color selection. */
  tone?: SemanticColorName;
}

/** Builds a status embed using the theme's semantic color for `tone`. */
export function statusEmbed(
  tone: SemanticColorName,
  options: StatusEmbedOptions,
): EmbedBuilder {
  const theme = options.theme ?? DEFAULT_THEME;
  return createEmbed(theme.status[tone], options);
}

export const successEmbed = (o: StatusEmbedOptions) => statusEmbed('success', o);
export const errorEmbed = (o: StatusEmbedOptions) => statusEmbed('danger', o);
export const warningEmbed = (o: StatusEmbedOptions) => statusEmbed('warning', o);
export const infoEmbed = (o: StatusEmbedOptions) => statusEmbed('info', o);
export const neutralEmbed = (o: StatusEmbedOptions) => statusEmbed('neutral', o);

// --- Typed product surfaces (v13 §9.1 requires each as a distinct factory) ---

/** Moderation case surface. Uses centralized mute/jail vocabulary (v3 §1). */
export function caseEmbed(options: StatusEmbedOptions & {
  caseNumber: number;
  actionLabel: string;
  actorName: string;
  targetName: string;
  reason?: string;
  durationLabel?: string;
  statusLabel: string;
}): EmbedBuilder {
  return statusEmbed(options.tone ?? 'info', {
    ...options,
    title: `Case #${options.caseNumber} — ${options.actionLabel}`,
    fields: [
      { name: 'Member', value: options.targetName, inline: true },
      { name: 'Moderator', value: options.actorName, inline: true },
      { name: 'Status', value: options.statusLabel, inline: true },
      ...(options.durationLabel
        ? [{ name: 'Duration', value: options.durationLabel, inline: true }]
        : []),
      ...(options.reason ? [{ name: 'Reason', value: options.reason, inline: false }] : []),
    ],
  });
}

/** Ticket surface. `stateLabel` carries the §5A state machine. */
export function ticketEmbed(options: StatusEmbedOptions & {
  ticketId: string;
  ticketType: string;
  requesterName: string;
  stateLabel: string;
  assignedTo?: string;
  panel?: { name: string; value: string }[];
}): EmbedBuilder {
  return statusEmbed(options.tone ?? 'info', {
    ...options,
    title: `Ticket ${options.ticketId}`,
    fields: [
      { name: 'Type', value: options.ticketType, inline: true },
      { name: 'State', value: options.stateLabel, inline: true },
      { name: 'Opened by', value: options.requesterName, inline: true },
      ...(options.assignedTo
        ? [{ name: 'Assigned to', value: options.assignedTo, inline: true }]
        : []),
      ...(options.panel ?? []),
    ],
  });
}

/** Level/rank surface, shared by leveling and leaderboard rows. */
export function levelEmbed(options: StatusEmbedOptions & {
  userName: string;
  level: number;
  seasonXpLabel: string;
  progressLabel: string;
  rankLabel?: string;
  lifetimeXpLabel?: string;
}): EmbedBuilder {
  return statusEmbed(options.tone ?? 'info', {
    ...options,
    title: options.title ?? `${options.userName} — Level ${options.level}`,
    fields: [
      { name: 'Level', value: String(options.level), inline: true },
      { name: 'Season XP', value: options.seasonXpLabel, inline: true },
      { name: 'Rank', value: options.rankLabel ?? '—', inline: true },
      { name: 'Progress to next level', value: options.progressLabel, inline: false },
      ...(options.lifetimeXpLabel
        ? [{ name: 'Lifetime XP', value: options.lifetimeXpLabel, inline: true }]
        : []),
    ],
  });
}

/** Economy balance surface. */
export function economyEmbed(options: StatusEmbedOptions & {
  userName: string;
  currencyName: string;
  balanceLabel: string;
  extras?: readonly FieldValue[];
}): EmbedBuilder {
  return statusEmbed(options.tone ?? 'info', {
    ...options,
    title: options.title ?? 'Redoubt Economy',
    fields: [
      { name: options.currencyName, value: options.balanceLabel, inline: true },
      ...(options.extras ?? []),
    ],
  });
}