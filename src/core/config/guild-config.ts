/**
 * Guild configuration cache.
 *
 * Every message, every interaction, and every command execution needs the
 * prefix and the enabled-module set. Reading them per-event would make the
 * database the bottleneck of the hot path, so they are cached per guild with
 * an explicit invalidation hook.
 *
 * The cache is deliberately WRITE-THROUGH on the paths that mutate: a
 * `setPrefix` that updated the row but not the cache would leave the bot using
 * the old prefix until the TTL expired, which is the kind of bug that only
 * shows up in production.
 */

import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { guildModules, guildSettings, moduleNameEnum, prefixes } from '../db/schema/core.js';
import { getLogger } from '../logging/logger.js';
import { DEFAULT_PREFIX } from '../registry/prefix-parser.js';
import { accentColor, isAccentName, type AccentName } from '../ui/themes/theme.js';

export type ModuleName = (typeof moduleNameEnum)['enumValues'][number];

export const MODULE_NAMES: readonly ModuleName[] = moduleNameEnum.enumValues;

export function isModuleName(value: string): value is ModuleName {
  return (MODULE_NAMES as readonly string[]).includes(value);
}

export interface GuildConfig {
  readonly guildId: string;
  readonly prefix: string;
  readonly accent: AccentName;
  readonly accentHex: number;
  readonly locale: string;
  readonly modules: ReadonlySet<ModuleName>;
  readonly settings: Readonly<Record<string, unknown>>;
}

/** Every module off — the safe default for a guild that has never configured. */
export function emptyGuildConfig(guildId: string): GuildConfig {
  return {
    guildId,
    prefix: DEFAULT_PREFIX,
    accent: 'azure',
    accentHex: accentColor('azure'),
    locale: 'en-US',
    modules: new Set<ModuleName>(),
    settings: {},
  };
}

export interface GuildConfigStore {
  get(guildId: string): Promise<GuildConfig>;
  /** Synchronous read of an already-warm cache; never queries. */
  peek(guildId: string): GuildConfig | undefined;
  setPrefix(guildId: string, prefix: string): Promise<void>;
  setModuleEnabled(guildId: string, module: ModuleName, enabled: boolean): Promise<void>;
  setAccent(guildId: string, accent: string): Promise<AccentName>;
  mergeSettings(guildId: string, patch: Record<string, unknown>): Promise<void>;
  invalidate(guildId: string): void;
  size(): number;
}

export interface GuildConfigStoreOptions {
  readonly ttlMs?: number;
}

