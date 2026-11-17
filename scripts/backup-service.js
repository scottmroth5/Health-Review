// The backup container on PostgreSQL (v3 Phase 1G, docs/adr/0010): the only place pg_dump and pg_restore run, so the app
// image stays free of them. deploy/compose.yml runs it with the server's .env and data folder.
//   node scripts/backup-service.js                         the schedule: SCHEDULE_BACKUP and SCHEDULE_RESTORE_TEST, the
//                                                          same jobs, runs and failure emails as the app's scheduler
//   node scripts/backup-service.js backup-now              one encrypted backup to Drive (deploy.sh, before migrating)
//   node scripts/backup-service.js restore-test            one restore test
//   node scripts/backup-service.js pre-migrate             exit 0 none pending, 10 pending (checked dump kept), 1 failed
//   node scripts/backup-service.js restore-pre-migration   a failed deploy: the dump back over the live database
//   node scripts/backup-service.js load-from-backup [--file <hrbk>]   newest backup in production's Drive folder (or a
//                                                          file) into an empty database
//   node scripts/backup-service.js reset-database --confirm <database>   before a load: refuses while anything else is
//                                                          connected, keeps a checked dump, then empties and migrates
//   node scripts/backup-service.js rollback-export         the 14 days after cutover: the database as an encrypted SQLite
//                                                          backup in this server's Drive folder (the old server restores
//                                                          it with backup:restore --file latest); refuses while connected
// Database URLs (never logged): DATABASE_URL (hr_app: runs, alerts, live counts), BACKUP_DATABASE_URL (hr_backup:
// pg_dump), MIGRATE_DATABASE_URL (hr_migrate: restore and load only).
import { readFileSync, statSync } from 'node:fs';
import { openStore } from '../db/store.ts';
import { scopeStore } from '../db/scope.ts';
import { OWNER_ID, getUser } from '../db/users.ts';
import { backupJob } from '../jobs/backup.js';
import { restoreTestJob } from '../jobs/restore-check.js';
import { createScheduler, schedulesFromEnv } from '../server/scheduler.js';
import { jobRunsLookup } from '../server/admin-queries.js';
import { createAlerts } from '../server/alerts.js';
import { createMailer } from '../tools/mail.ts';
import { dataPath } from '../tools/paths.ts';
import { createDriveClient } from '../tools/backup/drive.js';
import { PRODUCTION_DRIVE_FOLDER } from '../tools/backup/run.js';
import { newestBackup } from '../tools/backup/restore-check.js';
import { getGoogleAuth } from '../tools/google/auth.js';
import { loadFromBackup, newestDumpSince, preMigrate, resetDatabase, restorePreMigration, rollbackExport } from '../tools/backup/pg-deploy.js';
import { localDate } from '../tools/time.ts';

const [command = 'serve', ...rest] = process.argv.slice(2);
const arg = (flag) => { const i = rest.indexOf(flag); return i >= 0 ? rest[i + 1] : undefined; };
const need = (name) => {
  const v = process.env[name];
  if (!v) throw Object.assign(new Error(`${name} is not set`), { name: 'ConfigError' });
  return v;
};
const backupsDir = dataPath('backups');
const DEPLOY_MARKER = dataPath('.deploy-started');

async function withAppStore(fn) {
  const store = await openStore({ url: need('DATABASE_URL'), migrate: false, allUsers: true });
  try { return await fn(store); } finally { await store.close(); }
}

const backupOnce = (store) => backupJob({ store: scopeStore(store, OWNER_ID), pgUrl: need('BACKUP_DATABASE_URL'), copiesDir: backupsDir });
const restoreTestOnce = (store) => restoreTestJob({ store: scopeStore(store, OWNER_ID) });

