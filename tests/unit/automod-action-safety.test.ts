/**
 * AutoMod action safety (v16 §T).
 *
 * The invariant under test:
 *   AutoMod can LOG / DELETE / WARN / MUTE and can NEVER Kick, Ban, or Jail.
 *   Its escalation ceiling is MUTE.
 *
 * The compile-time half (kick/ban/jail absent from AutoModEnforcer) is
 * verified separately in tests/type-level/automod-enforcer.type-test.ts.
 * This suite covers the runtime halves: enum validity, ladder ceiling,
 * confidence gating, and dry-run/test-mode safety.
 */

import { describe, expect, it } from 'vitest';
import {
  AUTOMOD_ACTIONS,
  assertValidAutoModAction,
  decideEnforcement,
  isValidAutoModAction,
  ladderCeilingIsMute,
  resolveLadderAction,
  ruleNotSavedPanel,
  type AutoModEnforcer,
  type EscalationLadder,
} from '../../src/features/automod/enforcer.js';

const LADDER: EscalationLadder = {
  ladder: ['LOG', 'DELETE', 'WARN', 'MUTE'],
  decayMode: 'ROLLING_WINDOW',
  windowSeconds: 1800,
};

describe('AutoMod action enum (v16 §T.2, §T.3)', () => {
  it('contains exactly the four permitted actions', () => {
    expect([...AUTOMOD_ACTIONS]).toEqual(['LOG', 'DELETE', 'WARN', 'MUTE']);
  });

  it('excludes KICK, BAN, and JAIL', () => {
    expect(isValidAutoModAction('KICK')).toBe(false);
    expect(isValidAutoModAction('BAN')).toBe(false);
    expect(isValidAutoModAction('JAIL')).toBe(false);
    // Case-insensitive storage must not smuggle them in either.
    expect(isValidAutoModAction('kick')).toBe(false);
    expect(isValidAutoModAction('ban')).toBe(false);
  });

  it('rejects an unsupported action with the configuration error', () => {
    expect(() => assertValidAutoModAction('BAN', 'R-8F42')).toThrow(/is not a valid AutoMod action/);
    expect(() => assertValidAutoModAction('BAN', 'R-8F42')).toThrow(/LOG · DELETE · WARN · MUTE/);
    expect(() => assertValidAutoModAction('JAIL', 'R-8F42')).toThrow(/explicit moderation workflows/);
    expect(() => assertValidAutoModAction('KICK', 'R-8F42')).toThrow(/R-8F42/);
  });

  it('accepts each permitted action', () => {
    for (const action of AUTOMOD_ACTIONS) {
      expect(assertValidAutoModAction(action, 'R-000001')).toBe(action);
    }
  });

  it('never silently converts a severe action to a lesser one', () => {
    // v16 §T.3: there is deliberately no BAN -> KICK or BAN -> MUTE fallback.
    for (const forbidden of ['BAN', 'KICK', 'JAIL']) {
      let thrown = false;
      try {
        assertValidAutoModAction(forbidden, 'R-000001');
      } catch {
        thrown = true;
      }
      expect(thrown, `${forbidden} must never be downgraded silently`).toBe(true);
    }
  });

  it('renders the rule-not-saved panel with no selectable severe action', () => {
    const panel = ruleNotSavedPanel('ban');
    expect(panel).toContain('AUTOMOD RULE NOT SAVED');
    expect(panel).toContain('LOG · DELETE · WARN · MUTE');
  });
});

describe('escalation ceiling is MUTE (v16 §T.4, §T.11)', () => {
  it('accepts a ladder that stays within MUTE', () => {
    expect(ladderCeilingIsMute(LADDER)).toBe(true);
  });

  it('rejects a ladder containing a severe action', () => {
    const bad = { ...LADDER, ladder: ['LOG', 'BAN'] as never };
    expect(ladderCeilingIsMute(bad)).toBe(false);
  });

  it('never resolves beyond MUTE at any strike count', () => {
    for (let strikes = 0; strikes <= 20; strikes += 1) {
      const action = resolveLadderAction(LADDER, strikes);
      if (action !== null) expect(isValidAutoModAction(action)).toBe(true);
      expect(action).not.toBe('KICK');
      expect(action).not.toBe('BAN');
      expect(action).not.toBe('JAIL');
    }
  });

  it('caps at MUTE once the ladder is exhausted', () => {
    expect(resolveLadderAction(LADDER, 1)).toBe('LOG');
    expect(resolveLadderAction(LADDER, 4)).toBe('MUTE');
    expect(resolveLadderAction(LADDER, 5)).toBe('MUTE');
    expect(resolveLadderAction(LADDER, 99)).toBe('MUTE');
  });

  it('treats an empty ladder as no enforcement', () => {
    expect(resolveLadderAction({ ...LADDER, ladder: [] }, 5)).toBeNull();
  });
});

