/**
 * Rate limiting and cooldowns (v13 §14).
 *
 * Both are GUILD-AWARE: one abusive guild must never starve another (v13 §14).
 * That is the whole point of keying every bucket by guild rather than using a
 * single global limiter.
 *
 * v20 Priority A: correctness is never traded for speed. A cache hit that
 * SKIPS a check is not an optimization, it is a vulnerability — so the limiter
 * only ever says "not yet" or "yes", never "skip because it looked familiar".
 */

export interface BucketOptions {
  /** Sustained rate: tokens added per interval. */
  readonly refillRate: number;
  /** Burst capacity. */
  readonly capacity: number;
  /** Interval in milliseconds. */
  readonly intervalMs: number;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export const DEFAULT_GUILD_BUCKET: BucketOptions = {
  refillRate: 5,
  capacity: 10,
  intervalMs: 10_000,
};

/**
 * Token-bucket limiter keyed by `${guildId}:${scope}:${key}`.
 *
 * Buckets are evicted once refilled to capacity, so an idle guild costs
 * nothing.
 */
export class GuildRateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #defaults: BucketOptions;

  constructor(defaults: BucketOptions = DEFAULT_GUILD_BUCKET) {
    this.#defaults = defaults;
  }

  #refill(bucket: Bucket, options: BucketOptions): void {
    const now = Date.now();
    const elapsed = now - bucket.lastRefill;
    if (elapsed <= 0) return;

    const refillAmount = (elapsed / options.intervalMs) * options.refillRate;
    bucket.tokens = Math.min(options.capacity, bucket.tokens + refillAmount);
    bucket.lastRefill = now;
  }

  /**
   * Attempts to consume one token.
   *
   * Returns false when the caller is limited. The bucket is always touched so
   * a full bucket at rest does not read as "never seen".
   */
  tryConsume(
    guildId: string,
    key: string,
    options: BucketOptions = this.#defaults,
  ): boolean {
    const bucketKey = `${guildId}:${key}`;
    const now = Date.now();

    let bucket = this.#buckets.get(bucketKey);
    if (!bucket) {
      bucket = { tokens: options.capacity - 1, lastRefill: now };
      this.#buckets.set(bucketKey, bucket);
      return true;
    }

    this.#refill(bucket, options);

    if (bucket.tokens < 1) return false;

    bucket.tokens -= 1;

    // Evict a fully refilled bucket to avoid unbounded growth.
    if (bucket.tokens >= options.capacity) {
      this.#buckets.delete(bucketKey);
    }
    return true;
  }

  /** Tokens currently available. */
  remaining(
    guildId: string,
    key: string,
    options: BucketOptions = this.#defaults,
  ): number {
    const bucket = this.#buckets.get(`${guildId}:${key}`);
    if (!bucket) return options.capacity;
    this.#refill(bucket, options);
    return Math.floor(bucket.tokens);
  }

  /** Milliseconds until one token is available, or 0. */
  retryAfterMs(
    guildId: string,
    key: string,
    options: BucketOptions = this.#defaults,
  ): number {
    const bucket = this.#buckets.get(`${guildId}:${key}`);
    if (!bucket) return 0;
    this.#refill(bucket, options);
    if (bucket.tokens >= 1) return 0;
    return Math.ceil(((1 - bucket.tokens) / options.refillRate) * options.intervalMs);
  }

  clear(guildId: string): void {
    for (const key of this.#buckets.keys()) {
      if (key.startsWith(`${guildId}:`)) this.#buckets.delete(key);
    }
  }

  get size(): number {
    return this.#buckets.size;
  }
}

/**
 * Fixed-window cooldowns for user-scoped actions (daily, work, ticket create).
 *
 * Separate from rate limiting: a cooldown is an ACTION-level gate (one daily
 * claim per day), while a bucket is a TRAFFIC-level gate (N per interval).
 */
export class CooldownManager {
  readonly #lastUsed = new Map<string, number>();

  /** True when the action is on cooldown; records the use when it is not. */
  tryUse(key: string, cooldownMs: number, now = Date.now()): boolean {
    const last = this.#lastUsed.get(key);
    if (last !== undefined && now - last < cooldownMs) return false;
    this.#lastUsed.set(key, now);
    return true;
  }

  /** Reads without recording — used by staff checks that must not consume. */
  isOnCooldown(key: string, cooldownMs: number, now = Date.now()): boolean {
    const last = this.#lastUsed.get(key);
    return last !== undefined && now - last < cooldownMs;
  }

  remainingMs(key: string, cooldownMs: number, now = Date.now()): number {
    const last = this.#lastUsed.get(key);
    if (last === undefined) return 0;
    return Math.max(0, cooldownMs - (now - last));
  }

  /**
   * Clears a cooldown.
   *
   * v13 §18: cooldowns must NEVER prevent the AFK user clearing their own
   * status, staff clearing it, or internal cleanup — so this exists as an
   * explicit operation rather than being coupled to the gate.
   */
  clear(key: string): void {
    this.#lastUsed.delete(key);
  }

  /** Clears every cooldown for a guild. */
  clearGuild(guildId: string): void {
    for (const key of this.#lastUsed.keys()) {
      if (key.startsWith(`${guildId}:`)) this.#lastUsed.delete(key);
    }
  }

  get size(): number {
    return this.#lastUsed.size;
  }
}

/** Shared instances. */
export const rateLimiter = new GuildRateLimiter();
export const cooldowns = new CooldownManager();

/** Formats a duration the way operators expect to read it. */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}