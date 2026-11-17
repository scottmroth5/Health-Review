// The production database and its three roles (v3 Phase 1G, docs/adr/0010). Run once by the owner through
// scripts/db-setup.js (infra/db-setup.ps1), as RDS's master user; running it again resets the three passwords and
// re-applies the grants, and never drops anything.
//
//   <p>_migrate  owns the database, its public schema and every table: the migrations (scripts/migrate.js) and the
//                pre-migration restore only. Creates citext (a trusted extension) as the database owner.
//   <p>_app      the server: CONNECT, USAGE on public, read and write rows, use sequences. No CREATE, no DDL, no
//                BYPASSRLS: held to row-level security (v3 Phase 1I, docs/adr/0011), so each statement sees its own user's rows
//                (or every user's in all-users mode). Tables a later migration adds follow through default privileges.
//   <p>_backup   the backup container's pg_dump: SELECT on every table and sequence in public (granted here and by
//                default privileges, rather than pg_read_all_data, which RDS's master may not be allowed to grant), nothing else.
//                Held to row-level security too: its dumps and counts run in all-users mode (tools/backup/pg.js dump).
//
// Passwords arrive as values and are quoted with escapeLiteral; they are never logged, and errors name roles only.
// Role names are cluster-wide, so the prefix lets tests use their own (production: hr).

/** The database the app uses, and the collation recipe db/pg/migrate.js checkCollation requires. */
export const DATABASE = 'health_review';
const ROLE_PREFIX = /^[a-z][a-z0-9_]{0,20}$/;
const DB_NAME = /^[a-z][a-z0-9_]{0,40}$/;

export function roleNames(prefix = 'hr') {
  if (!ROLE_PREFIX.test(prefix)) throw new TypeError('role prefix: lowercase letters, digits and _ only');
  return { migrate: `${prefix}_migrate`, app: `${prefix}_app`, backup: `${prefix}_backup` };
}

const ident = (s) => `"${s}"`; // only ever our own checked names

/**
 * Step 1, connected to any database (postgres) as the master user: the roles (created, or their passwords reset) and the
 * database, owned by the migration role, with SQLite's byte order (C collation and ctype).
 * @param {{ query: Function, escapeLiteral: (s: string) => string }} client  a pg client
 * @param {{ prefix?: string, database?: string, passwords: { migrate: string, app: string, backup: string } }} o
 */
export async function setupRoles(client, { prefix = 'hr', database = DATABASE, passwords }) {
  if (!DB_NAME.test(database)) throw new TypeError('database name: lowercase letters, digits and _ only');
  const roles = roleNames(prefix);
  for (const [key, name] of Object.entries(roles)) {
    const pw = passwords?.[key];
    if (typeof pw !== 'string' || pw.length < 24) throw new TypeError(`setupRoles: the ${key} password must be at least 24 characters`);
    const { rows: [r] } = await client.query('SELECT 1 AS present FROM pg_roles WHERE rolname = $1', [name]);
    const attrs = `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${client.escapeLiteral(pw)}`;
    await client.query(`${r ? 'ALTER' : 'CREATE'} ROLE ${ident(name)} WITH ${attrs}`);
  }
  const { rows: [d] } = await client.query('SELECT 1 AS present FROM pg_database WHERE datname = $1', [database]);
  if (!d) {
    // CREATE DATABASE ... OWNER needs the caller to be able to act as the owner (PostgreSQL 16+): a membership held
    // only for this statement.
    await client.query(`GRANT ${ident(roles.migrate)} TO CURRENT_USER`);
    try {
      await client.query(`CREATE DATABASE ${ident(database)} OWNER ${ident(roles.migrate)} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`);
    } finally {
      await client.query(`REVOKE ${ident(roles.migrate)} FROM CURRENT_USER`);
    }
  }
  await client.query(`REVOKE ALL ON DATABASE ${ident(database)} FROM PUBLIC`);
  await client.query(`GRANT CONNECT ON DATABASE ${ident(database)} TO ${ident(roles.app)}, ${ident(roles.backup)}`);
  return roles;
}

/**
 * Step 2, connected to the new database as the migration role: the app's grants, now and for every table and sequence
 * the migration role creates later.
 */
export async function setupGrants(client, { prefix = 'hr' } = {}) {
  const { migrate, app, backup } = roleNames(prefix);
  await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await client.query(`GRANT USAGE ON SCHEMA public TO ${ident(app)}, ${ident(backup)}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ident(app)}`);
  await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ident(app)}`);
  await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(migrate)} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ident(app)}`);
  await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(migrate)} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${ident(app)}`);
  await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${ident(backup)}`);
  await client.query(`GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ident(backup)}`);
  await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(migrate)} IN SCHEMA public GRANT SELECT ON TABLES TO ${ident(backup)}`);
  await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(migrate)} IN SCHEMA public GRANT SELECT ON SEQUENCES TO ${ident(backup)}`);
}
