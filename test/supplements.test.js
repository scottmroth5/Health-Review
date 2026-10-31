// Supplement suggestions (owner's choice, 2026-10-30): the upper limits, the checks, the statement code adds, the
// setting (off by default, on only with the statement accepted), and Help. Synthetic accounts and values; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { openHealthStore, openOwnerStore } from '../db/store.js';
import { buildApp } from '../server/app.js';
import { authSettings } from '../server/auth.js';
import { limitEntry, overLimit, parseAmount, renderSuggestions, SUPPLEMENT_DISCLAIMER, SUPPLEMENT_RULES, SUPPLEMENTS_TITLE } from '../agent/supplements.js';
import { buildSystem, renderReport, reportSchema, REPORT_SCHEMA, EMERGENCY_LINE } from '../agent/instructions.js';
import { allowedNumbers, checkReport, checkSuggestions } from '../agent/validate.js';
import { prepareReview } from '../agent/review.js';
import { askHelp } from '../agent/help.js';

const SITE = 'http://localhost:5188';
const vitD = (amount, extra = {}) => ({ supplement: 'Vitamin D3', action: 'change', amount, reasons: 'Your note says you doubled it.',
  precautions: 'The adult upper limit is 4,000 IU a day. Check interactions with Sample Statin with your pharmacist.', ...extra });

test('supplement limits: the config is well formed, with a source for every entry and no duplicate names', () => {
  const config = JSON.parse(readFileSync(new URL('../config/supplement-limits.json', import.meta.url), 'utf8'));
  const names = config.supplements.flatMap((s) => [s.name, ...s.aliases].map((n) => n.toLowerCase()));
  assert.equal(new Set(names).size, names.length);
  for (const s of config.supplements) {
    assert.match(s.source, /^NIH ODS/, s.name);
    const limits = s.limits ?? s.bands.flatMap((b) => b.limits);
    for (const l of limits) assert.ok(l.amount > 0 && ['mg', 'mcg', 'IU'].includes(l.unit), s.name);
  }
});

test('amounts and upper limits: parsed with units, compared across mg and mcg, IU only against IU; calcium by age', () => {
  assert.deepEqual(parseAmount('2,000 IU a day'), { amount: 2000, unit: 'IU' });
  assert.deepEqual(parseAmount('5 g a day'), { amount: 5000, unit: 'mg' });
  assert.equal(parseAmount('one capsule'), null);
  assert.equal(limitEntry('Vitamin D3 (cholecalciferol)').name, 'Vitamin D');
  assert.equal(limitEntry('Magnesium glycinate').name, 'Magnesium');
  assert.equal(limitEntry('Creatine monohydrate'), null);
  assert.equal(overLimit(vitD('2,000 IU a day')), null);
  assert.deepEqual(overLimit(vitD('5,000 IU a day')), { limit: '4,000 IU', name: 'Vitamin D' });
  assert.equal(overLimit(vitD('100 mcg a day')), null);
  assert.ok(overLimit(vitD('0.2 mg a day')), '200 mcg is over 100 mcg');
  assert.equal(overLimit({ supplement: 'Creatine', amount: '20 g a day' }), null, 'not listed: not checked in code');
  const calcium = { supplement: 'Calcium citrate', amount: '2,200 mg a day' };
  assert.equal(overLimit(calcium, { age: 40 }), null);
  assert.ok(overLimit(calcium, { age: 55 }));
  assert.ok(overLimit(calcium, { age: null }), 'an unknown age takes the lowest limit');
});

test('suggestion checks: reasons and precautions given, never a medication, within the limit, medications and symptoms only in precautions', () => {
  const o = { medicationNames: ['Sample Statin'], age: 50 };
  assert.deepEqual(checkSuggestions([vitD('2,000 IU a day')], o), []);
  const problems = checkSuggestions([
    vitD('5,000 IU a day'),
    { supplement: 'Sample Statin', action: 'add', amount: '', reasons: 'Helps.', precautions: 'None known.' },
    vitD('', { precautions: ' ', reasons: 'Because Sample Statin and your joint pain.' }),
  ], o);
  assert.ok(problems.some((p) => /above the adult upper intake level for Vitamin D \(4,000 IU\)/.test(p)));
  assert.ok(problems.some((p) => /"Sample Statin" is a medication/.test(p)));
  assert.ok(problems.some((p) => /give the precautions/.test(p)));
  assert.ok(problems.some((p) => /medication "Sample Statin" in the reasons/.test(p)));
  assert.ok(problems.some((p) => /symptom wording in the reasons/.test(p)));
  assert.match(checkSuggestions([1, 2, 3, 4].map(() => vitD('')), o)[0], /too many supplement suggestions: 4/);
});

