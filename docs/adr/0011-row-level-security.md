# 0011: Row-level security on PostgreSQL, with an explicit all-users mode

- **Status:** accepted (Phase 1I, 2026-11-17: the code; deployed after a few clean days on RDS)
- **Date:** 2026-11-17

## Context
Every user's data lives in one database (ADR 0003). Today isolation is enforced in code only:
- `db/scope.js` binds `@uid` into every statement that names it;
- `test/user-scope.test.js` checks statically that each query on a user table names `user_id`;
- `test/user-isolation.test.js` checks that a second user can neither see nor change the first user's data on any route.

A statement that forgets its filter, on a scoped database, still reads every user's rows. Since 1H production runs on
PostgreSQL, so the database itself can refuse those rows.

Some code must read across users:
- the admin screens (users, usage, feedback), account export and deletion;
- the scheduler's run checks;
- the nightly backup, the restore test, the rollback export and the transfer scripts.

## Decision
- **Policies (migration `035-row-level-security`).** Every user table and `runs` have row-level security enabled and one policy, `user_rows`:
  `user_id = current_setting('app.user_id', true) OR current_setting('app.all_users', true) = 'on'`.
  - **`run_calls`** follows its run (`EXISTS` on `runs`, which is itself filtered).
  - **No setting, no rows:** a missing setting is NULL and an empty one is '', so neither matches.
  - **Writes:** with no `WITH CHECK`, the same test applies to the rows an insert or update writes.
  - **No role names** in any policy, so a dump restores into the scratch cluster and into test databases unchanged.
  - **App-wide tables** (`users`, `usage_totals`, `schema_migrations`) have none.
  - **A later user table** enables RLS and adds the same policy in its own migration. `test/rls.test.js` fails on a table with `user_id` and no policy.
- **ENABLE, not FORCE.** The table owner, `hr_migrate`, is not held to the policies, as its data migrations need. `hr_app` and `hr_backup` are held to them either way, so FORCE would only bind the owner.
- **Settings per statement (`db/postgres.ts`).** Every statement first makes its client's session settings its own scope: one user, all users, or none.
  - The settings are sent only when they differ from what that client last had.
  - They are forgotten on any rollback, since a rollback undoes a `set_config` made inside it.
  - So a pooled connection never carries one user's settings into another's statement.
  - **One user:** `scopeDatabase(db, uid)` prepares through `forUser(uid)`.
  - **No one:** the unscoped app database, which reads only app-wide tables.
  - **All users:** `allUsers()`, reached through `server/admin-queries.js everyone()`.
- **All-users mode is explicit, not a separate login** (owner's choice). It covers:
  - the admin queries, through `everyone()`;
  - the backup service and the transfer scripts (`openStore` / `openPostgresStore` `allUsers: true`);
  - pg_dump (`--enable-row-security`, with `PGOPTIONS=-c app.all_users=on`).
- **The app's own SQL names its user as `@uid`.** `test/user-scope.test.js` now also refuses a positional `user_id = ?` or an insert without `@uid` outside the admin queries and the migrations. On the unscoped database such a statement would find nothing in production.

## Alternatives considered
- **A fourth login for the admin and backup code.** It would need the owner to re-run the role setup, which resets the passwords, and to add a Parameter Store value. The app container would hold both passwords, so it guards against nothing more than the explicit mode does.
- **BYPASSRLS for `hr_backup`.** Whether RDS's master user may grant it is unclear. A role that bypasses everything also hides a backup that would have been empty under the policies.
- **Setting the user once per pooled connection, at checkout.** pg's pool has no asynchronous checkout hook. The setting would also outlive the request that made it on a reused connection.
- **FORCE ROW LEVEL SECURITY.** It binds only the owner, which would then need an all-users setting in every data migration.

## Consequences
- **What it protects against:** a query that forgets `user_id = @uid` on a scoped database returns only that user's rows, and a write with another user's id is refused.
  - `test/rls.test.js` checks this as the real roles.
  - It also checks that every GET route answers byte for byte the same as `hr_app` as with every row visible.
- **What it does not protect against:** code running in the app process can set the same settings, so RLS guards against mistakes, not against a compromised server. Parameterized SQL remains the guard against injection.
- **Tests:** the test suite connects as a superuser, which bypasses row-level security. Only `test/rls.test.js` runs as the production roles, and the static guard covers the rest.
- **Rolling back:** once 035 is applied, an image older than it sets no user. The app then starts, but its screens are empty and its writes are refused. Nothing is lost, and deploying the newer tag again brings everything back. To truly run an older image, use deploy.sh's failed-deploy restore or the backup container's `restore-pre-migration`, never `deploy.sh rollback` alone.
- **Cost:** one extra round trip each time a pooled connection serves a different user (or mode) than its last statement did.
- **What would make us revisit this:** more than one service with its own database role (v3 Phase 5) may move the scope to per-service roles.
