// The PostgreSQL backup path (v3 Phase 1G): pg_dump checked in a scratch cluster, packed and encrypted like the SQLite
// backup; the restore test on a .dump; pre-migrate's exit codes; the failed-deploy restore; and load-from-backup from a
// SQLite backup; reset-database and the rollback export. Made-up rows only. Needs a PostgreSQL server (DATABASE_URL, a user that may create roles and databases)
// and PostgreSQL 18's programs (PG_BIN): CI's postgres jobs and the backup image have both; elsewhere these skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { dropWhenIdle, freshPgDatabase, freshPgStore, pgSkip } from './pg.js';
import { pgToolsSkip } from '../tools/backup/pg.js';
import { restoreBackup, runBackup } from '../tools/backup/run.js';
import { decrypt, encrypt, pack, unpack } from '../tools/backup/crypto.js';
import { restoreTest } from '../tools/backup/restore-check.js';
import { loadFromBackup, newestDumpSince, preMigrate, resetDatabase, restorePreMigration, rollbackExport } from '../tools/backup/pg-deploy.js';
import { migratePostgres, openPostgresStore, PG_MIGRATIONS } from '../db/pg/migrate.js';
import Database from 'better-sqlite3';
import { setupGrants, setupRoles } from '../db/pg/roles.js';
import { createPostgresPool } from '../db/postgres.ts';
import { openOwnerStore } from '../db/store.js';
import { OWNER_ID } from '../db/users.js';

const skip = pgSkip || pgToolsSkip;
// Its own temp folder: test/backup.test.js counts hr-backup- folders in the shared one while this file runs in parallel.
if (!skip) {
  const own = mkdtempSync(join(tmpdir(), 'hr-pgtest-'));
  process.env.TMPDIR = own;
  process.env.TMP = own;
  process.env.TEMP = own;
  process.on('exit', () => rmSync(own, { recursive: true, force: true }));
}
const PASS = 'correct horse battery staple';
const quiet = () => {};
const scratchLeft = () => readdirSync(tmpdir()).filter((n) => n.startsWith('hr-scratch-pg-')).length;

async function seed(store, days = 12) {
  for (let d = 1; d <= days; d++) {
    await store.db.prepare("INSERT INTO daily_metrics (user_id, date, steps, updated_at) VALUES (?, ?, ?, 'x')")
      .run(OWNER_ID, `2026-03-${String(d).padStart(2, '0')}`, 8000 + d);
  }
}

test('pg backup: a checked dump, packed as health.dump, encrypted; the restore test passes and counts later rows', { skip }, async () => {
  const store = await freshPgStore();
  const out = mkdtempSync(join(tmpdir(), 'hr-pg-out-'));
  try {
    await seed(store);
    const before = scratchLeft();
    const r = await runBackup({ pgUrl: store.url, passphrase: PASS, toDir: out, date: '2026-03-12' });
    const file = readFileSync(r.savedTo);
    assert.deepEqual(r.files, ['health.dump']);
    assert.ok(!file.includes(Buffer.from('PGDMP')), 'the dump is encrypted');
    assert.equal(unpack(decrypt(file, PASS))[0].name, 'health.dump');

    const pass = await restoreTest({ file, passphrase: PASS, live: store.db });
    assert.equal(pass.ok, true);
    assert.deepEqual(pass.differences, []);
    assert.ok(pass.tables >= 20);

    await store.db.prepare("INSERT INTO daily_metrics (user_id, date, steps, updated_at) VALUES (?, '2026-03-13', 9000, 'x')").run(OWNER_ID);
    const later = await restoreTest({ file, passphrase: PASS, live: store.db });
    assert.equal(later.ok, true);
    assert.deepEqual(later.differences, [{ table: 'daily_metrics', backup: 12, live: 13 }]);
    assert.equal(scratchLeft(), before, 'scratch clusters are deleted');
  } finally {
    rmSync(out, { recursive: true, force: true });
    await store.close();
  }
});

