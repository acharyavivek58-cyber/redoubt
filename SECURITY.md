# Security

## The model

REDOUBT runs with the permissions a server owner grants it and nothing more.
Three properties hold throughout:

1. **Guild isolation.** Every guild-scoped query filters on the guild id
   resolved from the interaction, never on an id supplied by the caller. One
   guild's data is never visible to another.
2. **Least privilege by default.** Features require explicit permissions or
   staff roles. Nothing escalates on its own.
3. **Deny by default.** A command that cannot prove authorization does not run.

## Secrets

- Tokens, database passwords, and API keys are **environment variables only**.
  Nothing sensitive is committed, logged, or rendered.
- `.env` is git-ignored. `.env.example` is committed and contains placeholders
  only.
- The logger redacts `token`, `*.token`, `password`, `config.discord.token`,
  and `apiKey` paths at every level, including `trace`.
- The Discord token is validated before startup. A missing token — or the
  placeholder still sitting in `.env` — fails with
  `DISCORD_TOKEN is not configured`, and the error never contains the value.

**If you ever commit a real secret, deleting it in a later commit is not
enough.** The value remains in history and must be rotated.

## Owner-only operations

`/backup` and `/template` — every subcommand, both transports — are gated on
the **current** `guild.ownerId`.

Insufficient on their own, and treated as insufficient:

- Administrator
- Manage Guild / Manage Roles / Manage Messages
- Any configured staff role
- Having installed the bot

`isCurrentGuildOwner()` is a plain comparison against the live guild owner, read
fresh on every call — never a cached value, never a `created_by` column on a
backup row. `created_by` is informational only.

**Ownership can change mid-operation.** Any destructive preview→execute path
re-verifies immediately before mutating via `reauthorizeBeforeMutation()`. If
ownership changed in between, the result is `OWNER AUTHORIZATION LOST`, zero
mutation, and authorization never transfers to the old caller.

## Authorization

`checkPermissions()` performs eight checks, including the ones that are easy to
skip:

- Discord permission bit
- Module enabled for the guild
- Staff role membership
- Role hierarchy — the actor must outrank the target
- The bot must outrank the target
- An actor cannot act on themselves
- The guild owner cannot be moderated
- The bot cannot moderate itself

Denied paths are **generic**. The user learns they may not act and nothing more
— not whether the target exists, what their role is, or what the real blocker
was. The specific reason is written to the audit log for operators.

## Command injection and unsafe SQL

- All SQL uses Drizzle's parameter binding. Values are never interpolated.
- The two places that use `sql.raw` are internal constants — an advisory-lock
  key and a partial-index predicate — never user input. A test asserts no bind
  parameter (`$1`) appears in any generated index predicate, because
  PostgreSQL rejects those.
- No shell execution anywhere in the codebase.
- No dynamic code evaluation.

## Interaction handling

- Deferred immediately; edited once at the end.
- `interaction.isRepliable()` is checked before every edit, so an expired token
  cannot throw.
- The loading state only paints after a short delay, so instant operations do
  not flash a fake spinner.
- Internal failures render **only a correlation ID**. Never a stack trace, SQL
  error, or provider message.

## AutoMod safety

AutoMod's ceiling is **MUTE**. It can `LOG`, `DELETE`, `WARN`, and `MUTE`. It
cannot Kick, Ban, or Jail.

This is structural, not conventional:

- `AutoModEnforcer` has no such methods, so calling one is a **compile error**.
- ESLint blocks importing the jail/ban/kick services from
  `src/features/automod/**`, closing the indirect path a type cannot see.
- A test runs `tsc` over a fixture and fails if the ceiling is ever raised.

High-severity detections alert staff with an **informational recommendation**.
No destructive staff action ever happens automatically.

Detection is tuned to avoid false positives, because a detector that fires on
innocent text is worse than one that misses an obfuscation:

- Word-boundary matching — `ass` never matches `class` or `bass`.
- Code blocks are blanked before matching, so pasting a log line is not spam.
- A confidence gate: a single low-confidence match never punishes.
- Obfuscated matches are recorded one step below a plain match, and staff can
  see whether the hit came from the original or the normalized text.

## Privacy

**AFK messages are private.** The AFK message body is excluded from:

- general logs and debug output
- public channels
- Control Center general views
- analytics
- error logs

**AFK period ids are internal.** They are never shown to ordinary users; they
appear only as diagnostic log fields. Queued AFK messages carry both `guild_id`
and `afk_period_id`, and the composite uniqueness makes cross-guild association
impossible.

Search indexes store a deterministic digest of a query, never the raw query.

## Rate limiting

Two independent layers:

- **Per-guild token buckets** keyed `${guildId}:${key}`, so one guild's traffic
  can never throttle another's.
- **Per-command cooldowns**, checked *before* any database work.

Staff and cleanup operations use the non-consuming `isOnCooldown` check, so a
moderator responding to an incident is never locked out by their own automation.

## Transactions and delivery

- Transactions contain **no** network calls. Discord interactions always happen
  after commit.
- Migrations run under an advisory lock; workers never migrate and refuse to
  boot against a half-migrated schema.
- Database orchestration is exactly-once (UNIQUE constraint). External Discord
  delivery is at-least-once with durable idempotency. The codebase does not
  claim otherwise anywhere.

## Dependencies

CI runs `npm audit` and fails on high or critical severity findings. Deps are
pinned to exact versions.

## Reporting

Open a private security advisory on the repository. Please do not open a public
issue for a vulnerability.

## Out of scope

Stated plainly so the boundary is not mistaken for coverage:

- REDOUBT cannot defend a server against a malicious **owner**. If an owner
  grants the bot Administrator, the owner can do anything the bot can.
- It does not replace Discord's own rate limits.
- AI features are advisory only. A model that is unavailable, misconfigured, or
  answering nonsense degrades to "allow" — the deterministic rules remain in
  force, and no destructive action is ever taken from an AI suggestion.
