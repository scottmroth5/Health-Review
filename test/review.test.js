import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeTruncatedError } from '@scottmroth5/agent-core';
import { openHealthStore } from '../db/store.js';
import { findDashes, stripDashes, allowedNumbers, ungroundedNumbers, misroutedTopics } from '../agent/validate.js';
import { buildSystem, renderReport, CONTRACT } from '../agent/instructions.js';
import { buildSummary } from '../agent/summary.js';
import { withFallbacks, createReviewClaude } from '../agent/claude.js';
import { runReview, prepareReview } from '../agent/review.js';
import { computeWeek } from '../metrics/index.js';
import { silentLogger } from './helpers.js';

const report = (sections, physicianDiscussion = []) => ({ sections: sections.map(([title, body]) => ({ title, body })), physicianDiscussion });

// ---- checks ----
test('dashes: em, en and double hyphen are found anywhere and stripped as a last resort', () => {
  const r = report([['Weekly Wins', 'Good week — HRV up'], ['Watch Outs', 'Zones 2–3 and -- here']], [{ topic: 'A', detail: 'ok' }]);
  assert.equal(findDashes(r).length, 2);
  const fixed = stripDashes(r);
  assert.deepEqual(findDashes(fixed), []);
  assert.equal(fixed.sections[0].body, 'Good week, HRV up');
  assert.deepEqual(findDashes(report([['Ranges', 'Zone 2 is 127-137 bpm']])), [], 'a single hyphen is fine');
});

test('grounding: numbers must come from the summary or instructions; dates, negatives, commas and units handled', () => {
  const summary = { weekEnd: '2026-09-26', hrv: { mean: 48, change: -3.5 }, steps: 8123, sleep: 7.3 };
  const allowed = allowedNumbers(summary, 'Zone 2 is 127-137 bpm. He is 51.');
  const r = report([['Recovery Signals', 'HRV averaged 48 ms, down 3.5 from baseline, on Sep 26. Steps 8,123. Slept 7.3h. Zone 2 is 127 to 137. CoQ10 and A1C are names.']]);
  assert.deepEqual(ungroundedNumbers(r, allowed), []);
  const bad = report([['Weekly Wins', 'HRV rose to 52 ms, about 8.3% better, top 25% for age 51.']]);
  assert.deepEqual(ungroundedNumbers(bad, allowed), ['52', '8.3', '25']);
});

test('routing: medication names, lab names and symptoms only in physician discussion', () => {
  const names = { medicationNames: ['Sample Statin'], labNames: ['ALT', 'Glucose'] };
  const r = report(
    [['Weekly Wins', 'Alternate days went well; altitude hike.'], ['Watch Outs', 'Glucose was mentioned; the Sample Statin dose; felt sick Tuesday.']],
    [{ topic: 'Sample Statin and ALT', detail: 'Discuss with your physician.' }],
  );
  const problems = misroutedTopics(r, names);
  assert.equal(problems.length, 3);
  assert.ok(problems.every((p) => p.includes('"Watch Outs"')), 'case-sensitive short names do not match ordinary words');
});

// ---- instructions ----
test('system prompt: fixed contract first, then the owner sections with sensitive ones included and named', () => {
  const sections = [
    { position: 1, name: 'profile', text: 'Today is {{TODAY}}.', sensitive: 0 },
    { position: 2, name: 'medical', text: 'Medical context.', sensitive: 1 },
  ];
  const { system, sensitiveSent } = buildSystem(sections, '2026-09-27');
  assert.ok(system.startsWith(CONTRACT));
  assert.ok(system.includes('Today is 2026-09-27.\n\nMedical context.'));
  assert.deepEqual(sensitiveSent, ['medical']);
});

test('rendered report: sections as headings, physician items as a final list', () => {
  const md = renderReport(report([['Weekly Wins', '- Slept well']], [{ topic: 'Lab follow-up', detail: 'Ask about it.' }]));
  assert.equal(md, '## Weekly Wins\n- Slept well\n\n## Discuss with your physician\n- **Lab follow-up**: Ask about it.\n');
});

test('summary: strength keeps only this week\'s exercises; empty metrics dropped; notes and context included', () => {
  const week = computeWeek({ daily_metrics: [{ date: '2026-09-25', hrv_ms: 50 }], workout_sessions: [], strength_sets: [
    { date: '2026-09-02', exercise: 'Old Lift', set_no: 1, weight_lbs: 100, per_hand: 0, reps: 5 },
    { date: '2026-09-24', exercise: 'Squat', set_no: 1, weight_lbs: 150, per_hand: 0, reps: 5 },
  ], drinking_days: [], checkins: [] }, { weekEnd: '2026-09-26' });
  const s = buildSummary(week, [{ date: '2026-09-24', source: 'check-in', text: 'Slept badly' }], { today: '2026-09-27' });
  assert.deepEqual(s.strength.exercises.map((e) => e.exercise), ['Squat']);
  assert.equal(s.strength.otherExercisesIn28Days, 1);
  assert.ok(s.recovery.hrv_ms && !s.recovery.steps, 'metrics with no data at all are left out');
  assert.equal(s.notes.length, 1);
  assert.ok(s.about.nullMeans.startsWith('no data (not zero)'));
  assert.equal(s.strength.exercises[0].first.topPerHandLbs, undefined, 'empty fields are dropped inside list items');
});

