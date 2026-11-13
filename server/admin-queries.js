// The only queries that read across users (multi-user, phase 1): system checks such as the scheduler's, and later the
// admin's user list. test/user-scope.test.js exempts this file; every other query is scoped to one user (db/scope.js).
// Takes the shared, unscoped database. Metadata only: names, statuses and times, never health or report text.
// Async (v3 Phase 1B slice 4b, docs/adr/0006): every statement is awaited, so each runs on either handle.

import { RUNNING_STALE_MINUTES } from './scheduler.js';
import { monthStartIso } from './ai-access.js';
import { USER_TABLES } from '../db/migrations-users.js';
import { listTables, primaryKey, tableColumns } from '../db/dialect.js';
import { setupSteps } from './setup.js';
import { DEFAULT_TZ, localDate } from '../tools/time.js';
import { addDays } from '../metrics/stats.js';

/**
 * When each job last ran and whether one is running now, for any user (a scheduled job runs for every user in turn, so
 * catch-up and overlap are judged on the job as a whole).
 */
export function jobRunsLookup(db) {
  const raw = db.unscoped ?? db;
  const last = raw.prepare('SELECT started_at FROM runs WHERE name = ? ORDER BY id DESC LIMIT 1').pluck();
  const running = raw.prepare("SELECT 1 FROM runs WHERE name = ? AND status = 'running' AND started_at >= ? LIMIT 1").pluck();
  return {
    lastRanAt: async (name) => (await last.get(name)) ?? null,
    isRunning: async (name, now = new Date()) => Boolean(await running.get(name, new Date(now.getTime() - RUNNING_STALE_MINUTES * 60_000).toISOString())),
  };
}

/**
 * Every user for the admin's Users screen, pending first: account facts, which feeds are set up (yes or no, never a token,
 * key or sheet ID), the last post and sync, this month's AI spend (owner's time zone) and counts of their stored days and
 * reviews. Never health values or report text.
 */
