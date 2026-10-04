/**
 * Command execution (v13 §N).
 *
 * THE CORE ACTION. Both transports — the prefix adapter and the slash-command
 * adapter — funnel through `executeCommand`, so authorization, rate limiting,
 * exemption resolution, and error handling cannot drift between them.
 *
 * Order of operations matters and is deliberate:
 *
 *   1. RESOLVE the command (canonical name or alias). Unknown -> ignored.
 *   2. GUILD SCOPING. The guild id comes from the RESOLVED interaction, never
 *      from anything the caller supplied.
 *   3. OWNER GATE, checked FIRST and independently of every permission path.
 *   4. PERMISSIONS, via the existing `checkPermissions` — which also performs
 *      role-hierarchy checks, so this layer does not reimplement it.
 *   5. RATE LIMIT, before any database work.
 *   6. POLICY EXEMPTION, via the centralized resolver — never reimplemented.
 *   7. RUN the handler, then render.
 *
 * This is the FIRST authorization check, not the only one: any handler that
 * mutates re-verifies immediately beforehand via `reauthorizeBeforeMutation`,
 * because ownership can change between these two points.
 */

import type { GuildMember } from 'discord.js';
import { RedoubtError, PermissionError } from '../errors.js';
import { writeAudit } from '../logging/audit-events.js';
import { getLogger } from '../logging/logger.js';
import {
  checkPermissions,
  isCurrentGuildOwner,
} from '../permissions/permissions.js';
import {
  resolvePolicy,
  type PolicyRule,
  type PolicySubject,
} from '../policies/exclusions/resolver.js';
import { rateLimiter } from '../ratelimit/guild-limiter.js';
import type { CommandDefinition } from './command-registry.js';
import { registry } from './command-registry.js';
import type { GuildContext } from '../../shared/types/discord.js';

export interface ExecuteInput {
  /** ALWAYS derived from the resolved interaction — never caller-supplied. */
  readonly guild: GuildContext;
  /** The resolved member. Never reconstructed from user-supplied ids. */
  readonly actor: GuildMember;
  readonly channelId?: string;
  readonly commandName: string;
  readonly args: {
    readonly positional: readonly string[];
    readonly options: Readonly<Record<string, string>>;
    readonly rest: string;
  };
  /** Exemption rules already hydrated for this guild. */
  readonly policies?: readonly PolicyRule[];
  /** Whether the command's module is enabled for this guild. */
  readonly moduleEnabled?: boolean;
}

export type ExecuteOutcome =
  | { readonly kind: 'OK'; readonly result: { content?: string }; readonly command: CommandDefinition }
  | { readonly kind: 'UNKNOWN'; readonly name: string }
  | { readonly kind: 'DENIED'; readonly command: string; readonly message: string }
  | { readonly kind: 'RATE_LIMITED'; readonly retryAfterMs: number }
  | { readonly kind: 'EXEMPT'; readonly command: string }
  | {
      readonly kind: 'FAILED';
      readonly command: string;
      readonly message: string;
      readonly referenceId: string;
    };

/**
 * Whether the actor satisfies a command's permission set.
 *
 * The list is an ANY-of set: these are alternative staff-grade bits (Manage
 * Guild OR Moderate Members), not a requirement to hold every one. A command
 * with no bits is unrestricted at this layer and relies on visibility/staff
 * roles instead.
 */
function hasRequiredPermission(definition: CommandDefinition, actor: GuildMember): boolean {
  if (definition.permissions.length === 0) return true;
  return definition.permissions.some((bit) => actor.permissions.has(bit));
}

/** Maps a command's module to the policy domain that governs it. */
function domainForModule(module: string): Parameters<typeof resolvePolicy>[2]['domain'] {
  switch (module) {
    case 'automod':
      return 'AUTOMOD';
    case 'leveling':
      return 'LEVELING';
    case 'inviteRewards':
      return 'INVITES';
    case 'logging':
      return 'LOGGING';
    case 'economy':
      return 'ECONOMY';
    case 'tickets':
      return 'TICKETS';
    case 'welcome':
      return 'WELCOME';
    default:
      // Everything else is covered by a GLOBAL-domain rule, which the resolver
      // consults for any domain.
      return 'GLOBAL';
  }
}

/**
 * Runs a command end to end.
 *
 * Never throws: every failure becomes an `ExecuteOutcome` so a transport can
 * render it without inventing its own error path.
 */
