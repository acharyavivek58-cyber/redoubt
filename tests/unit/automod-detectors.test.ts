/**
 * AutoMod detection precision (v14 §R.3–R.8).
 *
 * The property that matters most here is the NEGATIVE one: a detector that
 * fires on innocent text is worse than one that misses an obfuscation, because
 * it punishes members for nothing. These tests pin both directions.
 */

import { describe, expect, it } from 'vitest';
import {
  analyzeLinks,
  analyzeMentions,
  evaluateCharacterFlood,
  evaluateRaidSignal,
  evaluateTermRules,
  isInsideCodeBlock,
  matchesRunTolerant,
  matchesWithBoundary,
  normalizeForMatching,
  type TextRule,
} from '../../src/features/automod/detectors.js';

const PROFANITY: TextRule = {
  ruleKey: 'profanity',
  terms: ['ass', 'damn'],
  confidence: 'HIGH',
};

function keysFor(content: string, rules: TextRule[] = [PROFANITY]): string[] {
  return evaluateTermRules(content, rules).map((d) => d.ruleKey);
}

describe('matching is boundary aware, never naive substring', () => {
  it('matches a standalone word', () => {
    expect(matchesWithBoundary('you are an ass', 'ass').matched).toBe(true);
  });

  it('does NOT match inside a longer word', () => {
    // The classic false positive: "ass" in "class" or "bass".
    for (const text of ['a class act', 'bass guitar', 'assassin', 'embassy', 'passage']) {
      expect(matchesWithBoundary(text, 'ass').matched, `"${text}" must not match`).toBe(false);
    }
  });

  it('matches at the start and end of a string', () => {
    expect(matchesWithBoundary('ass move', 'ass').matched).toBe(true);
    expect(matchesWithBoundary('nice ass', 'ass').matched).toBe(true);
  });

  it('finds a later occurrence after skipping a partial one', () => {
    const result = matchesWithBoundary('class and ass', 'ass');
    expect(result.matched).toBe(true);
    expect(result.index).toBeGreaterThan(4);
  });

  it('treats an underscore as a word character', () => {
    expect(matchesWithBoundary('sn_ass_pass', 'ass').matched).toBe(false);
  });

  it('supports deliberate partial-word matching when configured', () => {
    const rule: TextRule = { ruleKey: 'x', terms: ['fuck'], confidence: 'HIGH', allowPartialWords: true };
    expect(keysFor('fucking hell', [rule])).toEqual(['x']);
  });

  it('rejects an empty needle rather than matching everything', () => {
    expect(matchesWithBoundary('anything', '').matched).toBe(false);
  });
});

describe('normalization catches obfuscation without inventing matches', () => {
  it('folds separators out of a word', () => {
    expect(normalizeForMatching('a.s.s')).toBe('ass');
    expect(normalizeForMatching('a-s-s')).toBe('ass');
    expect(normalizeForMatching('@ss')).toBe('ass');
  });

  it('does NOT collapse runs, which would corrupt real words', () => {
    // "ass" must survive normalization: collapsing it to "as" would make every
    // rule match the wrong thing.
    expect(normalizeForMatching('ass')).toBe('ass');
    expect(normalizeForMatching('letter')).toBe('letter');
  });

  it('catches character padding via run-tolerant matching', () => {
    expect(matchesRunTolerant('aassss', 'ass').matched).toBe(true);
    expect(matchesRunTolerant('aasshole', 'asshole').matched).toBe(true);
  });

  it('still enforces boundaries under run padding', () => {
    // Padding must not become a licence to match inside words.
    expect(matchesRunTolerant('claaass', 'ass').matched).toBe(false);
  });

  it('folds common homoglyphs', () => {
    // Cyrillic А (U+0410) and а (U+0430) both render as Latin a; е renders
    // as e. Cyrillic с renders as c, NOT s, so "сс" folds to "cc".
    expect(normalizeForMatching('асс')).toBe('acc');
    expect(normalizeForMatching('Асс')).toBe('acc');
    expect(normalizeForMatching('аss')).toBe('ass');
  });

  it('reports an obfuscated match as NORMALIZED and less certain', () => {
    const detection = evaluateTermRules('you are an @ss', [PROFANITY])[0];
    expect(detection?.matchSource).toBe('NORMALIZED');
    // Obfuscation is evidence, not proof: one step down.
    expect(detection?.confidence).toBe('MEDIUM');
  });

  it('reports a plain match as ORIGINAL at full confidence', () => {
    const detection = evaluateTermRules('you are an ass', [PROFANITY])[0];
    expect(detection?.matchSource).toBe('ORIGINAL');
    expect(detection?.confidence).toBe('HIGH');
  });

  it('still does not match an innocent word after normalization', () => {
    expect(keysFor('the classic bassline')).toEqual([]);
  });

  it('keeps word boundaries in normalized space', () => {
    // Normalizing must not turn "class" into "ass" + noise.
    expect(keysFor('class')).toEqual([]);
    expect(keysFor('claaass')).toEqual([]);
  });
});

