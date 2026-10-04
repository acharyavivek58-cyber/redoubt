/**
 * AI gateway (v13 §2).
 *
 * STRICTLY OPTIONAL AND STRICTLY $0 (v13 §2). This module has these rules:
 *
 *  - The bot runs perfectly with NO key. Every entry point checks availability
 *    first and returns a clean "unavailable" result rather than throwing.
 *  - Gemini FREE TIER ONLY. There is no paid fallback and no code path that
 *    would upgrade to one.
 *  - QUOTAS ARE NEVER HARD-CODED. No request-per-minute number is baked in.
 *    The guild configures a conservative daily ceiling, and the circuit
 *    breaker reacts to observed failures rather than to an assumed quota.
 *  - A CIRCUIT BREAKER protects the rest of the bot. When the provider starts
 *    failing, the breaker opens and calls become local no-ops until it is
 *    ready to probe again, so a provider outage can never become a bot outage.
 *
 * The breaker is the interesting part: it must OPEN on failure, HOLD while
 * open (not hammer a struggling provider), and HALF_OPEN into a limited probe.
 */

import { QuotaExhaustedError } from '../../core/errors.js';
import { getLogger } from '../../core/logging/logger.js';

/**
 * Logger is resolved LAZILY.
 *
 * A module-level `getLogger()` parses the process environment at IMPORT time,
 * which couples every importer to boot order and makes the module untestable
 * without a full environment. Resolving on first use keeps that freedom.
 */
let cachedLogger: ReturnType<ReturnType<typeof getLogger>['child']> | undefined;
function log(): ReturnType<ReturnType<typeof getLogger>['child']> {
  cachedLogger ??= getLogger().child({ module: 'ai', operation: 'gateway' });
  return cachedLogger;
}

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface AiVerdict {
  /** True when the feature should ALLOW the action. */
  readonly allow: boolean;
  readonly confidence: number;
  readonly reason: string;
  /** True when no model call happened (no key, breaker open, daily cap). */
  readonly skipped: boolean;
}

export type AiSkipReason =
  | 'NO_API_KEY'
  | 'DISABLED_FOR_GUILD'
  | 'CIRCUIT_OPEN'
  | 'DAILY_LIMIT_REACHED'
  | 'NOT_DETERMINATIVE';

export interface CircuitConfig {
  /** Consecutive failures before the breaker opens. */
  readonly failureThreshold: number;
  /** How long the breaker stays open before allowing a probe. */
  readonly cooldownMs: number;
  /** Successful probes needed to close the breaker again. */
  readonly successThreshold: number;
  /** Attempts a single call makes before it is treated as failed. */
  readonly callTimeoutMs: number;
}

export const DEFAULT_CIRCUIT: CircuitConfig = {
  failureThreshold: 5,
  cooldownMs: 60_000,
  successThreshold: 2,
  callTimeoutMs: 8_000,
};

interface BreakerState {
  state: CircuitState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  openedAt: number;
}

export class CircuitBreaker {
  private state: BreakerState = {
    state: 'CLOSED',
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    openedAt: 0,
  };

  constructor(private readonly config: CircuitConfig = DEFAULT_CIRCUIT) {}

  get current(): CircuitState {
    return this.state.state;
  }

  /**
   * Whether a call may proceed right now.
   *
   * An OPEN breaker whose cooldown has elapsed transitions to HALF_OPEN,
   * admitting exactly one probe. This is what stops the bot from either
   * hammering a struggling provider or refusing to recover.
   */
  canAttempt(now: number): boolean {
    // Transitions here too, so the observable state is never incoherent:
    // returning true while `current` still reports OPEN would let two callers
    // each believe they were the single probe.
    this.maybeHalfOpen(now);
    return this.state.state !== 'OPEN';
  }

  /** Records success and closes the breaker once enough probes pass. */
  recordSuccess(): void {
    this.state.consecutiveFailures = 0;
    this.state.consecutiveSuccesses += 1;
    if (this.state.state === 'HALF_OPEN' && this.state.consecutiveSuccesses >= this.config.successThreshold) {
      this.state.state = 'CLOSED';
      this.state.consecutiveSuccesses = 0;
      log().info('ai circuit closed');
    }
  }

  /** Records failure and opens the breaker once the threshold is reached. */
  recordFailure(): void {
    this.state.consecutiveSuccesses = 0;
    this.state.consecutiveFailures += 1;

    if (this.state.state === 'HALF_OPEN') {
      // A failed probe sends us straight back to OPEN.
      this.state.state = 'OPEN';
      this.state.openedAt = Date.now();
      log().warn('ai circuit reopened after failed probe');
      return;
    }

    if (this.state.consecutiveFailures >= this.config.failureThreshold) {
      this.state.state = 'OPEN';
      this.state.openedAt = Date.now();
      log().warn({ failures: this.state.consecutiveFailures }, 'ai circuit opened');
    }
  }

  /** Transitions to HALF_OPEN when the cooldown has elapsed. */
  private maybeHalfOpen(now: number): void {
    if (this.state.state === 'OPEN' && now - this.state.openedAt >= this.config.cooldownMs) {
      this.state.state = 'HALF_OPEN';
      this.state.consecutiveSuccesses = 0;
      log().info('ai circuit half-open; probing');
    }
  }

