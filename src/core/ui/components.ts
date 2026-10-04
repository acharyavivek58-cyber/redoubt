/**
 * Action components (v13 §9.1).
 *
 * v13 §5A ACTION HIERARCHY: one obvious primary action, secondary actions
 * behind an overflow menu or a secondary row, destructive actions visually
 * distinguished and confirmed. Never a flat row of nine buttons.
 *
 * These builders enforce that structurally: `actionRow` refuses more than
 * MAX_PRIMARY_ACTIONS primary buttons, so a feature cannot accidentally ship
 * button clutter.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} from 'discord.js';

export const MAX_PRIMARY_ACTIONS = 2;

export type ButtonTone = 'primary' | 'secondary' | 'success' | 'danger' | 'link';

export interface ButtonSpec {
  /** Stable custom id, e.g. 'ticket:claim'. */
  readonly id: string;
  readonly label: string;
  readonly tone?: ButtonTone;
  readonly emoji?: string;
  readonly url?: string;
  readonly disabled?: boolean;
}

const TONE_MAP: Record<Exclude<ButtonTone, 'link'>, Exclude<ButtonStyle, ButtonStyle.Link>> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};

export function button(spec: ButtonSpec): ButtonBuilder {
  const style = spec.tone === 'link' ? ButtonStyle.Link : (TONE_MAP[spec.tone ?? 'secondary']);
  const builder = new ButtonBuilder().setCustomId(spec.id).setLabel(spec.label).setStyle(style);
  if (spec.emoji) builder.setEmoji(spec.emoji);
  if (spec.url) builder.setURL(spec.url);
  if (spec.disabled) builder.setDisabled(true);
  return builder;
}

export type ActionRowResult = {
  readonly rows: ActionRowBuilder<ButtonBuilder>[];
  /** True when an action was dropped for breaching the hierarchy rule. */
  readonly overflowed: boolean;
};

/**
 * Builds action rows honouring the hierarchy rule.
 *
 * Primary + secondary share row 1 (capped at MAX_PRIMARY_ACTIONS); any
 * remainder moves to an overflow row. `secondary` buttons may exceed the cap
 * because they are de-emphasised, but they still get their own row so the
 * primary action stays visually dominant.
 */
export function actionRow(specs: readonly ButtonSpec[]): ActionRowResult {
  if (specs.length === 0) return { rows: [], overflowed: false };

  const primary = specs.filter((s) => s.tone === 'primary' || s.tone === 'success');
  const secondary = specs.filter((s) => s.tone !== 'primary' && s.tone !== 'success');

  const acceptedPrimary = primary.slice(0, MAX_PRIMARY_ACTIONS);
  const demoted = primary.slice(MAX_PRIMARY_ACTIONS);

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  const overflowed = demoted.length > 0;

  if (acceptedPrimary.length > 0) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        acceptedPrimary.map((spec) => button(spec)),
      ),
    );
  }

  const restSecondary = [...demoted, ...secondary];
  for (let i = 0; i < restSecondary.length; i += 5) {
    const chunk = restSecondary.slice(i, i + 5);
    if (chunk.length === 0) continue;
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(chunk.map((spec) => button(spec))),
    );
  }

  return { rows, overflowed };
}

export interface SelectSpec {
  readonly id: string;
  readonly placeholder: string;
  readonly options: readonly { label: string; value: string; description?: string }[];
  readonly disabled?: boolean;
}

/**
 * Select menu row. v13 §5A routes secondary navigation here rather than into
 * extra buttons.
 */
export function selectRow(spec: SelectSpec): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(spec.id)
    .setPlaceholder(spec.placeholder)
    .addOptions(
      spec.options.map((option) => ({
        label: option.label.slice(0, 100),
        value: option.value.slice(0, 100),
        ...(option.description ? { description: option.description.slice(0, 100) } : {}),
      })),
    );
  if (spec.disabled) menu.setDisabled(true);
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

/**
 * v13 §5A NAVIGATION: a compact [Previous] [Home] [Next] row.
 * `hasNext`/`hasPrevious` drive disabled state so the row never shows dead
 * controls (v13 §5A "never leave disabled or irrelevant controls visible" —
 * pagination keeps them disabled rather than absent because position matters).
 */
export function navigationRow(options: {
  homeId: string;
  previousId?: string;
  nextId?: string;
  hasPrevious: boolean;
  hasNext: boolean;
}): ActionRowBuilder<ButtonBuilder> {
  const components: ButtonBuilder[] = [];

  if (options.previousId) {
    components.push(
      button({
        id: options.previousId,
        label: 'Previous',
        tone: 'secondary',
        disabled: !options.hasPrevious,
      }),
    );
  }

  components.push(button({ id: options.homeId, label: 'Home', tone: 'primary' }));

  if (options.nextId) {
    components.push(
      button({ id: options.nextId, label: 'Next', tone: 'secondary', disabled: !options.hasNext }),
    );
  }

  return new ActionRowBuilder<ButtonBuilder>().addComponents(components);
}