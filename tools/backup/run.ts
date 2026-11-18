// The nightly encrypted backup: snapshot the live database safely, pack it with the program catalog, encrypt,
// prove the result decrypts to the same bytes, then upload to the app's Google Drive folder (or write it to a
// folder, e.g. a USB drive) and prune old copies. The plaintext snapshot only ever exists in the OS temp folder
// and is deleted on every exit path. Nothing here logs file contents or the passphrase.
// Two engines: SQLite (db, better-sqlite3's online backup plus its integrity check, packed as health.db) and
// PostgreSQL (pgUrl, v3 Phase 1G: pg_dump as the backup role, restored into a throwaway local cluster as the check,
// packed as health.dump; tools/backup/pg.ts, in the backup container only).
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { checkPassphrase, decrypt, encrypt, pack, sha256, unpack } from './crypto.ts';
import type { ArchiveFile } from './crypto.ts';
import type { DriveClient } from './drive.ts';

/** Production's backup folder in Google Drive. */
export const PRODUCTION_DRIVE_FOLDER = 'Health-Review backups';
/**
 * Where this server's backups go: production's folder, unless BACKUP_DRIVE_FOLDER names another (staging, v3 Phase 1G:
 * so a test backup never replaces production's for the day, and a PostgreSQL backup never reaches the folder the SQLite
 * server's restore test reads).
 */
export const DRIVE_FOLDER = process.env.BACKUP_DRIVE_FOLDER?.trim() || PRODUCTION_DRIVE_FOLDER;
export const RETENTION = { nightly: 7, weekly: 3, monthly: 1 }; // owner's choice, 2026-10-05
const NAME = /^health-(\d{4}-\d{2}-\d{2})\.hrbk$/;

export const backupName = (date: string): string => `health-${date}.hrbk`;
const dayOf = (d: string): number => new Date(`${d}T00:00:00Z`).getUTCDay();
const addDays = (d: string, n: number): string => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const weekOf = (d: string): string => addDays(d, 6 - dayOf(d)); // weeks end on Saturday, like the rest of the app

/**
 * Which backups to keep: the newest `nightly` days, then the newest backup of each of the next `weekly` weeks,
 * then of the next `monthly` months. Names that are not backups are never touched.
 */
export function retention(names: string[], { nightly, weekly, monthly }: typeof RETENTION = RETENTION): { keep: string[], remove: string[] } {
  const dated = names.flatMap((n) => { const d = NAME.exec(n)?.[1]; return d ? [{ n, d }] : []; }).sort((a, b) => b.d.localeCompare(a.d));
  const keep = new Set(dated.slice(0, nightly).map((x) => x.n));
  // The newest backup of each of the next `count` weeks (or months) not already covered by a kept backup.
  const pick = (count: number, keyOf: (d: string) => string) => {
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

export interface BackupOptions {
  /** A SQLite live database (backed up online, safe while the app runs). */
  db?: Database.Database;
  /** Or a PostgreSQL one: the backup role's URL (never logged). */
  pgUrl?: string;
  passphrase: string | undefined;
  /** Other files to include when they exist. */
  extras?: { name: string, path: string }[];
  /** createDriveClient(...) or a fake; with toDir the upload is skipped. */
  drive?: DriveClient;
  /** Write the encrypted file to this folder instead. */
  toDir?: string;
  /** YYYY-MM-DD, the backup's name. */
  date: string;
}

/** What a backup made: its name, size and files, then where it went. */
export interface BackupResult {
  name: string;
  bytes: number;
  files: string[];
  savedTo?: string;
  driveFileId?: string;
  kept?: number;
  deleted?: number;
}

export async function runBackup({ db, pgUrl, passphrase, extras = [], drive, toDir, date }: BackupOptions): Promise<BackupResult> {
  checkPassphrase(passphrase);
  if (!drive && !toDir) throw new Error('Nowhere to put the backup');
  if (!db === !pgUrl) throw new Error('runBackup: give either a SQLite db or a PostgreSQL URL');
  const tmp = mkdtempSync(join(tmpdir(), 'hr-backup-'));
  try {
    const snapshot = join(tmp, pgUrl ? 'health.dump' : 'health.db');
    if (pgUrl) await pgSnapshot(pgUrl, snapshot);
    else if (db) {
      await db.backup(snapshot);
      const check = new Database(snapshot, { readonly: true });
      const integrity = check.pragma('integrity_check', { simple: true });
      check.close();
      if (integrity !== 'ok') throw new Error('The database snapshot failed its integrity check; nothing was uploaded');
    }

    const dbBytes = readFileSync(snapshot);
    const files: ArchiveFile[] = [{ name: pgUrl ? 'health.dump' : 'health.db', data: dbBytes }];
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
    if (!drive) throw new Error('Nowhere to put the backup');
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
 * A checked PostgreSQL snapshot at file: pg_dump, then restored into a throwaway cluster, which must hold the app's tables
 * (users and schema_migrations among them). PostgreSQL's stand-in for SQLite's integrity check.
 */
export async function pgSnapshot(url: string, file: string): Promise<{ tables: number }> {
  const { dump, restoreInto, withScratchCluster } = await import('./pg.ts');
  const { createPostgresPool } = await import('../../db/postgres.ts');
  await dump(url, file);
  const tables = await withScratchCluster(async (scratch) => {
    await restoreInto(scratch, file);
    const pool = createPostgresPool(scratch, { max: 1 });
    try {
      return (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).rows.map((r: { tablename: string }) => r.tablename);
    } finally {
      await pool.end();
    }
  });
  if (!tables.includes('users') || !tables.includes('schema_migrations')) throw new Error('The database dump did not restore with its tables; nothing was uploaded');
  return { tables: tables.length };
}

/**
 * Decrypts a backup into new files: the database at outPath (never over an existing file) and any other
 * files next to it as restored-<name>. Checks the restored database's integrity.
 */
export function restoreBackup({ file, passphrase, outPath }: { file: Buffer, passphrase: string, outPath: string }): { database: string, others: string[] } {
  // Never over an existing file: 'wx' refuses one in the same step as the write (no check-then-write gap).
  const writeNew = (path: string, data: Buffer, message: string) => {
    try { writeFileSync(path, data, { flag: 'wx' }); } catch (err: any) { throw err.code === 'EEXIST' ? new Error(message) : err; }
  };
  const files = unpack(decrypt(file, passphrase));
  const db = files.find((f) => f.name === 'health.db');
  if (!db) throw new Error(files.some((f) => f.name === 'health.dump')
    ? 'This is a PostgreSQL backup (health.dump); restore it with the backup container (load-from-backup)'
    : 'The backup has no database in it');
  writeNew(outPath, db.data, `${outPath} already exists; choose a new file name`);
  const check = new Database(outPath, { readonly: true });
  const integrity = check.pragma('integrity_check', { simple: true });
  check.close();
  if (integrity !== 'ok') throw new Error('The restored database failed its integrity check');
  const others = files.filter((f) => f !== db).map((f) => {
    const p = join(dirname(outPath), `restored-${basename(f.name)}`);
    writeNew(p, f.data, `${p} already exists`);
    return p;
  });
  return { database: outPath, others };
}
