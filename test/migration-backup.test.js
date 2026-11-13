// Before any migration changes a database file, a checked copy is taken (owner's rule, 2026-10-24), and the pending check
// predicts migrations by running them on a throwaway copy. Synthetic rows only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openSqliteStore as openStore } from '../db/migrate.js';
import { MIGRATIONS } from '../db/migrations.js';
import { migrationCopiesDir, openHealthStore, pendingMigrations, pruneMigrationCopies } from '../db/store.js';
import { repoPath } from '../tools/paths.js';

const quiet = { info() {} };
const copies = (dir) => (existsSync(join(dir, 'backups')) ? readdirSync(join(dir, 'backups')).filter((n) => n.startsWith('pre-migration-')) : []);

/** A database file one migration behind (the newest one not applied), with a row in it. */
function behind(dir) {
  const path = join(dir, 'h.db');
  const old = openStore(path, { app: 'health-review', migrations: MIGRATIONS.slice(0, -1) });
  old.db.prepare("INSERT INTO checkins (user_id, date, cadence, source, updated_at) VALUES ('00000000-0000-4000-8000-000000000001', '2026-01-01', 'daily', 'ui', 'x')").run();
  old.close();
  return path;
}

test('a migration is preceded by a checked copy of the database as it was; an up-to-date open keeps none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-migcopy-'));
  try {
    const path = behind(dir);
    const last = MIGRATIONS.at(-1).id;
    assert.deepEqual(pendingMigrations(path, tmpdir()).pending, [`health-review:${last}`]);
    assert.equal(copies(dir).length, 0, 'the pending check leaves no copy behind');

    openHealthStore(path, { log: quiet }).close();
    const [copy] = copies(dir);
    assert.ok(copy, 'a pre-migration copy was kept');
    const c = new Database(join(dir, 'backups', copy), { readonly: true });
    assert.equal(c.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(c.prepare("SELECT COUNT(*) FROM schema_migrations WHERE id = ?").pluck().get(last), 0, 'it holds the database before the migration');
    assert.equal(c.prepare('SELECT COUNT(*) FROM checkins').pluck().get(), 1);
    c.close();

    openHealthStore(path, { log: quiet }).close();
    assert.equal(copies(dir).length, 1, 'nothing to migrate: no new copy');
    assert.deepEqual(pendingMigrations(path, tmpdir()).pending, []);
    openHealthStore(':memory:').close();
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold a just-closed file a moment */ }
  }
});

test('only the newest 5 pre-migration copies are kept; other files are never touched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-prune-'));
  try {
    for (let i = 1; i <= 7; i++) writeFileSync(join(dir, `pre-migration-2026010${i}T000000Z.db`), '');
    writeFileSync(join(dir, 'health-2026-01-01.hrbk'), '');
    pruneMigrationCopies(dir, { now: new Date('2026-01-08T00:00:00Z') });
    assert.deepEqual(readdirSync(dir).sort(), ['health-2026-01-01.hrbk', ...[3, 4, 5, 6, 7].map((i) => `pre-migration-2026010${i}T000000Z.db`)]);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold a just-closed file a moment */ }
  }
});

test('no pre-migration copy is kept past 14 days, by the stamp in its name; other files are never touched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-prune-age-'));
  try {
    const names = ['pre-migration-20261029T223637015Z.db', 'pre-migration-20261030T000000Z.db', 'pre-migration-20261031T120000500Z.db',
      'pre-migration-20261102T205044305Z.db', 'pre-prompt-trim-20261030T131442187Z.db', 'notes.txt'];
    for (const n of names) writeFileSync(join(dir, n), '');
    // 14 days before 2026-11-13T12:00Z is 2026-10-30T12:00Z: the two copies before it go, the two after it stay.
    const removed = pruneMigrationCopies(dir, { now: new Date('2026-11-13T12:00:00Z') });
    assert.deepEqual(removed.sort(), ['pre-migration-20261029T223637015Z.db', 'pre-migration-20261030T000000Z.db']);
    assert.deepEqual(readdirSync(dir).sort(), ['notes.txt', 'pre-migration-20261031T120000500Z.db', 'pre-migration-20261102T205044305Z.db',
      'pre-prompt-trim-20261030T131442187Z.db']);
    // The count limit still applies to young copies.
    assert.deepEqual(pruneMigrationCopies(dir, { keep: 1, now: new Date('2026-11-13T12:00:00Z') }), ['pre-migration-20261031T120000500Z.db']);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold a just-closed file a moment */ }
  }
});

test('opening a database file prunes old copies even when nothing migrates; the folder follows HEALTH_DB_PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-prune-open-'));
  try {
    const path = join(dir, 'h.db');
    openHealthStore(path, { log: quiet }).close(); // a new, current file
    assert.equal(migrationCopiesDir(path), join(dir, 'backups'));
    const before = process.env.HEALTH_DB_PATH;
    process.env.HEALTH_DB_PATH = path;
    try { assert.equal(migrationCopiesDir(), join(dir, 'backups')); } finally { if (before === undefined) delete process.env.HEALTH_DB_PATH; else process.env.HEALTH_DB_PATH = before; }
    const stale = 'pre-migration-20200101T000000Z.db';
    // A minute back: the open's own copy (named by this millisecond, removed when nothing migrates) must not share its name.
    const fresh = `pre-migration-${new Date(Date.now() - 60_000).toISOString().replace(/[-:.]/g, '')}.db`;
    mkdirSync(join(dir, 'backups'));
    writeFileSync(join(dir, 'backups', stale), '');
    writeFileSync(join(dir, 'backups', fresh), '');
    openHealthStore(path, { log: quiet }).close();
    assert.deepEqual(copies(dir), [fresh], 'the stale copy is gone, the fresh one stays');
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold a just-closed file a moment */ }
  }
});

test('npm run db:pending exits 10 with the pending migrations, 0 when current', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-pending-'));
  try {
    const path = behind(dir);
    const run = () => {
      try {
        return { code: 0, out: execFileSync(process.execPath, [repoPath('scripts', 'migrations-pending.js')], { env: { ...process.env, HEALTH_DB_PATH: path }, encoding: 'utf8' }) };
      } catch (err) {
        return { code: err.status, out: err.stdout };
      }
    };
    const first = run();
    assert.equal(first.code, 10);
    assert.match(first.out, /migrations pending: 1 \(health-review:/);
    openHealthStore(path, { log: quiet }).close();
    const second = run();
    assert.equal(second.code, 0);
    assert.match(second.out, /none/);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold a just-closed file a moment */ }
  }
});
