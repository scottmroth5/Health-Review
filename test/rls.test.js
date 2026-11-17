// Row-level security (v3 Phase 1I, docs/adr/0011, migration 035-row-level-security): on PostgreSQL the production roles
// see only the rows of the user each statement names, whatever its SQL says. Runs as the real roles (db/pg/roles.js,
// a prefix of its own per run), because the test suite's superuser bypasses row-level security. Made-up rows only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { dropWhenIdle, freshPgDatabase, pgSkip } from './pg.js';
import { roleNames, setupRoles, setupGrants } from '../db/pg/roles.ts';
import { openPostgresStore, migratePostgres } from '../db/pg/migrate.ts';
import { createPostgresDatabase, createPostgresPool } from '../db/postgres.ts';
import { scopeDatabase } from '../db/scope.ts';
import { USER_TABLES } from '../db/migrations-users.ts';
import { OWNER_ID } from '../db/users.ts';
import { everyone } from '../server/admin-queries.js';
import { dump, pgToolsSkip, restoreInto } from '../tools/backup/pg.js';
import { openHealthStore } from '../db/store.ts';
import { refreshDemoDatabase } from '../demo/generate.js';
import { copyAll } from '../db/transfer.ts';
import { answers, TODAY } from './route-answers.js';

const pw = () => randomBytes(24).toString('base64url');
const LEE = 'lee-0000-4000-8000-000000000002';

