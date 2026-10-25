// Email the administrator when something needs attention (the scheduled jobs run unattended on the server): a job that
// failed, a week with no review after the last catch-up, and the owner's Health Auto Export going quiet. At most one email
// per kind of problem per day (the day is kept in the owner's settings row alert:<key>, so a restart never resends), and
// none again until it has recovered and failed afresh. Emails carry names, dates and error names only, never health
// values, like the server's log lines.
import { OWNER_ID } from '../db/users.js';
import { scopeDb } from '../db/scope.js';
import { localDate } from '../tools/time.js';

/** The data checks (metrics/dataquality.js) worth an email after the owner's scheduled sync. */
export const ALERT_CHECKS = ['health_stale', 'export_stale', 'workout_export_stale'];

/**
 * @param {{ db: object, mailer?: { send: Function }, adminEmail: () => string|null, appUrl?: () => string, clock?: () => Date, log?: object }} o
 */
export function createAlerts({ db, mailer, adminEmail, appUrl = () => '', clock = () => new Date(), log = console }) {
  const owner = scopeDb(db.unscoped ?? db, OWNER_ID);
  const key = (k) => `alert:${k}`;
  const lastSent = (k) => owner.prepare('SELECT value FROM settings WHERE user_id = @uid AND key = ?').pluck().get(key(k)) ?? null;

  /**
   * Sends one email for this kind of problem, unless one went out today (or, with once, at all since it last recovered).
   * Resolves true when sent.
   */
  async function alert(k, subject, text, { once = false } = {}) {
    const today = localDate(clock());
    const last = lastSent(k);
    if (last === today || (once && last)) return false;
    owner.prepare(`INSERT INTO settings (user_id, key, value, updated_at) VALUES (@uid, ?, ?, ?)
      ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key(k), today, clock().toISOString());
    log.info?.(`[alert] ${k}`);
    const to = adminEmail();
    if (!mailer || !to) return false;
    return mailer.send({ to, subject: `Health Review: ${subject}`, text: `${text}\n\n${appUrl() ? `Open ${appUrl()}/#activity for the details.\n` : ''}` }).catch(() => false);
  }

  /** The problem is over: the next one emails again, even the same day. */
  function recovered(k) {
    owner.prepare('DELETE FROM settings WHERE user_id = @uid AND key = ?').run(key(k));
  }

  /** After the owner's scheduled sync: one email for each warning data check until it clears, and recovery for the ones gone. */
  async function dataChecks(warnings) {
    const found = new Set(warnings.filter((w) => w.source === 'data_check' && w.severity !== 'info').map((w) => w.kind));
    for (const kind of ALERT_CHECKS) {
      if (!found.has(kind)) { recovered(`check:${kind}`); continue; }
      const detail = warnings.find((w) => w.source === 'data_check' && w.kind === kind)?.detail ?? '';
      await alert(`check:${kind}`, kind === 'health_stale' ? 'Apple Health data stopped' : 'a Health Auto Export automation stopped', detail, { once: true });
    }
  }

  return { alert, recovered, dataChecks };
}
