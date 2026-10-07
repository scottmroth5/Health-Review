import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openHealthStore } from '../db/store.js';
import { buildApp } from '../server/app.js';
import { createCatalog } from '../metrics/catalog.js';
import { createDictionary } from '../metrics/dictionary.js';
import { createReviewClaude } from '../agent/claude.js';
import { askAdvisor, chatContext, CHAT_CONTRACT } from '../agent/advisor-chat.js';
import { silentLogger } from './helpers.js';

const TODAY = new Date(2026, 2, 9, 12, 0); // local 2026-03-09
const phase = (exercises, extra = {}) => [{ name: 'Phase 1', weeks: [1, 4], workouts_per_week: 3, workouts: [{ name: 'A', exercises }], ...extra }];
const catalog = createCatalog({ version: 1, programs: [
  { name: 'MAPS Powerlift', weeks: 4, profile: { conditioning: 0, mobility: 0, focus: 'FOCUS TEXT FROM A BLUEPRINT' },
    phases: phase([{ name: 'Squat', sets: '5', reps: '3' }], { rest: '2 minutes' }) },
  { name: 'HIIT', weeks: 4, profile: { conditioning: 3, mobility: 3, minutes_per_session: 20 }, phases: phase([{ name: 'Sprints', sets: '6', reps: '30s' }]) },
] }, { programs: ['MAPS Powerlift', 'HIIT'] });
const dictionary = createDictionary({ version: 1, exercises: [
  { id: 'squat', name: 'Squat', implement: 'barbell', pattern: 'squat', primary: true },
  { id: 'sprints', name: 'Sprints', implement: 'other', pattern: 'other', primary: false },
  { id: 'circus-press', name: 'Circus Press', implement: 'dumbbell', pattern: 'vertical press', primary: false }] });
const substitutions = { equipment: { have: ['barbell', 'band'], lack: ['machine'] }, avoid: [{ exercise: 'circus-press' }] };

function seeded() {
  const store = openHealthStore(':memory:');
  store.db.prepare("INSERT INTO medications (name, kind, created_at) VALUES ('Sample Statin', 'medication', 'x')").run();
  store.db.prepare("INSERT INTO lab_tests (name, panel, unit, position, created_at) VALUES ('Sample Glucose', 'Panel', 'mg/dL', 1, 'x')").run();
  return store;
}
const response = (r) => ({ id: 'msg_test', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(r) }], usage: { input_tokens: 800, output_tokens: 300 } });
const fakeClaude = (drafts, prompts = []) => createReviewClaude({ client: { messages: { create: async (p) => { prompts.push(p); return response(drafts[Math.min(prompts.length, drafts.length) - 1]); } } } });

test('chat context: computed training facts only; no medications, labs or blueprint focus text', () => {
  const store = seeded();
  const ctx = chatContext(store.db, '2026-03-09', { catalog, dictionary, substitutions, weights: { strength: 3 } });
  const text = JSON.stringify(ctx);
  assert.deepEqual(ctx.advisor.ranking.map((r) => r.program), ['MAPS Powerlift', 'HIIT']); // strength 3x: (3 + 0.2 + 1) / 6 = 0.7 vs 2.5 / 6
  assert.deepEqual(ctx.advisor.weights, { strength: 3, joint: 1, time: 1, vo2: 1 });
  assert.deepEqual(ctx.pausedExercises, ['Circus Press']);
  assert.deepEqual(ctx.equipment, { have: ['barbell', 'band'], lack: ['machine'] });
  for (const secret of ['Sample Statin', 'Sample Glucose', 'FOCUS TEXT', 'focus']) assert.doesNotMatch(text, new RegExp(secret, 'i'));
  assert.doesNotMatch(CHAT_CONTRACT, /prescription/i, 'the medication check would flag the word in replies');
  store.close();
});

