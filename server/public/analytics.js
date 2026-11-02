// Demo analytics (the public demo only; PostHog guide step 6, 2026-11-02). No SDK: each event is one POST to PostHog's
// capture endpoint, built here field by field, so nothing leaves the browser that is not listed below. No URL, referrer,
// cookie or storage; a random id per page load and no person profiles. The server turns it on only in AUTH_MODE=demo
// with DEMO_ANALYTICS_TOKEN set (/api/status analytics); otherwise start is never called and track does nothing. A
// browser sending Global Privacy Control (navigator.globalPrivacyControl) gets nothing sent and nothing queued.

export const APP = 'health_review_demo';
export const SECTIONS = ['home', 'today', 'training', 'programs', 'health', 'meds', 'labs', 'reviews', 'prompt', 'activity', 'settings', 'users', 'help'];

// Where a visit came from, in general terms only (trafficSource): never the address itself.
export const SOURCES = ['linkedin', 'github', 'scottmroth', 'other', 'direct'];
const UTM_SOURCES = ['linkedin', 'github', 'scottmroth'];

/** Whether a hostname is a domain or one of its subdomains (never a lookalike such as linkedin.com.example.com). */
const within = (host, domain) => Boolean(domain) && (host === domain || host.endsWith(`.${domain}`));

/**
 * A visit's source, worked out in the browser: utm_source when it is exactly linkedin, github or scottmroth (any other
 * value is ignored), else the referrer's hostname: the demo's own host is direct, linkedin.com and lnkd.in (and their
 * subdomains) linkedin, github.com github, the operator's site (PERSONAL_SITE, from the server; and its subdomains)
 * scottmroth, any other host other, and no referrer direct. Only the category is ever sent.
 * @param {{ search?: string, referrer?: string, ownHost?: string, site?: string|null }} p
 */
export function trafficSource({ search = '', referrer = '', ownHost = '', site = null } = {}) {
  let utm = '';
  try { utm = String(new URLSearchParams(search).get('utm_source') ?? '').trim().toLowerCase(); } catch { /* ignored */ }
  if (UTM_SOURCES.includes(utm)) return utm;
  if (!referrer) return 'direct';
  let host;
  try { host = new URL(referrer).hostname.toLowerCase().replace(/\.$/, ''); } catch { return 'other'; }
  if (!host) return 'other';
  if (host === String(ownHost).toLowerCase()) return 'direct';
  if (within(host, 'linkedin.com') || within(host, 'lnkd.in')) return 'linkedin';
  if (host === 'github.com') return 'github';
  if (within(host, site ? String(site).toLowerCase() : null)) return 'scottmroth';
  return 'other';
}

// Each event and the one property it may carry, with its allowed values.
const EVENTS = {
  demo_opened: ['source', SOURCES],
  section_viewed: ['section', SECTIONS],
  sample_review_opened: ['which', ['latest', 'earlier']],
};

/**
 * The capture payload for an event, or null when the event or its property is not on the allowlist. Other properties
 * are dropped.
 */
export function analyticsEvent(name, props = {}, { token, distinctId }) {
  if (!Object.hasOwn(EVENTS, name)) return null;
  const properties = { app: APP, $process_person_profile: false };
  const rule = EVENTS[name];
  if (rule) {
    const [key, allowed] = rule;
    const value = props?.[key];
    if (!allowed.includes(value)) return null;
    properties[key] = value;
  }
  return { api_key: token, event: name, distinct_id: distinctId, properties };
}

/**
 * A tracker: nothing goes out until start gets a config from the server, events from before then wait (a few at most),
 * and with Global Privacy Control on, or no config, nothing is ever sent or kept.
 * @param {{ nav?: object, send?: (url: string, body: object) => void, randomId?: () => string }} [deps]
 */
export function createTracker({ nav = globalThis.navigator, send = post, randomId = () => crypto.randomUUID() } = {}) {
  let config = null;
  let off = nav?.globalPrivacyControl === true;
  // Events from before the config arrives (the first screen renders while /api/status loads); dropped when off.
  const early = [];
  const track = (name, props) => {
    if (off) return;
    if (!config) {
      if (early.length < 10) early.push([name, props]);
      return;
    }
    try {
      const body = analyticsEvent(name, props, config);
      if (body) send(config.url, body);
    } catch { /* analytics never breaks the page */ }
  };
  return {
    /** Turns sending on with { host, token } from /api/status and sends the queued events; anything else turns it off. */
    start({ host, token } = {}) {
      if (config || off) { early.length = 0; return; }
      const queued = early.splice(0);
      if (!host || !token) { off = true; return; }
      config = { url: `${host}/i/v0/e/`, token, distinctId: randomId() };
      for (const [name, props] of queued) track(name, props);
    },
    /** Sends one event; never throws, and a blocked request is ignored. */
    track,
  };
}

function post(url, body) {
  fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    credentials: 'omit', referrerPolicy: 'no-referrer', keepalive: true,
  }).catch(() => {});
}

// The page's one tracker.
const tracker = createTracker();
export const startAnalytics = (config) => tracker.start(config);
export const track = (name, props) => tracker.track(name, props);
