// The sync as a job: npm run sync, Sync now and the in-app scheduler (SCHEDULE_SYNC) run this. Apple Health comes from
// the Drive folders here, or (APPLE_SOURCE=rest, the server) through POST /api/ingest/*, so the sync then only reads the
// Workout Log sheet.
import { getGoogleAuth } from '../tools/google/auth.js';
import { createSheetsSource } from '../ingest/sheets.js';
import { runSync } from '../ingest/sync.js';
import { OWNER_ID } from '../db/users.js';

const quiet = { info() {}, warn() {}, error() {} };

/**
 * @param {object} o
 * @param {{ auth?: object, sheetId?: string|null, catalog?: object|null, ensureYearTab?: () => Promise<boolean> }} [o.userFeed]
 *   another user's Workout Log: their own Google sign-in (Sheets read only) and their sheet (multi-user, phase 3); Apple
 *   data arrives by their REST posts. ensureYearTab: for a sheet the app created, adds this year's tab first.
 * @returns {Promise<{ counts: object, warnings: object[] }>}
 */
export async function syncJob({ store, backfill = false, logger = quiet, source, userFeed }) {
  if (store.db.uid !== OWNER_ID) {
    // Another user: only their own Workout Log, read with their own permission; nothing of the owner's .env.
    if (!userFeed?.sheetId || !(userFeed.auth || source)) return { counts: {}, warnings: [] };
    // A sheet Health Review created gets this year's tab before it is read (January); a failure is a warning only.
    let tabWarning = null;
    if (userFeed.ensureYearTab) {
      try { await userFeed.ensureYearTab(); } catch (err) {
        tabWarning = { source: 'workout_log', kind: "this year's tab not added", detail: `Add a tab named with this year (${err.name})`, severity: 'warn' };
      }
    }
    const result = await runSync({
      store, source: source ?? createSheetsSource(userFeed.auth, { WORKOUT_LOG_SHEET_ID: userFeed.sheetId }),
      apple: 'rest', exportFolders: {}, logger,
      // Their catalog (server/index.js catalogFor: their own programs, plus MAPS when shared); null: none.
      ...(userFeed.catalog === undefined ? {} : { catalog: userFeed.catalog }),
    });
    if (tabWarning) result.warnings.unshift(tabWarning);
    return result;
  }
  return runSync({ store, source: source ?? createSheetsSource(getGoogleAuth()), backfill, logger });
}
