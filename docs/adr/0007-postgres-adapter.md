# 0007: PostgreSQL behind the same interface, with one SQL text for both engines

- **Status:** accepted (Phase 1C slice 1, 2026-11-12: the adapter); the schema and shared SQL follow in later slices
- **Date:** 2026-11-12

## Context
ADR 0006 put every database call behind one async interface: `prepare` with `get`, `all`, `run` and `pluck`, plus `exec` and `tx`. Production moves to RDS PostgreSQL in Phase 1H, and the SQLite adapter stays until then, and through the 14-day rollback window after it.

The app's SQL is written with better-sqlite3's placeholders:
- **`?`** for positional values;
- **`@name`** for named ones. The scope wrapper (db/scope.js) binds `@uid`, and an unscoped statement that names `@uid` must fail rather than read every user's rows.

PostgreSQL takes only `$1..$n`. Its driver returns `bigint` and `numeric` as strings. Its transactions also behave differently from SQLite's in two ways that matter here:
- **Writers can interleave.** Under read committed, two transactions can both read, then both write. SQLite's `BEGIN IMMEDIATE` lets only one write transaction run at a time, and the read-then-write sequences checked in Phase 1B rely on that.
- **A failed statement aborts the transaction.** Every later statement in it fails, where SQLite carries on.

## Decision
- **One SQL text for both engines.** Where the engines can't share one (JSON paths, the list of tables), a small helper in db/ picks the expression by `db.engine`. Callers never branch on the engine.
- **Placeholders are rewritten at prepare** (db/placeholders.ts `toPositional`):
  - `?` and `@name` become `$n`, and a repeated name reuses its number;
  - strings, quoted identifiers and comments are skipped;
  - values bind with better-sqlite3's rules and errors (one plain object of named values, arrays spread, `undefined` as null, booleans and Dates refused), so the same mistake fails the same way on both engines. test/placeholders.test.js compares the two case by case.
- **Numbers parse as numbers** (db/postgres.ts `createPostgresPool`):
  - int8 and numeric become JS numbers, and an int8 past 2^53 throws rather than round;
  - this is set on the app's pool only, never on node-postgres's global parsers;
  - every session runs in UTC.
- **Transactions** (`createPostgresDatabase`):
  - `tx(fn)` checks out one client, and an AsyncLocalStorage routes the statements `fn` awaits to it;
  - a nested `tx` is a savepoint;
  - each transaction first takes one database-wide advisory lock, held until it ends, so write transactions run one at a time as they do on SQLite;
  - statements outside a transaction run in parallel on the pool;
  - a failed statement aborts its transaction. Code must not catch a statement error inside a transaction and carry on, and a test pins this behavior.
- **The driver is node-postgres (`pg`)** in pure JavaScript (MIT, no install scripts).
- **Tests use a real PostgreSQL** (the Phase 0 PGlite spike): CI's `postgres:18` service and a local container. Each test file gets its own database, created with C collation. Tests that need a server skip without `DATABASE_URL`.

## Alternatives considered
- **Writing SQL per engine:** two texts per query would double the review surface, and they would drift.
- **A query builder or ORM:** a rewrite of 370-odd statements for a dialect difference that comes down to a short list of spots.
- **Serializable isolation with retries instead of the lock:** a retry would rerun the body of `fn`, and that body can have side effects. The lock keeps today's guarantee exactly. Revisit when the Phase 3 queue needs parallel transactions (`SKIP LOCKED`).
- **A savepoint around every statement inside a transaction,** so a failed statement wouldn't abort it: that doubles the round trips for every write. No caller needs to carry on after an error.
- **postgres.js:** good, but `pg` is the more common driver, and the pool, the types and the RDS docs all assume it.

## Consequences
- Each later migration is written for both engines until SQLite is retired, and a parity test compares the two schemas (slice 2).
- Writes are no faster on PostgreSQL than on SQLite until the lock is revisited. At this app's scale that's fine. Reads gain parallel connections.
- Removing the SQLite adapter (after Phase 1H's rollback window) removes the placeholder layer's reason to exist. Its rewriting stays cheap, as it runs once per prepare.
