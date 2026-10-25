// Feedback, enhancement requests and bug reports (Help): kept for the administrator, emailed to them with the sender as
// reply-to; limits, the demo and paused accounts; the admin list; export and delete include it. Also the prompt
// builder's draft (agent/prompt-draft.js): a template without AI, Claude with the answers only. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openHealthStore } from '../db/store.js';
import { scopeDb } from '../db/scope.js';
import { buildApp } from '../server/app.js';
import { authSettings } from '../server/auth.js';
import { templateDraft } from '../agent/prompt-draft.js';

const SITE = 'http://localhost:5188';

async function setup({ claude = null, ai = true } = {}) {
  const settings = authSettings({ AUTH_MODE: 'google', PUBLIC_URL: SITE, GOOGLE_WEB_CLIENT_ID: 'x', GOOGLE_WEB_CLIENT_SECRET: 'y',
    AUTH_ALLOWED_EMAILS: 'owner@example.com', SESSION_SECRET: randomBytes(48).toString('base64') });
  const store = openHealthStore(':memory:');
  store.db.prepare("INSERT INTO users (id, email, name, role, status, created_at) VALUES ('lee', 'lee@example.com', 'Lee', 'user', 'approved', 'x'), ('kim', 'kim@example.com', 'Kim', 'user', 'approved', 'x')").run();
  const mail = [];
  const services = claude ? { claude: () => claude, aiAccess: () => (ai ? { source: 'own', reason: null } : { source: null, reason: 'no_key' }) } : {};
  let email;
  let nonce;
  const app = await buildApp({ store, authMode: 'google', services, mailer: { send: async (m) => { mail.push(m); return true; } }, log: { info() {}, warn() {}, error() {} },
    auth: { settings, exchange: async () => ({ email, email_verified: true, nonce }) } });
  const cookies = (res) => [res.headers['set-cookie']].flat().filter(Boolean).map((c) => c.split(';')[0]).join('; ');
  const signIn = async (as) => {
    email = as;
    const login = await app.inject('/auth/login');
    const url = new URL(login.headers.location);
    nonce = url.searchParams.get('nonce');
    const res = await app.inject({ url: `/auth/google/callback?state=${url.searchParams.get('state')}&code=c`, headers: { cookie: cookies(login) } });
    const cookie = cookies(res).split('; ').find((c) => c.startsWith('hr_session='));
    return { get: (u) => app.inject({ url: u, headers: { cookie, 'user-agent': 'TestBrowser/1.0' } }), send: (method, u, payload) => app.inject({ method, url: u, headers: { cookie, origin: SITE, 'user-agent': 'TestBrowser/1.0' }, ...(payload ? { payload } : {}) }) };
  };
  return { store, mail, signIn };
}

test('feedback: stored, emailed to the admin with the sender as reply-to; the admin lists it and marks it done', async () => {
  const { store, mail, signIn } = await setup();
  const lee = await signIn('lee@example.com');
  const sent = await lee.send('POST', '/api/feedback', { kind: 'bug', subject: 'Chart is blank', body: 'The weight chart shows nothing.', doing: 'Opened Health on my phone', screen: 'health' });
  assert.equal(sent.statusCode, 200);
  assert.equal(mail.length, 1);
  assert.equal(mail[0].to, 'owner@example.com');
  assert.equal(mail[0].replyTo, 'lee@example.com');
  assert.equal(mail[0].subject, 'Health Review [bug] Chart is blank');
  assert.match(mail[0].text, /Bug report from Lee <lee@example\.com>/);
  assert.match(mail[0].text, /What they were doing: Opened Health on my phone/);
  assert.match(mail[0].text, /Screen: health \| App: \S+ \| Browser: TestBrowser\/1\.0/);
  assert.equal((await lee.get('/api/feedback')).json()[0].status, 'new');

  const kim = await signIn('kim@example.com');
  assert.deepEqual((await kim.get('/api/feedback')).json(), [], "never another user's");
  assert.equal((await kim.get('/api/admin/feedback')).statusCode, 403);
  const owner = await signIn('owner@example.com');
  const list = (await owner.get('/api/admin/feedback')).json();
  assert.equal(list.newCount, 1);
  assert.equal(list.items[0].email, 'lee@example.com');
  assert.equal(list.items[0].context.screen, 'health');
  assert.equal((await owner.send('POST', `/api/admin/feedback/${list.items[0].id}/status`, { status: 'done' })).statusCode, 200);
  assert.equal((await lee.get('/api/feedback')).json()[0].status, 'done');
  assert.equal((await owner.get('/api/admin/feedback')).json().newCount, 0);

  // Export carries it; deleting the account removes it.
  assert.equal((await lee.get('/api/account/export')).json().tables.feedback.length, 1);
  await lee.send('POST', '/api/account/delete', { confirmEmail: 'lee@example.com' });
  assert.equal(store.db.prepare('SELECT COUNT(*) FROM feedback').pluck().get(), 0);
});

