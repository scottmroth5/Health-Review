# 0007: PostgreSQL behind the same interface, with one SQL text for both engines

- **Status:** accepted (Phase 1C slice 1, 2026-11-12: the adapter; slice 2, 2026-11-13: the schema; slice 3, 2026-11-13: the shared SQL; slice 4, 2026-11-13: the whole suite on both engines)
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
- **The shared SQL** (slice 3):
  - the app's SQL is rewritten where only SQLite accepted it: `"end"` quoted, `ON CONFLICT` for `INSERT OR`, `CASE` for a two-argument `MAX`, every selected column grouped or aggregated, `LOWER(x) LIKE` where SQLite's `LIKE` ignored case, and flags returned as 1 or 0 rather than a comparison (PostgreSQL returns true and false);
  - what cannot be shared is in db/dialect.js (`jsonText`, `listTables`, `tableColumns`, `primaryKey`, `isUniqueViolation`), which picks by `db.engine`;
  - a statement that may fail on a duplicate inside a transaction uses `ON CONFLICT`, because catching the error would leave a PostgreSQL transaction aborted;
  - test/sql-postgres.test.js asks PostgreSQL to prepare every SQL statement written out in the code against the baseline schema. Preparing plans a statement without running it, so the check needs no rows, and it fails on any statement that wouldn't run or that returns a boolean.
- **The driver is node-postgres (`pg`)** in pure JavaScript (MIT, no install scripts).
- **The schema** (slice 2, db/pg/001-baseline.sql and db/pg/migrate.js):
  - one baseline migration equal to the SQLite schema through migration 033, with SQLite's column order (`SELECT *` returns columns in that order);
  - `INTEGER` is `bigint`, as SQLite's integers are 64-bit; a rowid key is a `bigint` identity column; `REAL` is `double precision`;
  - `TEXT COLLATE NOCASE` (medication and lab test names) is `citext`. On a C-ctype database it folds ASCII case only, as NOCASE does, so equality, uniqueness and sorting need no query changes;
  - the store refuses a database that sorts or folds text differently from SQLite, checked by behavior so any locale provider is covered;
  - migrations run under a session advisory lock, each in its own transaction, recorded in `schema_migrations` like SQLite's;
  - every later SQLite migration gets a PostgreSQL twin under the same id, and test/schema-parity.test.js compares the two schemas table by table (it caught each of 14 deliberate changes to the baseline).
- **Tests use a real PostgreSQL** (the Phase 0 PGlite spike): CI's `postgres:18` service and a local container. Tests that need a server skip without `DATABASE_URL`.
- **The whole suite runs on either engine** (slice 4):
  - `TEST_DB=postgres` makes every test store a fresh PostgreSQL database. Each is a copy of a migrated template database, built once per schema version (its name carries a hash of the baseline and the runner), because copying takes milliseconds where migrating takes about a second. A store is dropped when closed, and any left open are closed at exit.
  - Tests seed through the async interface, as the app writes, so one test text serves both engines. Tests of SQLite itself (its migrations, the sync guard, backup, restore, the demo refresh) keep a SQLite store on either run.
  - CI runs time zone × engine: four jobs.
  - test/cross-engine.test.js builds the demo's made-up data on SQLite, copies it row for row into PostgreSQL (test/copy-rows.js, the start of 1E's migration script), and requires every GET route and view to answer byte for byte the same. This catches what no single-engine test can: rows that come back in a different order.

## Alternatives considered
- **Writing SQL per engine:** two texts per query would double the review surface, and they would drift.
- **A query builder or ORM:** a rewrite of 370-odd statements for a dialect difference that comes down to a short list of spots.
- **Serializable isolation with retries instead of the lock:** a retry would rerun the body of `fn`, and that body can have side effects. The lock keeps today's guarantee exactly. Revisit when the Phase 3 queue needs parallel transactions (`SKIP LOCKED`).
- **A savepoint around every statement inside a transaction,** so a failed statement wouldn't abort it: that doubles the round trips for every write. No caller needs to carry on after an error.
- **A unique index on `LOWER(name)` instead of citext:** uniqueness would match, but every query comparing or sorting those names would need rewriting to get NOCASE's behavior. citext is a trusted extension, available on RDS and in the postgres:18 image.
- **`integer` (32-bit) for integer columns:** smaller, but narrower than SQLite's, so a value SQLite accepts could fail on PostgreSQL.
- **postgres.js:** good, but `pg` is the more common driver, and the pool, the types and the RDS docs all assume it.

## Consequences
- Each later migration is written for both engines until SQLite is retired, and a parity test compares the two schemas (slice 2).
- The account export lists each table's rows in primary key order. SQLite's rowid (insertion) order has no PostgreSQL counterpart. The rows themselves are unchanged.
- An ORDER BY names enough columns to break every tie, because rows tied on the sort keys come back in no set order, and the two engines pick different ones. The cross-engine routes found one (the Log workout form's exercise names, now by count, then name). NULLs sort first on SQLite and last on PostgreSQL, and the demo data showed no route where that changes an answer.
- PostgreSQL types a bare bound parameter in a select list as text, so a value selected back as a column is wrapped in CAST. No app query does this; a test did.
- A test suite four times as long in CI (time zone × engine), which runs in parallel jobs.
- Writes are no faster on PostgreSQL than on SQLite until the lock is revisited. At this app's scale that's fine. Reads gain parallel connections.
- Removing the SQLite adapter (after Phase 1H's rollback window) removes the placeholder layer's reason to exist. Its rewriting stays cheap, as it runs once per prepare.
