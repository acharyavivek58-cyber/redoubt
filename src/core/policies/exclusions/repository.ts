/**
 * Policy persistence (v13 §7.2).
 *
 * The RESOLVER is the single source of truth for semantics; this layer only
 * hydrates `PolicyRule` values from storage. Two things matter here:
 *
 *  - DENY-OVERRIDES-ALLOW must survive the round trip, which means a disabled
 *    policy is excluded from hydration (an operator turning a policy off is a
 *    real action, not a no-op).
 *  - Rows are cached per guild, because the resolver runs on the hot path of
 *    every message. The cache is invalidated explicitly rather than polled.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { policies, policyRules } from '../../db/schema/features.js';
import { getLogger } from '../../logging/logger.js';
import type { PolicyDomain, PolicyRule } from './resolver.js';

/** Row shape as stored, with the policy-level fields joined in. */
interface StoredRuleRow extends Record<string, unknown> {
  readonly id: string;
  readonly guild_id: number;
  readonly domain: string;
  readonly enabled: boolean;
  readonly subject: 'USER' | 'ROLE' | 'CHANNEL' | 'CATEGORY';
  readonly subject_id: string;
  readonly rule_scope: string | null;
  readonly effect: 'SKIP' | 'QUIET' | 'ALLOW';
  readonly priority: number;
}

const VALID_DOMAINS: readonly PolicyDomain[] = [
  'GLOBAL',
  'AUTOMOD',
  'LEVELING',
  'INVITES',
  'LOGGING',
  'ECONOMY',
  'TICKETS',
  'WELCOME',
];

function isPolicyDomain(value: string): value is PolicyDomain {
  return (VALID_DOMAINS as readonly string[]).includes(value);
}

export interface CreateRuleInput {
  readonly policyId: string;
  readonly subject: 'USER' | 'ROLE' | 'CHANNEL' | 'CATEGORY';
  readonly subjectId: string;
  readonly ruleScope?: string | null;
  readonly effect?: 'SKIP' | 'QUIET' | 'ALLOW';
  readonly priority?: number;
}

export interface PolicyRepository {
  listRules(guildId: string): Promise<readonly PolicyRule[]>;
  createRule(guildId: string, input: CreateRuleInput): Promise<PolicyRule>;
  setPolicyEnabled(guildId: string, policyId: string, enabled: boolean): Promise<void>;
  deleteRule(guildId: string, ruleId: string): Promise<boolean>;
  invalidate(guildId: string): void;
  cacheStats(): { guilds: number; rules: number };
}

export interface PolicyRepositoryOptions {
  /**
   * How long a hydrated rule set stays valid. Exemptions are read far more
   * often than they are edited, so a short TTL bounds staleness without a
   * query per message. Explicit invalidation covers same-tick correctness.
   */
  readonly ttlMs?: number;
}

export function createPolicyRepository(
  db: Database,
  options: PolicyRepositoryOptions = {},
): PolicyRepository {
  const ttlMs = options.ttlMs ?? 30_000;
  const log = getLogger().child({ module: 'policies', operation: 'repository' });
  const cache = new Map<string, { expiresAt: number; rules: readonly PolicyRule[] }>();
  /** In-flight loads, so N concurrent messages issue one query, not N. */
  const pending = new Map<string, Promise<readonly PolicyRule[]>>();

  async function load(guildId: string): Promise<readonly PolicyRule[]> {
    const rows = await db.execute<StoredRuleRow>(sql`
      SELECT pr.id, p.guild_id, p.domain, p.enabled,
             pr.subject, pr.subject_id, pr.rule_scope, pr.effect, pr.priority
        FROM policy_rules pr
        JOIN policies p ON p.id = pr.policy_id
       WHERE p.guild_id = ${guildId}
         AND p.enabled = true
       ORDER BY pr.priority DESC, pr.id
    `);

    const rules: PolicyRule[] = [];
    for (const row of rows) {
      // An unrecognized domain in the database is a corrupt row, not a licence
      // to guess. Skipping it is safer than silently widening its reach.
      if (!isPolicyDomain(row.domain)) {
        log.warn({ domain: row.domain, ruleId: row.id }, 'skipping policy rule with unknown domain');
        continue;
      }
      rules.push({
        id: row.id,
        guildId: String(row.guild_id),
        domain: row.domain,
        subject: row.subject,
        subjectId: row.subject_id,
        ruleScope: row.rule_scope,
        effect: row.effect,
        priority: row.priority,
      });
    }
    return rules;
  }

  async function rules(guildId: string): Promise<readonly PolicyRule[]> {
    const hit = cache.get(guildId);
    if (hit && hit.expiresAt > Date.now()) return hit.rules;

    const inFlight = pending.get(guildId);
    if (inFlight) return inFlight;

    const task = load(guildId)
      .then((loaded) => {
        cache.set(guildId, { expiresAt: Date.now() + ttlMs, rules: loaded });
        return loaded;
      })
      .finally(() => {
        pending.delete(guildId);
      });

    pending.set(guildId, task);
    return task;
  }

  return {
    listRules: rules,

    async createRule(guildId, input) {
      const inserted = await db
        .insert(policyRules)
        .values({
          policyId: input.policyId,
          subject: input.subject,
          subjectId: input.subjectId,
          ruleScope: input.ruleScope ?? null,
          effect: input.effect ?? 'SKIP',
          priority: input.priority ?? 0,
        })
        .returning();

      const row = inserted[0];
      if (!row) throw new Error('Policy rule insert returned no row.');

      cache.delete(guildId);
      return {
        id: row.id,
        guildId,
        domain: 'GLOBAL',
        subject: row.subject,
        subjectId: row.subjectId,
        ruleScope: row.ruleScope,
        effect: row.effect,
        priority: row.priority,
      };
    },

    async setPolicyEnabled(guildId, policyId, enabled) {
      // Scoped to the guild so a policy id from another guild cannot be
      // toggled through this repository.
      const updated = await db
        .update(policies)
        .set({ enabled })
        .where(and(eq(policies.id, policyId), eq(policies.guildId, Number(guildId))))
        .returning({ id: policies.id });
      if (updated.length === 0) throw new Error('Policy not found for this guild.');
      cache.delete(guildId);
    },

    async deleteRule(guildId, ruleId) {
      const deleted = await db
        .delete(policyRules)
        .where(
          and(
            eq(policyRules.id, ruleId),
            inArray(
              policyRules.policyId,
              db.select({ id: policies.id }).from(policies).where(eq(policies.guildId, Number(guildId))),
            ),
          ),
        )
        .returning({ id: policyRules.id });
      cache.delete(guildId);
      return deleted.length > 0;
    },

    invalidate(guildId) {
      cache.delete(guildId);
    },

    cacheStats() {
      let count = 0;
      for (const entry of cache.values()) count += entry.rules.length;
      return { guilds: cache.size, rules: count };
    },
  };
}