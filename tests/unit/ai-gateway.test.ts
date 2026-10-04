/**
 * AI gateway invariants (v13 §2).
 *
 * The $0-budget rules, made testable:
 *  - the bot runs with NO key (optional, never a hard dependency)
 *  - every failure path degrades to ALLOW, never to an outage
 *  - the circuit breaker opens, holds, and recovers
 *  - NO quota is hard-coded anywhere
 */

import { describe, expect, it, vi } from 'vitest';
import {
  AiGateway,
  CircuitBreaker,
  DEFAULT_CIRCUIT,
  parseVerdict,
  type UsageCounter,
} from '../../src/features/ai/gateway.js';

function gateway(overrides: Partial<ConstructorParameters<typeof AiGateway>[0]> = {}) {
  return new AiGateway({
    generate: async () => 'ALLOW: true\nCONFIDENCE: 0.9\nREASON: looks fine',
    model: 'gemini-2.5-flash',
    maxOutputTokens: 1000,
    ...overrides,
  });
}

describe('AI is strictly optional', () => {
  it('reports unavailable with no generate function', () => {
    const ai = new AiGateway({ model: 'gemini-2.5-flash', maxOutputTokens: 1000 });
    expect(ai.available).toBe(false);
  });

  it('skips cleanly with no key instead of throwing', async () => {
    const ai = new AiGateway({ model: 'gemini-2.5-flash', maxOutputTokens: 1000 });
    const result = await ai.evaluate({ guildId: '1', prompt: 'is this ok?', needed: true });
    // A missing key must never become a runtime failure.
    expect(result).toEqual({
      kind: 'SKIPPED',
      reason: 'NO_API_KEY',
      message: 'AI features are not configured on this server.',
    });
  });

  it('skips when the guild has AI disabled', async () => {
    const ai = gateway({ isGuildEnabled: async () => false });
    const result = await ai.evaluate({ guildId: '1', prompt: 'x', needed: true });
    expect(result.kind === 'SKIPPED' && result.reason).toBe('DISABLED_FOR_GUILD');
  });

  it('does not call the model when it is not determinative', async () => {
    const generate = vi.fn(async () => 'ALLOW: true');
    const ai = gateway({ generate });
    const result = await ai.evaluate({ guildId: '1', prompt: 'x', needed: false });
    expect(generate).not.toHaveBeenCalled();
    expect(result.kind === 'SKIPPED' && result.reason).toBe('NOT_DETERMINATIVE');
  });
});

describe('every failure degrades to allow', () => {
  it('allows when the provider throws', async () => {
    const ai = gateway({
      generate: async () => {
        throw new Error('provider down');
      },
    });
    const result = await ai.evaluate({ guildId: '1', prompt: 'x', needed: true });
    expect(result.kind).toBe('VERDICT');
    if (result.kind === 'VERDICT') {
      // Failing open keeps the deterministic rules in charge.
      expect(result.verdict.allow).toBe(true);
      expect(result.verdict.skipped).toBe(true);
    }
  });

  it('allows when the model answers in an unusable shape', async () => {
    const ai = gateway({ generate: async () => 'I think it is probably fine actually' });
    const result = await ai.evaluate({ guildId: '1', prompt: 'x', needed: true });
    expect(result.kind === 'VERDICT' && result.verdict.allow).toBe(true);
  });

  it('never throws out of evaluate', async () => {
    const ai = gateway({
      generate: async () => {
        throw new Error('boom');
      },
    });
    await expect(ai.evaluate({ guildId: '1', prompt: 'x', needed: true })).resolves.toBeDefined();
  });
});

describe('verdict parsing', () => {
  it('reads allow, confidence, and reason', () => {
    const verdict = parseVerdict('ALLOW: false\nCONFIDENCE: 0.75\nREASON: targeted harassment');
    expect(verdict).toEqual({
      allow: false,
      confidence: 0.75,
      reason: 'targeted harassment',
      skipped: false,
    });
  });

  it('tolerates alternative separators and casing', () => {
    expect(parseVerdict('allow=true')?.allow).toBe(true);
    expect(parseVerdict('ALLOW = FALSE')?.allow).toBe(false);
  });

  it('clamps an out-of-range confidence', () => {
    expect(parseVerdict('ALLOW: true\nCONFIDENCE: 5')?.confidence).toBe(1);
    expect(parseVerdict('ALLOW: true\nCONFIDENCE: 0.4')?.confidence).toBe(0.4);
  });

  it('falls back to a neutral confidence for malformed numbers', () => {
    // A negative value is nonsense input, not a real 0. Neutral is the safe
    // default: the verdict still stands, but it carries no extra weight.
    expect(parseVerdict('ALLOW: true\nCONFIDENCE: -3')?.confidence).toBe(0.5);
  });

  it('returns null for an unparseable answer', () => {
    expect(parseVerdict('no idea')).toBeNull();
    expect(parseVerdict('')).toBeNull();
  });
});

