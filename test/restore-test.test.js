// The monthly backup restore test (tools/backup/restore-check.js, jobs/restore-check.js). Synthetic data; Google Drive is
// faked, nothing touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHealthStore } from '../db/store.js';
import { backupName } from '../tools/backup/run.js';
import { encrypt, pack } from '../tools/backup/crypto.js';
import { restoreTest } from '../tools/backup/restore-check.js';
import { restoreTestJob } from '../jobs/restore-check.js';
import { dataCheckWarnings } from '../server/queries.js';

const PASS = 'correct horse battery staple';
const leftovers = () => readdirSync(tmpdir()).filter((n) => n.startsWith('hr-restore-test-')).length;

function fakeDrive() {
  const files = new Map();
  let n = 0;
  return {
    files,
    async ensureFolder() { return 'folder-1'; },
    async upload(folder, name, data) { const id = `f${++n}`; files.set(id, { id, name, data }); return { id, name, size: data.length }; },
    async list() { return [...files.values()].map(({ id, name, data }) => ({ id, name, size: data.length })); },
    async remove(id) { files.delete(id); },
    async download(id) { return files.get(id).data; },
  };
}

function liveStore() {
  const store = openHealthStore(join(mkdtempSync(join(tmpdir(), 'hr-live-')), 'live.db'));
  const ins = store.db.prepare("INSERT INTO daily_metrics (date, steps, updated_at) VALUES (?, ?, 'x')");
  for (let d = 1; d <= 12; d++) ins.run(`2026-03-${String(d).padStart(2, '0')}`, 8000 + d);
  return store;
}

// A backup in the real format (encrypt(pack([health.db]))) built straight from the database file, without runBackup's
// temp snapshot folder, so this file never races test/backup.test.js's count of those folders (files run in parallel).
const FAST = { logN: 14, r: 8, p: 1 };
const backupOf = async (store, drive, date = '2026-03-12') => {
  store.db.pragma('wal_checkpoint(TRUNCATE)');
  const data = encrypt(pack([{ name: 'health.db', data: readFileSync(store.db.name) }]), PASS, FAST);
  const r = await drive.upload('folder-1', backupName(date), data);
  return { driveFileId: r.id, name: r.name };
};

test('restore test: a good backup passes; rows added since are differences, not failures; nothing is left in temp', async () => {
  const store = liveStore();
  const drive = fakeDrive();
  const r0 = await backupOf(store, drive);
  const before = leftovers();
  const pass = restoreTest({ file: drive.files.get(r0.driveFileId).data, passphrase: PASS, live: store.db });
  assert.equal(pass.ok, true);
  assert.deepEqual(pass.problems, []);
  assert.deepEqual(pass.differences, []);
  assert.ok(pass.tables >= 20);

  store.db.prepare("INSERT INTO daily_metrics (date, steps, updated_at) VALUES ('2026-03-13', 9000, 'x')").run(); // today's data, after the backup
  const later = restoreTest({ file: drive.files.get(r0.driveFileId).data, passphrase: PASS, live: store.db });
  assert.equal(later.ok, true);
  assert.deepEqual(later.differences, [{ table: 'daily_metrics', backup: 12, live: 13 }]);
  assert.equal(leftovers(), before, 'the decrypted copy is deleted');
  store.close();
});

test('restore test fails: a wrong passphrase or a damaged file throws; a missing table or an emptied one is a problem; temp is cleaned up', async () => {
  const store = liveStore();
  const drive = fakeDrive();
  const r0 = await backupOf(store, drive);
  const file = drive.files.get(r0.driveFileId).data;
  const before = leftovers();
  assert.throws(() => restoreTest({ file, passphrase: 'a different long passphrase', live: store.db }));
  const damaged = Buffer.from(file);
  damaged[damaged.length - 20] ^= 0xff;
  assert.throws(() => restoreTest({ file: damaged, passphrase: PASS, live: store.db }));
  assert.equal(leftovers(), before, 'nothing left behind after a failure');

  // A table the live database has but the backup lacks, and a table empty in the backup that holds 10+ rows live.
  store.db.exec('CREATE TABLE added_later (id INTEGER PRIMARY KEY)');
  const ins = store.db.prepare("INSERT INTO checkins (date, cadence, readiness, source, updated_at) VALUES (?, 'daily', 7, 'ui', 'x')");
  for (let d = 1; d <= 10; d++) ins.run(`2026-02-${String(d).padStart(2, '0')}`);
  const r = restoreTest({ file, passphrase: PASS, live: store.db });
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems, ['table added_later is missing from the backup', 'table checkins is empty in the backup but has 10 rows']);

  // A backup taken before a migration lacks that migration's tables: recorded, not a problem.
  const cols = store.db.prepare('PRAGMA table_info(schema_migrations)').all().map((c) => c.name);
  store.db.prepare(`INSERT INTO schema_migrations (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((c) => (c === 'id' ? '999-later' : 'x')));
  const older = restoreTest({ file, passphrase: PASS, live: store.db });
  assert.deepEqual(older.problems, ['table checkins is empty in the backup but has 10 rows']);
  assert.ok(older.differences.some((d) => d.table === 'added_later' && d.backup === null));
  store.close();
});

test('restore test job: records a run with counts only; a failure is a Today warning until a later test passes', async () => {
  const store = liveStore();
  const drive = fakeDrive();
  await backupOf(store, drive, '2026-03-11');
  await backupOf(store, drive, '2026-03-12');
  const ok = await restoreTestJob({ store, drive, passphrase: PASS });
  assert.equal(ok.file, 'health-2026-03-12.hrbk', 'the newest backup');
  const run = () => store.db.prepare("SELECT status, summary FROM runs WHERE name = 'restore-test' ORDER BY id DESC LIMIT 1").get();
  assert.equal(run().status, 'ok');
  assert.deepEqual(Object.keys(JSON.parse(run().summary)).sort(), ['differences', 'file', 'problems', 'rowsBackup', 'rowsLive', 'tables']);
  assert.ok(!dataCheckWarnings(store.db, '2026-03-13').some((w) => w.kind === 'restore_test_failed'));

  await assert.rejects(restoreTestJob({ store, drive, passphrase: 'a different long passphrase' }));
  assert.equal(run().status, 'error');
  const warning = dataCheckWarnings(store.db, '2026-03-13').find((w) => w.kind === 'restore_test_failed');
  assert.match(warning.message, /^The last backup restore test failed \(\d{4}-\d{2}-\d{2}\): .*npm run backup:test/);

  await restoreTestJob({ store, drive, passphrase: PASS });
  assert.ok(!dataCheckWarnings(store.db, '2026-03-13').some((w) => w.kind === 'restore_test_failed'), 'a passing test clears it');
  await assert.rejects(restoreTestJob({ store, drive: { ...fakeDrive() }, passphrase: PASS }), /No backups found/);
  store.close();
});
