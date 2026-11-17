// Email from the app (multi-user, phase 2): a new registration to the admin, and "you're in" to an approved user.
// Gmail SMTP over TLS with an app password (owner's choice, 2026-10-24): SMTP_USER and SMTP_APP_PASSWORD in the server's
// .env. Messages carry names, addresses and links only, never health data. Without SMTP settings nothing is sent and a
// "[mail] not configured" line is logged; the app works the same. Never logs the password or a message body.
import nodemailer from 'nodemailer';

/** One message: names, addresses and links only, never health data. */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
}

/** What the app sends through (a fake in tests). */
export interface MailTransport {
  sendMail(message: { from?: string, to: string, subject: string, text: string, replyTo?: string }): Promise<unknown>;
}

export interface Mailer {
  configured: boolean;
  send(message: MailMessage): Promise<boolean>;
}

interface Log {
  info?: (line: string) => void;
  warn?: (line: string) => void;
}

/**
 * A mailer: send({ to, subject, text }) resolves true when sent, false when not configured or it failed.
 * @param options  transport: a fake for tests
 */
export function createMailer({ env = process.env, transport, log = console }: { env?: NodeJS.ProcessEnv, transport?: MailTransport, log?: Log } = {}): Mailer {
  const user = env.SMTP_USER?.trim();
  const pass = env.SMTP_APP_PASSWORD?.replace(/\s+/g, ''); // Google shows app passwords in groups of four
  const t: MailTransport | null = transport ?? (user && pass
    ? nodemailer.createTransport({ host: env.SMTP_HOST || 'smtp.gmail.com', port: Number(env.SMTP_PORT || 465), secure: true, auth: { user, pass } })
    : null);
  return {
    configured: Boolean(t),
    async send({ to, subject: rawSubject, text, replyTo }: MailMessage) {
      // Header values never carry line breaks or other control characters (no header injection from user text).
      const subject = String(rawSubject ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
      if (!t) {
        log.info?.(`[mail] not configured; "${subject}" not sent`);
        return false;
      }
      try {
        await t.sendMail({ from: user ? `Health Review <${user}>` : undefined, to, subject, text, ...(replyTo ? { replyTo } : {}) });
        log.info?.(`[mail] sent "${subject}"`);
        return true;
      } catch (err) {
        log.warn?.(`[mail] "${subject}" failed: ${err instanceof Error ? err.name : 'Error'}`);
        return false;
      }
    },
  };
}
