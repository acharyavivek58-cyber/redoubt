/**
 * Command system (v13 §3, v11 §B).
 *
 * Covers the two properties the plan calls out explicitly:
 *  - the default prefix is `$` and `?` is never the default
 *  - `$prefix` parses as the prefix command rather than being mis-tokenized
 *  - per-guild isolation (Guild A's prefix never affects Guild B)
 *  - slash/prefix parity: one core action, two thin adapters
 */

import { describe, expect, it } from 'vitest';
import {
  CommandRegistry,
  type CommandDefinition,
} from '../../src/core/registry/command-registry.js';
import {
  DEFAULT_PREFIX,
  extractOptions,
  parsePrefixCommand,
  resolvePrefix,
  tokenize,
} from '../../src/core/registry/prefix-parser.js';

function def(overrides: Partial<CommandDefinition> & { name: string }): CommandDefinition {
  return {
    aliases: [],
    description: 'Test command',
    category: 'Utility',
    // Usage is REQUIRED by the registry validator, so the fixture supplies a
    // valid one and individual tests override it when exercising that check.
    usage: '[args]',
    examples: [],
    module: 'utility',
    permissions: [],
    staffRoleIds: [],
    ownerOnly: false,
    relatedCommands: [],
    visibility: 'PUBLIC',
    handler: async () => ({}),
    ...overrides,
  };
}

describe('default prefix is $ (v11 §B.2)', () => {
  it('defaults to $ when no prefix is configured', () => {
    expect(DEFAULT_PREFIX).toBe('$');
    expect(resolvePrefix(null)).toBe('$');
    expect(resolvePrefix(undefined)).toBe('$');
    expect(resolvePrefix('')).toBe('$');
    expect(resolvePrefix('   ')).toBe('$');
  });

  it('never treats ? as a default', () => {
    // `?` is only ever used when a guild EXPLICITLY configures it.
    expect(resolvePrefix(null)).not.toBe('?');
    expect(resolvePrefix('?')).toBe('?');
  });

  it('rejects a whitespace-containing prefix', () => {
    // Such a prefix cannot be split reliably, so it falls back safely.
    expect(resolvePrefix('!@#')).toBe('!@#');
    expect(resolvePrefix('a b')).toBe('$');
  });
});

describe('$prefix parses as the prefix command (v11 §B.6)', () => {
  it('matches the literal $prefix token', () => {
    const parsed = parsePrefixCommand('$prefix', null);
    expect(parsed?.name).toBe('prefix');
    expect(parsed?.args.positional).toEqual([]);
  });

  it('carries the new prefix argument', () => {
    const parsed = parsePrefixCommand('$prefix !', null);
    expect(parsed?.name).toBe('prefix');
    expect(parsed?.args.positional).toEqual(['!']);
  });

  it('works with a custom guild prefix too', () => {
    const parsed = parsePrefixCommand('!prefix ?', '!');
    expect(parsed?.name).toBe('prefix');
    expect(parsed?.args.positional).toEqual(['?']);
  });

  it('is not mis-tokenized as an empty command name', () => {
    // The regression: `$prefix !` must never yield name '' with arg 'prefix'.
    const parsed = parsePrefixCommand('$prefix !', null);
    expect(parsed?.name).not.toBe('');
    expect(parsed?.args.positional).not.toContain('prefix');
  });
});

describe('prefix parsing', () => {
  it('parses a simple command', () => {
    const parsed = parsePrefixCommand('$balance', null);
    expect(parsed?.name).toBe('balance');
  });

  it('parses positional arguments', () => {
    const parsed = parsePrefixCommand('$jail @User 30m', null);
    expect(parsed?.name).toBe('jail');
    expect(parsed?.args.positional).toEqual(['@User', '30m']);
  });

  it('ignores non-command messages', () => {
    expect(parsePrefixCommand('hello everyone', null)).toBeUndefined();
    expect(parsePrefixCommand('', null)).toBeUndefined();
    expect(parsePrefixCommand('$', null)).toBeUndefined();
  });

  it('honours a custom guild prefix', () => {
    const parsed = parsePrefixCommand('!balance', '!');
    expect(parsed?.name).toBe('balance');
  });

  it('does not resolve a command under a different guild prefix', () => {
    // A message using $ when this guild uses ! is not a command here.
    expect(parsePrefixCommand('$balance', '!')).toBeUndefined();
  });
});

describe('per-guild prefix isolation (v13 §3.3)', () => {
  it('resolves independently for different guild prefixes', () => {
    const guildA = parsePrefixCommand('$balance', '$');
    const guildB = parsePrefixCommand('!balance', '!');

    expect(guildA?.name).toBe('balance');
    expect(guildB?.name).toBe('balance');

    // Cross-guild: A's $ must not parse under B's ! and vice versa.
    expect(parsePrefixCommand('$balance', '!')).toBeUndefined();
    expect(parsePrefixCommand('!balance', '$')).toBeUndefined();
  });
});

describe('tokenizer', () => {
  it('splits on whitespace', () => {
    expect(tokenize('a b c')).toEqual(['a', 'b', 'c']);
  });

  it('preserves quoted strings with spaces', () => {
    expect(tokenize('"two words" tail')).toEqual(['two words', 'tail']);
  });

  it('handles collapsed whitespace', () => {
    expect(tokenize('  a   b  ')).toEqual(['a', 'b']);
  });

  it('returns nothing for empty input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   ')).toEqual([]);
  });
});