export function createGuildConfigStore(
  db: Database,
  options: GuildConfigStoreOptions = {},
): GuildConfigStore {
  const ttlMs = options.ttlMs ?? 60_000;
  const log = getLogger().child({ module: 'guild-config', operation: 'store' });
  const cache = new Map<string, { expiresAt: number; config: GuildConfig }>();
  const pending = new Map<string, Promise<GuildConfig>>();

  async function load(guildId: string): Promise<GuildConfig> {
    const base = emptyGuildConfig(guildId);
    const id = Number(guildId);

    const [prefixRow, settingsRow, moduleRows] = await Promise.all([
      db.select({ prefix: prefixes.prefix }).from(prefixes).where(eq(prefixes.guildId, id)).limit(1),
      db
        .select({
          accent: guildSettings.accent,
          data: guildSettings.data,
        })
        .from(guildSettings)
        .where(eq(guildSettings.guildId, id))
        .limit(1),
      db
        .select({ module: guildModules.module, enabled: guildModules.enabled })
        .from(guildModules)
        .where(eq(guildModules.guildId, id)),
    ]);

    const settings = settingsRow[0];
    const accent = settings?.accent;
    const modules = new Set<ModuleName>();
    for (const row of moduleRows) {
      if (row.enabled && isModuleName(row.module)) modules.add(row.module);
    }

    return {
      ...base,
      prefix: prefixRow[0]?.prefix || DEFAULT_PREFIX,
      accent: accent && isAccentName(accent) ? accent : base.accent,
      accentHex: accentColor(accent),
      modules,
      settings: settings?.data ?? {},
    };
  }

  async function get(guildId: string): Promise<GuildConfig> {
    const hit = cache.get(guildId);
    if (hit && hit.expiresAt > Date.now()) return hit.config;

    const inFlight = pending.get(guildId);
    if (inFlight) return inFlight;

    const task = load(guildId)
      .then((config) => {
        cache.set(guildId, { expiresAt: Date.now() + ttlMs, config });
        return config;
      })
      .catch((error: unknown) => {
        // A cache that throws on a read outage takes the whole bot with it.
        // Serve defaults and let the next expiry retry.
        log.error({ err: error, guildId }, 'guild config load failed; serving defaults');
        cache.set(guildId, { expiresAt: Date.now() + 5_000, config: emptyGuildConfig(guildId) });
        return emptyGuildConfig(guildId);
      })
      .finally(() => {
        pending.delete(guildId);
      });

    pending.set(guildId, task);
    return task;
  }

  /** Updates the cached copy after a write so reads are consistent immediately. */
  function patch(guildId: string, mutate: (config: GuildConfig) => GuildConfig): void {
    const hit = cache.get(guildId);
    const current = hit?.config ?? emptyGuildConfig(guildId);
    cache.set(guildId, { expiresAt: Date.now() + ttlMs, config: mutate(current) });
  }

  return {
    get,
    peek: (guildId) => cache.get(guildId)?.config,

    async setPrefix(guildId, prefix) {
      await db
        .insert(prefixes)
        .values({ guildId: Number(guildId), prefix })
        .onConflictDoUpdate({
          target: prefixes.guildId,
          set: { prefix, updatedAt: new Date() },
        });
      patch(guildId, (config) => ({ ...config, prefix }));
    },

    async setModuleEnabled(guildId, module, enabled) {
      await db
        .insert(guildModules)
        .values({ guildId: Number(guildId), module, enabled })
        .onConflictDoUpdate({
          target: [guildModules.guildId, guildModules.module],
          set: { enabled, updatedAt: new Date() },
        });
      patch(guildId, (config) => {
        const modules = new Set(config.modules);
        if (enabled) modules.add(module);
        else modules.delete(module);
        return { ...config, modules };
      });
    },

    async setAccent(guildId, accent) {
      // Validated before it reaches the cache: an unknown name would silently
      // fall back at render time and look like the setting did not save.
      if (!isAccentName(accent)) throw new Error(`Unknown accent: ${accent}`);
      await db
        .insert(guildSettings)
        .values({ guildId: Number(guildId), accent })
        .onConflictDoUpdate({
          target: guildSettings.guildId,
          set: { accent, updatedAt: new Date() },
        });
      patch(guildId, (config) => ({ ...config, accent, accentHex: accentColor(accent) }));
      return accent;
    },

    async mergeSettings(guildId, settingsPatch) {
      const current = (await get(guildId)).settings;
      const merged = { ...current, ...settingsPatch };
      await db
        .insert(guildSettings)
        .values({ guildId: Number(guildId), data: merged })
        .onConflictDoUpdate({
          target: guildSettings.guildId,
          set: { data: merged, updatedAt: new Date() },
        });
      patch(guildId, (config) => ({ ...config, settings: merged }));
    },

    invalidate(guildId) {
      cache.delete(guildId);
    },

    size: () => cache.size,
  };
}

/** Rows for a batch of guilds — used at boot to warm the cache in one query. */
export async function warmGuildConfigs(
  db: Database,
  guildIds: readonly string[],
): Promise<Map<string, GuildConfig>> {
  const numeric = guildIds.map((g) => Number(g)).filter((n) => Number.isFinite(n));
  const out = new Map<string, GuildConfig>();
  if (numeric.length === 0) return out;

  const [prefixRows, settingRows, moduleRows] = await Promise.all([
    db
      .select({ guildId: prefixes.guildId, prefix: prefixes.prefix })
      .from(prefixes)
      .where(and(inArray(prefixes.guildId, numeric))),
    db
      .select({ guildId: guildSettings.guildId, accent: guildSettings.accent, data: guildSettings.data })
      .from(guildSettings)
      .where(and(inArray(guildSettings.guildId, numeric))),
    db
      .select({ guildId: guildModules.guildId, module: guildModules.module, enabled: guildModules.enabled })
      .from(guildModules)
      .where(and(inArray(guildModules.guildId, numeric))),
  ]);

  const prefixesByGuild = new Map(prefixRows.map((r) => [String(r.guildId), r.prefix]));
  const settingsByGuild = new Map(settingRows.map((r) => [String(r.guildId), r]));
  const modulesByGuild = new Map<string, Set<ModuleName>>();
  for (const row of moduleRows) {
    if (!row.enabled || !isModuleName(row.module)) continue;
    const key = String(row.guildId);
    const set = modulesByGuild.get(key) ?? new Set<ModuleName>();
    set.add(row.module);
    modulesByGuild.set(key, set);
  }

  for (const guildId of guildIds) {
    const base = emptyGuildConfig(guildId);
    const settings = settingsByGuild.get(guildId);
    const accent = settings?.accent;
    out.set(guildId, {
      ...base,
      prefix: prefixesByGuild.get(guildId) || DEFAULT_PREFIX,
      accent: accent && isAccentName(accent) ? accent : base.accent,
      accentHex: accentColor(accent),
      modules: modulesByGuild.get(guildId) ?? new Set<ModuleName>(),
      settings: settings?.data ?? {},
    });
  }

  return out;
}