test('checkReport: suggestions checked only when on; numbers in reasons grounded, amounts and precautions exempt; dashes found', () => {
  const report = { highlights: ['Quiet week.'], nextSteps: [], sections: [{ title: 'Training', body: 'Two lifting days.' }], physicianDiscussion: [],
    supplementSuggestions: [vitD('3,000 IU a day', { reasons: 'Vitamin D was 24 at the last draw (below range).' })] };
  const allowed = allowedNumbers({ labs: [{ value: 24 }] });
  assert.deepEqual(checkReport(report, { allowed, medicationNames: ['Sample Statin'], labNames: ['Vitamin D'], opening: true, supplements: { age: 50 } }), [],
    'a lab value and range wording may be a reason; the amount and the limit need not be in the summary');
  const ungrounded = { ...report, supplementSuggestions: [vitD('', { reasons: 'Your level of 31 suggests it.' })] };
  assert.ok(checkReport(ungrounded, { allowed, supplements: { age: 50 } }).some((p) => /numbers not in the summary: 31/.test(p)));
  const dashed = { ...report, supplementSuggestions: [vitD('', { reasons: 'Helps — a lot.' })] };
  assert.ok(checkReport(dashed, { allowed, supplements: {} }).some((p) => /dash in supplement suggestion/.test(p)));
});

test('the review: rules, schema field and statement only when the setting is on; the statement comes first and includes the 911 line', () => {
  assert.ok(!buildSystem([], '2026-10-31').system.includes(SUPPLEMENT_RULES));
  assert.ok(buildSystem([], '2026-10-31', { supplements: true }).system.endsWith(SUPPLEMENT_RULES));
  assert.equal(reportSchema(), REPORT_SCHEMA);
  assert.ok(reportSchema({ supplements: true }).required.includes('supplementSuggestions'));
  assert.ok(SUPPLEMENT_DISCLAIMER.includes(EMERGENCY_LINE));
  assert.match(SUPPLEMENT_DISCLAIMER, /accept full responsibility/);

  const md = renderReport({ highlights: ['A.'], nextSteps: ['B.'], sections: [{ title: 'Training', body: 'C.' }], physicianDiscussion: [],
    supplementSuggestions: [vitD('2,000 IU a day')] });
  const at = (s) => md.indexOf(s);
  assert.ok(at('## Next steps') < at(`## ${SUPPLEMENTS_TITLE}`) && at(`## ${SUPPLEMENTS_TITLE}`) < at('## Training'));
  assert.ok(md.includes(`## ${SUPPLEMENTS_TITLE}\n${SUPPLEMENT_DISCLAIMER}\n\n**Change: Vitamin D3, 2,000 IU a day**\n- **Why:**`));
  assert.ok(!renderReport({ highlights: [], nextSteps: [], sections: [], physicianDiscussion: [], supplementSuggestions: [] }).includes(SUPPLEMENTS_TITLE));
  assert.equal(renderSuggestions([]), '');

  const store = openOwnerStore(':memory:');
  const week = { weekEnd: '2026-09-26', today: '2026-09-27' };
  const off = prepareReview(store.db, week);
  assert.equal(off.schema, REPORT_SCHEMA);
  assert.equal(off.checks.supplements, null);
  store.db.prepare("INSERT INTO settings (user_id, key, value, updated_at) VALUES (@uid, 'supplement_advice', '2026-10-31T12:00:00.000Z', 'x')").run();
  const on = prepareReview(store.db, week);
  assert.ok(on.system.includes(SUPPLEMENT_RULES));
  assert.ok(on.schema.properties.supplementSuggestions);
  assert.deepEqual(on.checks.supplements, { age: null });
  store.close();
});

