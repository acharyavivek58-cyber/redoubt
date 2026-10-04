/**
 * Centralized policies, rate limiting, and cooldowns (v13 §7.2, §14).
 *
 * Properties under test:
 *  - ONE exemption suppresses the action in EVERY subsystem at once
 *  - deny-overrides-allow, deterministically
 *  - exemptions are scope-SPECIFIC, not blanket
 *  - guild isolation: one guild's limiter never throttles another's
 *  - cooldowns never block staff or cleanup operations
 */

import { describe, expect, it } from 'vitest';
import {
  guildSubject,
  resolveAcrossDomains,
  resolvePolicy,
  type PolicyRule,
} from '../../src/core/policies/exclusions/resolver.js';
import {
  CooldownManager,
  GuildRateLimiter,
  formatDuration,
} from '../../src/core/ratelimit/guild-limiter.js';

function rule(overrides: Partial<PolicyRule> & Pick<PolicyRule, 'id'>): PolicyRule {
  return {
    guildId: '1',
    domain: 'AUTOMOD',
    subject: 'ROLE',
    subjectId: 'r1',
    ruleScope: null,
    effect: 'SKIP',
    priority: 0,
    ...overrides,
  };
}

describe('policy resolution (v13 §7.2)', () => {
  it('returns ALLOW when no rules exist', () => {
    const subject = guildSubject('1', 'u1', { roleIds: ['r1'] });
    expect(resolvePolicy([], subject, { domain: 'AUTOMOD' })).toEqual({
      exempt: false,
      quiet: false,
    });
  });

  it('skips a matching role', () => {
    const subject = guildSubject('1', 'u1', { roleIds: ['r1'] });
    const decision = resolvePolicy([rule({ id: 'p1' })], subject, { domain: 'AUTOMOD' });
    expect(decision.exempt).toBe(true);
    expect(decision.matchedRuleId).toBe('p1');
  });

  it('does not skip a non-matching role', () => {
    const subject = guildSubject('1', 'u1', { roleIds: ['other'] });
    expect(resolvePolicy([rule({ id: 'p1' })], subject, { domain: 'AUTOMOD' }).exempt).toBe(false);
  });

  it('never matches rules from another guild', () => {
    // Guild isolation: Guild 2's rule must not exempt a Guild 1 subject.
    const subject = guildSubject('1', 'u1', { roleIds: ['r1'] });
    const decision = resolvePolicy([rule({ id: 'p2', guildId: '2' })], subject, {
      domain: 'AUTOMOD',
    });
    expect(decision.exempt).toBe(false);
  });

  it('DENY (SKIP) overrides a higher-priority ALLOW', () => {
    const subject = guildSubject('1', 'u1', { roleIds: ['r1'] });
    const rules = [
      rule({ id: 'allow', domain: 'GLOBAL', effect: 'ALLOW', priority: 100 }),
      rule({ id: 'deny', domain: 'GLOBAL', effect: 'SKIP', priority: 0 }),
    ];
    const decision = resolvePolicy(rules, subject, { domain: 'AUTOMOD' });
    expect(decision.exempt).toBe(true);
    expect(decision.matchedRuleId).toBe('deny');
  });

  it('honours QUIET as an exemption that suppresses notices', () => {
    const subject = guildSubject('1', 'u1', { roleIds: ['r1'] });
    const decision = resolvePolicy([rule({ id: 'q', effect: 'QUIET' })], subject, {
      domain: 'AUTOMOD',
    });
    expect(decision.exempt).toBe(true);
    expect(decision.quiet).toBe(true);
  });

  it('is deterministic for multiple allows regardless of input order', () => {
    const subject = guildSubject('1', 'u1', { roleIds: ['r1'] });
    const rules = [
      rule({ id: 'low', domain: 'GLOBAL', effect: 'ALLOW', priority: 1 }),
      rule({ id: 'high', domain: 'GLOBAL', effect: 'ALLOW', priority: 99 }),
    ];
    expect(resolvePolicy(rules, subject, { domain: 'AUTOMOD' }).matchedRuleId).toBe('high');
    expect(resolvePolicy([...rules].reverse(), subject, { domain: 'AUTOMOD' }).matchedRuleId).toBe(
      'high',
    );
  });

  it('scopes an exemption to one rule when a scope is set', () => {
    const subject = guildSubject('1', 'u1', { roleIds: ['r1'] });
    const scoped = [rule({ id: 'scoped', ruleScope: 'caps' })];

    expect(resolvePolicy(scoped, subject, { domain: 'AUTOMOD', ruleScope: 'caps' }).exempt).toBe(
      true,
    );
    // A different rule must NOT inherit the exemption (v14 §R.9).
    expect(resolvePolicy(scoped, subject, { domain: 'AUTOMOD', ruleScope: 'links' }).exempt).toBe(
      false,
    );
  });

  it('matches by user, channel, and category', () => {
    const subject = guildSubject('1', 'u1', { roleIds: [], channelId: 'c1', categoryId: 'cat1' });
    expect(
      resolvePolicy([rule({ id: 'a', subject: 'USER', subjectId: 'u1' })], subject, {
        domain: 'AUTOMOD',
      }).exempt,
    ).toBe(true);
    expect(
      resolvePolicy([rule({ id: 'b', subject: 'CHANNEL', subjectId: 'c1' })], subject, {
        domain: 'AUTOMOD',
      }).exempt,
    ).toBe(true);
    expect(
      resolvePolicy([rule({ id: 'c', subject: 'CATEGORY', subjectId: 'cat1' })], subject, {
        domain: 'AUTOMOD',
      }).exempt,
    ).toBe(true);
  });

  it('does not blanket-exempt unless the scope is null', () => {
    const subject = guildSubject('1', 'u1', { roleIds: ['r1'] });
    const blanket = [rule({ id: 'blanket', domain: 'GLOBAL', ruleScope: null })];
    const specific = [rule({ id: 'specific', domain: 'GLOBAL', ruleScope: 'caps' })];

    // Blanket suppresses in every domain...
    expect(resolvePolicy(blanket, subject, { domain: 'LEVELING' }).exempt).toBe(true);
    expect(resolvePolicy(blanket, subject, { domain: 'ECONOMY' }).exempt).toBe(true);
    expect(resolvePolicy(blanket, subject, { domain: 'AUTOMOD' }).exempt).toBe(true);

    // ...while a scoped exemption only suppresses ITS OWN rule, even across
    // domains: it never satisfies an unscoped query, and never a sibling scope.
    expect(resolvePolicy(specific, subject, { domain: 'LEVELING' }).exempt).toBe(false);
    expect(resolvePolicy(specific, subject, { domain: 'LEVELING', ruleScope: 'links' }).exempt).toBe(
      false,
    );
    // The same scope does apply in its own right, in any domain.
    expect(resolvePolicy(specific, subject, { domain: 'AUTOMOD', ruleScope: 'caps' }).exempt).toBe(
      true,
    );
  });
});