  /** Wraps a call so the breaker observes the real outcome. */
  async guard<T>(operation: () => Promise<T>, now = Date.now()): Promise<T> {
    if (!this.canAttempt(now)) {
      // The user-facing message is owned by QuotaExhaustedError, so the circuit
      // never invents its own copy that could drift from the rest of the bot.
      throw new QuotaExhaustedError({ module: 'ai', operation: 'circuit-open' });
    }

    try {
      const result = await operation();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }
}

/** A guild's daily usage counter. Never sourced from a hard-coded quota. */
export interface UsageCounter {
  used(input: { guildId: string; day: string }): Promise<number>;
  increment(input: { guildId: string; day: string; amount?: number }): Promise<void>;
}

export interface AiGatewayOptions {
  /** Absent when GEMINI_API_KEY is unset; the gateway then self-disables. */
  readonly generate?: (input: { prompt: string; maxOutputTokens: number }) => Promise<string>;
  readonly model: string;
  readonly maxOutputTokens: number;
  readonly breaker?: CircuitBreaker;
  readonly usage?: UsageCounter;
  /** Per-guild ceiling. Null means the guild set none. */
  readonly guildDailyLimit?: (guildId: string) => Promise<number | null>;
  readonly isGuildEnabled?: (guildId: string) => Promise<boolean>;
}

export type AiResult =
  | { readonly kind: 'VERDICT'; readonly verdict: AiVerdict }
  | { readonly kind: 'SKIPPED'; readonly reason: AiSkipReason; readonly message: string }
  | { readonly kind: 'ERROR'; readonly message: string };

const SKIP_MESSAGES: Readonly<Record<AiSkipReason, string>> = {
  NO_API_KEY: 'AI features are not configured on this server.',
  DISABLED_FOR_GUILD: 'AI is disabled in this server.',
  CIRCUIT_OPEN: 'AI is temporarily unavailable. Please try again shortly.',
  DAILY_LIMIT_REACHED: 'This server has reached its configured daily AI limit.',
  NOT_DETERMINATIVE: 'AI is available but was not needed for this request.',
};

export class AiGateway {
  private readonly breaker: CircuitBreaker;

  constructor(private readonly options: AiGatewayOptions) {
    this.breaker = options.breaker ?? new CircuitBreaker();
  }

  /** False when no key is configured. Callers must check before offering AI. */
  get available(): boolean {
    return typeof this.options.generate === 'function';
  }

  get circuitState(): CircuitState {
    return this.breaker.current;
  }

  /**
   * Asks the model a yes/no moderation question.
   *
   * EVERY failure mode degrades to "allow" with `skipped: true`, never to an
   * exception the caller must handle. A model that is down, unconfigured, or
   * rate-limited must not become a moderator outage — the surrounding
   * deterministic rules are the real enforcement anyway, and the model is
   * advisory.
   */
  async evaluate(input: {
    guildId: string;
    prompt: string;
    /** Deterministic rules already spoke; only ask when they need help. */
    readonly needed: boolean;
    now?: number;
  }): Promise<AiResult> {
    const now = input.now ?? Date.now();

    if (!this.available) return this.skip('NO_API_KEY');
    if (input.needed === false) return this.skip('NOT_DETERMINATIVE');

    if (this.options.isGuildEnabled) {
      const enabled = await this.options.isGuildEnabled(input.guildId);
      if (!enabled) return this.skip('DISABLED_FOR_GUILD');
    }

    if (this.options.usage && this.options.guildDailyLimit) {
      const limit = await this.options.guildDailyLimit(input.guildId);
      if (limit !== null && limit > 0) {
        const used = await this.options.usage.used({
          guildId: input.guildId,
          day: new Date(now).toISOString().slice(0, 10),
        });
        if (used >= limit) return this.skip('DAILY_LIMIT_REACHED');
      }
    }

    const generate = this.options.generate;
    if (!generate) return this.skip('NO_API_KEY');

    try {
      const raw = await this.breaker.guard(
        () => generate({ prompt: input.prompt, maxOutputTokens: this.options.maxOutputTokens }),
        now,
      );

      if (this.options.usage) {
        await this.options.usage.increment({
          guildId: input.guildId,
          day: new Date(now).toISOString().slice(0, 10),
        });
      }

      const verdict = parseVerdict(raw);
      return verdict ? { kind: 'VERDICT', verdict } : { kind: 'VERDICT', verdict: allow(raw) };
    } catch (error) {
      // Degrade to ALLOW. The deterministic rules remain in force.
      log().warn({ err: error, guildId: input.guildId }, 'ai evaluation failed; allowing');
      return {
        kind: 'VERDICT',
        verdict: {
          allow: true,
          confidence: 0,
          reason: 'AI could not be consulted; no action taken.',
          skipped: true,
        },
      };
    }
  }

  private skip(reason: AiSkipReason): AiResult {
    return { kind: 'SKIPPED', reason, message: SKIP_MESSAGES[reason] };
  }
}

function allow(reason: string): AiVerdict {
  return { allow: true, confidence: 0.5, reason, skipped: false };
}

/**
 * Parses the model's structured answer.
 *
 * Returns null when the model did not answer in the expected shape, and the
 * caller then fails OPEN. A model that rambles must not become a moderator.
 */
export function parseVerdict(raw: string): AiVerdict | null {
  const match = /ALLOW\s*[:=]\s*(true|false)/i.exec(raw);
  if (!match) return null;

  const allow = match[1]?.toLowerCase() === 'true';
  const confidence = /CONFIDENCE\s*[:=]\s*([0-9.]+)/i.exec(raw);
  const reason = /REASON\s*[:=]\s*(.+)/i.exec(raw);

  return {
    allow,
    confidence: confidence?.[1] ? Math.min(1, Math.max(0, Number(confidence[1]))) : 0.5,
    reason: reason?.[1]?.trim() ?? 'No reason provided.',
    skipped: false,
  };
}
