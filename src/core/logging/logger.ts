/**
 * Structured logging (Pino) with guild-scoped child loggers (v13 §E.11).
 *
 * Every line binds guildId / userId / channelId / interactionId when known, so
 * an incident can be reconstructed without guesswork.
 */

import { pino, type Logger } from 'pino';
import { getConfig } from '../config/env.js';

let root: Logger | undefined;

function createLogger(): Logger {
  const config = getConfig();
  return pino({
    level: config.logging.level,
    // Pretty output is a local convenience; production stays machine-readable.
    ...(config.logging.pretty ? { transport: { target: 'pino-pretty' } } : {}),
    base: { service: 'redoubt' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    redact: {
      // Never log secrets, even at trace level.
      paths: [
        'token',
        '*.token',
        'password',
        '*.password',
        'apiKey',
        '*.apiKey',
        'config.discord.token',
        'config.ai.apiKey',
      ],
      censor: '[redacted]',
    },
  });
}

export function getLogger(): Logger {
  root ??= createLogger();
  return root;
}

/**
 * A child logger resolved LAZILY, for use at module scope.
 *
 * A module-level `getLogger()` parses the process environment at IMPORT time.
 * That couples every importer to boot order and makes the module impossible to
 * unit-test without a full environment — a mistake this codebase already made
 * once in the AI gateway. Use this instead so nothing is resolved until first
 * use.
 */
export function lazyLogger(bindings: {
  module?: string;
  operation?: string;
  [key: string]: unknown;
}): () => Logger {
  let child: Logger | undefined;
  return () => {
    child ??= scopedLogger(bindings);
    return child;
  };
}

/** Logger bound to a guild and operation for correlation. */
export function scopedLogger(bindings: {
  guildId?: string;
  userId?: string;
  channelId?: string;
  interactionId?: string;
  module?: string;
  operation?: string;
}): Logger {
  return getLogger().child(
    Object.fromEntries(Object.entries(bindings).filter(([, v]) => v !== undefined)),
  );
}

export type { Logger };