/**
 * Prefix parser (v13 §3.5, §B.6).
 *
 * Default prefix is `$`. There is NO `?` default anywhere (v11 §B.2).
 *
 * Two details that are easy to get wrong and are pinned by tests:
 *
 *  1. `$prefix` is BOTH a command name and the default prefix character. The
 *     literal token must be matched BEFORE `$` is treated as a separator,
 *     otherwise the command is unreachable at the default prefix.
 *  2. Parsing is per-guild: Guild A's prefix never affects Guild B.
 */

export const DEFAULT_PREFIX = '$';

/** Resolves a guild's prefix, falling back to the `$` default. */
export function resolvePrefix(storedPrefix: string | null | undefined): string {
  if (!storedPrefix || storedPrefix.trim().length === 0) return DEFAULT_PREFIX;
  // A prefix must be whitespace-free or the parser cannot split reliably.
  const trimmed = storedPrefix.trim();
  if (/\s/.test(trimmed)) return DEFAULT_PREFIX;
  return trimmed;
}

export interface ParsedCommand {
  readonly name: string;
  readonly args: CommandArgsShape;
}

export interface CommandArgsShape {
  readonly positional: readonly string[];
  readonly options: Readonly<Record<string, string>>;
  readonly rest: string;
}

const EMPTY_ARGS: CommandArgsShape = { positional: [], options: {}, rest: '' };

/**
 * Tokenizes an argument string with quoted-string support.
 *
 * `"two words"` becomes a single token, so a reason containing spaces survives
 * without the caller re-joining it.
 */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quoteChar: '"' | "'" | null = null;

  for (const char of input) {
    if (quoteChar) {
      if (char === quoteChar) {
        quoteChar = null;
        tokens.push(current);
        current = '';
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quoteChar = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

/** Extracts `--key value` and `--flag` options. */
export function extractOptions(tokens: readonly string[]): {
  options: Record<string, string>;
  positional: string[];
} {
  const options: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) continue;

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        options[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        options[body] = next;
        i += 1;
      } else {
        options[body] = 'true';
      }
      continue;
    }
    positional.push(token);
  }

  return { options, positional };
}

/**
 * Parses message content into a command invocation.
 *
 * Returns undefined when the message is not a command for this guild, so the
 * caller can ignore it silently rather than replying to normal chat.
 */
export function parsePrefixCommand(
  content: string,
  storedPrefix: string | null | undefined,
): ParsedCommand | undefined {
  const prefix = resolvePrefix(storedPrefix);
  if (!content.startsWith(prefix)) return undefined;

  const body = content.slice(prefix.length);
  if (body.length === 0) return undefined;

  // (1) Match the LITERAL `${prefix}prefix` token before splitting on the
  // prefix character. Without this, `$prefix !` would parse as an empty
  // command name plus the literal argument "prefix".
  const literalCommand = `${prefix}prefix`;
  if (body === literalCommand) {
    return { name: 'prefix', args: EMPTY_ARGS };
  }
  if (body.startsWith(`${literalCommand} `)) {
    const rest = body.slice(literalCommand.length).trim();
    return {
      name: 'prefix',
      args: { positional: rest.length > 0 ? [rest] : [], options: {}, rest },
    };
  }

  const tokens = tokenize(body);
  const first = tokens[0];
  if (first === undefined) return undefined;

  const { options, positional } = extractOptions(tokens.slice(1));
  const name = first.toLowerCase();

  return {
    name,
    args: {
      positional,
      options,
      rest: positional.join(' '),
    },
  };
}