export async function executeCommand(input: ExecuteInput): Promise<ExecuteOutcome> {
  const log = getLogger().child({
    module: 'commands',
    operation: 'execute',
    guildId: input.guild.guildId,
  });

  const definition = registry.resolve(input.commandName);
  if (!definition) {
    // A typo or a stray message must not produce a reply.
    return { kind: 'UNKNOWN', name: input.commandName };
  }

  // 3. OWNER GATE FIRST, and independently of every other path.
  //
  // `isCurrentGuildOwner` reads the LIVE guild owner, never a cached value.
  // Admin, Manage Guild, a staff role, and installing the bot are all
  // insufficient — this check is the only thing that opens /backup and
  // /template.
  if (definition.ownerOnly) {
    // Pure owner-id comparison: no permission bit or staff role can satisfy it.
    if (!isCurrentGuildOwner(input.guild, input.actor.id)) {
      writeAudit({
        event:
          definition.name === 'template' ? 'TEMPLATE_OWNER_DENIED' : 'BACKUP_OWNER_DENIED',
        guildId: input.guild.guildId,
        actorId: input.actor.id,
        currentOwnerId: input.guild.ownerId,
        resourceId: definition.name,
        result: 'DENIED',
        reason: 'not_current_owner',
      });

      return {
        kind: 'DENIED',
        command: definition.name,
        message: 'Only this server’s owner can use that.',
      };
    }
  }

  // 4. Permissions, delegated to the shared checker.
  const authorization = checkPermissions({
    context: input.guild,
    actor: input.actor,
    requiredPermission: hasRequiredPermission(definition, input.actor)
      ? definition.permissions[0]
      : undefined,
    module: definition.module,
    moduleEnabled: input.moduleEnabled,
    staffRoleIds: definition.staffRoleIds,
  });

  // Defence in depth: the ANY-of check above is stricter than checkPermissions'
  // single-bit form, so verify it explicitly too.
  if (!authorization.authorized || !hasRequiredPermission(definition, input.actor)) {
    writeAudit({
      event: 'COMMAND_DENIED',
      guildId: input.guild.guildId,
      actorId: input.actor.id,
      currentOwnerId: input.guild.ownerId,
      resourceId: definition.name,
      result: 'DENIED',
      // The reason is recorded for operators but NEVER shown to the user.
      reason: authorization.reason ?? 'missing_permission',
    });

    return {
      kind: 'DENIED',
      command: definition.name,
      message: 'You do not have permission to use this command.',
    };
  }

  // 5. Rate limit BEFORE any database work.
  const bucketKey = `cmd:${definition.name}`;
  if (!rateLimiter.tryConsume(input.guild.guildId, bucketKey)) {
    return {
      kind: 'RATE_LIMITED',
      retryAfterMs: rateLimiter.retryAfterMs(input.guild.guildId, bucketKey),
    };
  }

  // 6. Centralized exemption. Never reimplemented per feature.
  if (input.policies && input.policies.length > 0) {
    const roleIds = [...input.actor.roles.cache.keys()];
    const subject: PolicySubject & { guildId: string } = {
      guildId: input.guild.guildId,
      userId: input.actor.id,
      roleIds,
      channelId: input.channelId,
    };

    const decision = resolvePolicy(input.policies, subject, {
      domain: domainForModule(definition.module),
      // Scope-specific: an exemption for one command does not silence others.
      ruleScope: definition.name,
    });

    if (decision.exempt) {
      log.debug({ command: definition.name, rule: decision.matchedRuleId }, 'command exempted');
      writeAudit({
        event: 'COMMAND_EXEMPTED',
        guildId: input.guild.guildId,
        actorId: input.actor.id,
        resourceId: definition.name,
        result: 'SUCCESS',
        reason: decision.matchedRuleId,
      });
      return { kind: 'EXEMPT', command: definition.name };
    }
  }

  const ctx = {
    guildId: input.guild.guildId,
    guildName: input.guild.guildName,
    // v14: ownership always resolves to the CURRENT guild owner, never to a
    // value recorded when the command was configured.
    ownerId: input.guild.ownerId,
    userId: input.actor.id,
    channelId: input.channelId,
    locale: input.guild.locale,
    module: definition.module,
  };

  try {
    const result = await definition.handler(input.args, ctx);
    return { kind: 'OK', result, command: definition };
  } catch (error) {
    if (error instanceof PermissionError) {
      return { kind: 'DENIED', command: definition.name, message: error.displayMessage };
    }

    if (error instanceof RedoubtError) {
      // A user-facing error is safe to render exactly as written.
      log.warn({ err: error, command: definition.name }, 'user-facing command error');
      return {
        kind: 'FAILED',
        command: definition.name,
        message: error.displayMessage,
        referenceId: error.referenceId,
      };
    }

    // Anything else is an internal fault: log it with a correlation id and
    // show the user only that reference. Never a stack trace.
    const referenceId = `R-${Math.random().toString(16).slice(2, 8).toUpperCase()}`;
    log.error({ err: error, command: definition.name, referenceId }, 'command failed');
    return {
      kind: 'FAILED',
      command: definition.name,
      message: `Something went wrong running that command. Reference: ${referenceId}`,
      referenceId,
    };
  }
}