describe('code blocks are protected', () => {
  it('detects being inside a fenced block', () => {
    const text = 'before\n```\nthe ass code\n```\nafter';
    expect(isInsideCodeBlock(text, text.indexOf('ass'))).toBe(true);
  });

  it('detects being inside an inline code span', () => {
    const text = 'run `the ass` here';
    expect(isInsideCodeBlock(text, text.indexOf('ass'))).toBe(true);
  });

  it('does not treat text after a closed fence as code', () => {
    const text = '```\ncode\n```\nass outside';
    expect(isInsideCodeBlock(text, text.indexOf('ass outside'))).toBe(false);
  });

  it('never flags a term that only appears inside a code block', () => {
    // A developer pasting a log line is not a spammer.
    expect(keysFor('```\nfatal: ass error\n```')).toEqual([]);
    expect(keysFor('inline `ass` sample')).toEqual([]);
  });

  it('still flags a term outside the code block in the same message', () => {
    const text = '```\nsome ass code\n```\nyou are an ass';
    expect(keysFor(text)).toEqual(['profanity']);
  });
});

describe('link and mention analysis', () => {
  it('extracts urls and distinct hosts', () => {
    const analysis = analyzeLinks('see https://a.example/x and https://b.example/y and https://a.example/z');
    expect(analysis.urls).toHaveLength(3);
    expect(analysis.uniqueHostCount).toBe(2);
  });

  it('returns nothing for text with no links', () => {
    expect(analyzeLinks('no links here').uniqueHostCount).toBe(0);
  });

  it('counts total and unique user mentions', () => {
    const analysis = analyzeMentions('<@111> <@111> <@222> <@&333>');
    expect(analysis.total).toBe(3);
    expect(analysis.uniqueUsers).toBe(2);
    expect(analysis.roleMentions).toBe(1);
  });

  it('counts nothing in ordinary text', () => {
    expect(analyzeMentions('hello @everyone').total).toBe(0);
  });
});

describe('character flood detection', () => {
  it('flags a long run', () => {
    expect(evaluateCharacterFlood('aaaaaaaaaaaaaaaa')?.ruleKey).toBe('CHAR_FLOOD');
  });

  it('does not flag normal emphasis or laughter', () => {
    // A false positive here mutes people for laughing.
    for (const text of ['hahahaha', 'wow!!!!!', 'ok!!!', 'nooooo']) {
      expect(evaluateCharacterFlood(text), `"${text}" must not flood`).toBeNull();
    }
  });

  it('ignores whitespace runs, which are formatting', () => {
    expect(evaluateCharacterFlood('x' + ' '.repeat(40) + 'y')).toBeNull();
  });

  it('honours a guild-configured threshold', () => {
    expect(evaluateCharacterFlood('aaaa', { threshold: 4 })?.ruleKey).toBe('CHAR_FLOOD');
    expect(evaluateCharacterFlood('aaaa', { threshold: 10 })).toBeNull();
  });
});

describe('raid detection is conservative', () => {
  it('does not trigger below the join threshold', () => {
    const result = evaluateRaidSignal({
      joins: 3,
      windowSeconds: 30,
      averageAccountAgeHours: 1,
      defaultAvatarRatio: 1,
    });
    expect(result.triggered).toBe(false);
  });

  it('does not punish an event attended by established members', () => {
    // The failure mode that matters: a community all showing up at once must
    // never be treated as a raid.
    const result = evaluateRaidSignal({
      joins: 60,
      windowSeconds: 60,
      averageAccountAgeHours: 4000,
      defaultAvatarRatio: 0.1,
    });
    expect(result.triggered).toBe(false);
    expect(result.reason).toMatch(/not a raid/);
  });

  it('does not trigger on a slow trickle', () => {
    const result = evaluateRaidSignal({
      joins: 20,
      windowSeconds: 600,
      averageAccountAgeHours: 1,
      defaultAvatarRatio: 1,
    });
    expect(result.triggered).toBe(false);
  });

  it('triggers with high confidence only when BOTH signals agree', () => {
    const result = evaluateRaidSignal({
      joins: 40,
      windowSeconds: 30,
      averageAccountAgeHours: 3,
      defaultAvatarRatio: 0.95,
    });
    expect(result.triggered).toBe(true);
    expect(result.confidence).toBe('HIGH');
  });

  it('reports only LOW confidence when just one signal agrees', () => {
    // One weak signal must never escalate to automatic punishment.
    const youngOnly = evaluateRaidSignal({
      joins: 40,
      windowSeconds: 30,
      averageAccountAgeHours: 2,
      defaultAvatarRatio: 0.3,
    });
    expect(youngOnly.triggered).toBe(true);
    expect(youngOnly.confidence).toBe('LOW');

    const avatarOnly = evaluateRaidSignal({
      joins: 40,
      windowSeconds: 30,
      averageAccountAgeHours: 5000,
      defaultAvatarRatio: 1,
    });
    expect(avatarOnly.confidence).toBe('LOW');
  });

  it('treats unknown account age as insufficient evidence', () => {
    const result = evaluateRaidSignal({
      joins: 40,
      windowSeconds: 30,
      averageAccountAgeHours: null,
      defaultAvatarRatio: 1,
    });
    expect(result.confidence).toBe('LOW');
  });
});