test('the setting: off by default, on only with the statement accepted, off at any time; paused accounts can only turn it off', async () => {
  const settings = authSettings({ AUTH_MODE: 'google', PUBLIC_URL: SITE, GOOGLE_WEB_CLIENT_ID: 'x', GOOGLE_WEB_CLIENT_SECRET: 'y',
    AUTH_ALLOWED_EMAILS: 'owner@example.com', SESSION_SECRET: randomBytes(48).toString('base64') });
  const store = openHealthStore(':memory:');
  store.db.prepare("INSERT INTO users (id, email, role, status, created_at) VALUES ('lee', 'lee@example.com', 'user', 'approved', 'x'), ('pat', 'pat@example.com', 'user', 'paused', 'x')").run();
  let email;
  let nonce;
  const app = await buildApp({ store, authMode: 'google', mailer: { send: async () => true }, log: { info() {}, warn() {}, error() {} },
    auth: { settings, exchange: async () => ({ email, email_verified: true, nonce }) } });
  const cookies = (res) => [res.headers['set-cookie']].flat().filter(Boolean).map((c) => c.split(';')[0]).join('; ');
  const signIn = async (as) => {
    email = as;
    const login = await app.inject('/auth/login');
    const url = new URL(login.headers.location);
    nonce = url.searchParams.get('nonce');
    const res = await app.inject({ url: `/auth/google/callback?state=${url.searchParams.get('state')}&code=c`, headers: { cookie: cookies(login) } });
    const cookie = cookies(res).split('; ').find((c) => c.startsWith('hr_session='));
    return { get: (u) => app.inject({ url: u, headers: { cookie } }), send: (method, u, payload) => app.inject({ method, url: u, headers: { cookie, origin: SITE }, ...(payload ? { payload } : {}) }) };
  };
  const lee = await signIn('lee@example.com');
  const account = (await lee.get('/api/account')).json();
  assert.equal(account.supplementAdvice.since, null);
  assert.equal(account.supplementAdvice.statement, SUPPLEMENT_DISCLAIMER);
  assert.equal((await lee.send('PUT', '/api/account/supplement-advice', { on: true })).statusCode, 400, 'not without accepting');
  assert.equal((await lee.send('PUT', '/api/account/supplement-advice', { on: true, accept: false })).statusCode, 400);
  assert.ok((await lee.send('PUT', '/api/account/supplement-advice', { on: true, accept: true })).json().supplementAdvice.since);
  assert.equal(store.db.prepare("SELECT user_id FROM settings WHERE key = 'supplement_advice'").pluck().get(), 'lee', 'their own settings row');
  assert.equal((await lee.send('PUT', '/api/account/supplement-advice', { on: false })).json().supplementAdvice.since, null);

  const pat = await signIn('pat@example.com');
  assert.equal((await pat.send('PUT', '/api/account/supplement-advice', { on: true, accept: true })).statusCode, 403);
  assert.equal((await pat.send('PUT', '/api/account/supplement-advice', { on: false })).statusCode, 200);

  const demo = await buildApp({ store, authMode: 'demo', instance: 'demo', features: { chat: false } });
  assert.equal((await demo.inject({ method: 'PUT', url: '/api/account/supplement-advice', payload: { on: true, accept: true } })).statusCode, 403);
});

test('Help: plain text and no statement when off; with it on, structured, general only, and the statement with any supplement answer', async () => {
  const store = openOwnerStore(':memory:');
  const calls = [];
  const claude = (reply) => ({ send: async (o) => { calls.push(o); return { model: 'm', text: typeof reply === 'string' ? reply : null, data: typeof reply === 'string' ? null : reply }; } });
  const off = await askHelp({ store, claude: claude('Open Settings.'), question: 'Should I take creatine?', site: SITE, logger: { info() {}, warn() {}, error() {} } });
  assert.deepEqual(off, { answer: 'Open Settings.' });
  assert.equal(calls[0].schema, undefined);
  assert.doesNotMatch(calls[0].system, /turned on supplement suggestions/);

  store.db.prepare("INSERT INTO settings (user_id, key, value, updated_at) VALUES (@uid, 'supplement_advice', '2026-10-31T12:00:00.000Z', 'x')").run();
  const on = await askHelp({ store, claude: claude({ answer: 'Creatine is widely studied for strength.', supplementAdvice: true }), question: 'Should I take creatine?', site: SITE });
  assert.deepEqual(on, { answer: 'Creatine is widely studied for strength.', statement: SUPPLEMENT_DISCLAIMER });
  assert.ok(calls[1].schema.properties.supplementAdvice);
  assert.match(calls[1].system, /turned on supplement suggestions/);
  const unflagged = await askHelp({ store, claude: claude({ answer: 'Magnesium glycinate is a common form.', supplementAdvice: false }), question: 'Which magnesium?', site: SITE });
  assert.equal(unflagged.statement, SUPPLEMENT_DISCLAIMER, 'shown although the model did not flag it');
  const app = await askHelp({ store, claude: claude({ answer: 'Open Settings, then Data feeds.', supplementAdvice: false }), question: 'How do I sync?', site: SITE });
  assert.equal(app.statement, undefined);
  store.close();
});
