/**
 * Schema constraint tests.
 *
 * These assert the constraints that ARE the concurrency control. A missing or
 * malformed index here is not a style issue — it silently removes the
 * guarantee, so each one is pinned.
 *
 * Regression guarded: an early revision used `sql`${col} = ${value}`` for
 * partial-index predicates, which emits a bind parameter ($1) where
 * PostgreSQL requires a literal. The index looked correct in Drizzle and was
 * invalid in the generated SQL.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const drizzleDir = join(process.cwd(), 'drizzle');

function readInitSql(): string {
  const files = readdirSync(drizzleDir).filter((f) => f.endsWith('.sql')).sort();
  expect(files.length, 'expected at least one generated migration').toBeGreaterThan(0);
  // EVERY migration, not just the first: a later migration can (and does)
  // introduce load-bearing constraints. Reading only 0000 would silently stop
  // covering them.
  return files.map((f) => readFileSync(join(drizzleDir, f), 'utf8')).join('\n');
}

const SQL = readInitSql();

/** Extracts the full statement containing `indexName`. */
function statementFor(indexName: string): string {
  const statement = SQL.split('--> statement-breakpoint')
    .find((part) => part.includes(indexName));
  expect(statement, `index ${indexName} not found in migration`).toBeDefined();
  return statement!.trim();
}

describe('migration is valid PostgreSQL', () => {
  it('creates no bind parameters in index predicates', () => {
    // A `$n` inside a CREATE INDEX ... WHERE clause is invalid SQL.
    const indexStatements = SQL.split('--> statement-breakpoint')
      .filter((s) => s.includes('CREATE INDEX') || s.includes('CREATE UNIQUE INDEX'));

    for (const statement of indexStatements) {
      const whereIndex = statement.indexOf(' WHERE ');
      if (whereIndex === -1) continue;
      const predicate = statement.slice(whereIndex);
      expect(
        predicate,
        `index predicate must not contain a bind parameter: ${statement.slice(0, 90)}`,
      ).not.toMatch(/\$\d/);
    }
  });
});

