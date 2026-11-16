// The backup container's deploy and data steps on PostgreSQL (v3 Phase 1G, docs/adr/0010), behind
// scripts/backup-service.js. Back up before every database change (owner's rule):
//   preMigrate              pg_dump of the live database (the backup role) to data/backups/pre-migration-<stamp>.dump,
//                           restored into a throwaway cluster, and this image's pending migrations run there first: 0 none
//                           pending (the dump is removed), 10 pending and they succeed on the copy (the dump is kept for
//                           restorePreMigration), 1 a migration failed on the copy (the live database is untouched).
//   restorePreMigration     a failed deploy: the newest dump since the deploy began goes back over the live database as
//                           the migration role (schema dropped and recreated, then restored; RDS's point-in-time recovery
//                           and the Drive backup remain if this fails).
//   loadFromBackup          a Drive backup's SQLite database into an empty PostgreSQL database (staging now, the 1H
//                           cutover later): audited, copied and verified by fingerprint (scripts/migrate-to-postgres.js).
// Plaintext only in the OS temp folder or data/backups (the server's encrypted disk, mode 600, aged out with the .db
// copies); counts, names and exit codes in the output, never a value or a URL.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPostgresPool } from '../../db/postgres.ts';
import { migratePostgres, pendingPostgres, PG_MIGRATIONS } from '../../db/pg/migrate.js';
import { setupGrants } from '../../db/pg/roles.js';
import { decrypt, unpack } from './crypto.js';
import { restoreBackup } from './run.js';

const stamp = (d = new Date()) => d.toISOString().replace(/[-:.]/g, '').replace(/(\d{3})Z$/, '$1Z');
const DUMP_NAME = /^pre-migration-\d{8}T\d{9}Z\.dump$/;

/**
 * @param {{ backupUrl: string, dir: string, migrations?: typeof PG_MIGRATIONS, log?: (s: string) => void }} o
 * @returns {Promise<{ code: 0 | 10 | 1, pending: string[], file: string | null }>}
 */
export async function preMigrate({ backupUrl, dir, migrations = PG_MIGRATIONS, log = console.log }) {
  const { dump, restoreInto, withScratchCluster } = await import('./pg.js');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `pre-migration-${stamp()}.dump`);
  await dump(backupUrl, file);
  chmodSync(file, 0o600);
  let result;
  try {
    result = await withScratchCluster(async (scratch) => {
      await restoreInto(scratch, file);
      const pool = createPostgresPool(scratch, { max: 1 });
      try {
        const pending = await pendingPostgres(pool, migrations);
        if (!pending.length) return { code: 0, pending };
        try {
          await migratePostgres(pool, migrations);
          return { code: 10, pending };
        } catch (err) {
          log(`pre-migrate: a migration failed on the copy (${err.name}); the live database is untouched`);
          return { code: 1, pending };
        }
      } finally {
        await pool.end();
      }
    });
  } catch (err) {
    rmSync(file, { force: true });
    throw err;
  }
  if (result.code !== 10) rmSync(file, { force: true });
  log(`pre-migrate: ${result.pending.length ? `${result.pending.length} pending (${result.pending.join(', ')})` : 'none pending'}${result.code === 10 ? ', checked dump kept' : ''}`);
  return { ...result, file: result.code === 10 ? file : null };
}

/** The newest pre-migration dump in dir modified after `since` (a Date), or null. */
export function newestDumpSince(dir, since) {
  if (!existsSync(dir)) return null;
  const dumps = readdirSync(dir).filter((n) => DUMP_NAME.test(n)).sort().reverse();
  const name = dumps.find((n) => statSync(join(dir, n)).mtime > since);
  return name ? join(dir, name) : null;
}

/**
 * @param {{ migrateUrl: string, file: string, prefix?: string, log?: (s: string) => void }} o
 */
export async function restorePreMigration({ migrateUrl, file, prefix = 'hr', log = console.log }) {
  const { restoreLive } = await import('./pg.js');
  const pool = createPostgresPool(migrateUrl, { max: 1 });
  try {
    // Objects a failed migration added are not in the dump, so the schema starts empty; one transaction, grants included.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DROP SCHEMA public CASCADE');
      await client.query('CREATE SCHEMA public');
      await setupGrants(client, { prefix });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
  await restoreLive(migrateUrl, file);
  log('restore-pre-migration: the database is back to its state before the deploy');
}

/**
 * A backup's SQLite database into an empty PostgreSQL database, verified. Also writes the backup's program catalog to
 * catalogPath when none is there.
 * @returns {Promise<number>} the exit code (0 pass, 1 fail, 2 audit failures)
 */
export async function loadFromBackup({ file, passphrase, migrateUrl, catalogPath, log = console.log }) {
  const files = unpack(decrypt(file, passphrase));
  if (!files.some((f) => f.name === 'health.db')) throw new Error('load-from-backup takes a SQLite backup (health.db); this one has none');
  const tmp = mkdtempSync(join(tmpdir(), 'hr-load-'));
  try {
    const { database } = restoreBackup({ file, passphrase, outPath: join(tmp, 'health.db') });
    rmSync(join(tmp, 'restored-programs.json'), { force: true });
    const catalog = files.find((f) => f.name === 'programs.json');
    if (catalog && catalogPath) {
      // One step: 'wx' refuses an existing file as it opens it (no check-then-write gap).
      mkdirSync(join(catalogPath, '..'), { recursive: true });
      try {
        writeFileSync(catalogPath, catalog.data, { flag: 'wx', mode: 0o600 });
        log('load-from-backup: program catalog written');
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        log('load-from-backup: the program catalog is already there; kept it');
      }
    }
    const { migrateToPostgres } = await import('../../scripts/migrate-to-postgres.js');
    return await migrateToPostgres({ from: database, url: migrateUrl, log });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