// ---- client ----
test('fallbacks: on for supported models via the beta endpoint, plain call otherwise', async () => {
  const calls = [];
  const sdk = { messages: { create: async (p) => calls.push(['plain', p]) }, beta: { messages: { create: async (p) => calls.push(['beta', p]) } } };
  const client = withFallbacks(sdk);
  await client.messages.create({ model: 'claude-opus-5-5' });
  await client.messages.create({ model: 'claude-haiku-4-5' });
  assert.deepEqual(calls.map(([kind, p]) => [kind, p.fallbacks ?? null, p.betas ?? null]), [
    ['beta', 'default', ['server-side-fallback-2026-07-01']],
    ['plain', null, null],
  ]);
});

// ---- the run ----
function seededStore() {
  const store = openHealthStore(':memory:');
  const { db } = store;
  const now = 'x';
  db.prepare("INSERT INTO prompt_sections (position, name, text, sensitive, updated_at) VALUES (1, 'profile', 'Coach. Today is {{TODAY}}.', 0, ?), (2, 'genetics', 'Gene notes.', 1, ?)").run(now, now);
  db.prepare("INSERT INTO daily_metrics (date, hrv_ms, updated_at) VALUES ('2026-09-22', 48, 'x'), ('2026-09-23', 50, 'x')").run();
  db.prepare("INSERT INTO medications (name, kind, created_at) VALUES ('Sample Statin', 'medication', 'x')").run();
  db.prepare("INSERT INTO checkins (date, cadence, readiness, notes, source, updated_at) VALUES ('2026-09-24', 'daily', 7, 'Long work week', 'ui', 'x')").run();
  return store;
}

const response = (r, stop = 'end_turn') => ({
  id: 'msg_test', model: 'claude-opus-5-5', stop_reason: stop,
  content: [{ type: 'text', text: JSON.stringify(r) }],
  usage: { input_tokens: 1000, output_tokens: 500 },
});

test('review: a draft breaking the rules is retried with the problems listed; the clean one is saved', async () => {
  const store = seededStore();
  const prompts = [];
  const drafts = [
    report([['Weekly Wins', 'HRV hit 99 ms — great. Keep taking Sample Statin.']]),
    report([['Weekly Wins', 'HRV averaged 49 ms over 2 days.']], [{ topic: 'Sample Statin', detail: 'Discuss timing with your physician.' }]),
  ];
  const fake = { messages: { create: async (p) => { prompts.push(p); return response(drafts[prompts.length - 1]); } } };
  const r = await runReview({ store, claude: createReviewClaude({ client: fake }), weekEnd: '2026-09-26', today: '2026-09-27', logger: silentLogger });

  assert.equal(r.attempts, 2);
  assert.deepEqual(r.warnings, []);
  const retryText = prompts[1].messages[0].content;
  assert.match(retryText, /dash in "Weekly Wins"/);
  assert.match(retryText, /numbers not in the summary: 99/);
  assert.match(retryText, /medication "Sample Statin" in "Weekly Wins"/);
  assert.match(prompts[0].system[0].text, /Gene notes\./, 'sensitive sections are sent');
  assert.equal(prompts[0].output_config.effort, 'high');
  assert.equal(prompts[0].model, 'claude-opus-5-5');

  const saved = store.db.prepare('SELECT * FROM reviews').get();
  assert.equal(saved.week_ending, '2026-09-26');
  assert.match(saved.report_md, /## Discuss with your physician\n- \*\*Sample Statin\*\*/);
  assert.equal(saved.sensitive_sections, '["genetics"]');
  assert.match(saved.summary_json, /Long work week/, 'the week\'s notes are part of the summary');

  const run = store.db.prepare("SELECT status, meta, summary FROM runs WHERE name = 'review'").get();
  assert.equal(run.status, 'ok');
  assert.deepEqual(JSON.parse(run.meta).sensitiveSections, ['genetics']);
  assert.doesNotMatch(run.meta + run.summary, /Gene notes|HRV averaged|Long work week/, 'no prompt or report text in the run record');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM run_calls").get().n, 2);
  store.close();
});

test('review: problems left after the retry are saved as warnings; dashes are stripped in code', async () => {
  const store = seededStore();
  const draft = report([['Weekly Wins', 'Slept 9.9 hours — a record.']]);
  const fake = { messages: { create: async () => response(draft) } };
  const r = await runReview({ store, claude: createReviewClaude({ client: fake }), weekEnd: '2026-09-26', today: '2026-09-27', logger: silentLogger });
  assert.deepEqual(r.warnings, ['numbers not in the summary: 9.9']);
  const saved = store.db.prepare('SELECT report_md, warnings FROM reviews').get();
  assert.doesNotMatch(saved.report_md, /—/);
  assert.deepEqual(JSON.parse(saved.warnings), ['numbers not in the summary: 9.9']);
  store.close();
});

test('review: a truncated response fails the run instead of saving half a report (v1 bug fixed)', async () => {
  const store = seededStore();
  const fake = { messages: { create: async () => response(report([['Weekly Wins', 'ok']]), 'max_tokens') } };
  await assert.rejects(runReview({ store, claude: createReviewClaude({ client: fake }), weekEnd: '2026-09-26', today: '2026-09-27', logger: silentLogger }), ClaudeTruncatedError);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM reviews').get().n, 0);
  assert.deepEqual(JSON.parse(store.db.prepare("SELECT summary FROM runs WHERE name = 'review'").get().summary), { weekEnd: '2026-09-26', error: 'ClaudeTruncatedError' });
  store.close();
});

test('dry run preparation needs no client and names the sensitive sections it would send', () => {
  const store = seededStore();
  const prep = prepareReview(store.db, { weekEnd: '2026-09-26', today: '2026-09-27' });
  assert.deepEqual(prep.sensitiveSent, ['genetics']);
  assert.deepEqual(prep.checks.medicationNames, ['Sample Statin']);
  assert.ok(prep.checks.allowed.has(48));
  store.close();
});
