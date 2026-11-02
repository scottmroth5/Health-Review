// Demo analytics (server/public/analytics.js, server/security.js analyticsConfig): the payload holds only allowlisted
// fields, and only the demo, with a valid token and https host, sends anything or widens connect-src. Made-up values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openOwnerStore } from '../db/store.js';
import { buildApp } from '../server/app.js';
import { analyticsConfig, siteHostname, CONTENT_SECURITY_POLICY } from '../server/security.js';
import { analyticsEvent, createTracker, trafficSource, APP, SECTIONS, SOURCES } from '../server/public/analytics.js';

const ids = { token: 'phc_TestToken1234567890', distinctId: '00000000-0000-4000-8000-000000000000' };
const CONFIG = { token: ids.token, host: 'https://us.i.posthog.com' };

test('analyticsEvent: fixed events and values only, every other property dropped', () => {
  assert.deepEqual(analyticsEvent('demo_opened', { source: 'linkedin' }, ids), {
    api_key: ids.token, event: 'demo_opened', distinct_id: ids.distinctId, properties: { app: APP, $process_person_profile: false, source: 'linkedin' },
  });
  assert.equal(analyticsEvent('section_viewed', { section: 'health' }, ids).properties.section, 'health');
  assert.equal(analyticsEvent('sample_review_opened', { which: 'earlier' }, ids).properties.which, 'earlier');
  assert.equal(analyticsEvent('$pageview', {}, ids), null);
  assert.equal(analyticsEvent('toString', {}, ids), null);
  assert.equal(analyticsEvent('section_viewed', { section: 'reviews/2026-10-03' }, ids), null);
  assert.equal(analyticsEvent('section_viewed', {}, ids), null);
  assert.equal(analyticsEvent('sample_review_opened', { which: '2026-10-03' }, ids), null);
  assert.ok(SECTIONS.includes('reviews') && SECTIONS.includes('home'));
});

test('analyticsEvent: made-up sensitive values passed in never reach the payload', () => {
  const sensitive = {
    medication: 'Examplorin 20 mg', lab: 'glucose 105 mg/dL', email: 'someone@example.com', note: 'chest felt tight after the run',
    $current_url: 'https://demo.example.com/#reviews/2026-10-03', $referrer: 'https://example.com/?name=Pat', distinct_id: 'pat@example.com',
  };
  for (const [name, extra] of [['demo_opened', { source: 'other' }], ['section_viewed', { section: 'meds' }], ['sample_review_opened', { which: 'latest' }]]) {
    const json = JSON.stringify(analyticsEvent(name, { ...sensitive, ...extra }, ids));
    for (const v of Object.values(sensitive)) assert.ok(!json.includes(v), `${name} leaked ${v}`);
    assert.ok(!/current_url|referrer|medication|lab|email|note/.test(json), json);
  }
});

test('analyticsConfig: an https origin and a phc_ token, else off', () => {
  assert.deepEqual(analyticsConfig({ token: ids.token, host: 'https://us.i.posthog.com/some/path' }), { host: 'https://us.i.posthog.com', token: ids.token });
  assert.equal(analyticsConfig(null), null);
  assert.equal(analyticsConfig({ token: '', host: CONFIG.host }), null);
  assert.equal(analyticsConfig({ token: 'phx_personalKey1234567890', host: CONFIG.host }), null);
  assert.equal(analyticsConfig({ token: "phc_abc1234567890'; script-src *", host: CONFIG.host }), null);
  assert.equal(analyticsConfig({ token: ids.token, host: 'http://us.i.posthog.com' }), null);
  assert.equal(analyticsConfig({ token: ids.token, host: 'not a url' }), null);
  assert.equal(analyticsConfig({ token: ids.token, host: 'https://user:pw@us.i.posthog.com' }), null);
});

async function statusFor(opts) {
  const store = openOwnerStore(':memory:');
  const app = await buildApp({ store, ...opts });
  await app.ready();
  const res = await app.inject('/api/status');
  await app.close();
  store.close();
  return { body: res.json(), csp: res.headers['content-security-policy'] };
}

test('the demo with a token: /api/status carries the config and connect-src adds that one origin; scripts stay self', async () => {
  const { body, csp } = await statusFor({ authMode: 'demo', instance: 'demo', features: { chat: false }, analytics: CONFIG });
  assert.deepEqual(body.analytics, CONFIG);
  assert.match(csp, /connect-src 'self' https:\/\/us\.i\.posthog\.com;/);
  assert.match(csp, /script-src 'self';/);
});

test('no analytics outside the demo, or with a bad config', async () => {
  for (const opts of [
    { analytics: CONFIG },
    { authMode: 'demo', instance: 'demo', features: { chat: false } },
    { authMode: 'demo', instance: 'demo', features: { chat: false }, analytics: { ...CONFIG, host: 'http://us.i.posthog.com' } },
  ]) {
    const { body, csp } = await statusFor(opts);
    assert.equal(body.analytics, undefined);
    assert.equal(csp, CONTENT_SECURITY_POLICY);
  }
});

test('the tracker: events wait for the config, then go out; no config turns it off for good', () => {
  const sent = [];
  const t = createTracker({ nav: {}, send: (url, body) => sent.push({ url, body }), randomId: () => ids.distinctId });
  t.track('demo_opened', { source: 'direct' });
  t.track('section_viewed', { section: 'home' });
  assert.equal(sent.length, 0, 'nothing before the config');
  t.start(CONFIG);
  t.track('sample_review_opened', { which: 'latest' });
  assert.deepEqual(sent.map((x) => x.body.event), ['demo_opened', 'section_viewed', 'sample_review_opened']);
  assert.equal(sent[0].url, 'https://us.i.posthog.com/i/v0/e/');
  const off = createTracker({ nav: {}, send: () => assert.fail('sent without a config') });
  off.track('demo_opened', { source: 'direct' });
  off.start(undefined);
  off.track('demo_opened', { source: 'direct' });
});