describe('one exemption suppresses across every subsystem', () => {
  it('applies a single GLOBAL role exemption to automod, leveling, invites, logging, and economy', () => {
    // A GLOBAL rule is what makes one trusted role suppress every subsystem.
    const global = [rule({ id: 'trusted-all', domain: 'GLOBAL', subjectId: 'trusted-role' })];
    const subject = guildSubject('1', 'u1', { roleIds: ['trusted-role'] });

    const decisions = resolveAcrossDomains(global, subject, [
      'AUTOMOD',
      'LEVELING',
      'INVITES',
      'LOGGING',
      'ECONOMY',
    ]);

    for (const domain of ['AUTOMOD', 'LEVELING', 'INVITES', 'LOGGING', 'ECONOMY'] as const) {
      expect(decisions[domain].exempt, `${domain} should be exempt`).toBe(true);
    }
  });

  it('keeps a domain-scoped rule from leaking into other subsystems', () => {
    // An AUTOMOD-only exemption must NOT suppress leveling or economy.
    const automodOnly = [rule({ id: 'am', domain: 'AUTOMOD', subjectId: 'trusted-role' })];
    const subject = guildSubject('1', 'u1', { roleIds: ['trusted-role'] });

    const decisions = resolveAcrossDomains(automodOnly, subject, [
      'AUTOMOD',
      'LEVELING',
      'ECONOMY',
    ]);

    expect(decisions.AUTOMOD.exempt).toBe(true);
    expect(decisions.LEVELING.exempt).toBe(false);
    expect(decisions.ECONOMY.exempt).toBe(false);
  });

  it('does not exempt a member without the role', () => {
    const subject = guildSubject('1', 'u1', { roleIds: ['member'] });
    const decisions = resolveAcrossDomains(
      [rule({ id: 'trusted-all', domain: 'GLOBAL', subjectId: 'trusted-role' })],
      subject,
      ['AUTOMOD', 'LEVELING', 'ECONOMY'],
    );
    for (const decision of Object.values(decisions)) expect(decision.exempt).toBe(false);
  });
});

