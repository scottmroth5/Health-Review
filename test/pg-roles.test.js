// The production database's roles (db/pg/roles.js, v3 Phase 1G): the app reads and writes rows but cannot change the
// schema, the backup role only reads, the migration role migrates, and a table a later migration adds is usable by the
// app and readable by the backup. Each run uses its own role prefix and database (roles are cluster-wide). Runs only
// with a PostgreSQL server (DATABASE_URL, a user that may create roles and databases).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { dropWhenIdle, pgSkip } from './pg.js';
import { setupRoles, setupGrants } from '../db/pg/roles.js';
import { openPostgresStore, migratePostgres, PG_MIGRATIONS } from '../db/pg/migrate.js';
import { createPostgresPool } from '../db/postgres.ts';
import { OWNER_ID } from '../db/users.js';
import { scopeDatabase } from '../db/scope.js';

const pw = () => randomBytes(24).toString('base64url');

function urlAs(user, password, database) {
  const url = new URL(process.env.DATABASE_URL);
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

async function denied(promise) {
  await assert.rejects(promise, (err) => err.code === '42501'); // insufficient_privilege
}

test('roles: app reads and writes only, backup reads only, migrate owns the schema', { skip: pgSkip }, async () => {
  const prefix = `t${randomBytes(4).toString('hex')}`;
  const database = `${prefix}_db`;
  const passwords = { migrate: pw(), app: pw(), backup: pw() };
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  const pools = [];
  const poolAs = (role) => {
    const p = createPostgresPool(urlAs(`${prefix}_${role}`, passwords[role], database), { max: 2 });
    pools.push(p);
    return p;
  };
  try {
    const roles = await setupRoles(admin, { prefix, database, passwords });
    assert.deepEqual(roles, { migrate: `${prefix}_migrate`, app: `${prefix}_app`, backup: `${prefix}_backup` });
    // Running it again resets passwords and keeps the database.
    passwords.app = pw();
    await setupRoles(admin, { prefix, database, passwords });

    const migrate = poolAs('migrate');
    const grants = await migrate.connect();
    try { await setupGrants(grants, { prefix }); } finally { grants.release(); }
    assert.ok((await migratePostgres(migrate)).includes('000-baseline'));

    // The app: opens without migrating, reads and writes rows, cannot create or drop.
    const appStore = await openPostgresStore(urlAs(roles.app, passwords.app, database), { migrate: false, pool: { max: 2 } });
    try {
      // As a user (row-level security, v3 Phase 1I: the unscoped app database sees no user's rows).
      const owner = scopeDatabase(appStore.db, OWNER_ID);
      await owner.prepare("INSERT INTO settings (user_id, key, value, updated_at) VALUES (@uid, 'k', 'v', 'now')").run();
      assert.equal(await owner.prepare("SELECT value FROM settings WHERE user_id = @uid AND key = 'k'").pluck().get(), 'v');
      await owner.prepare("DELETE FROM settings WHERE user_id = @uid AND key = 'k'").run();
    } finally {
      await appStore.close();
    }
    const app = poolAs('app');
    await denied(app.query('CREATE TABLE app_made (x int)'));
    await denied(app.query('DROP TABLE settings'));
    await denied(app.query('ALTER TABLE settings ADD COLUMN extra text'));

    // The backup role: reads, never writes.
    const backup = poolAs('backup');
    assert.equal((await backup.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 1);
    await denied(backup.query("UPDATE users SET email = 'x@example.com'"));
    await denied(backup.query('CREATE TABLE backup_made (x int)'));

    // A later migration's table, with an identity key: the app writes it, the backup reads it.
    const later = [...PG_MIGRATIONS, { id: '900-later', up: 'CREATE TABLE later_t (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, v text)' }];
    await assert.rejects(openPostgresStore(urlAs(roles.app, passwords.app, database), { migrate: false, migrations: later }),
      /1 pending migration\(s\) \(900-later\)/);
    assert.deepEqual(await migratePostgres(migrate, later), ['900-later']);
    await app.query("INSERT INTO later_t (v) VALUES ('a')");
    assert.equal((await backup.query('SELECT count(*)::int AS n FROM later_t')).rows[0].n, 1);
  } finally {
    await Promise.all(pools.map((p) => p.end()));
    await dropWhenIdle(admin, database);
    for (const r of ['app', 'backup', 'migrate']) await admin.query(`DROP ROLE IF EXISTS "${prefix}_${r}"`);
    await admin.end();
  }
});

test('setupRoles refuses short passwords and odd names', { skip: pgSkip }, async () => {
  const fake = { query: async () => ({ rows: [] }), escapeLiteral: (s) => `'${s}'` };
  await assert.rejects(setupRoles(fake, { prefix: 'ok', passwords: { migrate: 'short', app: pw(), backup: pw() } }), /migrate password/);
  await assert.rejects(setupRoles(fake, { prefix: 'Bad-Name', passwords: {} }), /role prefix/);
  await assert.rejects(setupRoles(fake, { database: 'x; drop', passwords: {} }), /database name/);
});
