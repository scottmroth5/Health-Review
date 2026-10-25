// US-only access (owner's choice, 2026-10-25): requests from outside the allowed countries get a short 403 page, for the
// app and the demo. Health Auto Export posts (/api/ingest/*, token protected) and the deploy check (/api/health) are
// always let through, so the owner's phone keeps posting while abroad, as are private and loopback addresses (inside the
// server). The country comes from DB-IP's free IP to Country Lite database (CC BY 4.0, https://db-ip.com), downloaded
// into the image at build time (Dockerfile) and refreshed by the weekly rebuild. GEO_ALLOW (comma separated country
// codes) turns it on; unset, nothing is blocked (local runs, tests). Without the database it fails open and says so.
import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
import maxmind from 'maxmind';

export const GEO_DB_PATH = process.env.GEO_DB || '/app/geo/country.mmdb';
const ALWAYS_OPEN = [/^\/api\/ingest\//, /^\/api\/health(\?|$)/];

/** The allowed country codes from GEO_ALLOW ("US", "US,CA"); empty when unset. */
export const geoAllowFromEnv = (env = process.env) => String(env.GEO_ALLOW ?? '').split(',').map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));

/** Whether an address is private, loopback, link-local or shared (inside the server or its network). */
export function isPrivateAddress(ip) {
  let a = String(ip ?? '').trim().toLowerCase();
  if (a.startsWith('::ffff:') && isIP(a.slice(7)) === 4) a = a.slice(7);
  if (isIP(a) === 4) {
    const [p, q] = a.split('.').map(Number);
    return p === 10 || p === 127 || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 169 && q === 254) || (p === 100 && q >= 64 && q <= 127) || p === 0;
  }
  if (isIP(a) === 6) return a === '::1' || a === '::' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a);
  return false;
}

/** A country lookup from the database file: ip -> 'US' | null. Null when there is no file. */
export async function loadCountryLookup(path = GEO_DB_PATH) {
  if (!existsSync(path)) return null;
  const reader = await maxmind.open(path);
  return (ip) => reader.get(ip)?.country?.iso_code ?? null;
}

/**
 * The request check: returns true when the request must be refused. allow: country codes; lookup: ip -> country.
 * With no allow list, or no lookup (fail open), it never refuses.
 */
export function geoBlocker({ allow = [], lookup = null }) {
  if (!allow.length || !lookup) return () => false;
  return (req) => {
    if (ALWAYS_OPEN.some((re) => re.test(req.url))) return false;
    const ip = req.ip;
    if (!ip || isPrivateAddress(ip)) return false;
    return !allow.includes(lookup(ip));
  };
}

export const BLOCKED_PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Health Review</title>'
  + '<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:48px 16px;text-align:center;background:#f4f3f0;color:#1d1d1b}@media (prefers-color-scheme: dark){body{background:#121211;color:#e8e7e3}}</style></head>'
  + '<body><h1>Health Review</h1><p>Health Review is available in the United States only.</p></body></html>';