function urlAs(user, password, database) {
  const url = new URL(process.env.DATABASE_URL);
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

/** A migrated database with the three roles and made-up rows for the owner and lee, seeded as the owning role. */
async function setup() {
  const prefix = `r${randomBytes(4).toString('hex')}`;
  const database = `${prefix}_db`;
  const passwords = { migrate: pw(), app: pw(), backup: pw() };
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  const pools = [];
  let store = null;
  const close = async () => {
    await store?.close();
    await Promise.all(pools.map((p) => p.end()));
    await dropWhenIdle(admin, database);
    for (const r of Object.values(roleNames(prefix))) await admin.query(`DROP ROLE IF EXISTS "${r}"`);
    await admin.end();
  };
  try {
    return await seeded();
  } catch (err) {
    await close(); // a failed setup leaves no connection open (the test run would never end) and no role behind
    throw err;
  }

  async function seeded() {
  const roles = await setupRoles(admin, { prefix, database, passwords });
  const poolAs = (role, extra = {}) => {
    const p = createPostgresPool(urlAs(roles[role], passwords[role], database), { max: 2, ...extra });
    pools.push(p);
    return p;
  };
  const migrate = poolAs('migrate');
  const c = await migrate.connect();
  try { await setupGrants(c, { prefix }); } finally { c.release(); }
  await migratePostgres(migrate);
  // The table owner is not held to the policies (ENABLE, not FORCE), so it seeds every user's rows.
  await migrate.query("INSERT INTO users (id, email, role, status, created_at) VALUES ($1, 'lee@example.com', 'user', 'approved', 'x')", [LEE]);
  for (const [uid, n] of [[OWNER_ID, 2], [LEE, 3]]) {
    for (let i = 0; i < n; i++) {
      await migrate.query("INSERT INTO settings (user_id, key, value, updated_at) VALUES ($1, $2, 'v', 'x')", [uid, `k${i}`]);
      await migrate.query("INSERT INTO checkins (user_id, date, cadence, source, updated_at) VALUES ($1, $2, 'daily', 'ui', 'x')", [uid, `2026-01-0${i + 1}`]);
      const { rows: [run] } = await migrate.query("INSERT INTO runs (user_id, name, started_at) VALUES ($1, 'sync', 'x') RETURNING id", [uid]);
      await migrate.query("INSERT INTO run_calls (run_id, created_at) VALUES ($1, 'x')", [run.id]);
    }
  }
  await migrate.query("INSERT INTO runs (user_id, name, started_at) VALUES (NULL, 'system', 'x')");
  store = await openPostgresStore(urlAs(roles.app, passwords.app, database), { migrate: false, pool: { max: 1 } });
  return { roles, passwords, database, poolAs, store, close };
  }
}

const count = (db, table) => db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get();

test('every table with a user_id column, and run_calls, has row-level security and its policy', { skip: pgSkip }, async () => {
  const fresh = await freshPgDatabase();
  const store = await openPostgresStore(fresh.url);
  try {
    const withUserId = await store.db.prepare(`SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'user_id' ORDER BY table_name`).pluck().all();
    assert.deepEqual([...withUserId].sort(), [...USER_TABLES, 'runs'].sort(), 'USER_TABLES and runs are the tables with user_id');
    const rls = await store.db.prepare(`SELECT c.relname AS t, c.relrowsecurity AS rls, c.relforcerowsecurity AS force, p.qual
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_policies p ON p.schemaname = n.nspname AND p.tablename = c.relname AND p.policyname = 'user_rows'
      WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`).all();
    const byTable = new Map(rls.map((r) => [r.t, r]));
    for (const t of [...withUserId, 'run_calls']) {
      const r = byTable.get(t);
      assert.ok(r?.rls, `${t} has row-level security`);
      assert.equal(r.force, false, `${t}: ENABLE, not FORCE (the owner migrates every row)`);
      assert.match(r.qual ?? '', t === 'run_calls' ? /FROM runs/ : /app\.user_id.*app\.all_users/s, `${t} has the user_rows policy`);
    }
    for (const t of ['users', 'usage_totals', 'schema_migrations']) assert.equal(byTable.get(t)?.rls, false, `${t} is app-wide`);
  } finally {
    await store.close();
    await fresh.drop();
  }
});

test('as the app role: a query that forgets its user filter still sees only its own user', { skip: pgSkip }, async () => {
  const s = await setup();
  try {
    const lee = scopeDatabase(s.store.db, LEE);
    const owner = scopeDatabase(s.store.db, OWNER_ID);
    // No user_id in the SQL: the plan's new test.
    assert.equal(await count(lee, 'settings'), 3);
    assert.equal(await count(lee, 'checkins'), 3);
    assert.equal(await count(lee, 'runs'), 3, 'their runs, not the system run');
    assert.equal(await count(lee, 'run_calls'), 3, 'run_calls follow their run');
    assert.equal(await count(owner, 'settings'), 2);
    assert.deepEqual(await lee.prepare('SELECT DISTINCT user_id FROM checkins').pluck().all(), [LEE]);
    // Every user table answers lee with lee's rows only (most are empty here; none may show the owner's).
    for (const t of USER_TABLES) {
      assert.deepEqual(await lee.prepare(`SELECT DISTINCT user_id FROM ${t} WHERE user_id <> ?`).pluck().all(LEE), [], t);
    }
    // Unscoped: no user's rows; app-wide tables as before.
    assert.equal(await count(s.store.db, 'settings'), 0);
    assert.equal(await count(s.store.db, 'runs'), 0);
    assert.equal(await count(s.store.db, 'users'), 2);
    // All-users mode (the admin screens): everyone's, the system run included.
    assert.equal(await count(everyone(s.store.db), 'settings'), 5);
    assert.equal(await count(everyone(s.store.db), 'runs'), 6);
    assert.equal(await count(everyone(lee), 'run_calls'), 5, 'from a scoped database too');
  } finally {
    await s.close();
  }
});

test('as the app role: writing another user\'s rows is refused', { skip: pgSkip }, async () => {
  const s = await setup();
  try {
    const lee = scopeDatabase(s.store.db, LEE);
    const refused = (err) => err.code === '42501'; // new row violates row-level security policy
    await assert.rejects(lee.prepare("INSERT INTO settings (user_id, key, value, updated_at) VALUES (?, 'x', 'v', 'x')").run(OWNER_ID), refused);
    await assert.rejects(lee.prepare('UPDATE settings SET user_id = ?').run(OWNER_ID), refused);
    await assert.rejects(s.store.db.prepare("INSERT INTO settings (user_id, key, value, updated_at) VALUES (?, 'x', 'v', 'x')").run(LEE), refused,
      'unscoped writes nothing either');
    // Updates and deletes without a user filter touch only lee's rows.
    assert.equal((await lee.prepare("UPDATE settings SET value = 'changed'").run()).changes, 3);
    assert.equal((await lee.prepare('DELETE FROM checkins').run()).changes, 3);
    assert.equal(await count(scopeDatabase(s.store.db, OWNER_ID), 'checkins'), 2);
    assert.equal(await scopeDatabase(s.store.db, OWNER_ID).prepare("SELECT COUNT(*) FROM settings WHERE value = 'changed'").pluck().get(), 0);
  } finally {
    await s.close();
  }
});

test('one pooled connection never carries a user\'s settings into the next statement, after rollbacks too', { skip: pgSkip }, async () => {
  const s = await setup(); // the app store's pool holds a single connection
  try {
    const db = s.store.db;
    const lee = scopeDatabase(db, LEE);
    const owner = scopeDatabase(db, OWNER_ID);
    for (let i = 0; i < 3; i++) {
      assert.equal(await count(lee, 'settings'), 3);
      assert.equal(await count(db, 'settings'), 0);
      assert.equal(await count(owner, 'settings'), 2);
      assert.equal(await count(everyone(db), 'settings'), 5);
      assert.equal(await count(db, 'settings'), 0, 'all-users mode does not linger');
    }
    // A rolled-back transaction undoes the settings made inside it.
    await assert.rejects(db.tx(async () => {
      assert.equal(await count(lee, 'settings'), 3);
      throw new Error('stop');
    }), /stop/);
    assert.equal(await count(db, 'settings'), 0);
    assert.equal(await count(owner, 'settings'), 2);
    // A rolled-back savepoint, then the same transaction carries on: each statement still sees its own user.
    await db.tx(async () => {
      assert.equal(await count(owner, 'settings'), 2);
      await assert.rejects(db.tx(async () => {
        assert.equal(await count(lee, 'settings'), 3);
        throw new Error('inner');
      }), /inner/);
      assert.equal(await count(lee, 'settings'), 3, 'set again after the savepoint rolled back');
      assert.equal(await count(owner, 'settings'), 2);
      assert.equal(await count(db, 'settings'), 0);
    });
    // A failed statement outside a transaction.
    await assert.rejects(lee.prepare('SELECT * FROM no_such_table').all());
    assert.equal(await count(db, 'settings'), 0);
    assert.equal(await count(lee, 'settings'), 3);
    // Statements in parallel on one connection queue and keep their own users.
    const counts = await Promise.all([lee, db, owner, everyone(db), lee].map((d) => count(d, 'settings')));
    assert.deepEqual(counts, [3, 0, 2, 5, 3]);
  } finally {
    await s.close();
  }
});

test('the whole-database tools open in all-users mode; the app does not', { skip: pgSkip }, async () => {
  const s = await setup();
  try {
    const tool = await openPostgresStore(urlAs(s.roles.backup, s.passwords.backup, s.database), { migrate: false, allUsers: true, pool: { max: 1 } });
    try {
      assert.equal(await count(tool.db, 'settings'), 5);
      assert.equal(await count(scopeDatabase(tool.db, LEE), 'settings'), 3, 'scoping still narrows it');
    } finally {
      await tool.close();
    }
    const plain = createPostgresDatabase(s.poolAs('backup', { max: 1 }));
    assert.equal(await count(plain, 'settings'), 0, 'the backup role is held to the policies too');
  } finally {
    await s.close();
  }
});

// The app as production runs it: hr_app, held to the policies. Every GET route on the demo's made-up data answers byte for
// byte as it does for the table owner (who sees every row), so no request path reads a user table outside its user.
test('every GET route answers the same as the app role as with every row visible', { skip: pgSkip, timeout: 300_000 }, async () => {
  const prefix = `r${randomBytes(4).toString('hex')}`;
  const database = `${prefix}_db`;
  const passwords = { migrate: pw(), app: pw(), backup: pw() };
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  const sqlite = openHealthStore(':memory:');
  let owned;
  let app;
  try {
    const roles = await setupRoles(admin, { prefix, database, passwords });
    owned = await openPostgresStore(urlAs(roles.migrate, passwords.migrate, database), { pool: { max: 2 } });
    const grants = createPostgresPool(urlAs(roles.migrate, passwords.migrate, database), { max: 1 });
    try { await setupGrants(grants, { prefix }); } finally { await grants.end(); }
    await refreshDemoDatabase(sqlite, { today: TODAY });
    const copied = await copyAll(sqlite, owned);
    assert.ok(copied.daily_metrics > 300, 'the demo data is there');
    app = await openPostgresStore(urlAs(roles.app, passwords.app, database), { migrate: false, pool: { max: 2 } });
    assert.equal(await count(app.db, 'daily_metrics'), 0, 'unscoped, the app role sees no user rows');
    const [a, b] = [await answers(owned), await answers(app)];
    assert.ok(Object.keys(a).length >= 60, `the routes and views (${Object.keys(a).length})`);
    const differ = Object.keys(a).filter((u) => a[u] !== b[u]);
    for (const u of differ) console.log(`${u}\n  owner:   ${a[u].slice(0, 200)}\n  hr_app:  ${b[u].slice(0, 200)}`);
    assert.deepEqual(differ, [], 'routes answering differently under row-level security');
  } finally {
    sqlite.close();
    await app?.close();
    await owned?.close();
    await dropWhenIdle(admin, database);
    for (const r of ['app', 'backup', 'migrate']) await admin.query(`DROP ROLE IF EXISTS "${prefix}_${r}"`);
    await admin.end();
  }
});

test('pg_dump as the read-only backup role dumps every user\'s rows', { skip: pgSkip || pgToolsSkip }, async () => {
  const s = await setup();
  const dir = mkdtempSync(join(tmpdir(), 'hr-rls-'));
  const target = await freshPgDatabase();
  try {
    const file = join(dir, 'health.dump');
    await dump(urlAs(s.roles.backup, s.passwords.backup, s.database), file);
    await restoreInto(target.url, file);
    const n = async (t) => (await target.pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
    assert.equal(await n('settings'), 5);
    assert.equal(await n('runs'), 6);
    assert.equal(await n('run_calls'), 5);
  } finally {
    await target.drop();
    rmSync(dir, { recursive: true, force: true });
    await s.close();
  }
});
