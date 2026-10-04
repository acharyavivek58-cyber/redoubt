# Development

How to work on REDOUBT. Read this before changing code.

## Requirements

- **Node 24** (the engine is pinned to `>=24`)
- **PostgreSQL 16+** — the only datastore. There is no Redis.

```bash
npm install
```

If `tsx` or `vitest` fail immediately with an esbuild error, approve the
install scripts once:

```bash
npm install-scripts approve esbuild
npm rebuild esbuild
```

## Local setup

```bash
cp .env.example .env      # then edit DISCORD_TOKEN and DATABASE_URL
npm run db:migrate        # the only process allowed to migrate
npm run dev
```

`.env` is git-ignored and ships with a placeholder token. Put the real token in
there — never in source, tests, docs, or a commit.

## Environment variables

Validated once at boot by `src/core/config/env.ts` (Zod). A missing or
malformed value stops startup with an actionable message rather than failing
later with a confusing error.

`.env` is loaded with Node's built-in `process.loadEnvFile()` — **no `dotenv`
dependency**. Loading never overrides a variable already present in
`process.env`, so a real shell export always beats the file. That matters: the
placeholder token in `.env` would otherwise overwrite a working value.

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `DISCORD_TOKEN` | **yes** | — | Fails with `DISCORD_TOKEN is not configured` when missing or still the placeholder |
| `DISCORD_CLIENT_ID` | **yes** | — | Application id |
| `DATABASE_URL` | **yes** | — | PostgreSQL connection string |
| `DATABASE_POOL_MAX` | no | `10` | |
| `DATABASE_STATEMENT_TIMEOUT_MS` | no | `10000` | Server GUC, set per session |
| `JOBS_ENABLED` | no | `true` | |
| `JOBS_CONCURRENCY` | no | `5` | |
| `SHARD_TOTAL` | no | `0` (off) | |
| `SHARD_ID` | no | — | Set automatically per spawned shard |
| `RUN_MIGRATIONS` | no | `true` | |
| `GEMINI_API_KEY` | no | — | **Optional.** Free tier only |
| `LOG_LEVEL` | no | `info` | `fatal`…`trace` |
| `LOG_PRETTY` | no | `false` | |

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Watch mode |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the built output |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint with typed rules |
| `npm test` | Correctness suite |
| `npm run perf` | Hot-path latency budgets (separate config) |
| `npm run db:generate` | Generate a migration from the schema |
| `npm run db:migrate` | Apply migrations under an advisory lock |
| `npm run db:migrate -- --status` | Report applied vs latest schema version |

## Database and migrations

- Schema is defined in `src/core/db/schema/*.ts` and exported from `index.ts`.
- Generated SQL lives in `drizzle/`. **Commit both** the schema change and the
  migration.
- Migrations run under a PostgreSQL advisory lock, so simultaneous deploys
  cannot race. Only the manager process migrates.
- Workers call `waitForSchema()` and refuse to start until the required
  version exists, rather than failing every query with an obscure error.

After changing a schema file:

```bash
npm run db:generate -- --name your_change
npx vitest run tests/unit/schema-constraints.test.ts   # asserts the generated SQL
```

That test reads **every** migration file, not just the first, and asserts the
partial-unique indexes that act as the concurrency control.

## Testing

```bash
npm test                    # everything
npx vitest run tests/unit/afk-domain.test.ts
npx vitest watch
```

Two suites are compile-time proofs. They shell out to `tsc` over a fixture and
fail if a forbidden call *compiles*:

- `tests/type-level/automod-enforcer.compile.test.ts` — AutoMod cannot reach
  Kick/Ban/Jail.
- `tests/type-level/role-workflows.compile.test.ts` — `ON_JOIN` is not
  expressible as a role workflow.

Do not rename these to `*.compiletest.ts`; vitest's include pattern is
`tests/**/*.test.ts`, so a file outside it would silently never run.

### Performance budgets

```bash
npm run perf
```

Separate from `npm test` on purpose — these assert latency budgets and are
allowed to be noisy. They cover the functions that run on **every message**:
prefix parsing, policy resolution, level derivation, AutoMod detection, and
rate limiting. If one fails, look for an accidental O(n²) or a lost cache
before touching the budget.

## Code conventions

### Structure

```
src/
  core/        cross-cutting: config, db, permissions, policies, ratelimit,
               registry, jobs, ui, logging, interactions, errors
  features/    vertical slices: afk, economy, automod, leveling, moderation,
               roles, ai, help, pulse
  shared/      types and constants used by both
```

Flow is **transport → core action → service → repository**. A feature must not
call Discord from a repository, and a repository must not build embeds.

### Embeds

`src/core/ui` is the **only** embed construction path. Use the factories in
`embeds/embed-factory.ts` and the components in `components.ts`. Never
construct an `EmbedBuilder` directly in a feature.

At most **two primary actions** per surface; anything more moves to an overflow
row. Every button must do something.

### Terminology

The public vocabulary is **Mute / Unmute**. The words `timeout`, `untimeout`,
and `timed out` must never appear in rendered output, logs, case labels, help
text, docs, or tests. Resolve labels from
`src/shared/constants/action-labels.ts`. `tests/unit/terminology.test.ts`
enforces this.

### Guild scoping

Every guild-scoped query filters on the guild id resolved from the interaction,
never on an id supplied by the caller. Cache keys include the guild id for the
same reason. `Guild A ≠ Guild B` is a tested property, not an assumption.

### Logging

Use `lazyLogger()` at module scope, not `getLogger()`. A module-level
`getLogger()` parses the environment at **import** time, which couples every
importer to boot order and makes the module untestable.

```ts
const log = lazyLogger({ module: 'thing', operation: 'service' });
log().info({ ... }, 'message');
```

Secrets are redacted by the logger's `redact` config. Never log a token, a
password, or private AFK content.

## Adding a command

1. Add a definition to `src/core/registry/manifest.ts`.
2. Write the handler. If a backing service does not exist yet, keep the honest
   `unavailable()` placeholder — **do not** add a command that pretends to work.
3. Cross-references in `relatedCommands` must resolve; `assertIntegrity()` runs
   at boot and throws otherwise.
4. Add tests. The manifest test suite enforces unique names/aliases, non-empty
   usage, owner-only correctness, and terminology.

## Adding a feature service

Follow the AFK / economy / Jail pattern:

1. `domain.ts` — pure, total functions. No database, no Discord. This is where
   the invariants live and where the tests go.
2. `service.ts` — owns the SQL. Injects any Discord operations it needs rather
   than importing the client.

Keep transactions short. **Never** hold a transaction open across a Discord or
network call; that pins a pooled connection and can deadlock under load.
