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
 * @param {{ auth?: object, sheetId?: string|null, catalog?: object|null }} [o.userFeed]  another user's Workout Log: their own
 *   Google sign-in (Sheets read only) and their sheet (multi-user, phase 3); Apple data arrives by their REST posts
 * @returns {Promise<{ counts: object, warnings: object[] }>}
 */
export function syncJob({ store, backfill = false, logger = quiet, source, userFeed }) {
  if (store.db.uid !== OWNER_ID) {
    // Another user: only their own Workout Log, read with their own permission; nothing of the owner's .env.
    if (!userFeed?.sheetId || !(userFeed.auth || source)) return Promise.resolve({ counts: {}, warnings: [] });
    return runSync({
      store, source: source ?? createSheetsSource(userFeed.auth, { WORKOUT_LOG_SHEET_ID: userFeed.sheetId }),
      apple: 'rest', exportFolders: {}, logger,
      // Their catalog (server/index.js catalogFor: their own programs, plus MAPS when shared); null: none.
      ...(userFeed.catalog === undefined ? {} : { catalog: userFeed.catalog }),
    });
  }
  return runSync({ store, source: source ?? createSheetsSource(getGoogleAuth()), backfill, logger });
}
