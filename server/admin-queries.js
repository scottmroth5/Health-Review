// The only queries that read across users (multi-user, phase 1): system checks such as the scheduler's, and later the
// admin's user list. test/user-scope.test.js exempts this file; every other query is scoped to one user (db/scope.js).
// Takes the shared, unscoped database. Metadata only: names, statuses and times, never health or report text.

import { RUNNING_STALE_MINUTES } from './scheduler.js';
import { monthStartIso } from './ai-access.js';

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

/**
 * Every user for the admin's Users screen, pending first: account facts, which feeds are set up (yes or no, never a token,
 * key or sheet ID), the last post and sync, this month's AI spend (owner's time zone) and counts of their stored days and
 * reviews. Never health values or report text.
 */
export function listUsers(db, { now = new Date() } = {}) {
  const raw = db.unscoped ?? db;
  return raw.prepare(`SELECT u.id, u.email, u.name, u.role, u.status, u.created_at, u.approved_at, u.last_seen_at,
      u.claude_key_enc IS NOT NULL AS has_key, u.uses_owner_key, u.owner_key_cap_usd, u.maps_shared, u.feeds,
      u.ingest_token_hash IS NOT NULL AS has_token, u.google_refresh_enc IS NOT NULL AS google_connected,
      EXISTS (SELECT 1 FROM settings s WHERE s.user_id = u.id AND s.key = 'workout_log_sheet_id') AS sheet_set,
      (SELECT MAX(received_at) FROM ingest_log i WHERE i.user_id = u.id AND i.result = 'ok') AS last_post,
      (SELECT MAX(finished_at) FROM runs r WHERE r.user_id = u.id AND r.name = 'sync' AND r.status = 'ok') AS last_sync,
      (SELECT COALESCE(SUM(cost_usd), 0) FROM runs r WHERE r.user_id = u.id AND r.started_at >= @since) AS spent_month,
      (SELECT COUNT(*) FROM daily_metrics d WHERE d.user_id = u.id) AS health_days,
      (SELECT COUNT(*) FROM log_sessions l WHERE l.user_id = u.id) AS lifting_days,
      (SELECT COUNT(*) FROM reviews v WHERE v.user_id = u.id) AS reviews
    FROM users u ORDER BY u.status = 'pending' DESC, u.role = 'admin' DESC, u.created_at DESC`).all({ since: monthStartIso(now) })
    .map(({ feeds, ...u }) => {
      let chosen = {};
      try { chosen = JSON.parse(feeds ?? '{}') ?? {}; } catch { chosen = {}; }
      return {
        ...u,
        has_key: Boolean(u.has_key), uses_owner_key: Boolean(u.uses_owner_key), maps_shared: Boolean(u.maps_shared),
        has_token: Boolean(u.has_token), google_connected: Boolean(u.google_connected), sheet_set: Boolean(u.sheet_set),
        spent_month: Math.round(u.spent_month * 100) / 100,
        feeds: u.role === 'admin' ? null : { appleHealth: chosen.appleHealth ?? false, workoutLog: chosen.workoutLog ?? false, manual: chosen.manual ?? true },
      };
    });
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

/** The administrator's Claude key for a user: on with a monthly cap in dollars, or off (cap cleared). Never an admin. */
export function setOwnerKey(db, id, { on, cap = null }) {
  (db.unscoped ?? db).prepare("UPDATE users SET uses_owner_key = ?, owner_key_cap_usd = ? WHERE id = ? AND role <> 'admin'").run(on ? 1 : 0, on ? cap : null, id);
}

/** Shares the owner's MAPS catalog with a user, or stops. Never an admin. */
export function setMapsShared(db, id, shared) {
  (db.unscoped ?? db).prepare("UPDATE users SET maps_shared = ? WHERE id = ? AND role <> 'admin'").run(shared ? 1 : 0, id);
}
