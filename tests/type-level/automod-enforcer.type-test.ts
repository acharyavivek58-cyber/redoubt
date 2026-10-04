/**
 * TYPE-LEVEL TEST (v16 §T.11).
 *
 * Proves the compile-time half of the AutoMod guarantee: `kick`, `ban`, and
 * `jail` are not members of AutoModEnforcer, so calling one is a compile
 * error rather than a review finding.
 *
 * The lines below are INTENTIONALLY type errors. They are excluded from the
 * normal typecheck (tsconfig excludes this directory) and verified by
 * tests/type-level/automod-enforcer.compiletest.ts, which asserts tsc rejects
 * them. Do not "fix" them.
 */

import type { AutoModEnforcer } from '../../../src/features/automod/enforcer.js';

/** A minimal conforming implementation. */
declare const enforcer: AutoModEnforcer;

// --- These four ARE allowed and must typecheck ---
void enforcer.log;
void enforcer.delete;
void enforcer.warn;
void enforcer.mute;

// --- Each of these MUST be a compile error ---
// @ts-expect-error AutoMod can never KICK (v16 §T.1)
enforcer.kick;
// @ts-expect-error AutoMod can never BAN (v16 §T.1, §T.7)
enforcer.ban;
// @ts-expect-error AutoMod can never JAIL (v16 §T.1, §T.9)
enforcer.jail;
// @ts-expect-error No generic severe-action helper may exist (v16 §T.13)
enforcer.applySevereAction;

// --- Nor may one be smuggled in via a structural escape hatch ---
// @ts-expect-error Casting to a wider shape does not grant execution
(enforcer as unknown as Record<string, unknown>)['kick'];

export {};