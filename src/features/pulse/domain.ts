/**
 * Server Pulse — domain logic.
 *
 * PURE functions only. No database, no Discord, no rendering.
 *
 * The insight this feature exists to deliver: a moderator should be able to
 * run ONE command and learn whether their server is healthy this week — is
 * activity rising or falling, is moderation quiet or spiking, is the economy
 * circulating or hoarding — without opening four different dashboards and
 * doing arithmetic.
 *
 * Everything here is derived from data REDOUBT ALREADY STORES (moderation
 * cases, leveling profiles, economy wallets, analytics). No new tables, no new
 * infrastructure, no external API.
 */

export type PulseTrend = 'UP' | 'DOWN' | 'FLAT';

export type PulseHealth = 'HEALTHY' | 'WATCH' | 'ALERT';

export interface ActivitySample {
  /** Day bucket, e.g. '2026-10-01'. */
  readonly day: string;
  readonly messages: number;
  readonly activeMembers: number;
}

export interface ModerationSample {
  readonly day: string;
  readonly cases: number;
}

export interface LevelSample {
  readonly levelUps: number;
  readonly activeMembers: number;
  /** Mean level across members with a profile this season. */
  readonly averageLevel: number;
}

export interface EconomySample {
  /** Total currency in circulation. */
  readonly circulating: number;
  /** Currency granted in the window. */
  readonly granted: number;
  /** Currency spent in the window. */
  readonly spent: number;
  readonly wallets: number;
}

/** Percentage change between two non-negative numbers, with a sane zero case. */
export function percentChange(current: number, previous: number): number {
  if (previous === 0) return current === 0 ? 0 : 100;
  return ((current - previous) / previous) * 100;
}

/**
 * Classifies a trend.
 *
 * `flatBand` is the dead zone: a 3% wobble is noise, not a trend, and calling
 * it "UP" would cry wolf every time a moderator checked.
 */
export function classifyTrend(changePercent: number, flatBand = 5): PulseTrend {
  if (changePercent > flatBand) return 'UP';
  if (changePercent < -flatBand) return 'DOWN';
  return 'FLAT';
}

/** A rolling total for the last `days` samples, oldest-last. */
export function rollingTotal<T extends { readonly day: string }>(
  samples: readonly T[],
  value: (sample: T) => number,
  days: number,
): number {
  return samples.slice(-days).reduce((total, sample) => total + value(sample), 0);
}

export interface PulseInput {
  readonly activity: readonly ActivitySample[];
  readonly moderation: readonly ModerationSample[];
  readonly levels: LevelSample;
  readonly economy: EconomySample;
  /** Days in the comparison window. */
  readonly windowDays?: number;
}

export interface PulseInsight {
  readonly severity: 'GOOD' | 'INFO' | 'WARN';
  readonly headline: string;
  readonly detail: string;
}

export interface PulseSnapshot {
  readonly health: PulseHealth;
  readonly messageTrend: PulseTrend;
  readonly messageChangePercent: number;
  readonly totalMessages: number;
  readonly dailyAverage: number;
  readonly activeMembers: number;
  readonly messagesPerActiveMember: number;
  readonly moderationCases: number;
  readonly moderationTrend: PulseTrend;
  readonly casesPerThousandMessages: number;
  readonly levelUps: number;
  readonly averageLevel: number;
  readonly circulating: number;
  readonly velocity: number;
  readonly insights: readonly PulseInsight[];
}

/**
 * Builds the snapshot.
 *
 * The health verdict is deliberately conservative: it takes a real signal in
 * TWO independent dimensions to escalate past WATCH. A single noisy metric
 * must not paint a healthy server red — moderators lose trust in a dashboard
 * that cries wolf.
 */
