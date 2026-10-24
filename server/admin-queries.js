// The only queries that read across users (multi-user, phase 1): system checks such as the scheduler's, and later the
// admin's user list. test/user-scope.test.js exempts this file; every other query is scoped to one user (db/scope.js).
// Takes the shared, unscoped database. Metadata only: names, statuses and times, never health or report text.

import { RUNNING_STALE_MINUTES } from './scheduler.js';

/**
 * When each job last ran and whether one is running now, for any user (a scheduled job runs for every user in turn, so
 * catch-up and overlap are judged on the job as a whole).
 */
export function jobRunsLookup(db) {
  const raw = db.unscoped ?? db;
  const last = raw.prepare('SELECT started_at FROM runs WHERE name = ? ORDER BY id DESC LIMIT 1').pluck();
  const running = raw.prepare("SELECT 1 FROM runs WHERE name = ? AND status = 'running' AND started_at >= ? LIMIT 1").pluck();
  return {
    lastRanAt: (name) => last.get(name) ?? null,
    isRunning: (name, now = new Date()) => Boolean(running.get(name, new Date(now.getTime() - RUNNING_STALE_MINUTES * 60_000).toISOString())),
  };
}

/** Users who get scheduled jobs: approved, not paused. The owner is first. */
export function activeUserIds(db) {
  const raw = db.unscoped ?? db;
  return raw.prepare("SELECT id FROM users WHERE status = 'approved' ORDER BY role = 'admin' DESC, created_at").pluck().all();
}
