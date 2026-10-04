# Architecture

## The shape of a request

```
Discord (message or interaction)
        │
        ▼
  transport adapter          prefix  |  slash
        │                    thin: parse, dispatch, render
        ▼
  core action                executeCommand() — one path for both transports
        │
        ├── owner gate        current guild.ownerId, nothing else
        ├── permissions      checkPermissions() — role hierarchy included
        ├── rate limit        before any database work
        ├── policy exemption  centralized resolver
        │
        ▼
  service                    business rules, state machines, transactions
        │
        ▼
  repository                 SQL only; no Discord, no UI
```

Two rules make this hold together:

- **Both transports are thin.** They parse and render. Authorization, rate
  limiting, exemption, and error handling live in the core action, so the two
  surfaces cannot drift.
- **Nothing crosses a layer backwards.** A repository never calls Discord. A
  service never builds an embed. UI never runs SQL.

## Directories

| Path | Responsibility |
| --- | --- |
| `src/core/config` | Env validation, guild config cache |
| `src/core/db` | Schema, client, migration gate, migrate CLI |
| `src/core/errors` | Typed error hierarchy, safe user messages |
| `src/core/interactions` | Defer guard, edit-reply discipline |
| `src/core/jobs` | pg-boss queue, `job_runs` idempotency ledger |
| `src/core/logging` | Pino logger, audit registry |
| `src/core/permissions` | Eight checks, owner gate, revalidation |
| `src/core/policies` | Centralized exclusion engine + repository |
| `src/core/ratelimit` | Token buckets, cooldowns |
| `src/core/registry` | Command registry, manifest, executor, prefix parser |
| `src/core/ui` | Themes, embed factories, components, panels |
| `src/features/*` | Vertical slices, each with `domain.ts` + `service.ts` |
| `src/shared` | Types and constants shared by both |

## Why `domain.ts` is separate

Every feature splits pure logic from persistence:

- **`domain.ts`** — total functions, no I/O. State machines, plan builders,
  validators. This is where the invariants live, and where the bulk of the
  tests are, because these tests need neither a database nor Discord.
- **`service.ts`** — owns the SQL and injects Discord operations it needs.

This is why the AFK, economy, and Jail invariants are testable in milliseconds.
A test that proves "a re-jail carries the original captured roles forward"
should not need Postgres.

## Invariants and where they are enforced

Some rules are enforced by the type system, some by database constraints, and
some by runtime code. This table says which is which, because the strength of a
guarantee is only as good as its enforcement mechanism.

| Rule | Enforced by |
| --- | --- |
| AutoMod cannot Kick/Ban/Jail | **Type**: no such members exist on `AutoModEnforcer`. **Lint**: `no-restricted-imports` blocks importing those services from `features/automod/**` |
| No auto-role-on-join | **Type**: `RoleWorkflow` has no `ON_JOIN` member |
| Owner-only backup/template | **Runtime**: `isCurrentGuildOwner()` reads the live owner; re-checked before mutation |
| Public vocabulary is Mute/Unmute | **Runtime**: centralized labels + a test that scans for forbidden terms |
| Exactly-once DB orchestration | **Database**: `UNIQUE (job_name, idempotency_key)` on `job_runs` |
| At-most-one active jail per member | **Database**: partial unique index `WHERE status = 'ACTIVE'` |
| One open application per member | **Database**: partial unique index `WHERE status = 'PENDING'` |
| Two members never share a temp-voice channel | **Database**: partial unique index `WHERE status = 'ACTIVE'` |
| AFK period cannot cross guilds | **Database**: unique on `afk_period_id` **and** on `(guild_id, afk_period_id)` |
| Return claim has exactly one winner | **Database**: the row count of a single atomic `UPDATE` |
| Level/xp_in_level/season_xp agree | **Runtime**: all three derived from the new total inside one `FOR UPDATE` transaction |
| Reward delivered once | **Database**: unique on `(guild_id, user_id, reward_id, season_id)` |

The pattern: **anything expressible as a constraint is a constraint.** Runtime
checks guard what the database cannot.

## Concurrency

### Atomic claims, not check-then-act

Where a race matters, the winner is decided by the database, not by a prior
read:

- **Economy debit** — `UPDATE … WHERE balance >= amount RETURNING balance`. Two
  concurrent purchases cannot both pass a read-then-write check.
- **AFK return** — `UPDATE … WHERE period_status = 'ACTIVE' AND afk_period_id = $id`.
  The returned-row count *is* the ownership token.
- **Jail release** — the expiry job is scoped by `(operation_id, version)`, so a
  superseded job matches zero rows and performs no Discord writes.

### Transactions

Transactions are short and contain no network calls. Any Discord interaction
happens **after** commit, because a transaction held across a network call pins
a pooled connection and deadlocks under load.

This is why `leveling` enqueues reward delivery after the transaction returns:
a rolled-back award must never enqueue anything.

### Isolation between shards

Shards partition guilds. Every guild-scoped query filters on the guild id
resolved from the interaction, and every cache key includes it, so one shard can
never serve another's data.

## Jobs

pg-boss on the same PostgreSQL instance. No Redis, no second datastore.

**The honesty rule (v21 §A):**

- **Database orchestration is exactly-once.** Claiming a run `INSERT`s its
  `(job_name, idempotency_key)`. A duplicate insert fails. The constraint is the
  guarantee.
- **External Discord delivery is at-least-once with durable idempotency.** A
  message can be delivered, the process can die before the run is marked
  complete, and the job runs again. Handlers are therefore idempotent.

Nothing in this codebase claims literal exactly-once delivery.

Jobs without an idempotency key are **refused** rather than run unguarded,
because they cannot be made safe to replay.

## Caching

Two caches, both explicitly invalidated rather than treated as authority:

- **Guild config** (prefix, accent, modules, settings) — write-through, so a
  `setPrefix` updates the cached copy. A stale prefix is the kind of bug that
  only shows up in production.
- **Policy rules** — read on the hot path of every message, invalidated on write.

Neither cache is a source of truth. Every mutation writes through to PostgreSQL
first; the cache exists to avoid a query per message, never to decide anything.

A read failure serves defaults rather than throwing, so a database blip cannot
take the bot down.

## Migrations and workers

Migrations run under a PostgreSQL advisory lock with a bounded wait. Only the
manager process migrates.

Workers call `waitForSchema()` and **refuse to start** until the required
version is recorded. A worker booting against a half-migrated schema would fail
every query with an obscure error; refusing to boot fails loudly and correctly.

## Shutdown

Explicit and fail-loud. `SIGINT`/`SIGTERM` drain and exit `0`. An uncaught
exception logs with a correlation ID, stops accepting work, releases resources,
and exits **non-zero** so the supervisor restarts into a known-good state.

Nothing is swallowed. A second signal during shutdown does not start a second
teardown.
