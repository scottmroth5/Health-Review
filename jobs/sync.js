// The sync as a job: npm run sync, Sync now and the in-app scheduler (SCHEDULE_SYNC) run this. Apple Health comes from
// the Drive folders here, or (APPLE_SOURCE=rest, the server) through POST /api/ingest/*, so the sync then only reads the
// Workout Log sheet.
import { getGoogleAuth } from '../tools/google/auth.js';
import { createSheetsSource } from '../ingest/sheets.js';
import { runSync } from '../ingest/sync.js';
import { OWNER_ID } from '../db/users.js';

const quiet = { info() {}, warn() {}, error() {} };

/** @returns {Promise<{ counts: object, warnings: object[] }>} */
export function syncJob({ store, backfill = false, logger = quiet, source }) {
  // The Google feeds in .env (the Drive folders and the Workout Log sheet) are the owner's; other users' own feeds come
  // with per-user feeds (multi-user, phase 3), and until then their sync has nothing to read.
  if (store.db.uid !== OWNER_ID) return Promise.resolve({ counts: {}, warnings: [] });
  return runSync({ store, source: source ?? createSheetsSource(getGoogleAuth()), backfill, logger });
}