async function serve() {
  const store = await openStore({ url: need('DATABASE_URL'), migrate: false, allUsers: true });
  const mailer = createMailer();
  const adminEmail = async () => process.env.ADMIN_EMAIL || (await getUser(store.db, OWNER_ID))?.email;
  const alerts = createAlerts({ db: store.db, mailer, adminEmail, appUrl: () => process.env.PUBLIC_URL || '' });
  const ownerJob = async (job, fn) => {
    try {
      await fn();
      await alerts.recovered(job);
    } catch (err) {
      await alerts.alert(job, `the ${job} failed`, `The scheduled ${job} failed (${err.name}).`);
      throw err;
    }
  };
  const runners = {
    backup: () => ownerJob('backup', async () => { const r = await backupOnce(store); console.log(`[backup] ok ${r.name} ${r.bytes} bytes`); }),
    'restore-test': () => ownerJob('restore-test', async () => {
      const r = await restoreTestOnce(store);
      console.log(`[restore-test] ${r.ok ? 'ok' : 'failed'} ${r.file} tables=${r.tables} problems=${r.problems.length}`);
      if (!r.ok) throw Object.assign(new Error('restore test failed'), { name: 'RestoreTestFailed' });
    }),
  };
  const scheduler = createScheduler({
    jobs: schedulesFromEnv().filter((j) => runners[j.name]).map((j) => ({ ...j, run: runners[j.name] })),
    runs: jobRunsLookup(store.db),
  });
  await scheduler.start();
  // The scheduler's timer does not hold the process open; this does, until a stop signal.
  const keepAlive = setInterval(() => {}, 1 << 30);
  const stop = async () => {
    scheduler.stop();
    clearInterval(keepAlive);
    await store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
  console.log('[backup-service] running');
}

async function main() {
  switch (command) {
    case 'serve':
      await serve();
      return 0;
    case 'backup-now':
      return withAppStore(async (store) => {
        const r = await backupOnce(store);
        console.log(`backup: ok ${r.name} ${r.bytes} bytes`);
        return 0;
      });
    case 'restore-test':
      return withAppStore(async (store) => {
        const r = await restoreTestOnce(store);
        console.log(`restore-test: ${r.ok ? 'ok' : 'failed'} tables=${r.tables} problems=${r.problems.length}`);
        return r.ok ? 0 : 1;
      });
    case 'pre-migrate':
      return (await preMigrate({ backupUrl: need('BACKUP_DATABASE_URL'), dir: backupsDir })).code;
    case 'restore-pre-migration': {
      let since;
      try { since = statSync(DEPLOY_MARKER).mtime; } catch { throw new Error('No deploy marker (data/.deploy-started); nothing to restore'); }
      const file = newestDumpSince(backupsDir, since);
      if (!file) throw new Error('No pre-migration dump since this deploy began; nothing to restore');
      await restorePreMigration({ migrateUrl: need('MIGRATE_DATABASE_URL'), file });
      return 0;
    }
    case 'reset-database':
      return resetDatabase({
        backupUrl: need('BACKUP_DATABASE_URL'), migrateUrl: need('MIGRATE_DATABASE_URL'), dir: backupsDir, confirm: arg('--confirm'),
      });
    case 'rollback-export':
      await rollbackExport({
        backupUrl: need('BACKUP_DATABASE_URL'), passphrase: need('HEALTH_BACKUP_PASSPHRASE'), date: localDate(),
        drive: createDriveClient(getGoogleAuth()), extras: [{ name: 'programs.json', path: dataPath('maps', 'programs.json') }],
      });
      return 0;
    case 'load-from-backup': {
      const passphrase = need('HEALTH_BACKUP_PASSPHRASE');
      let file;
      if (arg('--file')) file = readFileSync(arg('--file'));
      else {
        const drive = createDriveClient(getGoogleAuth());
        const newest = await newestBackup(drive, PRODUCTION_DRIVE_FOLDER);
        if (!newest) throw new Error(`No backups found in the "${PRODUCTION_DRIVE_FOLDER}" folder`);
        console.log(`load-from-backup: ${newest.name}`);
        file = await drive.download(newest.id);
      }
      return loadFromBackup({ file, passphrase, migrateUrl: need('MIGRATE_DATABASE_URL'), catalogPath: dataPath('maps', 'programs.json') });
    }
    default:
      throw new Error(`Unknown command "${command}"`);
  }
}

main().then((code) => {
  if (command !== 'serve') process.exitCode = code;
}, (err) => {
  // Names and messages written for people; a pg tool's own output never reaches here (tools/backup/pg.js).
  console.error(`[backup-service] ${command} failed: ${err.name}: ${err.message}`);
  process.exitCode = 1;
});
