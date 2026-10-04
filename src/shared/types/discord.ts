/**
 * Shared types used across core and features.
 */

import type { Snowflake } from 'discord.js';

export type GuildId = Snowflake;
export type UserId = Snowflake;
export type ChannelId = Snowflake;
export type RoleId = Snowflake;
export type MessageId = Snowflake;

/**
 * The resolved guild-scoped context for an operation.
 *
 * v13 §8: guild context is always DERIVED from the resolved interaction. A
 * supplied guild id is never authoritative, so every service takes this object
 * rather than a bare guildId string that a caller could have invented.
 */
export interface GuildContext {
  readonly guildId: GuildId;
  readonly guildName: string;
  readonly ownerId: UserId;
  readonly locale?: string;
}

/** Per-viewer access tier used by permission checks and Help visibility. */
export const VISIBILITY_LEVELS = [
  'PUBLIC',
  'STAFF',
  'ADMIN',
  'OWNER_ONLY',
  'CONFIGURED_PERMISSION',
] as const;

export type VisibilityLevel = (typeof VISIBILITY_LEVELS)[number];

/** Feature module names. Each maps to a guild_modules enablement row. */
export const MODULES = [
  'moderation',
  'automod',
  'security',
  'tickets',
  'giveaways',
  'applications',
  'reports',
  'appeals',
  'roles',
  'temporaryVoice',
  'leveling',
  'economy',
  'welcome',
  'inviteRewards',
  'honeypot',
  'logging',
  'ai',
  'utility',
  'afk',
] as const;

export type ModuleName = (typeof MODULES)[number];

/** Narrowing guard for module names arriving from config or user input. */
export function isModuleName(value: string): value is ModuleName {
  return (MODULES as readonly string[]).includes(value);
}