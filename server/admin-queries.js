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

/** Every user for the admin's Users screen: account facts only (never keys, tokens or health data). Pending first. */
export function listUsers(db) {
  const raw = db.unscoped ?? db;
  return raw.prepare(`SELECT id, email, name, role, status, created_at, approved_at, last_seen_at,
      claude_key_enc IS NOT NULL AS has_key, uses_owner_key, maps_shared
    FROM users ORDER BY status = 'pending' DESC, role = 'admin' DESC, created_at DESC`).all()
    .map((u) => ({ ...u, has_key: Boolean(u.has_key), uses_owner_key: Boolean(u.uses_owner_key), maps_shared: Boolean(u.maps_shared) }));
}

/** A new pending user from a registration (their Google name and address); returns the row. */
export function createPendingUser(db, { email, name, id, now = new Date().toISOString() }) {
  const raw = db.unscoped ?? db;
  raw.prepare("INSERT INTO users (id, email, name, role, status, created_at, terms_accepted_at) VALUES (?, ?, ?, 'user', 'pending', ?, ?)")
    .run(id, String(email).toLowerCase(), name ?? null, now, now);
  return raw.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

/** Sets a user's status (approve, reject, pause, resume); the owner's own status never changes. Returns the row or null. */
export function setUserStatus(db, id, status, now = new Date().toISOString()) {
  const raw = db.unscoped ?? db;
  const changed = raw.prepare(`UPDATE users SET status = ?, approved_at = CASE WHEN ? = 'approved' THEN COALESCE(approved_at, ?) ELSE approved_at END
    WHERE id = ? AND role <> 'admin'`).run(status, status, now, id).changes;
  return changed ? raw.prepare('SELECT * FROM users WHERE id = ?').get(id) : null;
}

/** Users who get scheduled jobs: approved, not paused. The owner is first. */
export function activeUserIds(db) {
  const raw = db.unscoped ?? db;
  return raw.prepare("SELECT id FROM users WHERE status = 'approved' ORDER BY role = 'admin' DESC, created_at").pluck().all();
}
