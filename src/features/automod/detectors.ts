/**
 * AutoMod detection (v14 §R.3–R.8, v16).
 *
 * Text analysis only — this module never enforces. It produces a confidence-
 * graded `Detection` that `enforcer.ts` decides about, which is what keeps
 * "precision before punishment" enforceable rather than aspirational.
 *
 * Three properties:
 *
 *  1. MATCHING IS TOKEN/BOUNDARY AWARE, NEVER NAIVE SUBSTRING. A rule for
 *     "ass" must not fire on "class", "assassinate", or "bass". Detectors work
 *     on normalized text with word boundaries derived from the ORIGINAL string,
 *     so obfuscation (`a.s.s`) is caught without false positives.
 *
 *  2. CODE BLOCKS ARE PROTECTED. Content inside ``` fences is skipped, because
 *     a developer pasting a log line is not a spammer.
 *
 *  3. NORMALIZATION KEEPS BOTH FORMS. The event records whether the match came
 *     from the ORIGINAL or the NORMALIZED text (v14 §R.5), so staff can see
 *     what was actually matched and false positives are debuggable.
 */

import type { AutoModConfidence } from './enforcer.js';

export type MatchSource = 'ORIGINAL' | 'NORMALIZED';

export interface Detection {
  readonly ruleKey: string;
  readonly confidence: AutoModConfidence;
  /** Which form produced the hit. */
  readonly matchSource: MatchSource;
  readonly reason: string;
  /** Zero-based offset into whichever text matched. */
  readonly index: number;
  /** The matched fragment, for staff review. Truncated. */
  readonly excerpt: string;
  readonly context?: Record<string, unknown>;
}

/**
 * Confusables folded to their ASCII base.
 *
 * Only characters with genuinely common homoglyph substitutions are mapped.
 * An over-eager table here would silently rewrite real words and cause false
 * positives, which is worse than missing an obfuscation.
 */
const HOMOGLYPHS: Readonly<Record<string, string>> = {
  '@': 'a',
  А: 'a', // А CYRILLIC CAPITAL A
  а: 'a', // а CYRILLIC SMALL A
  В: 'b', // В CYRILLIC CAPITAL VE
  Е: 'e', // Е CYRILLIC CAPITAL IE
  е: 'e', // е CYRILLIC SMALL IE
  О: 'o', // О CYRILLIC CAPITAL O
  о: 'o', // о CYRILLIC SMALL O
  р: 'p', // р CYRILLIC SMALL ER
  Р: 'p', // Р CYRILLIC CAPITAL ER
  с: 'c', // с CYRILLIC SMALL ES
  С: 'c', // С CYRILLIC CAPITAL ES
  у: 'y', // у CYRILLIC SMALL U
  і: 'i', // і CYRILLIC SMALL BYELORUSSIAN-UKRAINIAN I
  ѕ: 's', // ѕ CYRILLIC SMALL DZE
  һ: 'h', // һ CYRILLIC SMALL SHHA
  '\\': '',
  '|': 'l',
  '1': 'i',
  '0': 'o',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  $: 's',
};

/**
 * Normalizes text for obfuscation-resistant matching.
 *
 * Deliberately NON-destructive to semantics: it folds homoglyphs and removes
 * separators between characters (a.s.s → ass). It does NOT collapse repeated
 * characters — doing so would corrupt real words ("ass" → "as", "letter" →
 * "leter"). Run-padding is handled by `matchesRunTolerant` instead, which
 * tolerates repetition without destroying it.
 */
export function normalizeForMatching(input: string): string {
  let out = '';
  for (const char of input.normalize('NFKC')) {
    out += HOMOGLYPHS[char] ?? char.toLowerCase();
  }
  // Collapse letter/digit separators used to split a word: a.s.s, a-s-s, a s s
  out = out.replace(/[.\-_~*|](?=[a-z0-9])/g, '');
  return out;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Matches `needle` allowing each of its characters to be REPEATED.
 *
 * This catches character padding ("aasshole" for "asshole") without
 * normalizing the text, so genuine doubles inside words survive. Word
 * boundaries are still enforced: "class" never matches "ass".
 */
export function matchesRunTolerant(
  text: string,
  needle: string,
): { readonly matched: boolean; readonly index: number } {
  if (needle.length === 0) return { matched: false, index: -1 };

  const body = [...needle].map((char) => `${escapeRegExp(char)}+`).join('');
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, 'u');
  const match = pattern.exec(text);
  return { matched: match !== null, index: match?.index ?? -1 };
}

/** True when the offset is inside a fenced code block or inline code span. */
export function isInsideCodeBlock(text: string, index: number): boolean {
  const before = text.slice(0, index);
  const fences = (before.match(/```/g) ?? []).length;
  if (fences % 2 === 1) return true;
  // Inline code spans, skipping double backticks.
  const ticks = (before.match(/(?<!`)`(?!`)/g) ?? []).length;
  return ticks % 2 === 1;
}

