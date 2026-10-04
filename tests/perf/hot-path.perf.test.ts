/**
 * Hot-path performance budgets.
 *
 * These functions run on EVERY message, so their cost is multiplied by a
 * server's entire message volume. The budgets are deliberately generous
 * relative to typical hardware — they exist to catch an accidental O(n²) or a
 * missing cache, not to micro-optimize.
 *
 * Run with `npm run perf`; they are excluded from `npm test` by directory.
 */

import { describe, expect, it } from 'vitest';
import { parsePrefixCommand, tokenize } from '../../src/core/registry/prefix-parser.js';
import {
  guildSubject,
  resolveAcrossDomains,
  type PolicyRule,
} from '../../src/core/policies/exclusions/resolver.js';
import {
  clampXp,
  deriveProgression,
  levelFromSeasonXp,
  DEFAULT_CURVE,
} from '../../src/features/leveling/level-curve.js';
import {
  evaluateTermRules,
  normalizeForMatching,
  stripCodeBlocks,
} from '../../src/features/automod/detectors.js';
import { GuildRateLimiter } from '../../src/core/ratelimit/guild-limiter.js';

/** Median-ish: average over enough iterations to smooth scheduler noise. */
function measureMs(iterations: number, fn: (i: number) => void): number {
  const start = performance.now();
  for (let i = 0; i < iterations; i += 1) fn(i);
  return (performance.now() - start) / iterations;
}

const BUDGET = {
  tokenize: 0.05,
  parse: 0.2,
  policy: 0.05,
  levelCurve: 0.005,
  normalize: 0.02,
  detect: 0.2,
  rateLimit: 0.002,
} as const;

describe('prefix parsing hot path', () => {
  const message = '$ban user 123456789 spamming in #general for 10 minutes please stop';

  it(`tokenizes under ${BUDGET.tokenize}ms`, () => {
    const ms = measureMs(20_000, () => tokenize(message));
    expect(ms).toBeLessThan(BUDGET.tokenize);
  });

  it(`parses a command under ${BUDGET.parse}ms`, () => {
    const ms = measureMs(10_000, () => parsePrefixCommand(message, '$'));
    expect(ms).toBeLessThan(BUDGET.parse);
  });

  it(`parses a message with no prefix quickly`, () => {
    const plain = 'just a normal chat message with no command at all';
    const ms = measureMs(20_000, () => parsePrefixCommand(plain, '$'));
    expect(ms).toBeLessThan(BUDGET.parse);
  });
});

describe('policy resolution hot path', () => {
  const rules: PolicyRule[] = Array.from({ length: 200 }, (_, i) => ({
    id: `rule-${i}`,
    guildId: '1',
    domain: 'GLOBAL' as const,
    subject: 'ROLE' as const,
    subjectId: `role-${i}`,
    ruleScope: i % 3 === 0 ? `scope-${i}` : null,
    effect: 'SKIP' as const,
    priority: i,
  }));
  const subject = guildSubject('1', 'user', { roleIds: ['role-7', 'role-150'] });

  it(`resolves against 200 rules under ${BUDGET.policy}ms`, () => {
    const ms = measureMs(5_000, () =>
      resolveAcrossDomains(rules, subject, ['AUTOMOD', 'ECONOMY'], null),
    );
    expect(ms).toBeLessThan(BUDGET.policy);
  });

  it('scales roughly linearly, not quadratically', () => {
    const small = rules.slice(0, 50);
    const large = rules.slice(0, 200);

    const smallMs = measureMs(3_000, () =>
      resolveAcrossDomains(small, subject, ['AUTOMOD'], null),
    );
    const largeMs = measureMs(3_000, () =>
      resolveAcrossDomains(large, subject, ['AUTOMOD'], null),
    );

    // 4x the rules must not cost anything close to 16x the time.
    expect(largeMs).toBeLessThan(Math.max(smallMs * 8, BUDGET.policy));
  });
});

describe('level curve hot path', () => {
  it(`derives progression under ${BUDGET.levelCurve}ms`, () => {
    const ms = measureMs(100_000, (i) => deriveProgression(i * 37, DEFAULT_CURVE));
    expect(ms).toBeLessThan(BUDGET.levelCurve);
  });

  it(`resolves a level from a large xp total under ${BUDGET.levelCurve}ms`, () => {
    const ms = measureMs(100_000, (i) => levelFromSeasonXp(10_000_000 + i, DEFAULT_CURVE));
    expect(ms).toBeLessThan(BUDGET.levelCurve);
  });

  it('clamps in constant time', () => {
    const ms = measureMs(200_000, () => clampXp(25, 25));
    expect(ms).toBeLessThan(BUDGET.levelCurve);
  });
});

describe('automod detection hot path', () => {
  const content =
    'hey everyone, here is the log line I was talking about ``` const ass = require("ass") ``` ' +
    'and also this is a fairly typical message with some ordinary words in it, nothing special';

  it(`normalizes under ${BUDGET.normalize}ms`, () => {
    const ms = measureMs(20_000, () => normalizeForMatching(content));
    expect(ms).toBeLessThan(BUDGET.normalize);
  });

  it(`strips code blocks under ${BUDGET.normalize}ms`, () => {
    const ms = measureMs(20_000, () => stripCodeBlocks(content));
    expect(ms).toBeLessThan(BUDGET.normalize);
  });

  it(`runs the rule set under ${BUDGET.detect}ms`, () => {
    const ruleSet = [
      { ruleKey: 'a', terms: ['ass', 'damn', 'shit'], confidence: 'HIGH' as const },
      { ruleKey: 'b', terms: ['free', 'nitro', 'steam'], confidence: 'MEDIUM' as const },
      { ruleKey: 'c', terms: ['badword', 'other'], confidence: 'LOW' as const },
    ];
    const ms = measureMs(5_000, () => evaluateTermRules(content, ruleSet));
    expect(ms).toBeLessThan(BUDGET.detect);
  });
});

describe('rate limiter hot path', () => {
  const bucket = { capacity: 100, refillRate: 10, intervalMs: 1_000 } as const;

  it(`consumes a token under ${BUDGET.rateLimit}ms`, () => {
    const limiter = new GuildRateLimiter(bucket);
    const ms = measureMs(50_000, () => limiter.tryConsume('1', 'global', bucket));
    expect(ms).toBeLessThan(BUDGET.rateLimit);
  });

  it('keeps per-guild state independent', () => {
    const limiter = new GuildRateLimiter(bucket);
    const ms = measureMs(1_000, (i) => limiter.tryConsume(`guild-${i % 50}`, 'global', bucket));
    // 50 distinct guilds must not degrade into a shared-state bottleneck.
    expect(ms).toBeLessThan(BUDGET.rateLimit * 10);
  });
});
