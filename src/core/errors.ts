/**
 * Typed error hierarchy (v13 §6).
 *
 * - UserFacingError     -> rendered to the user as a polished message
 * - PermissionError     -> authorization failure, also user-facing but generic
 * - QuotaExhaustedError -> Gemini circuit-breaker trip
 * - everything else    -> logged with a correlation ID; the user sees only
 *                          a safe reference ID, never internal detail.
 *
 * v14 §7: uncaught exceptions must NOT be swallowed. The process logs, stops
 * accepting new work, attempts cleanup, and exits non-zero so the supervisor
 * restarts into a known-good state.
 */

import { randomBytes } from 'node:crypto';

/** A correlation ID safe to show a user: e.g. `R-8F42`. */
export function newReferenceId(): string {
  return `R-${randomBytes(3).toString('hex').toUpperCase()}`;
}

export interface ErrorContext {
  readonly guildId?: string;
  readonly userId?: string;
  readonly channelId?: string;
  readonly interactionId?: string;
  readonly module?: string;
  readonly operation?: string;
  readonly [key: string]: unknown;
}

export abstract class RedoubtError extends Error {
  abstract readonly code: string;

  /** Safe message intended for the user. */
  readonly userMessage: string;
  readonly referenceId: string;
  readonly context: ErrorContext;

  /** Optional suffix appended to userMessage (e.g. a reference line). */
  protected messageSuffix = '';

  constructor(userMessage: string, context: ErrorContext = {}) {
    super(userMessage);
    this.name = new.target.name;
    this.userMessage = userMessage;
    this.referenceId = newReferenceId();
    this.context = context;
  }

  /** Final user-facing text, including any subclass suffix. */
  get displayMessage(): string {
    return this.messageSuffix ? `${this.userMessage}\n${this.messageSuffix}` : this.userMessage;
  }
}

/** An expected, explainable failure. Rendered directly to the user. */
export class UserFacingError extends RedoubtError {
  readonly code = 'USER_FACING';

  constructor(
    userMessage: string,
    readonly detail?: Record<string, unknown>,
    context?: ErrorContext,
  ) {
    super(userMessage, context);
  }
}

/**
 * Authorization failed. The user message is intentionally generic: it never
 * reveals whether the target exists, what their role is, or what the real
 * blocker was (v13 §8 — no internal authorization detail on the denied path).
 */
export class PermissionError extends RedoubtError {
  readonly code = 'PERMISSION_DENIED';

  constructor(
    userMessage = 'You do not have permission to use this command.',
    context: ErrorContext = {},
  ) {
    super(userMessage, context);
  }
}

export class ConfigurationError extends RedoubtError {
  readonly code = 'CONFIGURATION';

  constructor(userMessage: string, detail?: Record<string, unknown>, context?: ErrorContext) {
    super(userMessage, context);
    this.detail = detail;
  }

  readonly detail?: Record<string, unknown>;
}

export class DatabaseError extends RedoubtError {
  readonly code = 'DATABASE';

  constructor(userMessage = 'A storage error occurred.', context: ErrorContext = {}) {
    super(userMessage, context);
  }
}

/** An external provider (Gemini) failed in a way that is not the user's fault. */
export class ExternalProviderError extends RedoubtError {
  readonly code = 'PROVIDER';

  constructor(userMessage: string, context: ErrorContext = {}) {
    super(userMessage, context);
  }
}

/**
 * Gemini free-tier quota exhausted or the provider is unavailable.
 *
 * v13 §2: quota limits are NEVER hard-coded, and provider internals are never
 * exposed. The user-facing message is fixed and generic.
 */
export class QuotaExhaustedError extends RedoubtError {
  readonly code = 'QUOTA_EXHAUSTED';

  constructor(context: ErrorContext = {}) {
    super('AI is unavailable right now. Please try again later.', context);
  }

  /** True when the upstream response indicates quota/rate limiting. */
  static fromProviderStatus(status: number | undefined): boolean {
    return status === 429 || status === 402 || status === 503;
  }
}

export class RateLimitError extends RedoubtError {
  readonly code = 'RATE_LIMITED';

  constructor(userMessage = 'You are going a little fast. Please wait a moment.', context: ErrorContext = {}) {
    super(userMessage, context);
  }
}

export class ValidationError extends RedoubtError {
  readonly code = 'VALIDATION';

  constructor(userMessage: string, context: ErrorContext = {}) {
    super(userMessage, context);
  }
}

/** Owner authorization was lost mid-operation (v14 §7). */
export class OwnerAuthorizationLostError extends RedoubtError {
  readonly code = 'OWNER_AUTHORIZATION_LOST';

  constructor(context: ErrorContext = {}) {
    super(
      [
        'OWNER AUTHORIZATION LOST',
        'The server owner changed during this operation.',
        'No further changes will be performed.',
      ].join('\n'),
      context,
    );
    // Appended here (not at render time) so the message is complete wherever
    // it is surfaced and matches the reference in audit records.
    this.messageSuffix = `Reference: ${this.referenceId}`;
  }
}

/** Normalizes anything thrown into a RedoubtError. */
export function toRedoubtError(error: unknown, context: ErrorContext = {}): RedoubtError {
  if (error instanceof RedoubtError) return error;

  const referenceId = newReferenceId();
  const normalized = new UserFacingError(
    `Something went wrong while running that command.\nReference: ${referenceId}`,
    undefined,
    { ...context, referenceId, original: error },
  );
  return normalized;
}

/** True when the error is safe to render verbatim to a user. */
export function isUserSafe(error: unknown): error is RedoubtError {
  return error instanceof RedoubtError;
}