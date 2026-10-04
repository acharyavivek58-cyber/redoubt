/**
 * Server Pulse — rendering.
 *
 * Uses `core/ui` exclusively. No feature constructs an EmbedBuilder directly;
 * this module composes the existing factories and components so the result
 * reads as the same bot as every other surface.
 */

import type { ActionRowBuilder, ButtonBuilder, EmbedBuilder } from 'discord.js';
import { actionRow, navigationRow } from '../../core/ui/components.js';
import {
  infoEmbed,
  neutralEmbed,
  warningEmbed,
  successEmbed,
} from '../../core/ui/embeds/embed-factory.js';
import type { Theme } from '../../core/ui/themes/theme.js';
import {
  healthLabel,
  trendGlyph,
  type PulseHealth,
  type PulseSnapshot,
  type PulseTrend,
} from './domain.js';

const HEALTH_TONE: Record<PulseHealth, 'success' | 'warning' | 'danger'> = {
  HEALTHY: 'success',
  WATCH: 'warning',
  ALERT: 'danger',
};

function signed(percent: number): string {
  if (percent === 0) return 'no change';
  const rounded = Math.abs(percent).toFixed(0);
  return percent > 0 ? `+${rounded}%` : `-${rounded}%`;
}

function trendLine(trend: PulseTrend, changePercent: number, label: string): string {
  return `${trendGlyph(trend)} **${label}** ${trend === 'FLAT' ? '' : signed(changePercent)}`.trim();
}

/** The headline dashboard. */
export function pulseEmbed(
  snapshot: PulseSnapshot,
  options: { readonly theme?: Theme; readonly guildName?: string; readonly windowDays: number },
): EmbedBuilder {
  const tone = HEALTH_TONE[snapshot.health];

  const description =
    snapshot.insights.length > 0
      ? snapshot.insights.map((i) => `**${i.headline}** — ${i.detail}`).join('\n\n')
      : 'No notable changes this week.';

  // Health drives the semantic colour, so a glance at the embed border is
  // enough. ALERT deliberately reuses the neutral info tone rather than a
  // full danger red: this is an observation, not an error.
  const factory = tone === 'success' ? successEmbed : tone === 'warning' ? warningEmbed : infoEmbed;

  return factory({
    theme: options.theme,
    guildName: options.guildName,
    title: `Server Pulse — ${healthLabel(snapshot.health)}`,
    description,
    fields: [
      { name: 'Activity', value: activityField(snapshot), inline: true },
      { name: 'Moderation', value: moderationField(snapshot), inline: true },
      { name: 'Progression', value: progressionField(snapshot), inline: true },
      { name: 'Economy', value: economyField(snapshot), inline: true },
    ],
    footer: `Last ${options.windowDays} days`,
  });
}

function activityField(snapshot: PulseSnapshot): string {
  const lines = [
    trendLine(snapshot.messageTrend, snapshot.messageChangePercent, 'Messages'),
    `${snapshot.totalMessages.toLocaleString()} this week`,
    `${snapshot.dailyAverage.toLocaleString()}/day`,
  ];
  if (snapshot.activeMembers > 0) {
    lines.push(`${snapshot.activeMembers} active members`);
    lines.push(`${snapshot.messagesPerActiveMember} msgs/member`);
  }
  return lines.join('\n');
}

function moderationField(snapshot: PulseSnapshot): string {
  return [
    trendLine(snapshot.moderationTrend, 0, 'Cases'),
    `${snapshot.moderationCases} recorded`,
    `${snapshot.casesPerThousandMessages} per 1k messages`,
  ].join('\n');
}

function progressionField(snapshot: PulseSnapshot): string {
  return [`${snapshot.levelUps} level-ups`, `Average level ${snapshot.averageLevel}`].join('\n');
}

function economyField(snapshot: PulseSnapshot): string {
  return [
    `${snapshot.circulating.toLocaleString()} circulating`,
    `${snapshot.velocity >= 0 ? '+' : ''}${snapshot.velocity}/member net`,
  ].join('\n');
}

/**
 * The action row.
 *
 * Two primary actions maximum (v13 §5A). Everything beyond that goes to the
 * overflow row, and nothing is present that does not do something.
 */
export function pulseActions(options: {
  readonly windowDays: number;
  readonly page: number;
  readonly hasNextPage: boolean;
}): { components: ActionRowBuilder<ButtonBuilder>[] } {
  return {
    components: [
      ...actionRow([
        { id: 'pulse:activity', label: 'Activity breakdown', tone: 'primary' },
        {
          id: `pulse:window:${options.windowDays === 7 ? 14 : 7}`,
          label: options.windowDays === 7 ? 'Last 14 days' : 'Last 7 days',
          tone: 'secondary',
        },
      ]).rows,
      navigationRow({
        homeId: 'pulse:home',
        previousId: 'pulse:prev',
        nextId: 'pulse:next',
        hasPrevious: options.page > 0,
        hasNext: options.hasNextPage,
      }),
    ],
  };
}

/** Empty state — a server with no recorded activity yet. */
export function pulseEmpty(
  options: { readonly theme?: Theme; readonly guildName?: string },
): EmbedBuilder {
  return neutralEmbed({
    theme: options.theme,
    guildName: options.guildName,
    title: 'Server Pulse',
    description:
      'No activity has been recorded for this server yet.\n\nPulse builds from message analytics, moderation cases, level profiles, and economy wallets — give the bot a little time to gather them.',
  });
}

/** Error state — never a raw provider or SQL message. */
export function pulseUnavailable(options: {
  readonly theme?: Theme;
  readonly guildName?: string;
  readonly referenceId?: string;
}): EmbedBuilder {
  return neutralEmbed({
    theme: options.theme,
    guildName: options.guildName,
    title: 'Server Pulse',
    description:
      'Pulse could not read this server’s data just now. Nothing was changed — try again in a moment.',
    referenceId: options.referenceId,
  });
}
