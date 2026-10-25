// Email from the app (multi-user, phase 2): a new registration to the admin, and "you're in" to an approved user.
// Gmail SMTP over TLS with an app password (owner's choice, 2026-10-24): SMTP_USER and SMTP_APP_PASSWORD in the server's
// .env. Messages carry names, addresses and links only, never health data. Without SMTP settings nothing is sent and a
// "[mail] not configured" line is logged; the app works the same. Never logs the password or a message body.
import nodemailer from 'nodemailer';

/**
 * A mailer: send({ to, subject, text }) resolves true when sent, false when not configured or it failed.
 * @param {{ env?: object, transport?: object, log?: { info: Function, warn: Function } }} [options]  transport: a fake for tests
 */
export function createMailer({ env = process.env, transport, log = console } = {}) {
  const user = env.SMTP_USER?.trim();
  const pass = env.SMTP_APP_PASSWORD?.replace(/\s+/g, ''); // Google shows app passwords in groups of four
  const t = transport ?? (user && pass
    ? nodemailer.createTransport({ host: env.SMTP_HOST || 'smtp.gmail.com', port: Number(env.SMTP_PORT || 465), secure: true, auth: { user, pass } })
    : null);
  return {
    configured: Boolean(t),
    async send({ to, subject, text, replyTo }) {
      if (!t) {
        log.info?.(`[mail] not configured; "${subject}" not sent`);
        return false;
      }
      try {
        await t.sendMail({ from: user ? `Health Review <${user}>` : undefined, to, subject, text, ...(replyTo ? { replyTo } : {}) });
        log.info?.(`[mail] sent "${subject}"`);
        return true;
      } catch (err) {
        log.warn?.(`[mail] "${subject}" failed: ${err.name}`);
        return false;
      }
    },
  };
}
