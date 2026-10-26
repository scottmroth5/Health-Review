// The only queries that read across users (multi-user, phase 1): system checks such as the scheduler's, and later the
// admin's user list. test/user-scope.test.js exempts this file; every other query is scoped to one user (db/scope.js).
// Takes the shared, unscoped database. Metadata only: names, statuses and times, never health or report text.

import { RUNNING_STALE_MINUTES } from './scheduler.js';
import { monthStartIso } from './ai-access.js';
import { USER_TABLES } from '../db/migrations-users.js';
import { setupSteps } from './setup.js';

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
      (SELECT COUNT(*) FROM reviews v WHERE v.user_id = u.id) AS reviews,
      (SELECT COUNT(*) FROM user_programs p WHERE p.user_id = u.id) AS programs,
      -- Setup progress (server/setup.js): counts and flags only.
      EXISTS (SELECT 1 FROM settings s WHERE s.user_id = u.id AND s.key = 'goal_primary') AS goals_set,
      (SELECT COUNT(*) FROM settings s WHERE s.user_id = u.id AND s.key IN ('birth_year', 'sex', 'height_in')) AS profile_keys,
      (SELECT COUNT(*) FROM workout_sessions w WHERE w.user_id = u.id) AS workouts,
      (SELECT COUNT(DISTINCT date) FROM strength_exercises e WHERE e.user_id = u.id AND e.tab_year <> 0) AS sheet_days,
      (SELECT COUNT(DISTINCT date) FROM strength_exercises e WHERE e.user_id = u.id AND e.tab_year = 0) AS app_workouts,
      (SELECT COUNT(*) FROM checkins c WHERE c.user_id = u.id) AS checkins,
      (SELECT COUNT(*) FROM medications m WHERE m.user_id = u.id) AS meds,
      (SELECT COUNT(*) FROM lab_results r WHERE r.user_id = u.id) AS labs,
      (SELECT COUNT(*) FROM drinking_days d WHERE d.user_id = u.id) AS drinks,
      (SELECT value FROM settings s WHERE s.user_id = u.id AND s.key = 'setup_dismissed') AS setup_dismissed,
      EXISTS (SELECT 1 FROM settings s WHERE s.user_id = u.id AND s.key = 'setup_hidden') AS setup_hidden
    FROM users u ORDER BY u.status = 'pending' DESC, u.role = 'admin' DESC, u.created_at DESC`).all({ since: monthStartIso(now) })
    .map(({ feeds, goals_set, profile_keys, workouts, sheet_days, app_workouts, checkins, meds, labs, drinks, setup_dismissed, setup_hidden, ...u }) => {
      let chosen = {};
      try { chosen = JSON.parse(feeds ?? '{}') ?? {}; } catch { chosen = {}; }
      let dismissed = [];
      try { dismissed = JSON.parse(setup_dismissed ?? '[]') ?? []; } catch { dismissed = []; }
      const owner = u.role === 'admin';
      const setup = setupSteps({
        owner, chosen, ai: owner || Boolean(u.has_key) || Boolean(u.uses_owner_key), goalsSet: Boolean(goals_set), profileSet: profile_keys === 3,
        apple: { token: Boolean(u.has_token), days: u.health_days, workouts },
        sheet: { connected: Boolean(u.google_connected), sheetSet: Boolean(u.sheet_set), liftingDays: sheet_days },
        manual: { checkins, appWorkouts: app_workouts, meds, labs, drinks },
        dismissed, hidden: Boolean(setup_hidden),
      }, { today: now.toISOString().slice(0, 10) });
      return {
        ...u,
        // How far through Home's setup checklist (never what they entered).
        setup: { doneCount: setup.doneCount, total: setup.total, complete: setup.complete },
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

/** Every table with a user_id column, read from the schema (so a new user table is never missed), parents first. */
function userIdTables(raw) {
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").pluck().all()
    .filter((t) => raw.prepare(`PRAGMA table_info("${t}")`).all().some((c) => c.name === 'user_id'));
  const order = new Map(USER_TABLES.map((t, i) => [t, i]));
  return tables.sort((a, b) => (order.get(a) ?? -1) - (order.get(b) ?? -1));
}

// Columns of a users row that never leave the server: sealed keys and permissions, and the token's hash.
const SECRET_USER_COLUMNS = ['claude_key_enc', 'ingest_token_hash', 'google_refresh_enc'];

/**
 * Everything stored for one user (multi-user, phase 6, "Export my data"): their account facts and every row of theirs
 * in every table with a user_id, plus their runs' call metadata. Never their sealed keys, Google permission or token hash.
 */
export function exportUserData(db, uid, { now = new Date() } = {}) {
  const raw = db.unscoped ?? db;
  const user = raw.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  if (!user) return null;
  for (const c of SECRET_USER_COLUMNS) delete user[c];
  const tables = Object.fromEntries(userIdTables(raw).map((t) => [t, raw.prepare(`SELECT * FROM "${t}" WHERE user_id = ? ORDER BY rowid`).all(uid)]));
  tables.run_calls = raw.prepare('SELECT c.* FROM run_calls c JOIN runs r ON r.id = c.run_id WHERE r.user_id = ? ORDER BY c.id').all(uid);
  return { exportedAt: now.toISOString(), format: 'health-review-export-1', account: user, tables };
}

/**
 * Deletes a user and everything stored for them (phase 6): every row of theirs in every table with a user_id (children
 * first; run_calls go with their runs), then the users row, in one transaction. Never an admin. Returns the counts
 * deleted per table, or null when there is no such user (or it is an admin).
 */
export function deleteUserData(db, uid) {
  const raw = db.unscoped ?? db;
  const user = raw.prepare('SELECT role FROM users WHERE id = ?').get(uid);
  if (!user || user.role === 'admin') return null;
  const counts = {};
  raw.transaction(() => {
    for (const t of userIdTables(raw).reverse()) counts[t] = raw.prepare(`DELETE FROM "${t}" WHERE user_id = ?`).run(uid).changes;
    raw.prepare('DELETE FROM users WHERE id = ?').run(uid);
  })();
  return counts;
}

/** Feedback from every user for the administrator, newest first, with who sent it. */
export function listFeedback(db) {
  const raw = db.unscoped ?? db;
  return raw.prepare(`SELECT f.id, f.kind, f.subject, f.body, f.context, f.status, f.created_at, u.email, u.name
    FROM feedback f JOIN users u ON u.id = f.user_id ORDER BY f.created_at DESC LIMIT 500`).all()
    .map((r) => ({ ...r, context: r.context ? JSON.parse(r.context) : null }));
}

/** Marks a feedback item new or done; returns whether it existed. */
export function setFeedbackStatus(db, id, status) {
  return (db.unscoped ?? db).prepare('UPDATE feedback SET status = ? WHERE id = ?').run(status, id).changes > 0;
}

/** How many feedback items are new (the Users tile badge). */
export function newFeedbackCount(db) {
  return (db.unscoped ?? db).prepare("SELECT COUNT(*) FROM feedback WHERE status = 'new'").pluck().get();
}
