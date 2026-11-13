# 0008: Move the data with a verified copy, and keep the way back

- **Status:** accepted (Phase 1E, 2026-11-13: the tools; the production rehearsal is the owner's step before cutover in 1H)
- **Date:** 2026-11-13

## Context
ADR 0007 put the app on both engines, with one SQL text and a PostgreSQL schema that matches SQLite's table by table. At cutover (1H), every user's data moves from the SQLite file to PostgreSQL. For the 14 days after, a rollback has to be able to bring it back.

The copy has to meet four requirements:
- **Lossless, and proven so,** not assumed.
- **Silent about content:** the tools run against real health data, so nothing they print may contain a stored value, a user id or an email.
- **Explicit about stored values PostgreSQL would refuse.** SQLite lets an INTEGER column hold text, which PostgreSQL's bigint refuses. PostgreSQL text also can't hold a NUL character, and JavaScript rounds an integer past 2^53. These must be found before the copy, not halfway through it.
- **Never a merge** into a database that already holds data.

## Decision
- **One module, db/transfer.js, on the async interface for both sides,** so each direction uses the same code:
  - `tableOrder`: parents first, by foreign key;
  - `checkSameSchema`: the same tables, columns and column order, at the same migration;
  - `copyAll`: one target transaction, primary key order, batched inserts, identity sequences reset;
  - `audit`, `fingerprint` and `compare`.
- **Audit first.** The audit reads SQLite's own `typeof()` per column and counts each value PostgreSQL would refuse or JavaScript would change, as a failure. A number in a text column is counted as a warning, since it becomes its text. The migrate script stops on any failure before connecting to PostgreSQL.
- **The empty-target rule.** The target must be freshly migrated: only the owner row its migrations seed, which the copy replaces. Anything else is refused.
- **Verification by fingerprint.** For each table, it takes the row count and a SHA-256 per user over the rows in primary key order, each value normalized by its column's type: numbers as numbers, text as text, null as null. Both sides are hashed the same way after the copy, and the scripts report each table's counts and match, then PASS or FAIL. Group keys are hashes of user ids, so a report never names a user.
- **The source is never opened in place.** The migrate script takes a checked copy (VACUUM INTO, integrity check) into a new OS temp folder, deleted on every exit path, as the backup does.
- **The way back is the same copy in reverse.** scripts/export-to-sqlite.js writes a new SQLite file made with the SQLite migrations. It never overwrites a file, and it deletes its own file when verification fails.
- **Rehearsed on made-up data in CI on every push:** the demo database goes to PostgreSQL and back, and the round trip's fingerprint must equal the original's. The production copy is rehearsed once on the owner's server, against a throwaway PostgreSQL held in memory, with counts only, before the cutover window.

## Alternatives considered
- **pgloader:** it handles SQLite, but its type casts are its own. It would convert or drop the values the audit is there to find, and it adds a tool to the image. It has no verification step either.
- **sqlite3 `.dump` loaded into psql:** the dump's SQL is SQLite's dialect (unquoted `end`, `INSERT OR`, blob literals). It would need rewriting, and it bypasses the schema PostgreSQL already has.
- **Comparing row counts only:** a truncated text or a rounded number keeps the count. The per-user hash catches both.
- **Copying into a database that already has data (upsert):** it would hide a wrong target. A rerun after a failure starts from a new database instead.

## Consequences
- The tools need no new dependency. They run inside the app image (`docker compose exec app node scripts/...`), so the server needs nothing installed.
- The whole database is read into memory one table at a time, which is fine at this size (about 13 MB). A much larger database would need keyset batches.
- The fingerprint reads every row twice per direction. Verification takes seconds here, and it's the price of proof.
- After cutover, any migration added later needs its PostgreSQL twin before the reverse export can match (the schema check refuses otherwise), which the parity test already requires.
