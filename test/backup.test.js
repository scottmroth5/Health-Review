// Encrypted backups. Synthetic data only; Google Drive is faked, nothing touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { decrypt, encrypt, pack, unpack } from '../tools/backup/crypto.js';
import { backupName, restoreBackup, retention, runBackup, DRIVE_FOLDER } from '../tools/backup/run.js';

const PASS = 'correct horse battery staple';
const FAST = { logN: 14, r: 8, p: 1 }; // test speed only; real backups use the default (2^17)

function fakeDrive() {
  const files = new Map();
  let n = 0;
  const calls = [];
  return {
    files,
    calls,
    async ensureFolder(name) { calls.push(['folder', name]); return 'folder-1'; },
    async upload(folder, name, data) { calls.push(['upload', name]); const id = `f${++n}`; files.set(id, { id, name, data, folder }); return { id, name, size: data.length }; },
    async list() { calls.push(['list']); return [...files.values()].map(({ id, name, data }) => ({ id, name, size: data.length })); },
    async remove(id) { calls.push(['remove', id]); files.delete(id); },
  };
}

function sampleDb() {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('synthetic a'), ('synthetic b');");
  return db;
}

test('crypto: round trip; fresh salt and nonce each time; wrong passphrase and any changed byte fail', () => {
  const plain = Buffer.from('synthetic payload '.repeat(50));
  const a = encrypt(plain, PASS, FAST);
  const b = encrypt(plain, PASS, FAST);
  assert.deepEqual(decrypt(a, PASS), plain);
  assert.notDeepEqual(a, b, 'two encryptions of the same data differ');
  assert.throws(() => decrypt(a, 'a different passphrase!!'), /wrong passphrase, or the file was changed/);
  for (const at of [6, 10, 30, a.length - 20, a.length - 1]) { // key settings, salt, nonce, ciphertext, tag
    const bad = Buffer.from(a);
    bad[at] ^= 1;
    assert.throws(() => decrypt(bad, PASS), at === 6 ? /invalid key settings|wrong passphrase/ : /wrong passphrase, or the file was changed/, `byte ${at}`);
  }
  assert.throws(() => decrypt(Buffer.from('not a backup at all, just text'), PASS), /Not a Health-Review backup/);
  assert.throws(() => encrypt(plain, 'short'), /at least 16 characters/);
  assert.throws(() => encrypt(plain, ''), /HEALTH_BACKUP_PASSPHRASE is not set/);
});

test('crypto: archives hold several files and detect damage', () => {
  const files = [{ name: 'health.db', data: Buffer.from('db bytes') }, { name: 'programs.json', data: Buffer.from('{"version":1}') }];
  assert.deepEqual(unpack(pack(files)).map((f) => [f.name, f.data.toString()]), [['health.db', 'db bytes'], ['programs.json', '{"version":1}']]);
});

test('retention: 7 nightly, then the newest of 3 more weeks, then of 1 more month', () => {
  const days = Array.from({ length: 70 }, (_, i) => new Date(Date.UTC(2026, 9, 5) - i * 86400000).toISOString().slice(0, 10));
  const { keep, remove } = retention([...days.map(backupName), 'notes.txt']);
  assert.deepEqual(keep, [
    ...days.slice(0, 7).map(backupName), // Oct 5 back to Sep 29
    backupName('2026-09-26'), backupName('2026-09-19'), backupName('2026-09-12'), // newest of the next three Saturday-ending weeks
    backupName('2026-08-31'), // newest of the next month
  ]);
  assert.equal(keep.length + remove.length, 70, 'files that are not backups are never touched');
});

