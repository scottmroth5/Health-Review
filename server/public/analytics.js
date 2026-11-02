// Demo analytics (the public demo only; PostHog guide step 6, 2026-11-02). No SDK: each event is one POST to PostHog's
// capture endpoint, built here field by field, so nothing leaves the browser that is not listed below. No URL, referrer,
// cookie or storage; a random id per page load and no person profiles. The server turns it on only in AUTH_MODE=demo
// with DEMO_ANALYTICS_TOKEN set (/api/status analytics); otherwise start is never called and track does nothing.

export const APP = 'health_review_demo';
export const SECTIONS = ['home', 'today', 'training', 'programs', 'health', 'meds', 'labs', 'reviews', 'prompt', 'activity', 'settings', 'users', 'help'];

// Each event and the one property it may carry, with its allowed values.
const EVENTS = {
  demo_opened: null,
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

let config = null;
let off = false;
// Events from before the config arrives (the first screen renders while /api/status loads), at most a few; dropped
// unsent when analytics is off.
const early = [];

/** Turns sending on with { host, token } from /api/status and sends the queued events; anything else turns it off. */
export function startAnalytics({ host, token } = {}) {
  if (config || off) return;
  const queued = early.splice(0);
  if (!host || !token) { off = true; return; }
  config = { url: `${host}/i/v0/e/`, token, distinctId: crypto.randomUUID() };
  for (const [name, props] of queued) track(name, props);
}

/** Sends one event; never throws, and a blocked request is ignored. */
export function track(name, props) {
  if (!config) {
    if (!off && early.length < 10) early.push([name, props]);
    return;
  }
  try {
    const body = analyticsEvent(name, props, config);
    if (!body) return;
    fetch(config.url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      credentials: 'omit', referrerPolicy: 'no-referrer', keepalive: true,
    }).catch(() => {});
  } catch { /* analytics never breaks the page */ }
}
