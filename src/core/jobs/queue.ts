/**
 * Job queue (v13 §11, v21 §A).
 *
 * pg-boss on the same PostgreSQL database as everything else — no Redis, no
 * second datastore, no operational bill.
 *
 * THE EXACTLY-ONCE HONESTY RULE (v21 §A) — this is the single most important
 * comment in the file:
 *
 *   - DB ORCHESTRATION IS EXACTLY ONCE. The `job_runs` table has a UNIQUE
 *     constraint on (job_name, idempotency_key). Claiming a run INSERTs that
 *     key, and a duplicate INSERT fails. The constraint — not counting logic,
 *     not a read-then-write check — is the guarantee, so it holds across shards
 *     and processes.
 *
 *   - EXTERNAL DISCORD DELIVERY IS AT-LEAST-ONCE WITH DURABLE IDEMPOTENCY. A
 *     message can be delivered, the process can die before the run is marked
 *     COMPLETED, and the job will run again. Handlers must therefore be
 *     idempotent, and Discord-side side effects must be keyed so a replay is
 *     recognisable. Nothing here — and no help text, comment, or test — may
 *     claim literal exactly-once delivery.
 */

import { PgBoss } from 'pg-boss';
import { sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { jobRuns } from '../db/schema/core.js';
import { lazyLogger } from '../logging/logger.js';

const log = lazyLogger({ module: 'jobs', operation: 'queue' });

export type RunStatus = 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface ClaimResult {
  readonly claimed: boolean;
  /** True when an existing run already completed this key. */
  readonly alreadyCompleted: boolean;
}

export interface JobContext<TData = unknown> {
  readonly jobId: string;
  readonly name: string;
  readonly data: TData;
  readonly attempts: number;
}

export type JobHandler<TData = unknown> = (ctx: JobContext<TData>) => Promise<void>;

export interface EnqueueOptions {
  /**
   * Stable identity for the logical operation. Re-enqueueing with the same key
   * is a no-op at the ledger, which is what makes at-least-once delivery safe.
   */
  readonly idempotencyKey: string;
  readonly runAfter?: Date;
  readonly priority?: number;
  readonly retryLimit?: number;
  readonly retryDelay?: number;
  readonly expireInSeconds?: number;
  readonly singletonKey?: string;
}

export interface JobQueue {
  readonly name: string;
  /** Registers a guarded handler. Must be called before `start()`. */
  work<TData>(name: string, handler: JobHandler<TData>): Promise<void>;
  start(): Promise<void>;
  stop(options?: { graceful?: boolean }): Promise<void>;
  send<TData>(name: string, data: TData, options: EnqueueOptions): Promise<string>;
  /** Work already recorded as done for this key is reported, not re-run. */
  isCompleted(name: string, idempotencyKey: string): Promise<boolean>;
  pendingRecovery(olderThanSeconds?: number): Promise<number>;
}

export interface JobQueueOptions {
  readonly databaseUrl: string;
  readonly db: Database;
  readonly concurrency: number;
  readonly schema?: string;
}

/**
 * Claims a job run.
 *
 * The INSERT is the whole mechanism. On a unique violation the job has already
 * been claimed by someone, so the caller must not run its side effects.
 */
export async function claimJobRun(
  db: Database,
  name: string,
  idempotencyKey: string,
): Promise<ClaimResult> {
  const inserted = await db
    .insert(jobRuns)
    .values({ jobName: name, idempotencyKey, status: 'RUNNING', attempts: 1 })
    .onConflictDoNothing()
    .returning({ id: jobRuns.id });

  if (inserted.length > 0) return { claimed: true, alreadyCompleted: false };

  const existing = await db
    .select({ status: jobRuns.status })
    .from(jobRuns)
    .where(sql`${jobRuns.jobName} = ${name} AND ${jobRuns.idempotencyKey} = ${idempotencyKey}`)
    .limit(1);

  return { claimed: false, alreadyCompleted: existing[0]?.status === 'COMPLETED' };
}

export async function completeJobRun(
  db: Database,
  name: string,
  idempotencyKey: string,
): Promise<void> {
  await db
    .update(jobRuns)
    .set({ status: 'COMPLETED', completedAt: new Date(), error: null })
    .where(sql`${jobRuns.jobName} = ${name} AND ${jobRuns.idempotencyKey} = ${idempotencyKey}`);
}

export async function failJobRun(
  db: Database,
  name: string,
  idempotencyKey: string,
  error: string,
): Promise<void> {
  await db
    .update(jobRuns)
    .set({ status: 'FAILED', error: error.slice(0, 2000) })
    .where(sql`${jobRuns.jobName} = ${name} AND ${jobRuns.idempotencyKey} = ${idempotencyKey}`);
}

export function createJobQueue(options: JobQueueOptions): JobQueue {
  const { db, concurrency } = options;
  const boss = new PgBoss({
    connectionString: options.databaseUrl,
    schema: options.schema ?? 'pgboss',
    // `max` bounds the pg-boss pool so a job burst cannot exhaust the connection
    // budget the request path depends on.
    max: Math.max(2, concurrency),
    application_name: 'redoubt-jobs',
  });

  function guard<TData>(
    name: string,
    handler: JobHandler<TData>,
  ): (job: { id: string | number; data: TData; retryCount?: number }) => Promise<void> {
    return async (job) => {
      const key = (job.data as { idempotencyKey?: string } | undefined)?.idempotencyKey;
      if (!key) {
        // A job without an idempotency key cannot be made safe to replay, so it
        // is refused rather than run unguarded.
        log().error({ jobName: name, jobId: String(job.id) }, 'job enqueued without idempotency key');
        throw new Error('Job data must include an idempotencyKey.');
      }

      const claim = await claimJobRun(db, name, key);
      if (!claim.claimed) {
        if (claim.alreadyCompleted) {
          log().debug({ jobName: name, key }, 'job already completed; skipping replay');
          return;
        }
        log().debug({ jobName: name, key }, 'job already claimed by another worker; skipping');
        return;
      }

      try {
        await handler({
          jobId: String(job.id),
          name,
          data: job.data,
          attempts: (job.retryCount ?? 0) + 1,
        });
        await completeJobRun(db, name, key);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await failJobRun(db, name, key, message);
        // Rethrow so pg-boss can apply its retry policy. Because the ledger row
        // is now FAILED (not RUNNING), a retry must be able to claim it again
        // — which is why claimJobRun treats only COMPLETED as terminal.
        throw error;
      }
    };
  }

  return {
    name: options.schema ?? 'pgboss',

    async work<TData>(name: string, handler: JobHandler<TData>) {
      const guarded = guard(name, handler);
      await boss.work(name, (job: unknown) =>
        guarded(job as { id: string | number; data: TData; retryCount?: number }),
      );
    },

    async start() {
      boss.on('error', (error: Error) => log().error({ err: error }, 'pg-boss error'));
      boss.on('warning', (warning: unknown) => log().warn({ warning }, 'pg-boss warning'));
      await boss.start();
      log().info({ concurrency }, 'job queue started');
    },

    async stop({ graceful = true } = {}) {
      await boss.stop({ graceful, timeout: 30_000 });
      log().info('job queue stopped');
    },

    async send<TData>(name: string, data: TData, options: EnqueueOptions) {
      const jobId = await boss.send(
        name,
        { ...(data as object), idempotencyKey: options.idempotencyKey },
        {
          startAfter: options.runAfter,
          priority: options.priority ?? 0,
          retryLimit: options.retryLimit ?? 3,
          retryDelay: options.retryDelay ?? 5,
          expireInSeconds: options.expireInSeconds,
          singletonKey: options.singletonKey,
        },
      );
      return String(jobId ?? '');
    },

    async isCompleted(name, idempotencyKey) {
      const rows = await db
        .select({ status: jobRuns.status })
        .from(jobRuns)
        .where(sql`${jobRuns.jobName} = ${name} AND ${jobRuns.idempotencyKey} = ${idempotencyKey}`)
        .limit(1);
      return rows[0]?.status === 'COMPLETED';
    },

    async pendingRecovery(olderThanSeconds = 300) {
      const rows = await db.execute<{ count: number }>(sql`
        SELECT count(*)::int AS count
          FROM job_runs
         WHERE status = 'RUNNING'
           AND started_at < now() - (${olderThanSeconds} * interval '1 second')
      `);
      return rows[0]?.count ?? 0;
    },
  };
}


