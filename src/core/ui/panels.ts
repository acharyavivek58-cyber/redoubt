/**
 * Empty, loading, and error state panels (v13 §5A / v20 Priority B).
 *
 * v13 §5A requires these to be INTENTIONALLY DESIGNED, not terse strings:
 *   "NO OPEN TICKETS" + a plain-language explanation + a next action.
 *
 * Error panels never expose raw exceptions, SQL, or provider internals — only
 * a title, plain-language cause, optional remedy, and a reference ID.
 */

import type { EmbedBuilder } from 'discord.js';
import { infoEmbed, errorEmbed, type StatusEmbedOptions } from './embeds/embed-factory.js';

export interface EmptyStateOptions extends StatusEmbedOptions {
  /** e.g. 'NO OPEN TICKETS' */
  headline: string;
  /** Plain-language explanation of why it is empty. */
  explanation: string;
  /** Optional next action, e.g. 'Create a ticket type'. */
  nextAction?: string;
}

export function emptyState(options: EmptyStateOptions): EmbedBuilder {
  return infoEmbed({
    ...options,
    title: options.title ?? options.headline,
    description: [
      options.explanation,
      ...(options.nextAction ? ['', `**Next:** ${options.nextAction}`] : []),
    ].join('\n'),
  });
}

export interface LoadingStateOptions extends StatusEmbedOptions {
  /** e.g. 'Generating transcript…' */
  operation: string;
  note?: string;
}

/**
 * Loading panel. v20 Priority B forbids fake progress theatrics, so this is a
 * calm single line — a real status, not an animated placeholder.
 */
export function loadingState(options: LoadingStateOptions): EmbedBuilder {
  return infoEmbed({
    ...options,
    title: options.title ?? 'Working',
    description: options.note ? `${options.operation}\n\n${options.note}` : options.operation,
  });
}

export interface ErrorPanelOptions extends StatusEmbedOptions {
  headline: string;
  cause: string;
  remedy?: string;
  referenceId?: string;
}

/**
 * Error panel. `cause` must already be user-safe — callers pass a
 * RedoubtError.userMessage, never an underlying provider or database string.
 */
export function errorPanel(options: ErrorPanelOptions): EmbedBuilder {
  const parts = [options.cause];
  if (options.remedy) parts.push('', `**Try:** ${options.remedy}`);
  if (options.referenceId) parts.push('', `Reference: ${options.referenceId}`);

  return errorEmbed({
    theme: options.theme,
    guildName: options.guildName,
    title: options.title ?? options.headline,
    description: parts.join('\n'),
    fields: options.fields,
    referenceId: options.referenceId,
  });
}

/**
 * v14 §5: the non-owner surface for backup/template controls.
 *
 * Shows no actionable destructive control — the button rows are omitted by the
 * caller. v13 §5A: UI visibility is never the security boundary; the
 * server-side owner check is what actually authorizes the operation.
 */
export function ownerAccessRequiredPanel(
  options: StatusEmbedOptions & { headline?: string } = {},
): EmbedBuilder {
  return errorEmbed({
    theme: options.theme,
    guildName: options.guildName,
    title: options.headline ?? 'Owner Access Required',
    description:
      'Only the current server owner can perform backup and template operations.',
  });
}

/** v14 §4: ownership changed mid-operation. */
export function ownerAuthorizationLostPanel(
  options: StatusEmbedOptions & { referenceId: string } = { referenceId: '' },
): EmbedBuilder {
  return errorEmbed({
    theme: options.theme,
    guildName: options.guildName,
    title: 'Owner Authorization Lost',
    description: [
      'The server owner changed during this operation.',
      'No further changes will be performed.',
      '',
      `Reference: ${options.referenceId}`,
    ].join('\n'),
  });
}