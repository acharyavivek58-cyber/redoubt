/**
 * Centralized exclusion/policy engine (v13 §7.2).
 *
 * A SINGLE source of truth consulted by automod, anti-spam, leveling, invites,
 * logging, and economy — rather than each feature reimplementing exemption
 * logic and drifting apart.
 *
 * Ordering is DENY-OVERRIDES-ALLOW: any matching DENY/SKIP wins regardless of
 * an ALLOW elsewhere, so a guild can always tighten access.
 */

export type PolicySubjectType = 'USER' | 'ROLE' | 'CHANNEL' | 'CATEGORY';
export type PolicyEffect = 'SKIP' | 'QUIET' | 'ALLOW';
export type PolicyDomain =
  | 'GLOBAL'
  | 'AUTOMOD'
  | 'LEVELING'
  | 'INVITES'
  | 'LOGGING'
  | 'ECONOMY'
  | 'TICKETS'
  | 'WELCOME';

export interface PolicyRule {
  readonly id: string;
  readonly guildId: string;
  readonly domain: PolicyDomain;
  readonly subject: PolicySubjectType;
  readonly subjectId: string;
  /** Null = applies to every rule in the domain. */
  readonly ruleScope?: string | null;
  readonly effect: PolicyEffect;
  readonly priority: number;
}

export interface PolicySubject {
  readonly userId: string;
  /** Role ids the subject holds. */
  readonly roleIds: readonly string[];
  readonly channelId?: string;
  readonly categoryId?: string;
}

export interface PolicyDecision {
  /** True when the subject is exempt from this check. */
  readonly exempt: boolean;
  /** True when the action proceeds but silently (no notice). */
  readonly quiet: boolean;
  readonly matchedRuleId?: string;
  readonly reason?: string;
}

const ALLOW: PolicyDecision = { exempt: false, quiet: false };

/**
 * Resolves whether a subject is exempt within a domain.
 *
 * Matching precedence: higher priority first, then DENY/SKIP over ALLOW at any
 * priority so an explicit exemption can never be silently overridden by a
 * blanket allow.
 */
export function resolvePolicy(
  rules: readonly PolicyRule[],
  subject: PolicySubject,
  query: { domain: PolicyDomain; ruleScope?: string | null },
): PolicyDecision {
  const candidates = rules
    .filter((rule) => rule.guildId === subjectGuild(subject))
    // A rule applies to its OWN domain, or — when it carries no domain
    // constraint of its own — to every domain. Without this, a single trusted
    // role could never suppress both AutoMod and Leveling, which is exactly
    // the cross-subsystem exemption the plan requires.
    .filter((rule) => rule.domain === query.domain || rule.domain === 'GLOBAL')
    .filter((rule) => matchesSubject(rule, subject))
    .filter((rule) => matchesScope(rule, query.ruleScope ?? null));

  if (candidates.length === 0) return ALLOW;

  // Deny/SKIP always wins, even against a higher-priority ALLOW.
  const deny = candidates.find((rule) => rule.effect === 'SKIP');
  if (deny) {
    return {
      exempt: true,
      quiet: false,
      matchedRuleId: deny.id,
      reason: `policy ${deny.id} skips ${deny.subject}:${deny.subjectId}`,
    };
  }

  // Among allows, the quietest/highest-priority one governs.
  const allow = [...candidates].sort((a, b) => b.priority - a.priority)[0];
  if (allow) {
    return {
      exempt: true,
      quiet: allow.effect === 'QUIET',
      matchedRuleId: allow.id,
      reason: `policy ${allow.id} allows ${allow.subject}:${allow.subjectId}`,
    };
  }

  return ALLOW;
}

/** A rule with no SKIP/ALLOW effect yet still silences the subsystem. */
function matchesSubject(rule: PolicyRule, subject: PolicySubject): boolean {
  switch (rule.subject) {
    case 'USER':
      return rule.subjectId === subject.userId;
    case 'ROLE':
      return subject.roleIds.includes(rule.subjectId);
    case 'CHANNEL':
      return subject.channelId !== undefined && rule.subjectId === subject.channelId;
    case 'CATEGORY':
      return subject.categoryId !== undefined && rule.subjectId === subject.categoryId;
    default:
      return false;
  }
}

/**
 * A null scope matches anything; a concrete scope matches only itself.
 *
 * This is what lets a per-rule exemption stay SPECIFIC rather than
 * blanket-exempting a role from every check (v14 §R.9).
 */
function matchesScope(rule: PolicyRule, queryScope: string | null): boolean {
  const ruleScope = rule.ruleScope ?? null;
  if (ruleScope === null) return true;
  if (queryScope === null) return false;
  return ruleScope === queryScope;
}

/**
 * Rules are always guild-scoped. The subject carries its own guild so a caller
 * cannot evaluate another guild's rules against it.
 */
function subjectGuild(subject: PolicySubject): string {
  return (subject as PolicySubject & { guildId?: string }).guildId ?? '';
}

/** Guild-scoped subject. */
export function guildSubject(
  guildId: string,
  userId: string,
  extras: { roleIds?: readonly string[]; channelId?: string; categoryId?: string } = {},
): PolicySubject & { guildId: string } {
  return {
    guildId,
    userId,
    roleIds: extras.roleIds ?? [],
    channelId: extras.channelId,
    categoryId: extras.categoryId,
  };
}

/**
 * Evaluates across several domains at once.
 *
 * Used by the anti-farm and cross-subsystem tests to prove one exemption
 * suppresses the action in every subsystem simultaneously.
 */
export function resolveAcrossDomains(
  rules: readonly PolicyRule[],
  subject: PolicySubject & { guildId: string },
  domains: readonly PolicyDomain[],
  ruleScope?: string | null,
): Record<PolicyDomain, PolicyDecision> {
  const result = {} as Record<PolicyDomain, PolicyDecision>;
  for (const domain of domains) {
    result[domain] = resolvePolicy(rules, subject, { domain, ruleScope });
  }
  return result;
}