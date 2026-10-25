// Training goals (server/public/goals.js) and the Home tile order: the rules, saving them, and the review and chat
// carrying the goals. Synthetic accounts; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openHealthStore } from '../db/store.js';
import { scopeDb } from '../db/scope.js';
import { buildApp } from '../server/app.js';
import { authSettings } from '../server/auth.js';
import { TILES, cleanGoals, goalWeights, orderFor, tileOrder } from '../server/public/goals.js';
import { prepareReview } from '../agent/review.js';
import { CONTRACT } from '../agent/instructions.js';

const SITE = 'http://localhost:5188';

test('goal rules: primary first, then secondary, then the rest in their usual order; unknown goals ignored', () => {
  const training = ['log-workout-card', 'program-card', 'adherence-card', 'lifts-card', 'training-card', 'advisor-card'];
  assert.deepEqual(orderFor({}, training, 'training'), training, 'no goal: unchanged');
  assert.deepEqual(orderFor({ primary: 'strength' }, training, 'training'), ['log-workout-card', 'program-card', 'lifts-card', 'training-card', 'advisor-card', 'adherence-card']);
  assert.deepEqual(orderFor({ primary: 'endurance', secondary: 'cardio' }, ['vo2-card', 'zones-card'], 'health'), ['zones-card', 'vo2-card']);
  const charts = ['hrv_ms', 'resting_hr', 'sleep_total_hr', 'steps', 'weight_lbs', 'body_fat_pct'];
  assert.deepEqual(orderFor({ primary: 'weight', secondary: 'health' }, charts, 'charts'), ['weight_lbs', 'body_fat_pct', 'steps', 'sleep_total_hr', 'hrv_ms', 'resting_hr']);
  assert.deepEqual(cleanGoals({ primary: 'strength', secondary: 'strength' }), { primary: 'strength', secondary: null });
  assert.deepEqual(cleanGoals({ primary: 'flying', secondary: 'cardio' }), { primary: null, secondary: null });
  assert.deepEqual(goalWeights({ primary: 'strength', secondary: 'cardio' }), { strength: 3, joint: 1, time: 1, vo2: 2 });
  assert.deepEqual(goalWeights({}), { strength: 1, joint: 1, time: 1, vo2: 1 });
});

test('tile order: the user\'s own (unknown tiles dropped, new ones added at the end), else Daily Check-in then the goals\'', () => {
  assert.deepEqual(tileOrder(null, {}), TILES);
  assert.deepEqual(tileOrder(null, { primary: 'cardio' }).slice(0, 3), ['today', 'health', 'training']);
  const own = tileOrder(['help', 'nonsense', 'today', 'help'], { primary: 'cardio' });
  assert.deepEqual(own.slice(0, 2), ['help', 'today']);
  assert.equal(own.length, TILES.length, 'every tile, once');
});

async function setup() {
  const settings = authSettings({ AUTH_MODE: 'google', PUBLIC_URL: SITE, GOOGLE_WEB_CLIENT_ID: 'x', GOOGLE_WEB_CLIENT_SECRET: 'y',
    AUTH_ALLOWED_EMAILS: 'owner@example.com', SESSION_SECRET: randomBytes(48).toString('base64') });
  const store = openHealthStore(':memory:');
  store.db.prepare("INSERT INTO users (id, email, role, status, created_at) VALUES ('lee', 'lee@example.com', 'user', 'approved', 'x')").run();
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
  return { store, signIn };
}

test('saving goals and the tile order; bad values refused', async () => {
  const { signIn } = await setup();
  const lee = await signIn('lee@example.com');
  assert.deepEqual((await lee.get('/api/account')).json().goals, { primary: null, secondary: null });
  assert.equal((await lee.send('PUT', '/api/account/goals', { primary: 'flying' })).statusCode, 400);
  const saved = (await lee.send('PUT', '/api/account/goals', { primary: 'weight', secondary: 'weight' })).json();
  assert.deepEqual(saved.goals, { primary: 'weight', secondary: null }, 'a second goal equal to the first is dropped');
  assert.deepEqual((await lee.send('PUT', '/api/account/goals', { primary: 'strength', secondary: 'cardio' })).json().goals, { primary: 'strength', secondary: 'cardio' });

  assert.equal((await lee.send('PUT', '/api/account/tile-order', { tiles: ['today', 'hacker'] })).statusCode, 400);
  assert.deepEqual((await lee.send('PUT', '/api/account/tile-order', { tiles: ['help', 'today', 'help'] })).json().tileOrder, ['help', 'today']);
  assert.equal((await lee.send('PUT', '/api/account/tile-order', { tiles: null })).json().tileOrder, null);
});

test('the review summary and its instructions carry the goals (labels only); none when unset', async () => {
  const { store } = await setup();
  const db = scopeDb(store.db, 'lee');
  const week = { weekEnd: '2026-03-14', today: '2026-03-16' };
  assert.equal(prepareReview(db, week).summary.goals, undefined);
  db.prepare("INSERT INTO settings (user_id, key, value, updated_at) VALUES (@uid, 'goal_primary', 'cardio', 'x'), (@uid, 'goal_secondary', 'weight', 'x')").run();
  assert.deepEqual(prepareReview(db, week).summary.goals, { primary: 'Cardio fitness', secondary: 'Lose weight / body composition' });
  assert.match(CONTRACT, /"goals" \(present only when the owner set them\)/);
});