describe('v15 — role purchases are uniquely ACTIVE, not uniquely historical', () => {
  it('constrains active entitlements only', () => {
    const stmt = statementFor('role_purchases_active_unique');
    expect(stmt).toContain('UNIQUE INDEX');
    expect(stmt).toContain('"guild_id","user_id","item_id"');
    expect(stmt).toContain('WHERE');
    expect(stmt).toContain('"active" = 1');
  });

  it('keeps purchase history unconstrained so refunds never block re-purchase', () => {
    // economy_purchases must NOT have a unique index on
    // (guild_id, user_id, shop_item_id) — that would permanently block a
    // legitimate purchase after a refund.
    const purchaseTables = SQL.split('--> statement-breakpoint')
      .filter((s) => s.includes('economy_purchases') && s.includes('CREATE UNIQUE INDEX'));
    for (const stmt of purchaseTables) {
      expect(stmt).not.toMatch(/shop_item_id"\)(\s|$)/);
    }
  });
});

describe('v12 — at most one ACTIVE jail per member per guild', () => {
  it('uses a partial unique index scoped to ACTIVE status', () => {
    const stmt = statementFor('jails_guild_user_active_unique');
    expect(stmt).toContain('UNIQUE INDEX');
    expect(stmt).toContain('"guild_id","user_id"');
    expect(stmt).toMatch(/WHERE\s+"jails"\."status" = 'ACTIVE'/);
  });
});

describe('v15 — level rewards are unique per REWARD, not per level', () => {
  it('keys on reward_id so one level can grant several rewards', () => {
    const stmt = statementFor('level_rewards_granted_unique');
    expect(stmt).toContain('UNIQUE INDEX');
    // The regression this guards: keying on (guild_id,user_id,level,season_id)
    // would let granting a role BLOCK the currency reward at the same level.
    expect(stmt).toContain('"reward_id"');
    expect(stmt).not.toMatch(/UNIQUE INDEX[^;]*\("guild_id","user_id","level"/);
  });
});

describe('v17 — unified reward delivery across all reward sources', () => {
  it('uniquely identifies one logical delivery operation per reward', () => {
    const stmt = statementFor('reward_deliveries_unique');
    expect(stmt).toContain('UNIQUE INDEX');
    expect(stmt).toContain('"source"');
    expect(stmt).toContain('"source_id"');
    expect(stmt).toContain('"reward_id"');
  });
});

describe('v19/v21 — AFK period identity and guild isolation', () => {
  it('makes afk_period_id globally unique', () => {
    expect(statementFor('afk_status_period_unique')).toContain('("afk_period_id")');
  });

  it('additionally scopes periods per guild', () => {
    const stmt = statementFor('afk_status_guild_period_unique');
    expect(stmt).toContain('UNIQUE INDEX');
    expect(stmt).toContain('"guild_id","afk_period_id"');
  });

  it('allows at most one AFK state per member per guild', () => {
    const stmt = statementFor('afk_status_active_unique');
    expect(stmt).toContain('UNIQUE INDEX');
    expect(stmt).toContain('"guild_id","user_id"');
    expect(stmt).toContain("'AFK'");
  });

  it('makes repeated back-notification clicks idempotent per period', () => {
    const stmt = statementFor('afk_back_notifications_unique');
    expect(stmt).toContain('UNIQUE INDEX');
    expect(stmt).toContain('"subscriber_id","afk_period_id"');
  });

  it('prevents duplicate logical return-announcement operations', () => {
    const stmt = statementFor('afk_return_actions_unique');
    expect(stmt).toContain('UNIQUE INDEX');
    expect(stmt).toContain('"afk_period_id","action_type"');
  });
});

describe('v13 — idempotency and numbering guarantees', () => {
  it('makes job execution idempotent by job name and key', () => {
    expect(statementFor('job_runs_name_key_unique')).toContain('"job_name","idempotency_key"');
  });

  it('numbers moderation cases uniquely per guild', () => {
    expect(statementFor('mod_cases_guild_number_unique')).toContain(
      '"guild_id","case_number"',
    );
  });

  it('archives season standings uniquely per season and member', () => {
    expect(statementFor('season_leaderboards_unique')).toContain('"season_id","user_id"');
  });

  it('permits only one daily claim per member per day', () => {
    // Composite PK is the DB-level duplicate-claim guarantee. Assert the
    // columns rather than the generated constraint name, which Drizzle
    // derives from the column set.
    const stmt = SQL.split('--> statement-breakpoint').find((s) =>
      s.includes('economy_daily_claims_guild_id_user_id_claim_date_pk'),
    );
    expect(stmt).toContain('PRIMARY KEY("guild_id","user_id","claim_date")');
  });
});

describe('v14 — giveaway claims remain staff-authorized', () => {
  it('indexes claims awaiting a staff decision', () => {
    const stmt = statementFor('giveaway_claims_pending_idx');
    expect(stmt).toContain('WHERE');
    expect(stmt).toContain('"staff_decision" IS NULL');
  });
});

describe('applications — one open submission per member per form', () => {
  it('scopes uniqueness to PENDING so a decided form can be re-applied', () => {
    const stmt = statementFor('applications_open_unique');
    expect(stmt).toContain('UNIQUE INDEX');
    expect(stmt).toContain('"guild_id","user_id","form_id"');
    expect(stmt).toContain(`WHERE "application_submissions"."status" = 'PENDING'`);
  });
});

describe('reports — one open report per reporter per target', () => {
  it('prevents duplicate-report spam and parallel reports on one target', () => {
    const stmt = statementFor('reports_open_unique');
    expect(stmt).toContain('"guild_id","reporter_id","target_user_id"');
    expect(stmt).toContain(`WHERE "reports"."status" = 'OPEN'`);
  });

  it('indexes the staff review queue by status and priority', () => {
    const stmt = statementFor('reports_queue_idx');
    expect(stmt).toContain('"guild_id","status","priority"');
  });
});

describe('appeals — one open appeal per contested case', () => {
  it('stops a member flooding staff with parallel appeals for one action', () => {
    const stmt = statementFor('appeals_case_unique');
    expect(stmt).toContain('"guild_id","case_id"');
    expect(stmt).toContain(`WHERE "appeals"."status" = 'OPEN'`);
  });
});

describe('temporary voice — two members never share a channel', () => {
  it('scopes the unique channel index to ACTIVE sessions', () => {
    const stmt = statementFor('temp_voice_active_channel_unique');
    expect(stmt).toContain('UNIQUE INDEX');
    expect(stmt).toContain('"guild_id","channel_id"');
    expect(stmt).toContain(`WHERE "temp_voice_channels"."status" = 'ACTIVE'`);
  });
});

describe('verification — single-use by construction', () => {
  it('allows only one captcha row per member per guild', () => {
    const stmt = statementFor('verification_captcha_user_unique');
    expect(stmt).toContain('UNIQUE INDEX');
    expect(stmt).toContain('"guild_id","user_id"');
  });

  it('indexes members awaiting verification', () => {
    const stmt = statementFor('verification_pending_idx');
    expect(stmt).toContain(`WHERE "verification_state"."status" = 'PENDING'`);
  });
});

describe('search — re-indexing updates in place', () => {
  it('keys documents by guild and external id, not a surrogate key', () => {
    const stmt = SQL.split('--> statement-breakpoint').find((s) =>
      s.includes('search_documents_guild_id_external_id_pk'),
    );
    expect(stmt).toContain('PRIMARY KEY("guild_id","external_id")');
  });
});

describe('self-assign — selection only, never automatic', () => {
  it('records a user selection keyed by guild, user, and role', () => {
    const stmt = SQL.split('--> statement-breakpoint').find((s) =>
      s.includes('self_role_selections_guild_id_user_id_role_id_pk'),
    );
    expect(stmt).toContain('PRIMARY KEY("guild_id","user_id","role_id")');
  });

  it('models no join-time role grant table at all', () => {
    // v-plan: role assignment happens only via verification, application
    // approval, role purchase, self-assign, and level reward. There is no
    // auto-role-on-join table, so none may exist.
    expect(SQL).not.toMatch(/CREATE TABLE "auto_role_assignments"/);
    expect(SQL).not.toMatch(/CREATE TABLE "join_roles"/);
    expect(SQL).not.toMatch(/CREATE TABLE "autoroles_on_join"/);
  });
});