test('Global Privacy Control: nothing is sent and nothing is queued, even with a config', () => {
  const sent = [];
  const t = createTracker({ nav: { globalPrivacyControl: true }, send: (url, body) => sent.push(body), randomId: () => ids.distinctId });
  t.track('demo_opened', { source: 'direct' });
  t.track('section_viewed', { section: 'home' });
  t.start(CONFIG);
  t.track('sample_review_opened', { which: 'latest' });
  assert.deepEqual(sent, []);
  // Only true counts: a browser without the signal (undefined or false) is tracked as before.
  for (const gpc of [undefined, false]) {
    const out = [];
    const u = createTracker({ nav: { globalPrivacyControl: gpc }, send: (url, body) => out.push(body), randomId: () => ids.distinctId });
    u.start(CONFIG);
    u.track('demo_opened', { source: 'direct' });
    assert.equal(out.length, 1);
  }
});

// Made-up names only: example.test stands in for the operator's site, demo.example.test for the demo itself.
const SITE = 'example.test';
const OWN = 'demo.example.test';
const from = (referrer, search = '', site = SITE) => trafficSource({ search, referrer, ownHost: OWN, site });

test('trafficSource: utm_source first, when it is exactly one of the three', () => {
  assert.equal(from('', '?utm_source=linkedin&utm_medium=featured'), 'linkedin');
  assert.equal(from('', '?utm_source=GitHub'), 'github', 'any case');
  assert.equal(from('https://www.linkedin.com/', '?utm_source=scottmroth'), 'scottmroth', 'the tag beats the referrer');
  // Spoofed or unknown values are ignored, and the referrer decides.
  for (const utm of ['linkedin.evil', 'https://x', 'facebook', '', 'linkedin%00', ' ']) {
    assert.equal(from('', `?utm_source=${utm}`), 'direct', utm);
    assert.equal(from('https://github.com/someone', `?utm_source=${utm}`), 'github', utm);
  }
});

test('trafficSource: the referrer host, never a lookalike', () => {
  assert.equal(from('https://www.linkedin.com/feed/update/123'), 'linkedin');
  assert.equal(from('https://linkedin.com/'), 'linkedin');
  assert.equal(from('https://lnkd.in/abc'), 'linkedin');
  assert.equal(from('https://github.com/someone/repo'), 'github');
  assert.equal(from(`https://${SITE}/`), 'scottmroth');
  assert.equal(from(`https://www.${SITE}/about`), 'scottmroth');
  assert.equal(from(`https://${OWN}/#reviews`), 'direct', "the demo's own pages are direct");
  assert.equal(from(''), 'direct', 'no referrer');
  assert.equal(from('https://news.example.org/'), 'other');
  for (const lookalike of ['https://linkedin.com.example.com/', 'https://evil-linkedin.com/', 'https://lnkd.in.example.net/', 'https://gist.github.com/', 'https://github.com.evil.test/', `https://${SITE}.evil.test/`, `https://not${SITE}/`]) {
    assert.equal(from(lookalike), 'other', lookalike);
  }
  assert.equal(from('not a url'), 'other');
  assert.equal(from(`https://${SITE}/`, '', null), 'other', 'without PERSONAL_SITE, the site is just another host');
  for (const value of ['', 'https://x', 'linkedin', 'direct']) assert.ok(SOURCES.includes(from(value)));
});

test('demo_opened carries only a source on the list: never a URL, referrer or query value', () => {
  for (const source of SOURCES) assert.equal(analyticsEvent('demo_opened', { source }, ids).properties.source, source);
  assert.equal(analyticsEvent('demo_opened', {}, ids), null);
  assert.equal(analyticsEvent('demo_opened', { source: 'https://www.linkedin.com/feed' }, ids), null);
  assert.equal(analyticsEvent('demo_opened', { source: 'LinkedIn' }, ids), null);
  const leaks = { source: 'linkedin', referrer: 'https://www.linkedin.com/in/someone', url: 'https://demo.example.test/?utm_source=linkedin&name=Pat', utm_campaign: 'personal_brand', $referrer: 'https://x.test/' };
  const json = JSON.stringify(analyticsEvent('demo_opened', leaks, ids));
  for (const v of ['https://', 'someone', 'Pat', 'personal_brand', 'utm_']) assert.ok(!json.includes(v), v);
});

test('the site name: a bare hostname or nothing; the demo sends it, the privacy page names it', async () => {
  assert.equal(siteHostname('Example.Test'), 'example.test');
  for (const bad of ['a b', 'x;y', 'https://example.test', 'example', '', null, 'exa mple.test', "example.test'"]) assert.equal(siteHostname(bad), null, String(bad));
  assert.equal(analyticsConfig({ ...CONFIG, site: 'x;y' }).site, undefined, 'a bad site is dropped, analytics stays on');
  const { body } = await statusFor({ authMode: 'demo', instance: 'demo', features: { chat: false }, analytics: CONFIG, personalSite: SITE });
  assert.equal(body.analytics.site, SITE);
  assert.equal((await statusFor({ analytics: CONFIG, personalSite: SITE })).body.analytics, undefined, 'never outside the demo');
  for (const [personalSite, shown] of [[SITE, SITE], [null, "the operator&#39;s website"]]) {
    const store = openOwnerStore(':memory:');
    const app = await buildApp({ store, personalSite });
    const page = (await app.inject('/privacy')).body;
    assert.ok(page.includes(`(LinkedIn, GitHub, ${shown}, other, or direct)`), shown);
    assert.ok(!page.includes('{{'));
    await app.close();
    store.close();
  }
});