test('backup: uploads one encrypted, verified file with no readable database bytes, prunes, and leaves no temp files', async () => {
  const db = sampleDb();
  const drive = fakeDrive();
  const dir = mkdtempSync(join(tmpdir(), 'hr-test-'));
  writeFileSync(join(dir, 'programs.json'), '{"version":1,"programs":[]}');
  for (let i = 1; i <= 9; i++) drive.files.set(`old${i}`, { id: `old${i}`, name: backupName(`2026-09-${String(20 + i).padStart(2, '0')}`), data: Buffer.from('x') });
  const tmpBefore = readdirSync(tmpdir()).filter((n) => n.startsWith('hr-backup-')).length;

  const r = await runBackup({ db, passphrase: PASS, extras: [{ name: 'programs.json', path: join(dir, 'programs.json') }, { name: 'missing.json', path: join(dir, 'nope.json') }], drive, date: '2026-10-05' });
  assert.deepEqual([r.name, r.files, r.kept], ['health-2026-10-05.hrbk', ['health.db', 'programs.json'], 7]);
  assert.equal(drive.calls[0][1], DRIVE_FOLDER);
  const uploaded = drive.files.get(r.driveFileId).data;
  assert.equal(uploaded.subarray(0, 5).toString(), 'HRBK1');
  assert.ok(!uploaded.includes(Buffer.from('SQLite format 3')) && !uploaded.includes(Buffer.from('synthetic a')), 'nothing readable is uploaded');
  assert.deepEqual(unpack(decrypt(uploaded, PASS)).map((f) => f.name), ['health.db', 'programs.json']);
  assert.ok(drive.calls.every(([kind]) => ['folder', 'list', 'upload', 'remove'].includes(kind)));
  assert.equal(readdirSync(tmpdir()).filter((n) => n.startsWith('hr-backup-')).length, tmpBefore, 'temp snapshot deleted');

  const again = await runBackup({ db, passphrase: PASS, drive, date: '2026-10-05' });
  assert.equal([...drive.files.values()].filter((f) => f.name === again.name).length, 1, 'a second run the same day replaces the first');
  db.close();
});

test('backup: no passphrase or a short one stops before anything is written; --to writes to a folder instead', async () => {
  const db = sampleDb();
  const drive = fakeDrive();
  await assert.rejects(runBackup({ db, passphrase: undefined, drive, date: '2026-10-05' }), /not set/);
  assert.equal(drive.calls.length, 0);
  const dir = mkdtempSync(join(tmpdir(), 'hr-usb-'));
  const r = await runBackup({ db, passphrase: PASS, toDir: dir, date: '2026-10-05' });
  assert.equal(r.savedTo, join(dir, 'health-2026-10-05.hrbk'));
  assert.equal(readFileSync(r.savedTo).subarray(0, 5).toString(), 'HRBK1');
  db.close();
});

test('restore: a backup restores to an identical database and never overwrites a file', async () => {
  const db = sampleDb();
  const dir = mkdtempSync(join(tmpdir(), 'hr-restore-'));
  writeFileSync(join(dir, 'programs.json'), '{"version":1}');
  const r = await runBackup({ db, passphrase: PASS, toDir: dir, extras: [{ name: 'programs.json', path: join(dir, 'programs.json') }], date: '2026-10-05' });
  const out = join(dir, 'restored.db');
  const res = restoreBackup({ file: readFileSync(r.savedTo), passphrase: PASS, outPath: out });
  const restored = new Database(out, { readonly: true });
  assert.deepEqual(restored.prepare('SELECT v FROM t ORDER BY id').all().map((x) => x.v), ['synthetic a', 'synthetic b']);
  restored.close();
  assert.deepEqual(res.others, [join(dir, 'restored-programs.json')]);
  assert.throws(() => restoreBackup({ file: readFileSync(r.savedTo), passphrase: PASS, outPath: out }), /already exists/);
  assert.throws(() => restoreBackup({ file: readFileSync(r.savedTo), passphrase: 'wrong wrong wrong wrong', outPath: join(dir, 'other.db') }), /wrong passphrase/);
  assert.ok(!existsSync(join(dir, 'other.db')));
  db.close();
});
