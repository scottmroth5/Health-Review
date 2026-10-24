// Users: the owner is user 1 (a fixed id, so local mode, the demo and every script need no sign-in), with role admin.
// Every user table carries user_id (migration 025); every query on one is scoped to a user, and only
// server/admin-queries.js reads across users (test/user-scope.test.js checks both).
import { createTracer } from '@scottmroth5/agent-core';

export const OWNER_ID = '00000000-0000-4000-8000-000000000001';

/** The owner's email from OWNER_EMAIL, else the first AUTH_ALLOWED_EMAILS address, else a local placeholder. */
export function ownerEmailFromEnv(env = process.env) {
  const first = String(env.AUTH_ALLOWED_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).find(Boolean);
  return String(env.OWNER_EMAIL ?? '').trim().toLowerCase() || first || 'owner@localhost';
}

/** Keeps the owner row's email in step with the environment (the migration ran with whatever it had then). */
export function syncOwnerEmail(db, env = process.env) {
  const email = ownerEmailFromEnv(env);
  if (email === 'owner@localhost') return;
  db.prepare("UPDATE users SET email = ? WHERE id = ? AND email <> ? AND NOT EXISTS (SELECT 1 FROM users WHERE email = ? AND id <> ?)")
    .run(email, OWNER_ID, email, email, OWNER_ID);
}

/** The user row (null when missing). */
export function getUser(db, uid) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(uid) ?? null;
}

/** The user row for a sign-in email (null when none). */
export function userByEmail(db, email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(String(email ?? '').toLowerCase()) ?? null;
}

/** Stores a user's sealed Claude key (tools/secret-box.js), or removes it with null. Never the plain key. */
export function setClaudeKey(db, uid, sealed) {
  (db.unscoped ?? db).prepare('UPDATE users SET claude_key_enc = ?, claude_key_set_at = ? WHERE id = ?')
    .run(sealed, sealed ? new Date().toISOString() : null, uid);
}

/**
 * agent-core's tracer for one user's run: the run row gets the user of the scoped store (db/scope.js scopeStore) as its
 * user_id (the tracer itself knows nothing of users).
 * @returns the tracer run ({ id, recordCall, log, finish })
 */
export function startUserRun(store, name, meta = {}, logger) {
  const uid = store.db.uid;
  if (!uid) throw new TypeError(`startUserRun(${name}): the store is not scoped to a user`);
  const run = createTracer({ store, logger }).startRun(name, meta);
  if (run.id != null) store.db.prepare('UPDATE runs SET user_id = ? WHERE id = ?').run(uid, run.id);
  return run;
}
