/**
 * Command registry (v13 §N.4).
 *
 * THE SINGLE SOURCE OF TRUTH for every registered command's metadata. Help
 * renders from this and never maintains a second list, which structurally
 * prevents both failure modes the plan calls out:
 *   - a command exists but Help forgot it
 *   - Help lists a command that no longer exists
 *
 * v13 §3.2: slash and prefix are THIN ADAPTERS over one core action. The
 * registry stores the core action once; `CommandDefinition` exposes both
 * transports so they cannot drift.
 */

import type { BaseMessageOptions, EmbedBuilder } from 'discord.js';
import type { ModuleName, VisibilityLevel } from '../../shared/types/discord.js';

export interface CommandContext {
  readonly guildId: string;
  readonly guildName: string;
  readonly ownerId: string;
  readonly userId: string;
  readonly channelId?: string;
  readonly locale?: string;
  readonly module?: ModuleName;
}

export interface CommandResult {
  /** Text content, or undefined when only embeds/components are sent. */
  readonly content?: string;
  /**
   * Embeds built through `core/ui`. Always via the factory — a feature may
   * never construct an EmbedBuilder directly.
   */
  readonly embeds?: readonly EmbedBuilder[];
  /** Components built through `core/ui`. */
  readonly components?: BaseMessageOptions['components'];
}

export type CommandHandler = (args: CommandArgs, ctx: CommandContext) => Promise<CommandResult>;

export interface CommandArgs {
  /** Positional arguments after the command name. */
  readonly positional: readonly string[];
  /** Named options. */
  readonly options: Readonly<Record<string, string>>;
  /** The raw remainder, for free-form input. */
  readonly rest: string;
}

export interface CommandDefinition {
  /** Canonical name WITHOUT a prefix, e.g. 'balance'. */
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly category: string;
  /** Usage string showing the prefix placeholder, e.g. '<member> <duration>'. */
  readonly usage: string;
  readonly examples: readonly string[];
  readonly module: ModuleName;
  /** Discord permission bits required. */
  readonly permissions: readonly bigint[];
  readonly staffRoleIds: readonly string[];
  /** v14 §B: owner-only surface (backup/template). */
  readonly ownerOnly: boolean;
  readonly relatedCommands: readonly string[];
  readonly visibility: VisibilityLevel;
  readonly handler: CommandHandler;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Command registry: ${message}`);
}

/**
 * Validates a definition at BOOT.
 *
 * A command missing metadata fails fast here rather than appearing subtly
 * broken in Help at runtime.
 */
export function validateDefinition(definition: CommandDefinition): void {
  assert(definition.name, 'name is required');
  assert(/^[a-z0-9_-]+$/.test(definition.name), `name "${definition.name}" must be kebab/snake case`);
  assert(definition.description.length > 0, `${definition.name}: description is required`);
  assert(definition.description.length <= 200, `${definition.name}: description must be <= 200 chars`);
  assert(definition.category.length > 0, `${definition.name}: category is required`);
  // `usage` is mandatory: every command must document how it is invoked, even
  // when it takes no arguments (in which case it states that plainly). Help
  // renders this verbatim, so an empty string would produce a broken entry.
  assert(definition.usage.length > 0, `${definition.name}: usage is required`);
  assert(definition.visibility.length > 0, `${definition.name}: visibility is required`);
  assert(typeof definition.handler === 'function', `${definition.name}: handler is required`);

  // ownerOnly must be consistent with visibility (v13 §N.6).
  if (definition.ownerOnly) {
    assert(
      definition.visibility === 'OWNER_ONLY',
      `${definition.name}: ownerOnly requires OWNER_ONLY visibility`,
    );
  }
}

export class CommandRegistry {
  readonly #byName = new Map<string, CommandDefinition>();
  readonly #aliases = new Map<string, string>();

  register(definition: CommandDefinition): this {
    validateDefinition(definition);
    assert(!this.#byName.has(definition.name), `duplicate command "${definition.name}"`);

    this.#byName.set(definition.name, definition);
    for (const alias of definition.aliases) {
      assert(!this.#aliases.has(alias), `duplicate alias "${alias}"`);
      this.#aliases.set(alias, definition.name);
    }
    return this;
  }

  registerAll(definitions: readonly CommandDefinition[]): this {
    for (const definition of definitions) this.register(definition);
    return this;
  }

  /** Resolves by canonical name or alias. */
  resolve(name: string): CommandDefinition | undefined {
    const normalized = name.toLowerCase();
    const canonical = this.#aliases.get(normalized) ?? normalized;
    return this.#byName.get(canonical);
  }

  has(name: string): boolean {
    return this.resolve(name) !== undefined;
  }

  /** Every registered command, ordered for stable Help output. */
  all(): readonly CommandDefinition[] {
    return [...this.#byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  byCategory(category: string): readonly CommandDefinition[] {
    return this.all().filter((c) => c.category === category);
  }

  categories(): readonly string[] {
    return [...new Set(this.all().map((c) => c.category))].sort();
  }

  get size(): number {
    return this.#byName.size;
  }

  /**
   * Registry integrity check (v13 §N.4).
   *
   * Fails if any command is unreachable, has an alias colliding with a real
   * command, or references a related command that does not exist.
   */
  assertIntegrity(): void {
    for (const definition of this.all()) {
      for (const related of definition.relatedCommands) {
        assert(
          this.resolve(related),
          `${definition.name}: related command "${related}" does not exist`,
        );
      }
      for (const alias of definition.aliases) {
        assert(
          !this.#byName.has(alias),
          `alias "${alias}" (${definition.name}) collides with a real command`,
        );
      }
    }
  }
}

export const registry = new CommandRegistry();