describe('the circuit breaker protects the bot', () => {
  it('starts closed', () => {
    expect(new CircuitBreaker().current).toBe('CLOSED');
  });

  it('opens after the configured failure threshold', () => {
    const breaker = new CircuitBreaker({ ...DEFAULT_CIRCUIT, failureThreshold: 3 });
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.current).toBe('CLOSED');
    breaker.recordFailure();
    expect(breaker.current).toBe('OPEN');
  });

  it('refuses calls while open, then admits a probe after the cooldown', () => {
    const breaker = new CircuitBreaker({ ...DEFAULT_CIRCUIT, failureThreshold: 1, cooldownMs: 1000 });
    breaker.recordFailure();
    expect(breaker.current).toBe('OPEN');
    expect(breaker.canAttempt(Date.now())).toBe(false);
    // After the cooldown, a probe is admitted.
    expect(breaker.canAttempt(Date.now() + 1500)).toBe(true);
  });

  it('half-opens on a guard call after the cooldown', () => {
    const breaker = new CircuitBreaker({ ...DEFAULT_CIRCUIT, failureThreshold: 1, cooldownMs: 1000 });
    breaker.recordFailure();
    void breaker.guard(async () => 'ok', Date.now() + 1500);
    expect(breaker.current).toBe('HALF_OPEN');
  });

  it('closes again after enough successful probes', async () => {
    const breaker = new CircuitBreaker({
      ...DEFAULT_CIRCUIT,
      failureThreshold: 1,
      cooldownMs: 0,
      successThreshold: 2,
    });
    breaker.recordFailure();
    expect(breaker.current).toBe('OPEN');

    // The probe only happens once the cooldown has elapsed, which is what
    // moves the breaker to HALF_OPEN.
    await breaker.guard(async () => 'ok');
    expect(breaker.current).toBe('HALF_OPEN');
    await breaker.guard(async () => 'ok');
    expect(breaker.current).toBe('CLOSED');
  });

  it('reopens immediately when a probe fails', async () => {
    const breaker = new CircuitBreaker({ ...DEFAULT_CIRCUIT, failureThreshold: 1, cooldownMs: 0 });
    breaker.recordFailure();
    expect(breaker.current).toBe('OPEN');

    await expect(
      breaker.guard(async () => {
        throw new Error('still down');
      }),
    ).rejects.toThrow();
    // A failed probe must not be treated as recovery.
    expect(breaker.current).toBe('OPEN');
  });

  it('resets the failure count on a success', () => {
    const breaker = new CircuitBreaker({ ...DEFAULT_CIRCUIT, failureThreshold: 3 });
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.current).toBe('CLOSED');
  });

  it('stops calling the provider once the breaker is open', async () => {
    const generate = vi.fn(async () => {
      throw new Error('down');
    });
    const ai = gateway({ generate, breaker: new CircuitBreaker({ ...DEFAULT_CIRCUIT, failureThreshold: 2 }) });

    await ai.evaluate({ guildId: '1', prompt: 'x', needed: true });
    await ai.evaluate({ guildId: '1', prompt: 'x', needed: true });
    const callsAfterOpen = generate.mock.calls.length;

    await ai.evaluate({ guildId: '1', prompt: 'x', needed: true });
    // Hammering a struggling provider is exactly what the breaker prevents.
    expect(generate.mock.calls.length).toBe(callsAfterOpen);
  });
});

describe('no quota is hard-coded', () => {
  it('has no request-rate or daily numbers baked into the config', () => {
    const serialized = JSON.stringify(DEFAULT_CIRCUIT);
    // Circuit timing is OUR choice; provider quotas must never be assumed.
    expect(serialized).not.toMatch(/requestsPer|rpm|dailyLimit|quota/i);
  });

  it('skips when the guild reaches its own configured daily limit', async () => {
    const usage: UsageCounter = {
      used: async () => 100,
      increment: async () => {},
    };
    const ai = gateway({ usage, guildDailyLimit: async () => 100 });
    const result = await ai.evaluate({ guildId: '1', prompt: 'x', needed: true });
    expect(result.kind === 'SKIPPED' && result.reason).toBe('DAILY_LIMIT_REACHED');
  });

  it('proceeds when the guild set no limit', async () => {
    const usage: UsageCounter = { used: async () => 9_999, increment: async () => {} };
    const ai = gateway({ usage, guildDailyLimit: async () => null });
    const result = await ai.evaluate({ guildId: '1', prompt: 'x', needed: true });
    expect(result.kind).toBe('VERDICT');
  });

  it('counts usage only after a successful call', async () => {
    const increment = vi.fn(async () => {});
    const usage: UsageCounter = { used: async () => 0, increment };
    const ai = gateway({
      usage,
      guildDailyLimit: async () => 50,
      generate: async () => {
        throw new Error('down');
      },
    });
    await ai.evaluate({ guildId: '1', prompt: 'x', needed: true });
    // A call that never succeeded must not consume the guild's budget.
    expect(increment).not.toHaveBeenCalled();
  });
});