export async function listUsers(db, { now = new Date() } = {}) {
  const raw = db.unscoped ?? db;
  return (await raw.prepare(`SELECT u.id, u.email, u.name, u.role, u.status, u.created_at, u.approved_at, u.last_seen_at,
      CASE WHEN u.claude_key_enc IS NOT NULL THEN 1 ELSE 0 END AS has_key, u.uses_owner_key, u.owner_key_cap_usd, u.maps_shared, u.feeds,
      CASE WHEN u.ingest_token_hash IS NOT NULL THEN 1 ELSE 0 END AS has_token,
      CASE WHEN u.google_refresh_enc IS NOT NULL THEN 1 ELSE 0 END AS google_connected,
      CASE WHEN EXISTS (SELECT 1 FROM settings s WHERE s.user_id = u.id AND s.key = 'workout_log_sheet_id') THEN 1 ELSE 0 END AS sheet_set,
      (SELECT MAX(received_at) FROM ingest_log i WHERE i.user_id = u.id AND i.result = 'ok') AS last_post,
      (SELECT MAX(finished_at) FROM runs r WHERE r.user_id = u.id AND r.name = 'sync' AND r.status = 'ok') AS last_sync,
      (SELECT COALESCE(SUM(cost_usd), 0) FROM runs r WHERE r.user_id = u.id AND r.started_at >= @since) AS spent_month,
      (SELECT COUNT(*) FROM daily_metrics d WHERE d.user_id = u.id) AS health_days,
      (SELECT COUNT(*) FROM log_sessions l WHERE l.user_id = u.id) AS lifting_days,
      (SELECT COUNT(*) FROM reviews v WHERE v.user_id = u.id) AS reviews,
      (SELECT COUNT(*) FROM user_programs p WHERE p.user_id = u.id) AS programs,
      -- Setup progress (server/setup.js): counts and flags only.
      CASE WHEN EXISTS (SELECT 1 FROM settings s WHERE s.user_id = u.id AND s.key = 'goal_primary') THEN 1 ELSE 0 END AS goals_set,
      (SELECT COUNT(*) FROM settings s WHERE s.user_id = u.id AND s.key IN ('birth_year', 'sex', 'height_in')) AS profile_keys,
      (SELECT COUNT(*) FROM workout_sessions w WHERE w.user_id = u.id) AS workouts,
      (SELECT COUNT(DISTINCT date) FROM strength_exercises e WHERE e.user_id = u.id AND e.tab_year <> 0) AS sheet_days,
      (SELECT COUNT(DISTINCT date) FROM strength_exercises e WHERE e.user_id = u.id AND e.tab_year = 0) AS app_workouts,
      (SELECT COUNT(*) FROM checkins c WHERE c.user_id = u.id) AS checkins,
      (SELECT COUNT(*) FROM medications m WHERE m.user_id = u.id) AS meds,
      (SELECT COUNT(*) FROM lab_results r WHERE r.user_id = u.id) AS labs,
      (SELECT COUNT(*) FROM drinking_days d WHERE d.user_id = u.id) AS drinks,
      (SELECT value FROM settings s WHERE s.user_id = u.id AND s.key = 'setup_dismissed') AS setup_dismissed,
      CASE WHEN EXISTS (SELECT 1 FROM settings s WHERE s.user_id = u.id AND s.key = 'setup_hidden') THEN 1 ELSE 0 END AS setup_hidden
    FROM users u ORDER BY u.status = 'pending' DESC, u.role = 'admin' DESC, u.created_at DESC`).all({ since: monthStartIso(now) }))
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
export async function createPendingUser(db, { email, name, id, now = new Date().toISOString(), healthConsentVersion = null }) {
  const raw = db.unscoped ?? db;
  await raw.prepare(`INSERT INTO users (id, email, name, role, status, created_at, terms_accepted_at, health_consent_at, health_consent_version)
    VALUES (?, ?, ?, 'user', 'pending', ?, ?, ?, ?)`)
    .run(id, String(email).toLowerCase(), name ?? null, now, now, healthConsentVersion ? now : null, healthConsentVersion);
  return await raw.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

/** Sets a user's status (approve, reject, pause, resume); the owner's own status never changes. Returns the row or null. */
export async function setUserStatus(db, id, status, now = new Date().toISOString()) {
  const raw = db.unscoped ?? db;
  const { changes: changed } = await raw.prepare(`UPDATE users SET status = ?, approved_at = CASE WHEN ? = 'approved' THEN COALESCE(approved_at, ?) ELSE approved_at END
    WHERE id = ? AND role <> 'admin'`).run(status, status, now, id);
  return changed ? await raw.prepare('SELECT * FROM users WHERE id = ?').get(id) : null;
}

/** Users who get scheduled jobs: approved, not paused. The owner is first. */
export async function activeUserIds(db) {
  const raw = db.unscoped ?? db;
  // A user who has not given the health data consent gets no scheduled jobs until they do.
  return await raw.prepare("SELECT id FROM users WHERE status = 'approved' AND (role = 'admin' OR health_consent_at IS NOT NULL) ORDER BY role = 'admin' DESC, created_at").pluck().all();
}

/** The administrator's Claude key for a user: on with a monthly cap in dollars, or off (cap cleared). Never an admin. */
export async function setOwnerKey(db, id, { on, cap = null }) {
  await (db.unscoped ?? db).prepare("UPDATE users SET uses_owner_key = ?, owner_key_cap_usd = ? WHERE id = ? AND role <> 'admin'").run(on ? 1 : 0, on ? cap : null, id);
}

/** Shares the owner's MAPS catalog with a user, or stops. Never an admin. */
export async function setMapsShared(db, id, shared) {
  await (db.unscoped ?? db).prepare("UPDATE users SET maps_shared = ? WHERE id = ? AND role <> 'admin'").run(shared ? 1 : 0, id);
}

/** Every table with a user_id column, read from the schema (so a new user table is never missed), parents first. */
async function userIdTables(raw) {
  const tables = [];
  for (const t of await listTables(raw)) {
    if ((await tableColumns(raw, t)).includes('user_id')) tables.push(t);
  }
  const order = new Map(USER_TABLES.map((t, i) => [t, i]));
  return tables.sort((a, b) => (order.get(a) ?? -1) - (order.get(b) ?? -1));
}

// Columns of a users row that never leave the server: sealed keys and permissions, and the token's hash.
const SECRET_USER_COLUMNS = ['claude_key_enc', 'ingest_token_hash', 'google_refresh_enc'];

/**
 * Everything stored for one user (multi-user, phase 6, "Export my data"): their account facts and every row of theirs
 * in every table with a user_id, plus their runs' call metadata. Never their sealed keys, Google permission or token hash.
 */
export async function exportUserData(db, uid, { now = new Date() } = {}) {
  const raw = db.unscoped ?? db;
  const user = await raw.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  if (!user) return null;
  for (const c of SECRET_USER_COLUMNS) delete user[c];
  const tables = {};
  // Rows in primary key order (the same on both engines; SQLite's rowid order is insertion order and has no PostgreSQL twin).
  for (const t of await userIdTables(raw)) {
    const order = (await primaryKey(raw, t)).map((c) => `"${c}"`).join(', ');
    tables[t] = await raw.prepare(`SELECT * FROM "${t}" WHERE user_id = ? ORDER BY ${order}`).all(uid);
  }
  tables.run_calls = await raw.prepare('SELECT c.* FROM run_calls c JOIN runs r ON r.id = c.run_id WHERE r.user_id = ? ORDER BY c.id').all(uid);
  return { exportedAt: now.toISOString(), format: 'health-review-export-1', account: user, tables };
}

/**
 * Deletes a user and everything stored for them (phase 6): every row of theirs in every table with a user_id (children
 * first; run_calls go with their runs), then the users row, in one transaction. Never an admin. Returns the counts
 * deleted per table, or null when there is no such user (or it is an admin). Takes the async handle (db.tx): the role
 * check runs inside the transaction, so a change to the user between the check and the deletes cannot slip through.
 */
export async function deleteUserData(db, uid) {
  const raw = db.unscoped ?? db;
  return raw.tx(async () => {
    const user = await raw.prepare('SELECT role FROM users WHERE id = ?').get(uid);
    if (!user || user.role === 'admin') return null;
    const counts = {};
    for (const t of (await userIdTables(raw)).reverse()) counts[t] = (await raw.prepare(`DELETE FROM "${t}" WHERE user_id = ?`).run(uid)).changes;
    await raw.prepare('DELETE FROM users WHERE id = ?').run(uid);
    return counts;
  });
}

/**
 * Usage across all users by week (the admin's Usage card; no third party): for each week ending Saturday in the owner's
 * time zone, newest first (the current week runs to today):
 * - activeUsers: distinct users with their own activity: a check-in, a lifting day, a completed review or an accepted
 *   Health Auto Export post (scheduled syncs and skipped reviews run for everyone, so they do not count). User ids are
 *   only counted here; the number is all that is returned.
 * - reviews completed, failed and skipped; check-ins; lifting days; syncs completed and failed (runs 'review', 'sync')
 * - spendUsd: the Claude API cost of every run started that week (runs.cost_usd), rounded to cents
 * - feedback: items received
 * Totals only: never a user, an entry's date, a value or any text. UTC times are read as the owner's dates.
 */
export async function usageByWeek(db, { weeks = 12, now = new Date(), tz = process.env.OWNER_TZ || DEFAULT_TZ } = {}) {
  const raw = db.unscoped ?? db;
  const today = localDate(now, tz);
  const dayOfWeek = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
  const thisEnd = addDays(today, 6 - dayOfWeek(today));
  const ends = Array.from({ length: weeks }, (_, i) => addDays(thisEnd, -7 * i));
  const from = addDays(ends[ends.length - 1], -6);
  const rows = new Map(ends.map((weekEnding) => [weekEnding, {
    weekEnding, activeUsers: 0, reviews: { completed: 0, failed: 0, skipped: 0 }, checkins: 0, liftingDays: 0,
    syncs: { completed: 0, failed: 0 }, spendUsd: 0, feedback: 0,
  }]));
  const active = new Map(ends.map((e) => [e, new Set()]));
  const weekOf = (date) => (date >= from && date <= today ? addDays(date, 6 - dayOfWeek(date)) : null);
  const ownerDay = (iso) => localDate(new Date(iso), tz);
  // A day of slack before the first week: UTC times, and the owner's day can begin a few hours later or earlier.
  const since = `${addDays(from, -1)}T00:00:00Z`;
  for (const r of await raw.prepare('SELECT name, status, started_at, cost_usd, user_id FROM runs WHERE started_at >= ?').all(since)) {
    const week = weekOf(ownerDay(r.started_at));
    if (!week) continue;
    const w = rows.get(week);
    w.spendUsd += Number(r.cost_usd) || 0;
    if (r.name === 'review' && ['ok', 'error', 'skipped'].includes(r.status)) {
      w.reviews[{ ok: 'completed', error: 'failed', skipped: 'skipped' }[r.status]] += 1;
      if (r.status === 'ok' && r.user_id) active.get(week).add(r.user_id);
    } else if (r.name === 'sync' && (r.status === 'ok' || r.status === 'error')) {
      w.syncs[r.status === 'ok' ? 'completed' : 'failed'] += 1;
    }
  }
  for (const table of ['checkins', 'log_sessions']) {
    for (const { date, user_id: uid } of await raw.prepare(`SELECT date, user_id FROM ${table} WHERE date BETWEEN ? AND ?`).all(from, today)) {
      const week = weekOf(date);
      if (!week) continue;
      rows.get(week)[table === 'checkins' ? 'checkins' : 'liftingDays'] += 1;
      active.get(week).add(uid);
    }
  }
  for (const { received_at: at, user_id: uid } of await raw.prepare("SELECT received_at, user_id FROM ingest_log WHERE result = 'ok' AND received_at >= ?").all(since)) {
    const week = weekOf(ownerDay(at));
    if (week) active.get(week).add(uid);
  }
  for (const { created_at: at } of await raw.prepare('SELECT created_at FROM feedback WHERE created_at >= ?').all(since)) {
    const week = weekOf(ownerDay(at));
    if (week) rows.get(week).feedback += 1;
  }
  for (const [week, w] of rows) {
    w.activeUsers = active.get(week).size;
    w.spendUsd = Math.round(w.spendUsd * 100) / 100;
  }
  return [...rows.values()];
}

/**
 * The usage totals (usage_totals, server/usage-totals.js) summed over owner days from..to: visits by device, by browser and by
 * location (rolled up to countries and states, with the top cities), and arrivals by source. A return from Google's
 * sign-in is left out of arrivals: it is kept only so that coming back from signing in never counts as a real source.
 * Counts only, largest first.
 */
export async function usageTotals(db, { from, to, topCities = 15 }) {
  const raw = db.unscoped ?? db;
  const sum = (dimension) => raw.prepare(`SELECT value, SUM(count) AS count FROM usage_totals
    WHERE dimension = ? AND day BETWEEN ? AND ? GROUP BY value ORDER BY count DESC, value`).all(dimension, from, to);
  const ranked = (map) => [...map].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  const countries = new Map();
  const states = new Map();
  const cities = [];
  for (const { value, count } of await sum('location')) {
    const parts = value.split(', ');
    const country = parts.length === 3 ? parts[2] : 'Unknown';
    countries.set(country, (countries.get(country) ?? 0) + count);
    const state = parts.length === 3 ? `${parts[1]}, ${parts[2]}` : 'Unknown';
    states.set(state, (states.get(state) ?? 0) + count);
    cities.push({ value: parts.length === 3 ? value : 'Unknown', count });
  }
  return {
    visits: { device: await sum('device'), browser: await sum('browser'), location: { countries: ranked(countries), states: ranked(states), cities: cities.slice(0, topCities) } },
    arrivals: (await sum('source')).filter((r) => r.value !== 'google_signin_return'),
  };
}

/** Feedback from every user for the administrator, newest first, with who sent it. */
export async function listFeedback(db) {
  const raw = db.unscoped ?? db;
  return (await raw.prepare(`SELECT f.id, f.kind, f.subject, f.body, f.context, f.status, f.created_at, u.email, u.name
    FROM feedback f JOIN users u ON u.id = f.user_id ORDER BY f.created_at DESC LIMIT 500`).all())
    .map((r) => ({ ...r, context: r.context ? JSON.parse(r.context) : null }));
}

/** Marks a feedback item new or done; returns whether it existed. */
export async function setFeedbackStatus(db, id, status) {
  return (await (db.unscoped ?? db).prepare('UPDATE feedback SET status = ? WHERE id = ?').run(status, id)).changes > 0;
}

/** How many feedback items are new (the Users tile badge). */
export async function newFeedbackCount(db) {
  return await (db.unscoped ?? db).prepare("SELECT COUNT(*) FROM feedback WHERE status = 'new'").pluck().get();
}