/**
 * Blanks out every code region, preserving LENGTH.
 *
 * Blankings rather than deleting is what keeps offsets valid: a match index
 * found in the scannable text still points at the right characters in the
 * ORIGINAL, so excerpts stay accurate.
 *
 * Blanking BEFORE matching (rather than testing each hit) is what makes code
 * protection hold on the NORMALIZED path too — a per-hit check cannot work
 * there, because normalized indices do not correspond to code fences.
 */
export function stripCodeBlocks(text: string): string {
  const chars = [...text];
  let inFence = false;

  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i] ?? '';

    if (char === '`') {
      // Triple backtick opens/closes a fence; a single one opens a span.
      const isFenceStart = chars[i + 1] === '`' && chars[i + 2] === '`';
      if (isFenceStart) {
        inFence = !inFence;
        chars[i] = ' ';
        chars[i + 1] = ' ';
        chars[i + 2] = ' ';
        i += 2;
        continue;
      }
      if (!inFence) {
        // Blank the delimiters and the span body.
        const close = text.indexOf('`', i + 1);
        for (let j = i; j <= (close === -1 ? chars.length - 1 : close); j += 1) {
          chars[j] = ' ';
        }
        i = close === -1 ? chars.length : close;
        continue;
      }
    }

    if (inFence) chars[i] = ' ';
  }

  return chars.join('');
}

/**
 * Whether `needle` appears in `text` at a WORD BOUNDARY.
 *
 * This is the difference between a useful rule and a coin flip: "ass" matches
 * "you ass" but never "class" or "bass".
 */
export function matchesWithBoundary(
  text: string,
  needle: string,
  options: { readonly allowPartialWords?: boolean; readonly startFrom?: number } = {},
): { readonly matched: boolean; readonly index: number } {
  if (needle.length === 0) return { matched: false, index: -1 };
  if (options.allowPartialWords) {
    const index = text.indexOf(needle, options.startFrom ?? 0);
    return { matched: index !== -1, index };
  }

  let from = options.startFrom ?? 0;
  for (;;) {
    const index = text.indexOf(needle, from);
    if (index === -1) return { matched: false, index: -1 };

    const before = index === 0 ? '' : text[index - 1] ?? '';
    const after = text[index + needle.length] ?? '';

    const boundaryBefore = before === '' || !isWordChar(before);
    const boundaryAfter = after === '' || !isWordChar(after);

    if (boundaryBefore && boundaryAfter) return { matched: true, index };
    from = index + 1;
  }
}

/**
 * EVERY boundary-respecting occurrence of `needle`, not just the first.
 *
 * Useful when a caller needs to know how many times a term appears, or to
 * report each distinct location rather than only the first.
 */
export function findAllWithBoundary(
  text: string,
  needle: string,
  options: { readonly allowPartialWords?: boolean } = {},
): number[] {
  if (needle.length === 0) return [];

  const hits: number[] = [];
  let from = 0;
  for (;;) {
    const { matched, index } = matchesWithBoundary(text, needle, {
      ...options,
      startFrom: from,
    });
    if (!matched) return hits;
    hits.push(index);
    from = index + 1;
  }
}

function isWordChar(char: string): boolean {
  return /[\p{L}\p{N}_]/u.test(char);
}

/** Truncates an excerpt for safe display in an embed. */
function excerptAt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 12);
  const slice = text.slice(start, start + length + 24).replace(/\s+/g, ' ').trim();
  return slice.length > 90 ? `${slice.slice(0, 87)}…` : slice;
}

export interface TextRule {
  readonly ruleKey: string;
  readonly terms: readonly string[];
  /**
   * HIGH for unambiguous profanity/slurs, MEDIUM for contextual terms.
   * Detectors assign confidence; the enforcer's threshold decides what acts.
   */
  readonly confidence: AutoModConfidence;
  /** Allow matching inside a larger word (for genuinely compound terms). */
  readonly allowPartialWords?: boolean;
}

/** Runs term rules against a message, honouring code-block protection. */
export function evaluateTermRules(content: string, rules: readonly TextRule[]): Detection[] {
  const detections: Detection[] = [];
  // Code regions are blanked first, so protection applies to BOTH the
  // original and the normalized path.
  const scannable = stripCodeBlocks(content);
  const normalized = normalizeForMatching(scannable);

  for (const rule of rules) {
    for (const term of rule.terms) {
      // ORIGINAL first: an exact hit needs no explanation.
      const original = matchesWithBoundary(scannable.toLowerCase(), term, {
        allowPartialWords: rule.allowPartialWords,
      });
      if (original.matched) {
        detections.push({
          ruleKey: rule.ruleKey,
          confidence: rule.confidence,
          matchSource: 'ORIGINAL',
          reason: `matched configured term`,
          index: original.index,
          excerpt: excerptAt(content, original.index, term.length),
          context: { term },
        });
        break;
      }

      // Then NORMALIZED, which catches obfuscation AND character padding.
      const normalizedTerm = normalizeForMatching(term);
      const fuzzy = matchesRunTolerant(normalized, normalizedTerm);
      if (fuzzy.matched) {
        detections.push({
          ruleKey: rule.ruleKey,
          // An obfuscated match is one step less certain than a plain one.
          confidence: rule.confidence === 'HIGH' ? 'MEDIUM' : rule.confidence,
          matchSource: 'NORMALIZED',
          reason: `matched after normalization`,
          index: fuzzy.index,
          excerpt: excerptAt(content, fuzzy.index, term.length),
          context: { term },
        });
        break;
      }
    }
  }

  return detections;
}

