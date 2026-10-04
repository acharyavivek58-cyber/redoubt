# REDOUBT

An all-in-one Discord server management bot for large, multi-guild communities.

Built for guilds that have outgrown a pile of single-purpose bots and want one
auditable system instead of fifteen.

---

## Design commitments

These are the rules the codebase is built to make true, not aspirations. Each
one has code and a test behind it.

### Public vocabulary is Mute/Unmute

Discord's native timeout mechanism is an **internal** implementation detail.
The words "timeout", "untimeout", and "timed out" must never appear in any
rendered output, log line, case label, help text, doc, or test. Every
user-facing surface resolves its label through
[`src/shared/constants/action-labels.ts`](src/shared/constants/action-labels.ts),
and `tests/unit/terminology.test.ts` fails the build if one leaks.

### AutoMod's ceiling is MUTE

AutoMod can `LOG`, `DELETE`, `WARN`, and `MUTE`. It cannot Kick, Ban, or Jail —
not by convention, but structurally:

- [`src/features/automod/enforcer.ts`](src/features/automod/enforcer.ts) defines
  no such methods, so calling one is a **compile error**.
- `eslint.config.js` blocks importing the jail/ban/kick services from
  `features/automod/**`, closing the indirect path.
- `tests/type-level/automod-enforcer.compile.test.ts` runs `tsc` over a fixture
  and fails if the ceiling is ever raised.

High-severity detections alert staff with an **informational recommendation**.
No destructive staff action ever happens automatically.

### Precision before punishment

A detector that fires on innocent text is worse than one that misses an
obfuscation, because it punishes members for nothing. Matching is
boundary-aware (`ass` never matches `class`), code blocks are blanked before
matching so a developer pasting a log line is not a spammer, and a single
low-confidence match never results in punishment. See
[`src/features/automod/detectors.ts`](src/features/automod/detectors.ts).

### Roles are assigned through exactly five workflows

Verification click, application approval, role purchase, self-assign selection,
and level reward. **There is no auto-role-on-join**, and that is enforced by
the type system: the `RoleWorkflow` union has no `ON_JOIN` member, so adding
one is a compile error.
`tests/type-level/role-workflows.compile.test.ts` proves it.

### One centralized policy engine

Exemptions are resolved once in
[`src/core/policies/exclusions/resolver.ts`](src/core/policies/exclusions/resolver.ts)
and consulted by AutoMod, anti-spam, leveling, invites, logging, and economy.
No feature reimplements exemption logic.

Ordering is **deny-overrides-allow**: a matching `SKIP` beats any `ALLOW` at
any priority. Exemptions are **scope-specific** — a rule scoped to `caps`
exempts only the caps rule. A `GLOBAL`-domain rule is what suppresses across
every subsystem; a domain-scoped rule must not leak into another one.

### Owner-only operations

`/backup` and `/template` are gated on the **current** `guild.ownerId` — the
entire surface, every subcommand, both transports. Admin, Manage Guild, a staff
role, and being the bot installer are all insufficient. Authorization is checked
at request start **and** re-checked immediately before any mutation; if
ownership changed mid-operation the result is `OWNER AUTHORIZATION LOST`, zero
mutation, and authorization never transfers.

### Currency is virtual

Guild-scoped, non-cashable, non-convertible, and non-transferable between
guilds. There is no cash-out path in the code, and
`assertNoRealMoneyConversion` exists so that "no real money" is an *enforced*
invariant rather than a comment someone can route around.

### Exactly-once, stated honestly

Per v21 §A:

- **Database orchestration is exactly-once.** `job_runs` has a UNIQUE
  constraint on `(job_name, idempotency_key)`. Claiming a run inserts that key;
  a duplicate insert fails. The constraint is the guarantee.
- **External Discord delivery is at-least-once with durable idempotency.** A
  message can be delivered, the process can die before the run is marked
  complete, and the job will run again. Handlers are therefore idempotent.

Nothing in this repository — no comment, help text, or test — claims literal
exactly-once delivery.

### The progression invariant

```
level === levelFromSeasonXp(season_xp)  AND  xp_in_level === xpIntoLevel(season_xp)
```

All three values are derived from the **new** `season_xp` inside one
transaction holding `SELECT … FOR UPDATE`, so concurrent awards serialize and
the invariant cannot drift. Rewards are claimed in-transaction but delivered
only **after commit**. `lifetime_xp` never resets; season leaderboards are
frozen before rollover.

### The AutoMod ceiling, AFK, and Jail

