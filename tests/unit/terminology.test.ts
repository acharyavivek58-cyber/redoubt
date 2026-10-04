/**
 * v3 §1 / v13: MANDATORY TERMINOLOGY TEST.
 *
 * The public vocabulary is Mute/Unmute. Timeout terminology is an INTERNAL
 * implementation detail and must never leak into commands, embeds, logs, help,
 * docs, case labels, dashboards, tests, or user-facing errors.
 *
 * This suite asserts both directions: that public labels are correct, and that
 * the guard actually catches forbidden vocabulary.
 */

import { describe, expect, it } from 'vitest';
import {
  ACTION_SEVERITY,
  actionLabel,
  actionPastTense,
  actionSummary,
  containsForbiddenPublicTerm,
  FORBIDDEN_PUBLIC_TERMS,
  MODERATION_ACTIONS,
} from '../../src/shared/constants/action-labels.js';

describe('public moderation terminology (v3 §1)', () => {
  it('exposes Mute/Unmute as the public vocabulary', () => {
    expect(actionLabel('MUTE')).toBe('Mute');
    expect(actionLabel('UNMUTE')).toBe('Unmute');
    expect(actionPastTense('MUTE')).toBe('Muted');
    expect(actionPastTense('UNMUTE')).toBe('Unmuted');
  });

  it('uses Jail/Unjail vocabulary for jails', () => {
    expect(actionLabel('JAIL')).toBe('Jail');
    expect(actionLabel('UNJAIL')).toBe('Unjail');
    expect(actionPastTense('JAIL')).toBe('Jailed');
  });

  it('never exposes forbidden terms in any action label', () => {
    for (const action of MODERATION_ACTIONS) {
      expect(containsForbiddenPublicTerm(actionLabel(action))).toBe(false);
      expect(containsForbiddenPublicTerm(actionPastTense(action))).toBe(false);
      expect(containsForbiddenPublicTerm(actionSummary(action, '30 minutes'))).toBe(false);
    }
  });

  it('renders summaries in the documented format', () => {
    // The spec's example: "Mute • 30 minutes", NOT "Timeout • 30 minutes".
    expect(actionSummary('MUTE', '30 minutes')).toBe('Mute • 30 minutes');
  });

  it('detects forbidden vocabulary case-insensitively', () => {
    const leaked = [
      'Timeout this member',
      'untimed out',
      'Timed out for 30 minutes',
      'UNTIMED OUT',
      'time-out applied',
      'time out the user',
    ];
    for (const text of leaked) {
      expect(containsForbiddenPublicTerm(text)).toBe(true);
    }
  });

  it('does not flag legitimate moderator copy', () => {
    const allowed = [
      'Member successfully muted.',
      'Member unmuted by a moderator.',
      'Member successfully banned.',
      'Member jailed — Jail-chat only.',
      'Published in #announcements',
      'Download complete',
    ];
    for (const text of allowed) {
      expect(containsForbiddenPublicTerm(text)).toBe(false);
    }
  });

  it('orders escalation severity so MUTE ranks below KICK and BAN', () => {
    // AutoMod's ceiling is MUTE (v16 §T.4); this asserts the ordering that
    // makes the ceiling meaningful.
    expect(ACTION_SEVERITY.WARN).toBeLessThan(ACTION_SEVERITY.MUTE);
    expect(ACTION_SEVERITY.MUTE).toBeLessThan(ACTION_SEVERITY.KICK);
    expect(ACTION_SEVERITY.KICK).toBeLessThan(ACTION_SEVERITY.BAN);
  });

  it('covers every forbidden term in the guard list', () => {
    for (const term of FORBIDDEN_PUBLIC_TERMS) {
      expect(containsForbiddenPublicTerm(`prefix ${term} suffix`)).toBe(true);
    }
  });
});