describe('guild-aware rate limiting (v13 §14)', () => {
  it('limits within a guild', () => {
    const limiter = new GuildRateLimiter({ refillRate: 1, capacity: 3, intervalMs: 60_000 });
    expect(limiter.tryConsume('1', 'cmd')).toBe(true);
    expect(limiter.tryConsume('1', 'cmd')).toBe(true);
    expect(limiter.tryConsume('1', 'cmd')).toBe(true);
    expect(limiter.tryConsume('1', 'cmd')).toBe(false);
  });

  it('does NOT let one guild starve another', () => {
    // The property v13 §14 calls out explicitly.
    const limiter = new GuildRateLimiter({ refillRate: 1, capacity: 2, intervalMs: 60_000 });
    expect(limiter.tryConsume('1', 'cmd')).toBe(true);
    expect(limiter.tryConsume('1', 'cmd')).toBe(true);
    expect(limiter.tryConsume('1', 'cmd')).toBe(false);

    // Guild 2 is entirely unaffected.
    expect(limiter.tryConsume('2', 'cmd')).toBe(true);
    expect(limiter.tryConsume('2', 'cmd')).toBe(true);
    expect(limiter.tryConsume('2', 'cmd')).toBe(false);
  });

  it('keeps separate buckets per scope within a guild', () => {
    const limiter = new GuildRateLimiter({ refillRate: 1, capacity: 1, intervalMs: 60_000 });
    expect(limiter.tryConsume('1', 'balance')).toBe(true);
    expect(limiter.tryConsume('1', 'balance')).toBe(false);
    expect(limiter.tryConsume('1', 'shop')).toBe(true);
  });

  it('refills over time', async () => {
    const limiter = new GuildRateLimiter({ refillRate: 10, capacity: 2, intervalMs: 50 });
    expect(limiter.tryConsume('1', 'cmd')).toBe(true);
    expect(limiter.tryConsume('1', 'cmd')).toBe(true);
    expect(limiter.tryConsume('1', 'cmd')).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(limiter.tryConsume('1', 'cmd')).toBe(true);
  });

  it('reports remaining tokens and retry-after', () => {
    const limiter = new GuildRateLimiter({ refillRate: 1, capacity: 2, intervalMs: 1000 });
    expect(limiter.remaining('1', 'fresh')).toBe(2);
    limiter.tryConsume('1', 'x');
    limiter.tryConsume('1', 'x');
    expect(limiter.remaining('1', 'x')).toBe(0);
    expect(limiter.retryAfterMs('1', 'x')).toBeGreaterThan(0);
  });

  it('clears only the requested guild', () => {
    const limiter = new GuildRateLimiter({ refillRate: 1, capacity: 1, intervalMs: 60_000 });
    limiter.tryConsume('1', 'cmd');
    limiter.tryConsume('2', 'cmd');
    limiter.clear('1');
    expect(limiter.tryConsume('1', 'cmd')).toBe(true);
    expect(limiter.tryConsume('2', 'cmd')).toBe(false);
  });
});

describe('cooldowns are separate from rate limits (v14 §R.22.9)', () => {
  it('gates a repeated action', () => {
    const cd = new CooldownManager();
    expect(cd.tryUse('1:u1:daily', 60_000)).toBe(true);
    expect(cd.tryUse('1:u1:daily', 60_000)).toBe(false);
  });

  it('checks without consuming, for staff paths', () => {
    // v13 §18: staff operations must not be blocked by the user's cooldown.
    const cd = new CooldownManager();
    cd.tryUse('1:u1:daily', 60_000);
    expect(cd.isOnCooldown('1:u1:daily', 60_000)).toBe(true);
    // Reading did not reset the window.
    expect(cd.isOnCooldown('1:u1:daily', 60_000)).toBe(true);
  });

  it('can be cleared explicitly for cleanup', () => {
    const cd = new CooldownManager();
    cd.tryUse('1:u1:daily', 60_000);
    cd.clear('1:u1:daily');
    expect(cd.tryUse('1:u1:daily', 60_000)).toBe(true);
  });

  it('keeps cooldowns isolated per guild', () => {
    const cd = new CooldownManager();
    expect(cd.tryUse('1:u1:daily', 60_000)).toBe(true);
    expect(cd.tryUse('2:u1:daily', 60_000)).toBe(true);
  });

  it('expires after the window', () => {
    const cd = new CooldownManager();
    const t0 = 1_000_000;
    expect(cd.tryUse('k', 1000, t0)).toBe(true);
    expect(cd.tryUse('k', 1000, t0 + 500)).toBe(false);
    expect(cd.tryUse('k', 1000, t0 + 1500)).toBe(true);
  });
});

describe('duration formatting', () => {
  it('formats human-readable durations', () => {
    expect(formatDuration(5_000)).toBe('5s');
    expect(formatDuration(120_000)).toBe('2m');
    expect(formatDuration(7_200_000)).toBe('2h');
    expect(formatDuration(172_800_000)).toBe('2d');
  });
});