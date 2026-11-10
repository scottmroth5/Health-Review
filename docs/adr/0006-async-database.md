# 0006: One async database interface; SQLite transactions serialized by a lock

- **Status:** accepted (Phase 1A, 2026-11-03); in use everywhere since Phase 1B ended (slice 5, 2026-11-10)
- **Date:** 2026-11-03

## Context
Every query today calls better-sqlite3, which is synchronous. PostgreSQL drivers are asynchronous, so moving to RDS (ADR 0003) means awaiting every statement. Phase 1 converts the code to async on SQLite first and ships that, and only then adds PostgreSQL behind the same interface. That way the conversion and the engine change are never in one release.

What the code actually uses:
- **Statements:** 377 `prepare` calls in 34 source files, using only `get`, `all`, `run` and `pluck`.
- **Unused:** `iterate`, `raw`, `expand` and `columns` appear only inside the scope wrapper.
- **`run()` results:** 17 sites read `changes`. 14 read `lastInsertRowid`, which PostgreSQL has no equivalent for.
- **Transactions:** 27 `db.transaction` sites and 10 `store.tx` sites. All are synchronous.

## Decision
- **`db/database.ts` defines the interface:**
  - `prepare(sql)` gives `get`, `all`, `run` and `pluck`, each returning a promise;
  - `run` resolves to `{ changes }` only;
  - `exec` and `tx(async fn)`;
  - `engine`;
  - `raw`, the SQLite handle, for the SQLite-only tools until Phases 1C and 1G replace them.

  `createSqliteDatabase` implements it over today's connection, and the PostgreSQL adapter (1C) implements the same interface.
- **Inserts that need the new key use `INSERT ... RETURNING id`,** which both engines support. All 14 `lastInsertRowid` sites were changed in 1A, on today's sync code.
- **Scoping is unchanged:** `scopeDatabase(db, uid)` (`db/scope.js`) binds `@uid` exactly as `scopeDb` does. A statement naming `@uid` on the unscoped database still fails instead of reading everyone's rows.
- **Async transactions on one SQLite connection:** an async transaction stays open across awaits, so another request's statements could land inside it. To prevent that:
  - one transaction runs at a time, behind a promise-chain lock;
  - an AsyncLocalStorage marks the context that holds it, and its statements run inside it;
  - a nested `tx` is a SAVEPOINT that rolls back alone;
  - statements from any other context wait for the lock;
  - the lock is released however the transaction ends.
- **During Phase 1B the store has both handles:**
  - `db`, the sync handle for code not yet converted;
  - `adb` and `atx`, the async ones.

  A sync statement can't wait, so the sync handle throws `TransactionConflictError` if it's used while another context holds an async transaction, rather than silently joining it. agent-core's run tracer gets the unguarded handle (`raw`), so a run record never fails a job. Its write could be lost only if that other transaction rolled back, and Phase 1D replaces the tracer. When the last slice is converted, `adb` becomes `db`.
- **After Phase 1B (slice 5, 2026-11-10) the store is `{ db, tx, syncDb, raw }`:**
  - `db` and `tx` are the async interface, and every caller uses them; `adb` and `atx` are gone.
  - `syncDb` is the guarded sync handle, kept for the SQLite-only jobs until 1G: the backup (better-sqlite3's backup API) and the restore test (`sqlite_master` row counts). Tests seed and check rows on it too, unchanged.
  - `raw` stays for agent-core's run tracer and `startUserRun` (until 1D), `syncOwnerEmail` as the store opens (until 1C), and SQLite's own tables and pragmas (the demo refresh and the baseline, until 1G).
  - The review eval runner (`evals/run-review-eval.mjs`, harness-gated) still builds its own case store on the sync handle; 1C converts it, as PostgreSQL requires.
- **A transaction never spans an external call** (Claude, Google): everything else on the connection waits for it.

## Alternatives considered
- **A second SQLite connection for async code:** no shared lock, but SQLite allows one writer, so the two would meet as `SQLITE_BUSY` errors at random instead of a clear error at the line that conflicts.
- **Converting everything in one release, with no sync handle:** about 370 statements and 300 test statements in one diff, with no deploy in between to catch a missed await in production.
- **Supporting `iterate`, `raw` and `expand`:** nothing uses them, and each is one more behavior the PostgreSQL adapter would have to match.

## Consequences
- **Code converts a module at a time:** make the function async and await each statement. `npm run lint`'s no-floating-promises and no-misused-promises rules catch most missed awaits; a property read on a promise (`f().x`) gets past them, so each slice also checks every call site by name.
- **A converted function runs on either handle** (refined in Phase 1B, 2026-11-04), because `await` on a plain value works. Callers kept passing the sync `db` until everything under an entry point was converted, and then that entry point switched to `adb`/`atx` (now `db`/`tx`). A slice therefore never has to convert its callers' own queries. On the sync handle a converted function's awaits are microtasks only, so no request runs in between, the same atomicity as before. A loader that runs inside a synchronous transaction stays sync until that caller converts.
- **A transaction needs the async handle** (Phase 1B slice 2, 2026-11-04). better-sqlite3's `transaction` refuses a function that returns a promise, so a converted function that opens a transaction takes the async handle and calls `db.tx`. During 1B its callers passed `adb` from then on, which flipped them early. Functions with no transaction still run on either handle.
- **The sync handle's guard doesn't fire in practice.** On SQLite every awaited statement settles at once, so a transaction that awaits only statements runs to its end in the microtask queue. No other request, each of which arrives as its own event-loop task, can run a sync-handle statement inside it. That holds as long as a transaction awaits nothing but statements, which the rule against external calls already requires. test/database.test.ts checks it.
- **A read followed by a write is no longer atomic** once each statement is awaited. Phase 1B audited those sequences and put the ones that need it in one transaction, with concurrency tests (test/queries-concurrency.test.js, test/server-concurrency.test.js).
- **The lock serializes transactions, not plain reads.** A long transaction delays every other statement on the connection, so transactions stay short.
- **Tests use `memoryStore` in `test/helpers.js`,** which gives the store's handles (`db` async, `syncDb` sync), scoped to the owner or to a second user.
