/**
 * Theme token contract (v13 §9.2).
 *
 * GLOBAL Redoubt identity — NOT guild-customizable:
 *   embed structure · typography · spacing · component design ·
 *   status hierarchy · SEMANTIC COLORS · button conventions ·
 *   interaction style · copy style.
 *
 * The ONLY guild-customizable value is `accent`, restricted to a validated
 * palette. This is what guarantees no guild can make the bot look like a
 * different product: semantic colors cannot be overridden, so a guild can
 * shift the accent hue and nothing else.
 */

export const SEMANTIC_COLORS = {
  success: 0x2f9e6f,
  warning: 0xd08c34,
  danger: 0xcc4b4b,
  info: 0x3f7fd4,
  neutral: 0x3a4250,
} as const;

export type SemanticColorName = keyof typeof SEMANTIC_COLORS;

/**
 * Validated accent palette. A guild may choose any of these; arbitrary hex
 * values are rejected so the palette stays cohesive and accessible.
 */
export const ACCENT_PALETTE = {
  azure: 0x4a90d9,
  violet: 0x8b6fc4,
  teal: 0x3aa8a0,
  emerald: 0x3f9e6d,
  crimson: 0xc4505c,
  amber: 0xd39a3a,
  slate: 0x6c7a90,
  indigo: 0x5b6bc4,
} as const;

export type AccentName = keyof typeof ACCENT_PALETTE;

export const ACCENT_NAMES = Object.keys(ACCENT_PALETTE) as AccentName[];

export function isAccentName(value: string): value is AccentName {
  return Object.hasOwn(ACCENT_PALETTE, value);
}

/** Resolves an accent name to its color, defaulting safely. */
export function accentColor(name: string | undefined): number {
  return name && isAccentName(name) ? ACCENT_PALETTE[name] : ACCENT_PALETTE.azure;
}

export interface Theme {
  readonly accent: AccentName;
  readonly accentHex: number;
  readonly surfaces: {
    readonly background: number;
    readonly card: number;
    readonly elevated: number;
  };
  readonly text: {
    readonly primary: number;
    readonly muted: number;
    readonly inverted: number;
  };
  readonly status: typeof SEMANTIC_COLORS;
}

/**
 * Builds the theme for a guild. Semantic colors are fixed and not derived
 * from the accent, so `success`/`danger` etc. read identically everywhere.
 */
export function buildTheme(accentName?: string): Theme {
  const accent = accentName && isAccentName(accentName) ? accentName : 'azure';
  return {
    accent,
    accentHex: ACCENT_PALETTE[accent],
    surfaces: {
      background: 0x0d1117,
      card: 0x161b22,
      elevated: 0x21262d,
    },
    text: {
      primary: 0xe6edf3,
      muted: 0x8b949e,
      inverted: 0x0d1117,
    },
    status: SEMANTIC_COLORS,
  };
}

/** Default theme for DM/global surfaces where no guild context exists. */
export const DEFAULT_THEME: Theme = buildTheme('azure');

/** Discord color codes are 24-bit; this guards against overflow values. */
export function isValidColor(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffff;
}