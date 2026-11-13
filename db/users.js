// Users: the owner is user 1 (a fixed id, so local mode, the demo and every script need no sign-in), with role admin.
// Every user table carries user_id (migration 025); every query on one is scoped to a user, and only
// server/admin-queries.js reads across users (test/user-scope.test.js checks both).
import { createHash, randomBytes } from 'node:crypto';
// The run tracer lives in db/runs.js; re-exported here, where its callers have always imported it.
export { startUserRun } from './runs.js';

export const OWNER_ID = '00000000-0000-4000-8000-000000000001';

/** The owner's email from OWNER_EMAIL, else the first AUTH_ALLOWED_EMAILS address, else a local placeholder. */
export function ownerEmailFromEnv(env = process.env) {
  const first = String(env.AUTH_ALLOWED_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).find(Boolean);
  return String(env.OWNER_EMAIL ?? '').trim().toLowerCase() || first || 'owner@localhost';
}

/**
 * Keeps the owner row's email in step with the environment (the migration ran with whatever it had then). The server
 * runs it after opening the store (server/index.js, and buildApp in Google mode), as does openStore (db/store.js).
 * @param {import('./database.ts').Database} db  the async handle, unscoped
 */
export async function syncOwnerEmail(db, env = process.env) {
  const email = ownerEmailFromEnv(env);
  if (email === 'owner@localhost') return;
  await db.prepare("UPDATE users SET email = ? WHERE id = ? AND email <> ? AND NOT EXISTS (SELECT 1 FROM users WHERE email = ? AND id <> ?)")
    .run(email, OWNER_ID, email, email, OWNER_ID);
}

/** The user row (null when missing). */
export async function getUser(db, uid) {
  return (await db.prepare('SELECT * FROM users WHERE id = ?').get(uid)) ?? null;
}

/** The user row for a sign-in email (null when none). */
export async function userByEmail(db, email) {
  return (await db.prepare('SELECT * FROM users WHERE email = ?').get(String(email ?? '').toLowerCase())) ?? null;
}

/** Stores a user's sealed Claude key (tools/secret-box.js), or removes it with null. Never the plain key. */
export async function setClaudeKey(db, uid, sealed) {
  await (db.unscoped ?? db).prepare('UPDATE users SET claude_key_enc = ?, claude_key_set_at = ? WHERE id = ?')
    .run(sealed, sealed ? new Date().toISOString() : null, uid);
}

/** The SHA-256 (hex) of an ingest token; only this is stored. */
export const ingestTokenHash = (token) => createHash('sha256').update(String(token)).digest('hex');

/** A new ingest token for a user (shown to them once); stores only its hash, replacing any earlier one. */
export async function newIngestToken(db, uid) {
  const token = randomBytes(32).toString('base64url');
  await (db.unscoped ?? db).prepare('UPDATE users SET ingest_token_hash = ? WHERE id = ?').run(ingestTokenHash(token), uid);
  return token;
}

/** The approved user a posted ingest token belongs to, or null (also null until they give the health data consent). */
export async function userByIngestToken(db, token) {
  if (!token) return null;
  return (await (db.unscoped ?? db).prepare("SELECT id, status FROM users WHERE ingest_token_hash = ? AND status = 'approved' AND (role = 'admin' OR health_consent_at IS NOT NULL)")
    .get(ingestTokenHash(token))) ?? null;
}

// The health data consent (CONSUMER-HEALTH-DATA.md): its version is the date of the consent text; a new version is a
// new text, which people would have to agree to again.
export const HEALTH_CONSENT_VERSION = '2026-11-03';

/** Whether a user must still give the health data consent: everyone but the owner (an admin), until they have. */
export const needsHealthConsent = (user) => Boolean(user) && user.role !== 'admin' && user.id !== OWNER_ID && !user.health_consent_at;

/** Records that a user gave the health data consent, now, at the current version. */
export async function recordHealthConsent(db, uid, now = new Date()) {
  await (db.unscoped ?? db).prepare('UPDATE users SET health_consent_at = ?, health_consent_version = ? WHERE id = ?')
    .run(now.toISOString(), HEALTH_CONSENT_VERSION, uid);
}

/** Turns a user's ingest token off. */
export async function clearIngestToken(db, uid) {
  await (db.unscoped ?? db).prepare('UPDATE users SET ingest_token_hash = NULL WHERE id = ?').run(uid);
}

/** Which data feeds a user chose (JSON of { appleHealth, workoutLog, manual }). */
export async function setUserFeeds(db, uid, json) {
  await (db.unscoped ?? db).prepare('UPDATE users SET feeds = ? WHERE id = ?').run(json, uid);
}

/** Stores a user's sealed Google refresh token (Sheets read-only), or removes it with null. */
export async function setGoogleToken(db, uid, sealed) {
  await (db.unscoped ?? db).prepare('UPDATE users SET google_refresh_enc = ?, google_connected_at = ? WHERE id = ?')
    .run(sealed, sealed ? new Date().toISOString() : null, uid);
}

/** A user's own time zone (their settings row time_zone, set in Settings), or null for OWNER_TZ. Never for the owner. */
export async function timeZoneOf(db, uid) {
  if (!uid || uid === OWNER_ID) return null;
  return (await (db.unscoped ?? db).prepare("SELECT value FROM settings WHERE user_id = ? AND key = 'time_zone'").pluck().get(uid)) ?? null;
}