test('pre-migrate: 0 with nothing pending (no dump kept), 10 when the migrations pass on the copy, 1 when one fails', { skip }, async () => {
  const store = await freshPgStore();
  const dir = mkdtempSync(join(tmpdir(), 'hr-pg-pre-'));
  try {
    await seed(store, 3);
    const none = await preMigrate({ backupUrl: store.url, dir, log: quiet });
    assert.equal(none.code, 0);
    assert.equal(readdirSync(dir).length, 0);

    const later = [...PG_MIGRATIONS, { id: '900-later', up: 'ALTER TABLE daily_metrics ADD COLUMN later_note text' }];
    const ok = await preMigrate({ backupUrl: store.url, dir, migrations: later, log: quiet });
    assert.equal(ok.code, 10);
    assert.deepEqual(ok.pending, ['900-later']);
    assert.ok(existsSync(ok.file));
    assert.match(readdirSync(dir)[0], /^pre-migration-\d{8}T\d{9}Z\.dump$/);

    const broken = [...PG_MIGRATIONS, { id: '901-broken', up: 'ALTER TABLE no_such_table ADD COLUMN x int' }];
    const bad = await preMigrate({ backupUrl: store.url, dir, migrations: broken, log: quiet });
    assert.equal(bad.code, 1);
    assert.equal(readdirSync(dir).length, 1, 'only the earlier kept dump');
    // The live database was never touched.
    const cols = await store.db.prepare("SELECT column_name FROM information_schema.columns WHERE table_name = 'daily_metrics' AND column_name = 'later_note'").all();
    assert.equal(cols.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await store.close();
  }
});

test('restore-pre-migration: a migrated database goes back to its dump, grants included', { skip }, async () => {
  const prefix = `t${randomBytes(4).toString('hex')}`;
  const database = `${prefix}_db`;
  const pw = () => randomBytes(24).toString('base64url');
  const passwords = { migrate: pw(), app: pw(), backup: pw() };
  const urlAs = (role) => {
    const u = new URL(process.env.DATABASE_URL);
    u.username = `${prefix}_${role}`;
    u.password = passwords[role];
    u.pathname = `/${database}`;
    return u.toString();
  };
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  const dir = mkdtempSync(join(tmpdir(), 'hr-pg-restore-'));
  const pools = [];
  try {
    await setupRoles(admin, { prefix, database, passwords });
    const migrate = createPostgresPool(urlAs('migrate'), { max: 1 });
    pools.push(migrate);
    const c = await migrate.connect();
    try { await setupGrants(c, { prefix }); } finally { c.release(); }
    await migratePostgres(migrate);
    const app = createPostgresPool(urlAs('app'), { max: 1 });
    pools.push(app);
    await app.query("INSERT INTO settings (user_id, key, value, updated_at) VALUES ($1, 'before', 'v', 'x')", [OWNER_ID]);

    const since = new Date(Date.now() - 1000);
    const later = [...PG_MIGRATIONS, { id: '900-later', up: 'CREATE TABLE later_t (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY)' }];
    const pre = await preMigrate({ backupUrl: urlAs('backup'), dir, migrations: later, log: quiet });
    assert.equal(pre.code, 10);
    await migratePostgres(migrate, later);
    await app.query("INSERT INTO settings (user_id, key, value, updated_at) VALUES ($1, 'after', 'v', 'x')", [OWNER_ID]);

    const file = newestDumpSince(dir, since);
    assert.equal(file, pre.file);
    await restorePreMigration({ migrateUrl: urlAs('migrate'), file, prefix, log: quiet });
    const keys = (await app.query('SELECT key FROM settings ORDER BY key')).rows.map((r) => r.key);
    assert.deepEqual(keys, ['before'], 'rows written after the dump are gone');
    assert.equal((await app.query("SELECT to_regclass('later_t') IS NULL AS gone")).rows[0].gone, true);
    // The app can still write, and still cannot change the schema.
    await app.query("INSERT INTO settings (user_id, key, value, updated_at) VALUES ($1, 'again', 'v', 'x')", [OWNER_ID]);
    await assert.rejects(app.query('CREATE TABLE app_made (x int)'), (err) => err.code === '42501');
  } finally {
    await Promise.all(pools.map((p) => p.end()));
    rmSync(dir, { recursive: true, force: true });
    await dropWhenIdle(admin, database);
    for (const r of ['app', 'backup', 'migrate']) await admin.query(`DROP ROLE IF EXISTS "${prefix}_${r}"`);
    await admin.end();
  }
});

test('reset-database: typed name, no other connections, a checked dump kept, then empty and migrated for a load', { skip }, async () => {
  const prefix = `t${randomBytes(4).toString('hex')}`;
  const database = `${prefix}_db`;
  const pw = () => randomBytes(24).toString('base64url');
  const passwords = { migrate: pw(), app: pw(), backup: pw() };
  const urlAs = (role) => {
    const u = new URL(process.env.DATABASE_URL);
    u.username = `${prefix}_${role}`;
    u.password = passwords[role];
    u.pathname = `/${database}`;
    return u.toString();
  };
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  const dir = mkdtempSync(join(tmpdir(), 'hr-pg-reset-'));
  const work = mkdtempSync(join(tmpdir(), 'hr-pg-reset-load-'));
  const pools = [];
  try {
    await setupRoles(admin, { prefix, database, passwords });
    const migrate = createPostgresPool(urlAs('migrate'), { max: 1 });
    const c = await migrate.connect();
    try { await setupGrants(c, { prefix }); } finally { c.release(); }
    await migratePostgres(migrate);
    await migrate.end();
    let app = createPostgresPool(urlAs('app'), { max: 1 });
    pools.push(app);
    await app.query("INSERT INTO settings (user_id, key, value, updated_at) VALUES ($1, 'staging', 'v', 'x')", [OWNER_ID]);
    await app.query("INSERT INTO users (id, email, role, status, created_at) VALUES ('second', 'second@example.com', 'user', 'approved', 'x')");
    const reset = (confirm, waitMs = 300) => resetDatabase({
      backupUrl: urlAs('backup'), migrateUrl: urlAs('migrate'), dir, confirm, prefix, log: quiet, waitMs,
    });
    const settingsCount = async (p) => (await p.query('SELECT count(*)::int AS n FROM settings')).rows[0].n;

    await assert.rejects(reset(undefined), /--confirm/);
    await assert.rejects(reset('health_review'), /--confirm/);
    // The app still connected: refused, nothing dumped or changed.
    await assert.rejects(reset(database), /stop the app/);
    assert.equal(await settingsCount(app), 1);
    assert.equal(readdirSync(dir).length, 0);

    await app.end();
    pools.length = 0;
    assert.equal(await reset(database, 5000), 0);
    const kept = readdirSync(dir);
    assert.equal(kept.length, 1);
    assert.match(kept[0], /^pre-migration-\d{8}T\d{9}Z\.dump$/);

    app = createPostgresPool(urlAs('app'), { max: 1 });
    pools.push(app);
    assert.equal(await settingsCount(app), 0);
    assert.deepEqual((await app.query('SELECT id FROM users')).rows.map((r) => r.id), [OWNER_ID]);
    const ids = (await app.query('SELECT id FROM schema_migrations ORDER BY id')).rows.map((r) => r.id);
    assert.deepEqual(ids, PG_MIGRATIONS.map((m) => m.id).sort());
    await app.query("INSERT INTO settings (user_id, key, value, updated_at) VALUES ($1, 'after', 'v', 'x')", [OWNER_ID]);
    await assert.rejects(app.query('CREATE TABLE app_made (x int)'), (err) => err.code === '42501');
    await app.query("DELETE FROM settings WHERE key = 'after'");
    await app.end();
    pools.length = 0;

    // The state a load takes: a SQLite backup copies in and verifies.
    const source = openOwnerStore(join(work, 'live.db'));
    source.syncDb.prepare("INSERT INTO daily_metrics (user_id, date, steps, updated_at) VALUES (@uid, '2026-03-01', 7001, 'x')").run();
    source.syncDb.pragma('wal_checkpoint(TRUNCATE)');
    const bytes = readFileSync(join(work, 'live.db'));
    source.close();
    const file = encrypt(pack([{ name: 'health.db', data: bytes }]), PASS, { logN: 14, r: 8, p: 1 });
    assert.equal(await loadFromBackup({ file, passphrase: PASS, migrateUrl: urlAs('migrate'), log: quiet }), 0);
  } finally {
    await Promise.all(pools.map((p) => p.end()));
    rmSync(dir, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
    await dropWhenIdle(admin, database);
    for (const r of ['app', 'backup', 'migrate']) await admin.query(`DROP ROLE IF EXISTS "${prefix}_${r}"`);
    await admin.end();
  }
});

test('rollback-export: refuses while connected, then an encrypted SQLite backup with the same rows', { skip }, async () => {
  const target = await freshPgDatabase();
  const work = mkdtempSync(join(tmpdir(), 'hr-pg-rollback-'));
  let store;
  try {
    store = await openPostgresStore(target.url, { pool: { max: 1 } });
    for (let d = 1; d <= 4; d++) {
      await store.db.prepare("INSERT INTO daily_metrics (user_id, date, steps, updated_at) VALUES (?, ?, ?, 'x')").run(OWNER_ID, `2026-04-0${d}`, 6000 + d);
    }
    const catalog = join(work, 'programs.json');
    writeFileSync(catalog, '{"programs":[]}');
    const run = (waitMs) => rollbackExport({
      backupUrl: target.url, passphrase: PASS, date: '2026-04-05', toDir: work, extras: [{ name: 'programs.json', path: catalog }], log: quiet, waitMs,
    });
    // The app (here, the store's open connection) still connected: refused, nothing written.
    await assert.rejects(run(300), /stop the app/);
    assert.ok(!existsSync(join(work, 'health-2026-04-05.hrbk')));

    await store.close();
    store = null;
    const r = await run(5000);
    assert.equal(r.name, 'health-2026-04-05.hrbk');
    const file = readFileSync(join(work, r.name));
    assert.deepEqual(unpack(decrypt(file, PASS)).map((f) => f.name), ['health.db', 'programs.json']);
    const out = join(work, 'rollback.db');
    restoreBackup({ file, passphrase: PASS, outPath: out });
    const db = new Database(out, { readonly: true });
    try {
      assert.equal(db.prepare('SELECT count(*) AS n FROM daily_metrics').get().n, 4);
      assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 1);
    } finally {
      db.close();
    }
    assert.equal(readdirSync(tmpdir()).filter((n) => n.startsWith('hr-rollback-')).length, 0, 'no plaintext left in temp');
  } finally {
    await store?.close();
    await target.drop();
    rmSync(work, { recursive: true, force: true });
  }
});

test('load-from-backup: a SQLite backup into an empty database, verified, with the catalog written once', { skip }, async () => {
  const work = mkdtempSync(join(tmpdir(), 'hr-pg-load-'));
  const target = await freshPgDatabase();
  try {
    const source = openOwnerStore(join(work, 'live.db'));
    const ins = source.syncDb.prepare("INSERT INTO daily_metrics (user_id, date, steps, updated_at) VALUES (@uid, ?, ?, 'x')");
    for (let d = 1; d <= 5; d++) ins.run(`2026-03-0${d}`, 7000 + d);
    source.syncDb.pragma('wal_checkpoint(TRUNCATE)');
    const bytes = readFileSync(join(work, 'live.db'));
    source.close();
    const file = encrypt(pack([{ name: 'health.db', data: bytes }, { name: 'programs.json', data: Buffer.from('{"programs":[]}') }]), PASS, { logN: 14, r: 8, p: 1 });
    const catalogPath = join(work, 'maps', 'programs.json');
    const lines = [];
    assert.equal(await loadFromBackup({ file, passphrase: PASS, migrateUrl: target.url, catalogPath, log: (l) => lines.push(l) }), 0);
    assert.equal(readFileSync(catalogPath, 'utf8'), '{"programs":[]}');
    assert.ok(lines.some((l) => /PASS/.test(l)));
    assert.ok(!lines.join('\n').includes('7001'), 'no values in the output');
    assert.equal((await target.pool.query('SELECT count(*)::int AS n FROM daily_metrics')).rows[0].n, 5);
    // A PostgreSQL backup is refused (load-from-backup takes the SQLite server's).
    const dumpFile = encrypt(pack([{ name: 'health.dump', data: Buffer.from('x') }]), PASS, { logN: 14, r: 8, p: 1 });
    await assert.rejects(loadFromBackup({ file: dumpFile, passphrase: PASS, migrateUrl: target.url, catalogPath, log: quiet }), /SQLite backup/);
  } finally {
    await target.drop();
    rmSync(work, { recursive: true, force: true });
  }
});
