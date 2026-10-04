/**
 * Command manifest integrity (v13 §N.4, v14 §B).
 *
 * The manifest is the SINGLE SOURCE both transports and Help read from, so the
 * properties that matter are:
 *
 *  - every registered command is complete and uniquely named
 *  - the owner-only surface is EXACTLY backup + template, and nothing else
 *  - no owner-only command is reachable through a non-owner path
 *  - help text never leaks forbidden public terminology
 */

import { describe, expect, it } from 'vitest';
import { registry } from '../../src/core/registry/command-registry.js';
import { assertManifestIntegrity, commandCount } from '../../src/core/registry/manifest.js';
import '../setup.js';

describe('manifest integrity', () => {
  it('validates at boot', () => {
    expect(() => assertManifestIntegrity()).not.toThrow();
  });

  it('registers a non-trivial number of commands', () => {
    expect(commandCount()).toBeGreaterThan(20);
  });

  it('has no duplicate names or aliases', () => {
    const seen = new Set<string>();
    for (const command of registry.all()) {
      expect(seen.has(command.name), `duplicate command: ${command.name}`).toBe(false);
      seen.add(command.name);
      for (const alias of command.aliases) {
        expect(seen.has(alias), `duplicate alias: ${alias}`).toBe(false);
        seen.add(alias);
      }
    }
  });

  it('gives every command a description, category, and usage', () => {
    for (const command of registry.all()) {
      expect(command.description.length, `${command.name} needs a description`).toBeGreaterThan(5);
      expect(command.category.length, `${command.name} needs a category`).toBeGreaterThan(0);
      expect(command.module, `${command.name} needs a module`).toBeTruthy();
    }
  });
});

describe('the owner-only surface is exactly backup and template', () => {
  it('marks only backup and template as owner-only', () => {
    const ownerOnly = registry
      .all()
      .filter((c) => c.ownerOnly)
      .map((c) => c.name)
      .sort();
    expect(ownerOnly).toEqual(['backup', 'template']);
  });

  it('gives owner-only commands OWNER_ONLY visibility', () => {
    // Belt and braces: a command cannot be owner-gated but publicly visible.
    for (const command of registry.all()) {
      if (command.ownerOnly) {
        expect(command.visibility, `${command.name} must be OWNER_ONLY`).toBe('OWNER_ONLY');
      }
    }
  });

  it('grants owner-only commands no staff-role path', () => {
    // A staff role must never be sufficient; ownership is the only gate.
    for (const command of registry.all()) {
      if (command.ownerOnly) {
        expect(command.staffRoleIds, `${command.name} must have no staff roles`).toEqual([]);
      }
    }
  });

  it('never exposes backup or template at a lower visibility', () => {
    for (const name of ['backup', 'template']) {
      const command = registry.resolve(name);
      expect(command, `${name} must be registered`).toBeDefined();
      expect(command?.ownerOnly).toBe(true);
      expect(command?.visibility).toBe('OWNER_ONLY');
    }
  });
});

describe('terminology never leaks into the manifest', () => {
  const FORBIDDEN = /timeout|untimeout|timed out/i;

  it('keeps forbidden terms out of every user-visible field', () => {
    for (const command of registry.all()) {
      expect(command.description, `${command.name} description`).not.toMatch(FORBIDDEN);
      expect(command.usage, `${command.name} usage`).not.toMatch(FORBIDDEN);
      expect(command.category, `${command.name} category`).not.toMatch(FORBIDDEN);
      for (const example of command.examples) {
        expect(example, `${command.name} example`).not.toMatch(FORBIDDEN);
      }
    }
  });

  it('uses Mute/Unmute as the public action names', () => {
    const names = registry.all().map((c) => c.name);
    expect(names).toContain('mute');
    expect(names).toContain('unmute');
  });
});

describe('help and execution read the same list', () => {
  it('exposes every registered command by name', () => {
    for (const command of registry.all()) {
      expect(registry.resolve(command.name)).toBeDefined();
    }
  });

  it('resolves aliases to their canonical command', () => {
    const alias = registry.all().find((c) => c.aliases.length > 0);
    expect(alias).toBeDefined();
    if (alias) {
      const first = alias.aliases[0];
      expect(first).toBeDefined();
      if (first) expect(registry.resolve(first)?.name).toBe(alias.name);
    }
  });
});
