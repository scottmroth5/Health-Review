// The sync as a job: npm run sync, Sync now and the in-app scheduler (SCHEDULE_SYNC) run this. Apple Health comes from
// the Drive folders here, or (APPLE_SOURCE=rest, the server) through POST /api/ingest/*, so the sync then only reads the
// Workout Log sheet.
import { getGoogleAuth } from '../tools/google/auth.js';
import { createSheetsSource } from '../ingest/sheets.js';
import { runSync } from '../ingest/sync.js';

const quiet = { info() {}, warn() {}, error() {} };

/** @returns {Promise<{ counts: object, warnings: object[] }>} */
export function syncJob({ store, backfill = false, logger = quiet, source }) {
  return runSync({ store, source: source ?? createSheetsSource(getGoogleAuth()), backfill, logger });
}