- **AFK** — the return claim is a single atomic `UPDATE`; the returned-row
  count *is* the ownership token, so exactly one caller wins. `RETURNED` is
  durable and resumable; `FINALIZED` is immutable. Provenance gating (only a
  human's message may change state) is the loop protection.
- **Jail** — a re-jail **carries the original captured roles forward** rather
  than re-capturing, so a member can never end up permanently stuck at the jail
  role. Every expiry carries an operation id and version; a superseded job
  matches zero rows and performs no Discord writes. Restoration checks
  *effective* permissions — a channel `DENY` beats another role's `ALLOW` — and
  reports honestly when a role was deleted mid-jail.

## What works today

Implemented and tested: the command registry and manifest, the executor both
transports share, `$help`, `$pulse`, the AFK service, the economy service
(atomic debit and purchase reconciliation), the Jail service, leveling with the
progression invariant, AutoMod detection, the centralized policy engine, rate
limiting and cooldowns, the job queue with `job_runs` idempotency, and the
migration runner.

Commands whose backing feature is not wired yet return an honest
"not available in this server yet" rather than pretending to succeed. See
[ARCHITECTURE.md](ARCHITECTURE.md) for the layering and
[DEVELOPMENT.md](DEVELOPMENT.md) for how to add one.

---

## Stack

| Concern | Choice | Why |
| --- | --- | --- |
| Runtime | Node 24 | Native TS-adjacent tooling, stable ESM |
| Language | TypeScript 6 (strict, `noUncheckedIndexedAccess`) | The invariants above are compile-checked |
| Discord | discord.js 14 | Mature, typed gateway |
| Database | PostgreSQL 16+ | Constraints are the concurrency control |
| ORM | Drizzle 0.45 | SQL stays visible; partial indexes are first-class |
| Jobs | pg-boss 12 | Queues in the **same** Postgres — no Redis, no second bill |
| Validation | Zod 4 | One schema for env and commands |
| AI | `ai` + `@ai-sdk/google` | **Optional**, free tier only |
| Logging | Pino 10 | Structured, low overhead |
| Tests | Vitest 5 | Fast, native TS |

PostgreSQL is the **only** datastore. There is no Redis, no BullMQ, and no
external cache to operate.

---

## Getting started

```bash
npm install
cp .env.example .env      # fill in DISCORD_TOKEN, DISCORD_CLIENT_ID, DATABASE_URL
npm run db:migrate        # the ONLY process that may migrate
npm run dev
```

`.env` is git-ignored and ships with a placeholder token. Put your real token
there — never in source, tests, docs, or a commit. The bot refuses to start
with `DISCORD_TOKEN is not configured` if it is missing or still the
placeholder.

Full variable reference: [DEVELOPMENT.md](DEVELOPMENT.md#environment-variables).

### Environment

`GEMINI_API_KEY` is **optional**. With no key the bot runs normally and every
AI feature disables itself cleanly. There is no paid fallback.

---

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Watch mode |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the built output |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint, typed rules |
| `npm test` | Correctness suite |
| `npm run perf` | Hot-path latency budgets |
| `npm run db:generate` | Generate a migration from the schema |
| `npm run db:migrate` | Apply migrations (advisory-locked) |

---

## Deployment shape

Three modes, chosen purely from configuration:

- **Single process** (default) — one client, one job queue, no cluster.
- **Manager** — spawns shards via `ShardingManager`, owns the job queue, and is
  the only process permitted to migrate.
- **Worker** — one shard, spawned by the manager. Waits for the schema gate and
  **never** migrates.

Migrations run under a PostgreSQL advisory lock, so simultaneous deploys cannot
race. Workers poll for the schema marker and refuse to start until it exists,
rather than failing every query with an obscure error.

Uncaught exceptions are **not** swallowed: the process logs, stops accepting
work, releases resources, and exits non-zero so the supervisor restarts into a
known-good state.

---

## Verification

```bash
npm run typecheck && npm run lint && npm test && npm run perf && npm run build
```

The suite covers the invariants above rather than just exercising code paths.
Two of them are **compile-time** guarantees — the suite shells out to `tsc` and
fails if a forbidden call compiles. That is how "AutoMod can never ban" and
"there is no auto-role-on-join" stay true as the codebase grows.

CI runs the same checks on every push and pull request, plus an `npm audit`
gate and a check that `.env` is not tracked.

## Deployment

`Dockerfile`, `.dockerignore`, and `render.yaml` are included and match this
architecture: Node 24, `npm run build`, `node dist/index.js`, PostgreSQL only.

Migrations are a **separate manual step**, not an automatic one. Workers refuse
to boot against a half-migrated schema, so `npm run db:migrate` must complete
before the service starts.

See [DEVELOPMENT.md](DEVELOPMENT.md) for the full deployment notes.

## Further reading

- [ARCHITECTURE.md](ARCHITECTURE.md) — request flow, layering, and which
  invariant is enforced by which mechanism
- [SECURITY.md](SECURITY.md) — the security model and its limits
- [DEVELOPMENT.md](DEVELOPMENT.md) — setup, migrations, testing, conventions