test('chat: a reply with an ungrounded number and symptom wording is retried; the clean one is saved with its physician item', async () => {
  const store = seeded();
  const prompts = [];
  const drafts = [
    { reply: 'Go with HIIT at 77 percent effort, the pain will settle.', physicianDiscussion: [] },
    { reply: 'HIIT leads at 0.63 with time 1 and VO2 max 1. Since you want strength, MAPS Powerlift scores strength 1; target 3 sessions a week.',
      physicianDiscussion: [{ topic: 'Shoulder', detail: 'Discuss the shoulder you mentioned with a physician before heavy pressing.' }] },
  ];
  const r = await askAdvisor({ store, claude: fakeClaude(drafts, prompts), text: 'My shoulder hurts when I press. Strength matters most to me.',
    today: '2026-03-09', catalog, dictionary, substitutions, logger: silentLogger });
  assert.equal(prompts.length, 2);
  const retry = prompts[1].messages[0].content;
  assert.match(retry, /numbers not in the summary: 77/);
  assert.match(retry, /symptom wording in "Reply"/);
  assert.equal(prompts[0].output_config.effort, 'medium');
  assert.match(prompts[0].messages[0].content, /My shoulder hurts when I press/);
  assert.doesNotMatch(prompts[0].messages[0].content, /Sample Statin|Sample Glucose/);
  assert.deepEqual(r.reply.warnings, []);
  assert.deepEqual(r.reply.physician, [drafts[1].physicianDiscussion[0]]);
  const rows = store.db.prepare('SELECT role, text FROM advisor_notes ORDER BY created_at, rowid').all();
  assert.deepEqual(rows.map((x) => x.role), ['owner', 'claude']);
  const run = store.db.prepare("SELECT status, meta, summary FROM runs WHERE name = 'advisor-chat'").get();
  assert.equal(run.status, 'ok');
  assert.doesNotMatch(run.meta + run.summary, /shoulder|HIIT leads/i, 'no note or reply text in the run record');
  store.close();
});

test('chat API: thread, send, delete and clear; off without a client or when the instance turns it off; bad input refused', async () => {
  const store = seeded();
  const reply = { reply: 'MAPS Powerlift scores strength 1.', physicianDiscussion: [] };
  const app = await buildApp({ store, clock: () => TODAY, catalog, dictionary, substitutions, services: { claude: () => fakeClaude([reply]) } });
  assert.deepEqual((await app.inject('/api/advisor/chat')).json(), { enabled: true, notes: [] });
  const post = (payload) => app.inject({ method: 'POST', url: '/api/advisor/chat', payload });
  assert.equal((await post({ text: '' })).statusCode, 400);
  assert.equal((await post({ text: 'x'.repeat(4001) })).statusCode, 400);
  assert.equal((await post({ text: 'hi', weights: { strength: 4 } })).statusCode, 400);
  const ok = await post({ text: 'Which program builds strength?', weights: { strength: 2 } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().reply.text, 'MAPS Powerlift scores strength 1.');
  const { notes } = (await app.inject('/api/advisor/chat')).json();
  assert.deepEqual(notes.map((n) => [n.role, n.weights?.strength ?? null]), [['owner', 2], ['claude', null]]);
  assert.deepEqual((await app.inject({ method: 'DELETE', url: `/api/advisor/chat/${notes[0].id}` })).json(), { deleted: 1 });
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/advisor/chat/nope' })).statusCode, 404);
  assert.deepEqual((await app.inject({ method: 'DELETE', url: '/api/advisor/chat' })).json(), { deleted: 1 });
  await app.close();

  for (const options of [{ features: { chat: false }, services: { claude: () => fakeClaude([reply]) } }, { services: {} }]) {
    const off = await buildApp({ store, clock: () => TODAY, catalog, dictionary, substitutions, ...options });
    assert.equal((await off.inject('/api/advisor/chat')).json().enabled, false);
    assert.equal((await off.inject({ method: 'POST', url: '/api/advisor/chat', payload: { text: 'hi' } })).statusCode, 503);
    await off.close();
  }
  store.close();
});