describe('option extraction', () => {
  it('extracts --key value pairs', () => {
    expect(extractOptions(['--reason', 'spam', '@User'])).toEqual({
      options: { reason: 'spam' },
      positional: ['@User'],
    });
  });

  it('extracts --key=value form', () => {
    expect(extractOptions(['--reason=spam'])).toEqual({
      options: { reason: 'spam' },
      positional: [],
    });
  });

  it('treats a trailing flag as boolean true', () => {
    expect(extractOptions(['--force'])).toEqual({ options: { force: 'true' }, positional: [] });
  });
});

describe('command registry (v13 §N.4)', () => {
  it('resolves canonical names and aliases', () => {
    const registry = new CommandRegistry().register(
      def({ name: 'balance', aliases: ['bal'] }),
    );
    expect(registry.resolve('balance')?.name).toBe('balance');
    expect(registry.resolve('bal')?.name).toBe('balance');
    expect(registry.resolve('BALANCE')?.name).toBe('balance');
    expect(registry.resolve('nope')).toBeUndefined();
  });

  it('rejects duplicate command names at boot', () => {
    const registry = new CommandRegistry().register(def({ name: 'ping' }));
    expect(() => registry.register(def({ name: 'ping' }))).toThrow(/duplicate command/);
  });

  it('fails fast on incomplete metadata', () => {
    expect(() => new CommandRegistry().register(def({ name: 'x', description: '' }))).toThrow(
      /description is required/,
    );
    expect(() => new CommandRegistry().register(def({ name: 'x', usage: '' }))).toThrow(
      /usage is required/,
    );
    // A complete definition registers cleanly.
    expect(() => new CommandRegistry().register(def({ name: 'x' }))).not.toThrow();
  });

  it('requires OWNER_ONLY visibility when ownerOnly is set', () => {
    expect(() =>
      new CommandRegistry().register(
        def({ name: 'backup', ownerOnly: true, visibility: 'PUBLIC' }),
      ),
    ).toThrow(/OWNER_ONLY/);

    expect(() =>
      new CommandRegistry().register(
        def({ name: 'backup', ownerOnly: true, visibility: 'OWNER_ONLY' }),
      ),
    ).not.toThrow();
  });

  it('rejects invalid command names', () => {
    expect(() => new CommandRegistry().register(def({ name: 'Bad Name' }))).toThrow(
      /kebab/,
    );
  });

  it('groups commands by category for Help', () => {
    const registry = new CommandRegistry().registerAll([
      def({ name: 'balance', category: 'Economy' }),
      def({ name: 'shop', category: 'Economy' }),
      def({ name: 'ping', category: 'Utility' }),
    ]);
    expect(registry.byCategory('Economy').map((c) => c.name)).toEqual(['balance', 'shop']);
    expect(registry.categories()).toEqual(['Economy', 'Utility']);
  });

  it('detects a related command that does not exist', () => {
    const registry = new CommandRegistry().register(
      def({ name: 'jail', relatedCommands: ['unjail'] }),
    );
    expect(() => registry.assertIntegrity()).toThrow(/related command "unjail" does not exist/);
  });

  it('passes integrity when related commands exist', () => {
    const registry = new CommandRegistry().registerAll([
      def({ name: 'jail', relatedCommands: ['unjail'] }),
      def({ name: 'unjail' }),
    ]);
    expect(() => registry.assertIntegrity()).not.toThrow();
  });

  it('detects an alias colliding with a real command', () => {
    const registry = new CommandRegistry().registerAll([
      def({ name: 'ping' }),
      def({ name: 'pong', aliases: ['ping'] }),
    ]);
    expect(() => registry.assertIntegrity()).toThrow(/collides/);
  });

  it('every registered command appears in all() — Help cannot omit one', () => {
    const registry = new CommandRegistry().registerAll([
      def({ name: 'balance' }),
      def({ name: 'jail' }),
    ]);
    expect(registry.all().map((c) => c.name).sort()).toEqual(['balance', 'jail']);
    expect(registry.size).toBe(2);
  });
});

describe('slash/prefix parity contract (v13 §3.2)', () => {
  it('stores ONE handler per command for both transports', () => {
    // The structural guarantee: adapters wrap the same core action, so there
    // is only one place business logic can live.
    const registry = new CommandRegistry();
    let handlerCalls = 0;

    registry.register(
      def({
        name: 'balance',

        handler: async () => {
          handlerCalls += 1;
          return { content: '12,450 Coins' };
        },
      }),
    );

    // Simulate invoking via each transport; both resolve the same definition.
    const viaSlash = registry.resolve('balance');
    const viaPrefix = registry.resolve('balance');
    expect(viaSlash?.handler).toBe(viaPrefix?.handler);

    return Promise.all([viaSlash!.handler({ positional: [], options: {}, rest: '' }, {
      guildId: '1', guildName: 'G', ownerId: '1', userId: '2',
    }), viaPrefix!.handler({ positional: [], options: {}, rest: '' }, {
      guildId: '1', guildName: 'G', ownerId: '1', userId: '2',
    })]).then(() => {
      expect(handlerCalls).toBe(2);
    });
  });
});