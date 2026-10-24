// Before any migration changes a database file, a checked copy is taken (owner's rule, 2026-10-24), and the pending check
// predicts migrations by running them on a throwaway copy. Synthetic rows only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openStore } from '@scottmroth5/agent-core';
import { MIGRATIONS } from '../db/migrations.js';
import { openHealthStore, pendingMigrations, pruneMigrationCopies } from '../db/store.js';
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
    pruneMigrationCopies(dir);
    assert.deepEqual(readdirSync(dir).sort(), ['health-2026-01-01.hrbk', ...[3, 4, 5, 6, 7].map((i) => `pre-migration-2026010${i}T000000Z.db`)]);
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
