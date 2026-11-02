// Demo analytics (server/public/analytics.js, server/security.js analyticsConfig): the payload holds only allowlisted
// fields, and only the demo, with a valid token and https host, sends anything or widens connect-src. Made-up values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openOwnerStore } from '../db/store.js';
import { buildApp } from '../server/app.js';
import { analyticsConfig, CONTENT_SECURITY_POLICY } from '../server/security.js';
import { analyticsEvent, APP, SECTIONS } from '../server/public/analytics.js';

const ids = { token: 'phc_TestToken1234567890', distinctId: '00000000-0000-4000-8000-000000000000' };
const CONFIG = { token: ids.token, host: 'https://us.i.posthog.com' };

test('analyticsEvent: fixed events and values only, every other property dropped', () => {
  assert.deepEqual(analyticsEvent('demo_opened', {}, ids), {
    api_key: ids.token, event: 'demo_opened', distinct_id: ids.distinctId, properties: { app: APP, $process_person_profile: false },
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
  for (const [name, extra] of [['demo_opened', {}], ['section_viewed', { section: 'meds' }], ['sample_review_opened', { which: 'latest' }]]) {
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
