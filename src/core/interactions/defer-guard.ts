/**
 * Interaction lifecycle guard (v13 §6).
 *
 * THE rule: every deferred interaction is GUARANTEED to complete.
 *
 * A forgotten deferred response is the most common bot failure — Discord shows
 * "This interaction failed" after 3s and the user's action appears lost. This
 * wrapper owns the lifecycle so that cannot happen, on EITHER path:
 *
 *   - deferred -> success -> editReply
 *   - deferred -> failure -> editReply with a polished error panel
 *   - deferred -> crash   -> editReply with a safe reference ID
 *
 * It also guarantees a loading state always transitions to a final state
 * (v13 §5A: no deferred interaction is ever left visually empty).
 */

import {
  MessageFlags,
  type ChatInputCommandInteraction,
  type InteractionEditReplyOptions,
  type RepliableInteraction,
} from 'discord.js';
import { errorPanel, loadingState } from '../ui/panels.js';
import { toRedoubtError, type ErrorContext } from '../errors.js';
import { getLogger } from '../logging/logger.js';

/**
 * Payload for an EDIT of an existing reply.
 *
 * Deliberately InteractionEditReplyOptions rather than InteractionReplyOptions:
 * editReply cannot change visibility (no Ephemeral flag), which is exactly why
 * deferGuard owns visibility at defer time instead.
 */
export type EditPayload = InteractionEditReplyOptions;

export type Progress = (options: EditPayload) => Promise<unknown>;

export interface DeferGuardOptions extends ErrorContext {
  /** Shown while work runs; keeps the panel non-empty (v13 §5A). */
  readonly loadingMessage?: string;
  /** Hide loading text if the operation resolves very fast. */
  readonly fastFinishMs?: number;
}

const DEFAULT_FAST_FINISH = 250;

/**
 * Runs `work` with a guaranteed-completion interaction lifecycle.
 *
 * `work` receives a `progress` callback for intermediate updates; the final
 * response is always delivered exactly once.
 */
export async function deferGuard<T>(
  interaction: RepliableInteraction,
  work: (progress: Progress) => Promise<T | EditPayload>,
  options: DeferGuardOptions = {},
): Promise<T | undefined> {
  const log = getLogger().child({
    guildId: interaction.guildId ?? undefined,
    userId: interaction.user.id,
    interactionId: interaction.id,
  });

  try {
    if (interaction.isRepliable() && !interaction.deferred) {
      await interaction.deferReply();
    }
  } catch (error) {
    // Deferred already, or the interaction expired. Nothing to complete.
    log.debug({ err: error }, 'defer failed; interaction likely expired');
    return undefined;
  }

  // Loading state keeps the panel alive while work runs (v13 §5A).
  const showLoading = async (): Promise<void> => {
    if (!interaction.isRepliable()) return;
    try {
      await interaction.editReply({
        embeds: [
          loadingState({
            operation: options.loadingMessage ?? 'Working…',
          }),
        ],
      });
    } catch {
      /* interaction may have expired; the final attempt still runs */
    }
  };

  // Only paint the loading state when work is slow enough to need it —
  // v20 Priority B forbids fake loading theatrics for instant operations.
  const fastFinish = options.fastFinishMs ?? DEFAULT_FAST_FINISH;
  const loadingTimer: NodeJS.Timeout = setTimeout(() => void showLoading(), fastFinish);

  const progress: Progress = async (opts) => {
    if (loadingTimer) clearTimeout(loadingTimer);
    return interaction.isRepliable() ? interaction.editReply(opts) : undefined;
  };

  try {
    const result = await work(progress);

    if (loadingTimer) clearTimeout(loadingTimer);

    if (result && typeof result === 'object' && 'embeds' in result) {
      await interaction.editReply(result);
    } else if (result === undefined) {
      // work() already replied via progress or another path.
    }

    return result as T | undefined;
  } catch (error) {
    if (loadingTimer) clearTimeout(loadingTimer);

    // Never expose a raw exception: the user gets a polished panel with a
    // safe reference, and the full detail goes to the log.
    const safe = toRedoubtError(error, {
      guildId: interaction.guildId ?? undefined,
      userId: interaction.user.id,
      interactionId: interaction.id,
      ...options,
    });

    log.error(
      { err: error, referenceId: safe.referenceId, code: safe.code },
      'interaction handler failed',
    );

    try {
      await interaction.editReply({
        embeds: [
          errorPanel({
            headline: 'Something went wrong',
            cause: safe.userMessage,
            referenceId: safe.referenceId,
          }),
        ],
      });
    } catch {
      // Last resort: if even the error panel fails the interaction expired.
      try {
        await interaction.followUp({
          content: safe.userMessage,
          flags: MessageFlags.Ephemeral,
        });
      } catch {
        /* genuinely nothing more we can do */
      }
    }
    return undefined;
  }
}

/** Narrowed helper for the common chat-input command case. */
export async function deferGuardCommand<T>(
  interaction: ChatInputCommandInteraction,
  work: (progress: Progress) => Promise<T | EditPayload>,
  options: DeferGuardOptions = {},
): Promise<T | undefined> {
  return deferGuard(interaction, work, options);
}