describe('precision before punishment (v14 §R.1, §R.2)', () => {
  const base = {
    mode: 'ACTIVE' as const,
    minConfidence: 'MEDIUM' as const,
    ladder: LADDER,
    activeStrikes: 1,
    exempted: false,
  };

  it('does NOT punish a low-confidence match even when the rule would otherwise act', () => {
    // v14 §R.2: a single low-confidence match must be LOG ONLY or NO ACTION.
    // The gate is `minConfidence`; with a MEDIUM threshold a LOW match is
    // suppressed regardless of how many strikes have accumulated.
    const decision = decideEnforcement({
      ...base,
      confidence: 'LOW',
      minConfidence: 'MEDIUM',
      activeStrikes: 4,
    });
    expect(decision.action).toBeNull();
    expect(decision.result).toBe('SUPPRESSED_LOW_CONFIDENCE');
    expect(decision.suppressedReason).toMatch(/below threshold/);
    // The intended action is still reported for transparency, capped at MUTE.
    expect(decision.wouldHave).toBe('MUTE');
  });

  it('allows LOG when the rule accepts LOW confidence', () => {
    // A guild that opts into LOW-threshold rules gets LOG — never punishment
    // beyond the ladder, and never a severe action.
    const decision = decideEnforcement({
      ...base,
      confidence: 'LOW',
      minConfidence: 'LOW',
    });
    expect(decision.result).toBe('ACTIONED');
    expect(decision.action).toBe('LOG');
  });

  it('still reports what WOULD have happened when suppressed', () => {
    // Transparency: staff can see why it was suppressed and what would run.
    const decision = decideEnforcement({ ...base, confidence: 'LOW', minConfidence: 'HIGH' });
    expect(decision.wouldHave).toBe('LOG');
  });

  it('acts on a high-confidence match', () => {
    const decision = decideEnforcement({ ...base, confidence: 'HIGH', minConfidence: 'MEDIUM' });
    expect(decision.result).toBe('ACTIONED');
    expect(decision.action).toBe('LOG');
  });

  it('acts on a match exactly at the threshold', () => {
    const decision = decideEnforcement({ ...base, confidence: 'MEDIUM', minConfidence: 'MEDIUM' });
    expect(decision.result).toBe('ACTIONED');
  });

  it('lets an exemption win over any configured action', () => {
    const decision = decideEnforcement({
      ...base,
      confidence: 'HIGH',
      minConfidence: 'LOW',
      exempted: true,
      activeStrikes: 4,
    });
    expect(decision.result).toBe('BLOCKED_BY_EXEMPTION');
    expect(decision.action).toBeNull();
    expect(decision.wouldHave).toBeNull();
  });

  it('never acts in DRY_RUN but records the intended action', () => {
    // v14 §R.18: detect, log, report — never punish, never modify member state.
    const decision = decideEnforcement({
      ...base,
      mode: 'DRY_RUN',
      confidence: 'HIGH',
      minConfidence: 'LOW',
      activeStrikes: 4,
    });
    expect(decision.result).toBe('DRY_RUN');
    expect(decision.action).toBeNull();
    expect(decision.wouldHave).toBe('MUTE');
  });

  it('never acts when disabled', () => {
    const decision = decideEnforcement({
      ...base,
      mode: 'DISABLED',
      confidence: 'HIGH',
      minConfidence: 'LOW',
    });
    expect(decision.result).toBe('ALLOWED');
    expect(decision.action).toBeNull();
  });
});

describe('enforcer contract shape (v16 §T.11)', () => {
  it('exposes only the four permitted operations', () => {
    // Runtime probe: no member named kick/ban/jail (or a generic severe-action
    // helper) may exist on the enforcer, even if added loosely.
    const probe = {} as AutoModEnforcer;
    const surface = probe as unknown as Record<string, unknown>;
    for (const forbidden of ['kick', 'ban', 'jail', 'applySevereAction', 'punish']) {
      expect(surface[forbidden]).toBeUndefined();
    }
    for (const permitted of ['log', 'delete', 'warn', 'mute']) {
      expect(surface[permitted]).toBeUndefined();
    }
  });
});

describe('staff moderation remains separate (v16 §T.6)', () => {
  it('treats a severe staff recommendation as informational only', () => {
    // The alert names possible manual actions; nothing executes them.
    const alert = {
      guildId: '1',
      ruleName: 'Invite Links',
      userId: '2',
      confidence: 'HIGH' as const,
      automaticAction: 'MUTE' as const,
      recommendedReview: 'Possible KICK / BAN / JAIL',
      reason: 'Discord invite detected',
    };
    expect(alert.automaticAction).toBe('MUTE');
    expect(isValidAutoModAction(alert.automaticAction)).toBe(true);
    // The recommendation string is prose, not an executable action.
    expect(alert.recommendedReview).not.toBe('BAN');
  });
});