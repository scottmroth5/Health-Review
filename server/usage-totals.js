// App-wide usage totals for the admin's Usage card (2026-11-02): visits by device type, browser and main version, and by
// approximate location, once
// per account per day, and arrivals by a general traffic source. Everything is worked out on the server and only a count
// is kept (usage_totals, migration 032): never a user id, IP address, user agent, referrer, URL or query value, and each
// row is one dimension, so nothing links a device to a location. No outside service: locations come from the local
// DB-IP City Lite database (server/geo.js). Only the signed-in app counts (google mode); never the demo or local mode.
import { isIP } from 'node:net';
import { isPrivateAddress } from './geo.js';
import { localDate } from '../tools/time.js';

export const DEVICES = ['phone', 'tablet', 'computer'];
export const SOURCES = ['linkedin', 'github', 'site', 'demo', 'google_signin_return', 'other', 'direct'];
const UTM_SOURCES = ['linkedin', 'github', 'site', 'demo'];
const GOOGLE_SIGN_IN_HOSTS = ['accounts.google.com'];

/** A bare lowercase hostname, or null (SOURCE_SITE_HOST, SOURCE_DEMO_HOST and the like). */
export const hostnameOrNull = (value) => {
  const host = String(value ?? '').trim().toLowerCase();
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) && host.length <= 253 ? host : null;
};

/** Whether a hostname is a domain or one of its subdomains (never a lookalike such as linkedin.com.example.com). */
const within = (host, domain) => Boolean(domain) && (host === domain || host.endsWith(`.${domain}`));

/** phone, tablet or computer from the user agent (and the Sec-CH-UA-Mobile hint); the user agent is not kept. */
export function deviceOf(userAgent, chMobile) {
  const ua = String(userAgent ?? '');
  if (String(chMobile ?? '').trim() === '?1' || /\b(iPhone|iPod)\b/.test(ua) || (/\bAndroid\b/.test(ua) && /\bMobile\b/.test(ua))) return 'phone';
  if (/\biPad\b/.test(ua) || /\bAndroid\b/.test(ua) || /\bTablet\b/i.test(ua)) return 'tablet';
  return 'computer';
}

// Browsers by their user agent marker, most specific first (most user agents also say Chrome or Safari).
const BROWSERS = [
  ['Edge', /\b(?:Edg|EdgA|EdgiOS)\/(\d+)/],
  ['Opera', /\bOPR\/(\d+)/],
  ['Samsung Internet', /\bSamsungBrowser\/(\d+)/],
  ['Firefox', /\b(?:Firefox|FxiOS)\/(\d+)/],
  ['Chrome', /\b(?:CriOS|Chrome)\/(\d+)/],
  ['Safari', /\bVersion\/(\d+)(?=[.\s]).*\bSafari\//],
];

/**
 * The browser and its main version ("Chrome 130", "Safari 18"), the name alone when the version is missing or longer than
 * 4 digits, or "Other": a fixed name and a short number, never the user agent itself, which is not kept.
 */
export function browserOf(userAgent) {
  const ua = String(userAgent ?? '');
  for (const [name, re] of BROWSERS) {
    const m = re.exec(ua);
    if (m) return m[1].length <= 4 ? `${name} ${Number(m[1])}` : name;
  }
  return 'Other';
}

/**
 * "City, State, Country" for an address from the local database (place(ip) -> { city, state, country } in English), or
 * "unknown" when there is no database, the address is private or not an address, the lookup fails, or no country is
 * found. A missing city or state reads "Unknown". Commas inside a name are dropped so the value splits cleanly.
 */
export function locationOf(place, ip) {
  if (typeof place !== 'function' || !isIP(String(ip ?? '')) || isPrivateAddress(ip)) return 'unknown';
  let found;
  try { found = place(ip); } catch { return 'unknown'; }
  const clean = (s) => String(s ?? '').replace(/,/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!clean(found?.country)) return 'unknown';
  return [clean(found.city) || 'Unknown', clean(found.state) || 'Unknown', clean(found.country)].join(', ');
}

/**
 * The general source of an arrival: utm_source when it is exactly linkedin, github, site or demo (any case), else the
 * Referer's hostname: linkedin.com and lnkd.in (and subdomains) linkedin, github.com github, the site host (and
 * subdomains) site, the demo host demo, Google's sign-in host google_signin_return, any other host other, none direct.
 */
export function sourceOf({ query = '', referer = '', siteHost = null, demoHost = null } = {}) {
  let utm = '';
  try { utm = String(new URLSearchParams(query).get('utm_source') ?? '').trim().toLowerCase(); } catch { /* ignored */ }
  if (UTM_SOURCES.includes(utm)) return utm;
  if (!referer) return 'direct';
  let host;
  try { host = new URL(String(referer)).hostname.toLowerCase().replace(/\.$/, ''); } catch { return 'other'; }
  if (!host) return 'other';
  if (within(host, 'linkedin.com') || within(host, 'lnkd.in')) return 'linkedin';
  if (host === 'github.com') return 'github';
  if (GOOGLE_SIGN_IN_HOSTS.includes(host)) return 'google_signin_return';
  // The demo before the site: the demo's host is usually a subdomain of the site's.
  if (demoHost && host === demoHost) return 'demo';
  if (within(host, siteHost)) return 'site';
  return 'other';
}

const header = (req, name) => {
  const v = req.headers?.[name];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * The counters. visit(req) counts a signed-in browser visit once per account per owner day (an in-memory set of user
 * ids, replaced each day and never written anywhere; a restart may count someone twice); arrival(req) counts a page
 * arrival's source. Both keep only +1 on a (day, dimension, value) row.
 * @param {{ db: object, place?: Function|null, tz: string, siteHost?: string|null, demoHost?: string|null, appHost?: string|null, now?: () => Date }} opts
 */
export function createUsageTotals({ db, place = null, tz, siteHost = null, demoHost = null, appHost = null, now = () => new Date() }) {
  const add = db.prepare(`INSERT INTO usage_totals (day, dimension, value, count) VALUES (?, ?, ?, 1)
    ON CONFLICT (day, dimension, value) DO UPDATE SET count = count + 1`);
  let seenDay = null;
  let seen = new Set();
  const today = () => localDate(now(), tz);
  return {
    /** A signed-in browser visit by uid (the auth hook marked it); counted once a day per account. */
    visit(req, uid) {
      const day = today();
      if (day !== seenDay) { seenDay = day; seen = new Set(); }
      if (!uid || seen.has(uid)) return;
      seen.add(uid);
      add.run(day, 'device', deviceOf(header(req, 'user-agent'), header(req, 'sec-ch-ua-mobile')));
      add.run(day, 'browser', browserOf(header(req, 'user-agent')));
      add.run(day, 'location', locationOf(place, req.ip));
    },
    /** A page arrival (the sign-in page or the app page): its source only. Internal navigation is not an arrival. */
    arrival(req) {
      const dest = header(req, 'sec-fetch-dest');
      if (dest && dest !== 'document') return;
      if (header(req, 'sec-fetch-site') === 'same-origin') return;
      const referer = header(req, 'referer') ?? '';
      if (appHost && referer) {
        try { if (new URL(referer).hostname.toLowerCase() === appHost) return; } catch { /* other */ }
      }
      const query = String(req.url ?? '').split('?')[1] ?? '';
      add.run(today(), 'source', sourceOf({ query, referer, siteHost, demoHost }));
    },
  };
}
