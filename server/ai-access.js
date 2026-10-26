// Who pays for a user's AI (multi-user, phase 4): the owner's server key for the owner; a user's own key when they set
// one (always first); else the owner's key when the admin switched it on for them, while their AI spend this month (in
// the owner's time zone) is under the monthly cap; else none. Paused, pending and rejected users get none. When a user on
// the owner's key reaches the cap, their AI stops and the admin and the user each get one email that month (recorded in
// the user's settings row owner_key_cap_notified, YYYY-MM). Spend is every AI run of theirs that month (runs.cost_usd),
// so a run that starts under the cap may finish a little over it.
import { OWNER_ID, getUser } from '../db/users.js';
import { scopeDb } from '../db/scope.js';
import { localDate, zonedInstant } from '../tools/time.js';
import { supportEmailFrom } from './pages.js';

/** The monthly cap the admin may set, in US dollars. */
export const OWNER_KEY_CAP = { min: 1, max: 100 };
const NOTIFIED_KEY = 'owner_key_cap_notified';

/**
 * Pure: where a user's AI comes from.
 * @param {object|null} user  the users row
 * @param {{ spent?: number }} [usage]  their AI spend this month (dollars)
 * @returns {{ source: 'owner'|'own'|'owner-for-user'|null, reason: null|'paused'|'no_key'|'cap', capReached: boolean }}
 */
export function aiAccess(user, { spent = 0 } = {}) {
  const none = (reason, capReached = false) => ({ source: null, reason, capReached });
  if (!user) return none('no_key');
  if (user.id === OWNER_ID) return { source: 'owner', reason: null, capReached: false };
  if (user.status !== 'approved') return none('paused');
  if (user.claude_key_enc) return { source: 'own', reason: null, capReached: false };
  if (!user.uses_owner_key || !(user.owner_key_cap_usd > 0)) return none('no_key');
  if (spent >= user.owner_key_cap_usd) return none('cap', true);
  return { source: 'owner-for-user', reason: null, capReached: false };
}

/** The start of the owner's current month as a UTC ISO time (runs.started_at is UTC). */
export function monthStartIso(now = new Date()) {
  return zonedInstant(`${localDate(now).slice(0, 7)}-01`, 0, 0).toISOString();
}

/** A user's estimated AI spend since the start of the owner's month, in dollars. */
export function spentThisMonth(db, uid, now = new Date()) {
  return scopeDb(db.unscoped ?? db, uid).prepare('SELECT COALESCE(SUM(cost_usd), 0) FROM runs WHERE user_id = @uid AND started_at >= ?')
    .pluck().get(monthStartIso(now));
}

/** Forgets this month's cap email, so a raised cap that is reached again sends a fresh one. */
export function clearCapNotice(db, uid) {
  scopeDb(db.unscoped ?? db, uid).prepare('DELETE FROM settings WHERE user_id = @uid AND key = ?').run(NOTIFIED_KEY);
}

/**
 * The server's AI access check: check(uid) gives aiAccess for the user now, and sends the cap emails once a month.
 * @param {{ db: object, mailer?: { send: Function }, adminEmail?: () => string, appUrl?: () => string, clock?: () => Date, log?: object }} options
 */
export function createAiAccess({ db, mailer, adminEmail = () => null, appUrl = () => '', clock = () => new Date(), log = console, supportEmail = null }) {
  const support = supportEmailFrom(supportEmail);
  const raw = db.unscoped ?? db;
  const notifyCap = (user) => {
    const sdb = scopeDb(raw, user.id);
    const month = localDate(clock()).slice(0, 7);
    if (sdb.prepare('SELECT value FROM settings WHERE user_id = @uid AND key = ?').pluck().get(NOTIFIED_KEY) === month) return;
    sdb.prepare(`INSERT INTO settings (user_id, key, value, updated_at) VALUES (@uid, ?, ?, ?)
      ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(NOTIFIED_KEY, month, clock().toISOString());
    log.info?.('[users] a user reached their monthly AI cap');
    if (!mailer) return;
    const cap = `$${Number(user.owner_key_cap_usd).toFixed(2)}`;
    const send = (to, subject, text) => mailer.send({ to, subject, text }).catch(() => false);
    send(user.email, 'Health Review: AI paused for this month',
      `Your Health Review AI allowance for this month (${cap}) is used up, so the weekly review and chat are paused until next month.\n\nTo keep going now, add your own Claude API key in Settings at ${appUrl()}.\n${support ? `\nQuestions or problems: ${support}\n` : ''}`);
    const admin = adminEmail();
    if (admin) send(admin, 'Health Review: a user reached their AI cap',
      `${user.name || user.email} (${user.email}) used this month's ${cap} AI allowance on your Claude key. Their AI is paused until next month; you can raise the cap on the Users screen.\n`);
  };
  return {
    check(uid) {
      const user = getUser(raw, uid);
      const spent = user && user.id !== OWNER_ID && !user.claude_key_enc && user.uses_owner_key ? spentThisMonth(raw, uid, clock()) : 0;
      const access = aiAccess(user, { spent });
      if (access.capReached) notifyCap(user);
      return access;
    },
  };
}
