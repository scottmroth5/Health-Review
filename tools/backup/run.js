// The nightly encrypted backup: snapshot the live database safely, pack it with the program catalog, encrypt,
// prove the result decrypts to the same bytes, then upload to the app's Google Drive folder (or write it to a
// folder, e.g. a USB drive) and prune old copies. The plaintext snapshot only ever exists in the OS temp folder
// and is deleted on every exit path. Nothing here logs file contents or the passphrase.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { checkPassphrase, decrypt, encrypt, pack, sha256, unpack } from './crypto.js';

export const DRIVE_FOLDER = 'Health-Review backups';
export const RETENTION = { nightly: 7, weekly: 3, monthly: 1 }; // owner's choice, 2026-10-05
const NAME = /^health-(\d{4}-\d{2}-\d{2})\.hrbk$/;

export const backupName = (date) => `health-${date}.hrbk`;
const dayOf = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const weekOf = (d) => addDays(d, 6 - dayOf(d)); // weeks end on Saturday, like the rest of the app

/**
 * Which backups to keep: the newest `nightly` days, then the newest backup of each of the next `weekly` weeks,
 * then of the next `monthly` months. Names that are not backups are never touched.
 * @param {string[]} names
 * @returns {{ keep: string[], remove: string[] }}
 */
export function retention(names, { nightly, weekly, monthly } = RETENTION) {
  const dated = names.map((n) => ({ n, d: NAME.exec(n)?.[1] })).filter((x) => x.d).sort((a, b) => b.d.localeCompare(a.d));
  const keep = new Set(dated.slice(0, nightly).map((x) => x.n));
  // The newest backup of each of the next `count` weeks (or months) not already covered by a kept backup.
  const pick = (count, keyOf) => {
    const covered = new Set(dated.filter((x) => keep.has(x.n)).map((x) => keyOf(x.d)));
    let added = 0;
    for (const x of dated) {
      if (added >= count) break;
      if (keep.has(x.n) || covered.has(keyOf(x.d))) continue;
      covered.add(keyOf(x.d));
      keep.add(x.n);
      added += 1;
    }
  };
  pick(weekly, weekOf);
  pick(monthly, (d) => d.slice(0, 7));
  return { keep: dated.filter((x) => keep.has(x.n)).map((x) => x.n), remove: dated.filter((x) => !keep.has(x.n)).map((x) => x.n) };
}

/**
 * @param {object} o
 * @param {import('better-sqlite3').Database} o.db  the live database (backed up online, safe while the app runs)
 * @param {string} o.passphrase
 * @param {Array<{name: string, path: string}>} [o.extras]  other files to include when they exist
 * @param {object} [o.drive]  createDriveClient(...) or a fake; with o.toDir the upload is skipped
 * @param {string} [o.toDir]  write the encrypted file to this folder instead
 * @param {string} o.date  YYYY-MM-DD, the backup's name
 */
export async function runBackup({ db, passphrase, extras = [], drive, toDir, date }) {
  checkPassphrase(passphrase);
  if (!drive && !toDir) throw new Error('Nowhere to put the backup');
  const tmp = mkdtempSync(join(tmpdir(), 'hr-backup-'));
  try {
    const snapshot = join(tmp, 'health.db');
    await db.backup(snapshot);
    const check = new Database(snapshot, { readonly: true });
    const integrity = check.pragma('integrity_check', { simple: true });
    check.close();
    if (integrity !== 'ok') throw new Error('The database snapshot failed its integrity check; nothing was uploaded');

    const dbBytes = readFileSync(snapshot);
    const files = [{ name: 'health.db', data: dbBytes }];
    for (const x of extras) if (existsSync(x.path)) files.push({ name: x.name, data: readFileSync(x.path) });
    const encrypted = encrypt(pack(files), passphrase);
    // Prove the file restores before it goes anywhere.
    const back = unpack(decrypt(encrypted, passphrase));
    if (back.length !== files.length || back[0].sha256 !== sha256(dbBytes)) throw new Error('The encrypted backup did not verify; nothing was uploaded');

    const name = backupName(date);
    const summary = { name, bytes: encrypted.length, files: files.map((f) => f.name) };
    if (toDir) {
      const out = join(toDir, name);
      writeFileSync(out, encrypted);
      return { ...summary, savedTo: out };
    }
    const folder = await drive.ensureFolder(DRIVE_FOLDER);
    const before = await drive.list(folder);
    const uploaded = await drive.upload(folder, name, encrypted);
    // A second backup on the same day replaces the earlier one.
    for (const f of before.filter((f) => f.name === name)) await drive.remove(f.id);
    const after = (await drive.list(folder)).filter((f) => f.id === uploaded.id || f.name !== name);
    const { keep, remove } = retention(after.map((f) => f.name));
    for (const f of after.filter((f) => remove.includes(f.name))) await drive.remove(f.id);
    return { ...summary, driveFileId: uploaded.id, kept: keep.length, deleted: remove.length };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Decrypts a backup into new files: the database at outPath (never over an existing file) and any other
 * files next to it as restored-<name>. Checks the restored database's integrity.
 */
export function restoreBackup({ file, passphrase, outPath }) {
  if (existsSync(outPath)) throw new Error(`${outPath} already exists; choose a new file name`);
  const files = unpack(decrypt(file, passphrase));
  const db = files.find((f) => f.name === 'health.db');
  if (!db) throw new Error('The backup has no database in it');
  writeFileSync(outPath, db.data);
  const check = new Database(outPath, { readonly: true });
  const integrity = check.pragma('integrity_check', { simple: true });
  check.close();
  if (integrity !== 'ok') throw new Error('The restored database failed its integrity check');
  const others = files.filter((f) => f !== db).map((f) => {
    const p = join(dirname(outPath), `restored-${basename(f.name)}`);
    if (existsSync(p)) throw new Error(`${p} already exists`);
    writeFileSync(p, f.data);
    return p;
  });
  return { database: outPath, others };
}
