# 0010: Running production on RDS: roles, a backup container, and a checked dump before every migration

- **Status:** accepted (Phase 1G, 2026-11-16: the code; staging on the new server is the owner's step)
- **Date:** 2026-11-16

## Context
1F's Terraform builds RDS PostgreSQL 18 and an EC2 server. The code still assumed a SQLite file in four places:
- The server always opened SQLite. On PostgreSQL it would migrate on open, so the app's login would need DDL rights.
- The nightly backup and the monthly restore test used better-sqlite3's backup API and `sqlite_master`.
- deploy.sh's migration check, pre-migration copy and failed-deploy restore were file copies.
- The settings lived in a hand-made `.env` on the server.

Two rules shape the answer:
- **Back up before every database change:** a checked copy before any migration.
- **Plaintext health data only in the OS temp folder,** deleted on every exit path, except the server's own encrypted disk.

The connection to RDS must be verified TLS (`rds.force_ssl` is on), and the image held no RDS certificate authority.

## Decision
- **TLS.**
  - The image carries Amazon's RDS CA bundle (`/app/certs`).
  - Database URLs use `sslmode=verify-full` with that bundle.
  - In production, `createPostgresPool` refuses a remote URL without both (`checkTls`).
- **Engine switch.** The server opens PostgreSQL only when both `DB_ENGINE=postgres` and `DATABASE_URL` are set, so a stray URL never moves the SQLite server.
- **Three roles** (`db/pg/roles.js`), created once by the owner (`infra/db-setup.ps1`, through an SSM port forward, TLS verified against the RDS host name).
  - **The database:** `health_review`, with C collation and ctype, owned by `hr_migrate`.
  - **`hr_migrate`:** owns the schema and runs the migrations (`scripts/migrate.js`) and the failed-deploy restore.
  - **`hr_app`:** reads and writes rows, with no DDL and no BYPASSRLS, and follows new tables through default privileges. The server connects as it with `migrate: false`, and refuses to start while migrations are pending.
  - **`hr_backup`:** SELECT only, for pg_dump. These are plain grants rather than `pg_read_all_data`, which RDS's master may not be allowed to grant.
- **A backup container** (`Dockerfile --target backup`, image `<tag>-backup`, compose profile `postgres`).
  - **The image:** the app's runtime plus PostgreSQL 18 from the PostgreSQL project's apt repository, whose signing key is checked against its published fingerprint. The app image never carries pg tools.
  - **The only code that starts them:** `tools/backup/pg.ts`.
    - Commands take argument arrays, with no shell.
    - Connection details go through PG* environment variables, never argv.
    - Errors give a tool and its exit code only, since pg's own output can quote row values.
  - **What it runs:** `scripts/backup-service.js`, which runs:
    - the nightly backup and the monthly restore test, on the same schedule settings, run records and failure emails as before;
    - deploy.sh's one-off steps.
  - **The logins it holds:** the migration and backup roles, in `backup.env`. The app's `.env` never has them.
- **Backups.**
  - pg_dump runs as `hr_backup`, then the dump is restored into a throwaway local cluster as its check. That stands in for SQLite's integrity check. The cluster uses the C locale, is reachable on a Unix socket only, lives in the OS temp folder, and is deleted after the check.
  - The dump is packed as `health.dump` into the same encrypted `.hrbk` format, with the same retention.
  - The restore test restores into a throwaway cluster, never the production instance, and compares row counts under the same rules.
- **Before a migration** (deploy.sh, `pre-migrate`):
  1. A pg_dump of the live database goes to `data/backups/pre-migration-<stamp>.dump` (mode 600, on the encrypted disk). It is aged out with the SQLite copies: newest 5, at most 14 days.
  2. The dump is restored into a scratch cluster, and the new image's pending migrations run there first. The check exits 0 when nothing is pending, 10 when migrations are pending and pass on the copy, and 1 when one fails, leaving the live database untouched.
  3. The encrypted Drive backup is made with the current image.
  4. Then `scripts/migrate.js` runs as `hr_migrate`, then the new image starts.
- **When a migration or the new image fails:**
  1. The schema is emptied in one transaction, which also reapplies the grants.
  2. The dump is restored in one transaction.
  3. The old image starts.

  At today's size this takes under a minute. RDS's 7-day point-in-time recovery and the Drive backup are the fallbacks. No manual RDS snapshots are taken (owner's choice, 2026-11-16).
- **Before a load** (`reset-database --confirm <database>`, added 2026-11-16): the load copies only into a freshly migrated database, and a running app writes rows at once (staging's first load was refused over one bot visit in `usage_totals`). The 1H cutover also has to empty staging's copy, since both use the one database. The command:
  1. needs the database's name typed;
  2. refuses while anything else is connected (the app and the backup service stopped), after waiting a few seconds for closing connections;
  3. keeps a pg_dump checked in a scratch cluster, under the same pre-migration name and pruning;
  4. drops and re-creates the schema with its grants, then runs every migration as `hr_migrate`. Dropping the schema, not truncating, leaves exactly the freshly migrated state: the owner row and fresh sequences.
- **Settings from Parameter Store.**
  - `deploy/env-from-ssm.sh` runs on the host with the instance role before every start, since containers cannot reach instance metadata.
  - It writes `/health-review/env/*` to `.env` and `/health-review/backup/*` to `backup.env`. Both files are mode 600 and belong to the deploy user.
  - Values are never printed.
  - `infra/env-to-ssm.ps1` copies the Lightsail settings there, in staging or production mode.
- **Staging** (owner's choice): the new server runs under a temporary subdomain with a copy of the data (`load-from-backup`). It has:
  - no scheduled jobs;
  - no email;
  - its own Drive backup folder (`BACKUP_DRIVE_FOLDER`), so a test backup never replaces production's.
- **The demo stays on SQLite** (owner's choice): made-up data in memory, reset on restart, never connected to RDS. It moves when the SQLite code goes, after 1H's 14-day window.
- **Lightsail is unchanged.** It has no `server.conf`, so deploy.sh, compose and the app run there exactly as before.

## Alternatives considered
- **pg_dump in the app image:** simpler, but it puts PostgreSQL's programs, and the backup login, in the internet-facing container.
- **Manual RDS snapshots before each migration:** they need new AWS permissions on the server and a cleanup rule, and restoring one makes a new instance, which takes minutes. A checked dump plus point-in-time recovery covers the same failures.
- **`pg_restore --clean` for the failed-deploy restore:** it leaves tables that a failed migration added, which would block the next deploy of that migration. Emptying the schema first does not.
- **PGlite or a PostgreSQL container for the demo:** about 500 MB, or another container, on a 2 GB server, for data that is made up and thrown away.
- **Secrets in Secrets Manager:** $0.40 a secret a month. Parameter Store's standard SecureStrings under the same key are free.

## Consequences
- The app's login can no longer change the schema, a step toward 1I's row-level security.
- Deploys that migrate take longer: a dump, a scratch restore, a Drive backup, then the migration.
- CI's PostgreSQL jobs install PostgreSQL 18's programs, so the backup tests run there too.
- The backup image is published and scanned beside the app image.
- **Revisit when:**
  - the database outgrows a dump in a minute or two (then use snapshots or a replica);
  - 1I's row-level security needs the admin role split out.