test('feedback limits: bad kinds, blank or long text, 5 an hour, paused accounts', async () => {
  const { signIn } = await setup();
  const lee = await signIn('lee@example.com');
  assert.equal((await lee.send('POST', '/api/feedback', { kind: 'spam', subject: 'x', body: 'y' })).statusCode, 400);
  assert.equal((await lee.send('POST', '/api/feedback', { kind: 'feedback', subject: '  ', body: 'y' })).statusCode, 400);
  assert.equal((await lee.send('POST', '/api/feedback', { kind: 'feedback', subject: 'x', body: 'y'.repeat(5001) })).statusCode, 400);
  assert.equal((await lee.send('POST', '/api/feedback', { kind: 'feedback', subject: 'x', body: 'y', screen: '<script>' })).statusCode, 400);
  for (let i = 0; i < 5; i++) assert.equal((await lee.send('POST', '/api/feedback', { kind: 'enhancement', subject: `Idea ${i}`, body: 'z' })).statusCode, 200);
  assert.equal((await lee.send('POST', '/api/feedback', { kind: 'enhancement', subject: 'One more', body: 'z' })).statusCode, 429);
  const kim = await signIn('kim@example.com');
  await kim.send('POST', '/api/account/pause');
  assert.equal((await kim.send('POST', '/api/feedback', { kind: 'feedback', subject: 'x', body: 'y' })).statusCode, 403);
});

test('prompt builder: a template without AI; Claude gets only the answers and guidance; refused without AI', async () => {
  const t = templateDraft('training', { days: '4', equipment: 'home gym, no machines.', avoid: '' });
  assert.equal(t.name, 'Training');
  assert.equal(t.text, 'I lift 4 days a week. Equipment: home gym, no machines.');
  assert.equal(templateDraft('custom', { topic: 'Mobility', details: 'Nudge me — daily' }).text, 'Nudge me, daily', 'dashes replaced');

  const calls = [];
  const claude = { send: async (opts) => { calls.push(opts); return { text: 'I lift 4 days a week -- mornings.', model: opts.model }; } };
  const { store, signIn } = await setup({ claude });
  const db = scopeDb(store.db, 'lee');
  db.prepare("INSERT INTO medications (user_id, name, kind, created_at) VALUES (@uid, 'Made-up Pill', 'medication', 'x')").run();
  db.prepare("INSERT INTO settings (user_id, key, value, updated_at) VALUES (@uid, 'goal_primary', 'strength', 'x')").run();
  const lee = await signIn('lee@example.com');
  const spec = (await lee.get('/api/prompt/builder')).json();
  assert.equal(spec.claude, true);
  assert.ok(spec.kinds.some((k) => k.kind === 'about'));
  const draft = (await lee.send('POST', '/api/prompt/draft', { kind: 'training', answers: { days: '4' }, useClaude: true })).json();
  assert.equal(draft.text, 'I lift 4 days a week, mornings.');
  assert.match(calls[0].prompt, /Days a week you lift: 4/);
  assert.match(calls[0].prompt, /Strength and muscle/, 'their goals help');
  assert.ok(!JSON.stringify(calls[0]).includes('Made-up Pill'), 'never their data');
  assert.match(calls[0].system, /Never include medication names/);
  assert.equal((await lee.send('POST', '/api/prompt/draft', { kind: 'nope', answers: {} })).statusCode, 400);

  const noAi = await setup({ claude, ai: false });
  const kim = await noAi.signIn('kim@example.com');
  assert.equal((await kim.send('POST', '/api/prompt/draft', { kind: 'about', answers: { age: '40s' }, useClaude: true })).statusCode, 503);
  assert.equal((await kim.send('POST', '/api/prompt/draft', { kind: 'about', answers: { age: '40s' } })).json().text, 'I am 40s.', 'the template still works');
});
