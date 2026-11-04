// US-only access (owner's choice, 2026-10-25): requests from outside the allowed countries get a short 403 page, for the
// app and the demo. Health Auto Export posts (/api/ingest/*, token protected) and the deploy check (/api/health) are
// always let through, so the owner's phone keeps posting while abroad, as are private and loopback addresses (inside the
// server). The country comes from DB-IP's free IP to City Lite database (CC BY 4.0, https://db-ip.com; the Country Lite
// file when the city download failed), downloaded into the image at build time (Dockerfile) and refreshed by the weekly
// rebuild. The same file gives the usage totals' approximate locations (server/usage-totals.js). GEO_ALLOW (comma
// separated country codes) turns the check on; unset, nothing is blocked (local runs, tests). Without the database it
// fails open and says so. iCloud Private Relay addresses (Apple's relay partners, which DB-IP places wrong or nowhere) take
// their country from Apple's published list of relay addresses (https://mask-api.icloud.com/egress-ip-ranges.csv, also
// downloaded at build time), so visitors with Private Relay on get in.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import maxmind from 'maxmind';

// The city database, else the country one (both MaxMind format; the city file holds countries too).
export const GEO_DB_PATHS = process.env.GEO_DB ? [process.env.GEO_DB] : ['/app/geo/city.mmdb', '/app/geo/country.mmdb'];
// Apple's Private Relay list (lines "prefix,CC,region,city,").
export const RELAY_PATH = process.env.GEO_RELAY || '/app/geo/relay.csv';
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

/**
 * The local database, or null when there is no file: country(ip) -> 'US' | null, and place(ip) -> { city, state,
 * country } in English (empty with the country file). Nothing is sent anywhere.
 */
export async function loadGeoReader(paths = GEO_DB_PATHS) {
  const path = paths.find((p) => existsSync(p));
  if (!path) return null;
  const reader = await maxmind.open(path);
  return {
    country: (ip) => reader.get(ip)?.country?.iso_code ?? null,
    place: (ip) => {
      const r = reader.get(ip);
      return { city: r?.city?.names?.en ?? null, state: r?.subdivisions?.[0]?.names?.en ?? null, country: r?.country?.names?.en ?? null };
    },
  };
}

const v4Number = (a) => a.split('.').reduce((n, p) => n * 256 + Number(p), 0);

/** The top 64 bits of an IPv6 address as a BigInt (Apple's IPv6 ranges are /64 or shorter, so this is exact for them). */
function v6Top(a) {
  const [head, tail] = a.split('%')[0].split('::');
  const part = (s) => (s ? s.split(':').flatMap((g) => (g.includes('.') ? [v4Number(g) >>> 16, v4Number(g) & 0xffff].map((n) => n.toString(16)) : [g])) : []);
  const h = part(head);
  const t = tail === undefined ? [] : part(tail);
  const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return groups.slice(0, 4).reduce((n, g) => (n << 16n) | BigInt(parseInt(g, 16)), 0n);
}

/** The country in a sorted, non-overlapping list of [start, end, country] for x, or null. */
function findRange(list, x) {
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid][0] <= x) lo = mid + 1;
    else hi = mid - 1;
  }
  const r = list[hi];
  return r && x <= r[1] ? r[2] : null;
}

/** Sorts ranges by start and merges neighbors of the same country. */
function mergeRanges(list, one) {
  list.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const out = [];
  for (const r of list) {
    const last = out[out.length - 1];
    if (last && last[2] === r[2] && r[0] <= last[1] + one) {
      if (r[1] > last[1]) last[1] = r[1];
    } else {
      out.push(r);
    }
  }
  return out;
}

/**
 * Apple's Private Relay list (pure): country(ip) -> 'US' | null for relay addresses, and size, the ranges read. Lines
 * that are not a valid prefix and two-letter country are skipped.
 */
export function parseRelayRanges(text) {
  const v4 = [];
  const v6 = [];
  for (const line of String(text ?? '').split('\n')) {
    const [prefix, cc] = line.trim().split(',');
    const m = /^([^/]+)\/(\d{1,3})$/.exec(prefix ?? '');
    if (!m || !/^[A-Z]{2}$/.test(cc ?? '')) continue;
    const bits = Number(m[2]);
    const kind = isIP(m[1]);
    if (kind === 4 && bits <= 32) {
      const span = 2 ** (32 - bits);
      const start = Math.floor(v4Number(m[1]) / span) * span;
      v4.push([start, start + span - 1, cc]);
    } else if (kind === 6 && bits <= 64) {
      const span = 1n << BigInt(64 - bits);
      const start = (v6Top(m[1]) / span) * span;
      v6.push([start, start + span - 1n, cc]);
    }
  }
  const size = v4.length + v6.length;
  const ranges4 = mergeRanges(v4, 1);
  const ranges6 = mergeRanges(v6, 1n);
  return {
    size,
    country: (ip) => {
      let a = String(ip ?? '').trim().toLowerCase();
      if (a.startsWith('::ffff:') && isIP(a.slice(7)) === 4) a = a.slice(7);
      const kind = isIP(a);
      return kind === 4 ? findRange(ranges4, v4Number(a)) : kind === 6 ? findRange(ranges6, v6Top(a)) : null;
    },
  };
}

/** Apple's Private Relay list from its file, or null when there is none. */
export async function loadRelayRanges(path = RELAY_PATH) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  return parseRelayRanges(text);
}

/** The country lookup: the Private Relay list first, then the location database; null (fail open) without the database. */
export const countryLookup = (relay, reader) => (reader ? (ip) => relay?.country(ip) ?? reader.country(ip) : null);

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