export function buildPulse(input: PulseInput): PulseSnapshot {
  const windowDays = input.windowDays ?? 7;

  const activity = [...input.activity].sort((a, b) => a.day.localeCompare(b.day));
  const moderation = [...input.moderation].sort((a, b) => a.day.localeCompare(b.day));

  const recentActivity = activity.slice(-windowDays);
  const priorActivity = activity.slice(-windowDays * 2, -windowDays);

  const sumMessages = (rows: readonly ActivitySample[]): number =>
    rows.reduce((total, row) => total + row.messages, 0);

  const totalMessages = sumMessages(recentActivity);
  const priorMessages = sumMessages(priorActivity);

  const messageChangePercent = percentChange(totalMessages, priorMessages);
  const messageTrend = classifyTrend(messageChangePercent);

  const activeMembers = Math.max(
    ...recentActivity.map((row) => row.activeMembers),
    0,
  );

  const dailyAverage =
    recentActivity.length > 0 ? totalMessages / recentActivity.length : 0;

  const messagesPerActiveMember =
    activeMembers > 0 ? Number((totalMessages / activeMembers).toFixed(2)) : 0;

  const moderationCases = moderation
    .slice(-windowDays)
    .reduce((total, row) => total + row.cases, 0);
  const priorCases = moderation
    .slice(-windowDays * 2, -windowDays)
    .reduce((total, row) => total + row.cases, 0);

  const moderationTrend = classifyTrend(percentChange(moderationCases, priorCases));

  // Per 1,000 messages, so the number is comparable across server sizes.
  const casesPerThousandMessages =
    totalMessages > 0 ? Number(((moderationCases / totalMessages) * 1000).toFixed(2)) : 0;

  const circulating = input.economy.circulating;
  const flow = input.economy.granted - input.economy.spent;
  // Normalized by wallet count so a big server is not flagged for circulating
  // a larger absolute amount.
  const velocity =
    input.economy.wallets > 0 ? Number((flow / input.economy.wallets).toFixed(2)) : 0;

  const insights = buildInsights({
    messageTrend,
    messageChangePercent,
    dailyAverage,
    activeMembers,
    moderationTrend,
    casesPerThousandMessages,
    moderationCases,
    velocity,
    circulating,
    economyWallets: input.economy.wallets,
    levelUps: input.levels.levelUps,
    averageLevel: input.levels.averageLevel,
  });

  // Two independent signals required to reach ALERT.
  const alertSignals =
    (messageTrend === 'DOWN' ? 1 : 0) +
    (moderationTrend === 'UP' && casesPerThousandMessages > 8 ? 1 : 0) +
    (velocity < -50 ? 1 : 0);

  const watchSignals =
    (messageTrend === 'DOWN' ? 1 : 0) +
    (moderationTrend === 'UP' ? 1 : 0) +
    (casesPerThousandMessages > 8 ? 1 : 0);

  const health: PulseHealth =
    alertSignals >= 2 ? 'ALERT' : alertSignals === 1 || watchSignals >= 2 ? 'WATCH' : 'HEALTHY';

  return {
    health,
    messageTrend,
    messageChangePercent: Number(messageChangePercent.toFixed(1)),
    totalMessages,
    dailyAverage: Math.round(dailyAverage),
    activeMembers,
    messagesPerActiveMember,
    moderationCases,
    moderationTrend,
    casesPerThousandMessages,
    levelUps: input.levels.levelUps,
    averageLevel: input.levels.averageLevel,
    circulating,
    velocity,
    insights,
  };
}

/**
 * Turns the numbers into a short, specific list.
 *
 * Deliberately capped at four and ordered most-severe-first: a list of twelve
 * observations is a data dump, not an insight, and moderators stop reading it.
 */
export function buildInsights(input: {
  readonly messageTrend: PulseTrend;
  readonly messageChangePercent: number;
  readonly dailyAverage: number;
  readonly activeMembers: number;
  readonly moderationTrend: PulseTrend;
  readonly casesPerThousandMessages: number;
  readonly moderationCases: number;
  readonly velocity: number;
  readonly circulating: number;
  readonly economyWallets: number;
  readonly levelUps: number;
  readonly averageLevel: number;
}): PulseInsight[] {
  const insights: PulseInsight[] = [];

  if (input.messageTrend === 'DOWN' && input.messageChangePercent < -20) {
    insights.push({
      severity: 'WARN',
      headline: 'Activity is falling',
      detail: `Messages are down ${Math.abs(input.messageChangePercent).toFixed(0)}% versus the previous week. Worth a look at announcements, events, or chat health.`,
    });
  } else if (input.messageTrend === 'UP' && input.messageChangePercent > 20) {
    insights.push({
      severity: 'GOOD',
      headline: 'Activity is growing',
      detail: `Messages are up ${input.messageChangePercent.toFixed(0)}% versus the previous week.`,
    });
  }

  if (input.casesPerThousandMessages > 8) {
    insights.push({
      severity: 'WARN',
      headline: 'Moderation is picking up',
      detail: `${input.casesPerThousandMessages} cases per 1,000 messages this week. That usually means one recurring problem rather than general noise.`,
    });
  } else if (input.moderationTrend === 'FLAT' && input.moderationCases === 0) {
    insights.push({
      severity: 'GOOD',
      headline: 'A quiet week',
      detail: 'No moderation cases recorded. The community is behaving.',
    });
  }

  if (input.velocity < -50) {
    insights.push({
      severity: 'INFO',
      headline: 'Currency is leaving the economy',
      detail: `Spending is outpacing earnings by ${Math.abs(input.velocity)} per member. Consider a low-key earning source.`,
    });
  } else if (input.velocity > 50) {
    insights.push({
      severity: 'INFO',
      headline: 'Currency is accumulating',
      detail: `Members are earning ${input.velocity} more per member than they spend. There may be nothing worth buying.`,
    });
  }

  if (input.averageLevel > 0 && input.levelUps === 0 && input.activeMembers > 5) {
    insights.push({
      severity: 'INFO',
      headline: 'Levelling has stalled',
      detail: `Active members are not earning XP right now. If level rewards matter to you, check the XP channel rules.`,
    });
  }

  const severityRank = { WARN: 0, GOOD: 1, INFO: 2 } as const;
  insights.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

  return insights.slice(0, 4);
}

/** Short label for the health verdict, used as the embed title accent. */
export function healthLabel(health: PulseHealth): string {
  switch (health) {
    case 'HEALTHY':
      return 'Healthy';
    case 'WATCH':
      return 'Worth a look';
    default:
      return 'Needs attention';
  }
}

/** Glyph for the trend arrows, kept here so the renderer stays dumb. */
export function trendGlyph(trend: PulseTrend): string {
  switch (trend) {
    case 'UP':
      return '▲';
    case 'DOWN':
      return '▼';
    default:
      return '▬';
  }
}
