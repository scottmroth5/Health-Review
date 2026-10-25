// Ported from Job-Agent's server/session.js (same format and checks; cookie names differ).
// Signed cookies for the sign-in session: base64url(JSON payload) + "." + HMAC-SHA256 signature.
// The payload is readable (it holds only the email, first name and expiry) but cannot be changed without the secret.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'hr_session';
export const LOGIN_COOKIE = 'hr_login';

/** The secret's bytes from SESSION_SECRET (base64 or plain text); at least 32 bytes. */
export function sessionKey(secret) {
  const raw = String(secret ?? '');
  const b64 = /^[A-Za-z0-9+/=_-]+$/.test(raw) ? Buffer.from(raw, 'base64') : null;
  const key = b64 && b64.length >= 32 ? b64 : Buffer.from(raw, 'utf8');
  if (key.length < 32) throw new Error('SESSION_SECRET must be at least 32 bytes (48 random bytes in base64 is a good choice).');
  return key;
}

const mac = (key, data) => createHmac('sha256', key).update(data).digest('base64url');

/** A signed token for payload; exp (ms since epoch) is required. */
export function sign(payload, key) {
  if (!payload?.exp) throw new Error('sign: payload.exp is required');
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${data}.${mac(key, data)}`;
}

/** The payload when the signature is valid and it has not expired, else null. */
export function verify(token, key, now = Date.now()) {
  const [data, sig, extra] = String(token ?? '').split('.');
  if (!data || !sig || extra !== undefined) return null;
  const expected = Buffer.from(mac(key, data));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' && payload.exp > now ? payload : null;
  } catch {
    return null;
  }
}

/**
 * Cookie header -> { name: value }, a plain object with no prototype. Only ordinary cookie names are kept (letters,
 * digits, _ and -), so a cookie named __proto__ or constructor can never reach an object's prototype.
 */
export function parseCookies(header) {
  const found = new Map();
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || name === '__proto__' || name === 'constructor' || name === 'prototype') continue;
    let value = part.slice(i + 1).trim();
    try { value = decodeURIComponent(value); } catch { continue; }
    found.set(name, value);
  }
  return Object.assign(Object.create(null), Object.fromEntries(found));
}

/** A Set-Cookie value. maxAge in seconds (0 clears the cookie). */
export function cookie(name, value, { maxAge, secure = false, path = '/', sameSite = 'Lax' } = {}) {
  return [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'HttpOnly', `SameSite=${sameSite}`, ...(secure ? ['Secure'] : []), ...(maxAge != null ? [`Max-Age=${maxAge}`] : [])].join('; ');
}