// ---------------------------------------------------------------------------
// Link and mention analysis
// ---------------------------------------------------------------------------

const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;

export interface LinkAnalysis {
  readonly urls: readonly string[];
  /** Distinct registrable hosts, for allow/deny list matching. */
  readonly hosts: readonly string[];
  readonly uniqueHostCount: number;
}

export function analyzeLinks(content: string): LinkAnalysis {
  const urls = content.match(URL_PATTERN) ?? [];
  const hosts = urls.map((url) => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return '';
    }
  });
  const distinct = [...new Set(hosts.filter((h) => h !== ''))];
  return { urls, hosts, uniqueHostCount: distinct.length };
}

export interface MentionAnalysis {
  readonly total: number;
  readonly uniqueUsers: number;
  readonly roleMentions: number;
}

/** Counts mentions so mass-mention rules have a real number to act on. */
export function analyzeMentions(content: string): MentionAnalysis {
  const userIds = content.match(/<@!?\d+>/g) ?? [];
  const uniqueUsers = new Set(userIds.map((m) => m.replace(/<@!?/, '').replace('>', ''))).size;
  const roleMentions = (content.match(/<@&\d+>/g) ?? []).length;
  return { total: userIds.length, uniqueUsers, roleMentions };
}

/**
 * Detects repeated-character flooding ("aaaaaa") without flagging laughter or
 * emphasis, by requiring a LONG run.
 */
export function evaluateCharacterFlood(
  content: string,
  options: { readonly threshold?: number } = {},
): Detection | null {
  const threshold = Math.max(2, options.threshold ?? 12);
  // Built from the threshold rather than hard-coded, so a guild lowering it
  // actually takes effect.
  const pattern = new RegExp(`(.)\\1{${threshold - 1},}`, 'u');
  const match = pattern.exec(content);
  if (!match) return null;

  const char = match[1] ?? '';
  // Whitespace runs are formatting, not flooding.
  if (/\s/.test(char)) return null;

  return {
    ruleKey: 'CHAR_FLOOD',
    confidence: 'MEDIUM',
    matchSource: 'ORIGINAL',
    reason: 'long repeated character run',
    index: match.index,
    excerpt: excerptAt(content, match.index, match[0].length),
  };
}

// ---------------------------------------------------------------------------
// Raid heuristics
// ---------------------------------------------------------------------------

export interface RaidSignal {
  readonly joins: number;
  readonly windowSeconds: number;
  readonly averageAccountAgeHours: number | null;
  readonly defaultAvatarRatio: number;
}

/**
 * Decides whether a join burst looks like a raid.
 *
 * Deliberately conservative: an influx of brand-new accounts with default
 * avatars is the signal. A burst of established members is a server event and
 * must never trigger protection, or the bot would mute a whole community for
 * showing up.
 */
export function evaluateRaidSignal(signal: RaidSignal): {
  readonly triggered: boolean;
  readonly confidence: AutoModConfidence;
  readonly reason: string;
} {
  const { joins, windowSeconds, averageAccountAgeHours, defaultAvatarRatio } = signal;
  if (joins < 5 || windowSeconds <= 0) {
    return { triggered: false, confidence: 'HIGH', reason: 'below join threshold' };
  }

  const rate = joins / (windowSeconds / 60);
  if (rate < 10) {
    return { triggered: false, confidence: 'HIGH', reason: `join rate ${rate.toFixed(1)}/min below threshold` };
  }

  const young = averageAccountAgeHours !== null && averageAccountAgeHours < 24;
  const defaultAvatars = defaultAvatarRatio >= 0.8;

  if (young && defaultAvatars) {
    return {
      triggered: true,
      confidence: 'HIGH',
      reason: `sustained ${rate.toFixed(1)} joins/min from accounts averaging ${averageAccountAgeHours?.toFixed(1)}h old with ${Math.round(defaultAvatarRatio * 100)}% default avatars`,
    };
  }

  if (young || defaultAvatars) {
    // One signal alone is not enough to punish anyone: report, don't act.
    return {
      triggered: true,
      confidence: 'LOW',
      reason: 'partial raid signal; insufficient for automatic action',
    };
  }

  return {
    triggered: false,
    confidence: 'HIGH',
    reason: 'join burst consists of established members; not a raid',
  };
}
