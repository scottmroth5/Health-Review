// Multi-user phase 5: each user's own program catalog. Building, importing and exporting programs, match words tying
// Workout Log names to them, the catalog a user gets (theirs plus a shared one), blocks confirmed in the app, and a PDF
// read by a fake Claude. Made-up programs only, never MAPS content; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openHealthStore } from '../db/store.js';
import { scopeDb } from '../db/scope.js';
import { buildApp } from '../server/app.js';
import { authSettings } from '../server/auth.js';
import { OWNER_ID } from '../db/users.js';
import { programOf, userMatchers, PROGRAMS } from '../metrics/programs.js';
import { createCatalog, mergeCatalogs, programProblems } from '../metrics/catalog.js';
import { draftToProgram, DRAFT_SCHEMA } from '../agent/extract-program.js';

const SITE = 'http://localhost:5188';
const NOW = new Date('2026-03-20T16:00:00Z');

const program = (name, over = {}) => ({
  name, weeks: 4, profile: { focus: 'Made-up strength plan', standalone: true },
  phases: [
    { name: 'Phase 1', weeks: [1, 2], workouts_per_week: 2, workouts: [{ name: 'Workout A', exercises: [{ name: 'Barbell Squat', sets: '3', reps: '5' }, { name: 'Pullups', sets: '3', reps: '6-8' }] }] },
    { name: 'Phase 2', weeks: [3, 4], workouts_per_week: 2, special_weeks: { deload: [4] }, workouts: [{ name: 'Workout A', exercises: [{ name: 'Barbell Bench Press', sets: '4', reps: '8-12' }, { name: 'Planks', sets: '3', reps: '30s' }] }] },
  ],
  ...over,
});
// A made-up shared catalog for the owner: one program with a built-in name (createCatalog checks those names).
const SHARED = createCatalog({ version: 1, programs: [{ ...program('HIIT'), profile: { focus: 'Made-up intervals', standalone: true } }] });

async function setup({ claude } = {}) {
  const settings = authSettings({ AUTH_MODE: 'google', PUBLIC_URL: SITE, GOOGLE_WEB_CLIENT_ID: 'x', GOOGLE_WEB_CLIENT_SECRET: 'y',
    AUTH_ALLOWED_EMAILS: 'owner@example.com', SESSION_SECRET: randomBytes(48).toString('base64') });
  const store = openHealthStore(':memory:');
  store.db.prepare(`INSERT INTO users (id, email, role, status, created_at, maps_shared) VALUES
    ('lee', 'lee@example.com', 'user', 'approved', 'x', 0), ('kim', 'kim@example.com', 'user', 'approved', 'x', 1)`).run();
  const access = { lee: { source: 'own', reason: null }, kim: { source: null, reason: 'no_key' } };
  const services = { claude: () => claude, aiAccess: (uid) => access[uid] ?? { source: 'owner', reason: null } };
  let email;
  let nonce;
  const app = await buildApp({ store, authMode: 'google', services, clock: () => NOW, catalog: SHARED, mailer: { send: async () => true },
    log: { info() {}, warn() {}, error() {} }, auth: { settings, exchange: async () => ({ email, email_verified: true, nonce }) } });
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
  // Workout Log days for a user: one set per day of a named workout.
  const lift = (uid, days) => {
    const db = scopeDb(store.db, uid);
    const ex = db.prepare('INSERT INTO strength_exercises (user_id, tab_year, row_no, date, workout, exercise) VALUES (@uid, 2026, ?, ?, ?, ?)');
    const set = db.prepare("INSERT INTO strength_sets (user_id, exercise_id, set_no, weight_lbs, reps, reps_text) VALUES (@uid, ?, 1, 100, 5, '5')");
    days.forEach(([date, workout], i) => set.run(ex.run(i + 2, date, workout, 'Barbell Squat').lastInsertRowid));
  };
  return { app, store, signIn, lift };
}

test('match words: a user\'s programs come before the built-in names; whole words, any case, flexible spaces', () => {
  const ms = userMatchers([{ name: 'Plan Five', match: '5x5, five by five' }, { name: 'Strong (Base)' }]);
  assert.equal(programOf('Week 2 5x5 A', ms), 'Plan Five');
  assert.equal(programOf('FIVE  BY five day 1', ms), 'Plan Five');
  assert.equal(programOf('15x5', ms), null, 'whole words only');
  assert.equal(programOf('strong (base) Phase 1', ms), 'Strong (Base)');
  assert.equal(programOf('MAPS Anabolic Phase 1', ms), 'MAPS Anabolic', 'built-in names still work');
  assert.equal(userMatchers([]), PROGRAMS);
  assert.equal(programOf('Anabolic', userMatchers([{ name: 'My Anabolic', match: 'anabolic' }])), 'My Anabolic', 'theirs win');
});

test('a user program is checked like a catalog entry, and a merged catalog puts theirs first', () => {
  assert.deepEqual(programProblems(program('Any Name At All')), []);
  const bad = program('Gappy', { weeks: 6 });
  bad.phases[1].weeks = [4, 5];
  bad.phases[0].workouts[0].exercises[0].reps = 'lots';
  const problems = programProblems(bad);
  assert.ok(problems.some((p) => /starts at week 4, expected 3/.test(p)));
  assert.ok(problems.some((p) => /reps "lots"/.test(p)));
  assert.ok(programProblems(program('x'.repeat(81))).some((p) => /80 characters/.test(p)));
  const merged = mergeCatalogs([program('HIIT', { weeks: 4 }), program('Mine')], SHARED);
  assert.deepEqual(merged.programs.map((p) => p.name), ['HIIT', 'Mine']);
  assert.equal(merged.find('HIIT').profile.focus, 'Made-up strength plan', 'their own wins a name clash');
  assert.deepEqual([...merged.own], ['HIIT', 'Mine']);
});

test('programs API: build, check, rename, delete; import all or nothing; export only their own', async () => {
  const { signIn } = await setup();
  const lee = await signIn('lee@example.com');
  const kim = await signIn('kim@example.com');
  assert.deepEqual((await lee.get('/api/programs')).json().programs, []);
  assert.deepEqual((await lee.get('/api/programs')).json().shared, [], 'not shared with lee');
  assert.deepEqual((await kim.get('/api/programs')).json().shared, ['HIIT'], 'shared with kim: names only');
  assert.ok(!JSON.stringify((await kim.get('/api/programs')).json()).includes('Made-up intervals'), 'never the shared contents');

  const bad = program('Broken');
  bad.phases[0].weeks = [2, 2];
  const refused = await lee.send('POST', '/api/programs', { program: bad });
  assert.equal(refused.statusCode, 400);
  assert.ok(refused.json().problems.length > 0);

  const made = await lee.send('POST', '/api/programs', { program: { ...program('Plan Five'), extra: 'dropped' }, match: '5x5' });
  assert.equal(made.statusCode, 200);
  const row = made.json().programs[0];
  assert.equal(row.name, 'Plan Five');
  assert.equal(row.match, '5x5');
  assert.equal(row.source, 'manual');
  assert.equal(row.program.extra, undefined, 'unknown fields dropped');
  assert.equal((await lee.send('POST', '/api/programs', { program: program('Plan Five') })).statusCode, 400, 'names are unique');
  assert.equal((await kim.get('/api/programs')).json().programs.length, 0, 'never another user\'s');

  const renamed = await lee.send('PUT', `/api/programs/${row.id}`, { program: program('Plan 5'), match: '' });
  assert.equal(renamed.json().programs[0].name, 'Plan 5');
  assert.equal(renamed.json().programs[0].match, 'Plan 5', 'no match words: the name');
  assert.equal((await kim.send('PUT', `/api/programs/${row.id}`, { program: program('Taken') })).statusCode, 400, 'another user\'s id is not theirs');
  assert.equal((await kim.send('DELETE', `/api/programs/${row.id}`)).statusCode, 404);

  // Import: one clash refuses the whole file.
  const file = { version: 1, programs: [{ ...program('Imported A'), match: 'alpha' }, program('Plan 5')] };
  const clash = await lee.send('POST', '/api/programs/import', file);
  assert.equal(clash.statusCode, 400);
  assert.match(clash.json().problems.join(' '), /Plan 5: you already have/);
  assert.equal((await lee.get('/api/programs')).json().programs.length, 1, 'nothing imported');
  const ok = await lee.send('POST', '/api/programs/import', { version: 1, programs: [file.programs[0], program('Imported B')] });
  assert.equal(ok.json().added, 2);
  assert.equal((await lee.send('POST', '/api/programs/import', program('Single'))).json().added, 1, 'one program on its own');

  const exported = (await lee.get('/api/programs/export')).json();
  assert.equal(exported.version, 1);
  assert.deepEqual(exported.programs.map((p) => p.name).sort(), ['Imported A', 'Imported B', 'Plan 5', 'Single']);
  assert.equal(exported.programs.find((p) => p.name === 'Imported A').match, 'alpha');
  assert.ok(!(await kim.get('/api/programs/export')).body.includes('HIIT'), 'a shared catalog is never exported');
  assert.equal((await lee.send('DELETE', `/api/programs/${row.id}`)).statusCode, 200);
  assert.equal((await lee.get('/api/programs')).json().programs.length, 3);
});

test('their program names their days and blocks; a confirmed block gets phases, and the Advisor ranks their programs', async () => {
  const { signIn, lift } = await setup();
  const lee = await signIn('lee@example.com');
  lift('lee', [['2026-03-02', 'Plan Five Phase 1 A'], ['2026-03-05', ''], ['2026-03-09', 'Plan Five Phase 1 A'], ['2026-03-16', 'Plan Five Phase 2 A'], ['2026-03-19', '']]);
  assert.equal((await lee.get('/api/advisor')).json().available, false, 'no catalog yet');
  const before = (await lee.get('/api/training?view=month')).json();
  assert.ok(!JSON.stringify(before.buckets).includes('Plan Five'));

  await lee.send('POST', '/api/programs', { program: program('Plan Five'), match: 'plan five' });
  const month = (await lee.get('/api/training?view=month')).json();
  assert.ok(month.buckets.some((b) => b.programs.some((p) => p.name === 'Plan Five')), 'training volume names the program');
  const blocks = (await lee.get('/api/program/blocks')).json();
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].program, 'Plan Five');
  assert.equal(blocks[0].source, 'detected');
  assert.equal((await lee.get('/api/program')).json().program, null, 'only confirmed blocks count');

  const confirmed = await lee.send('POST', `/api/program/blocks/${blocks[0].id}/confirm`);
  assert.equal(confirmed.json().blocks[0].source, 'confirmed');
  const current = (await lee.get('/api/program')).json().program;
  assert.equal(current.program, 'Plan Five');
  assert.equal(current.phase, 'Phase 2');
  assert.equal(current.program_weeks, 4);
  assert.equal((await lee.send('POST', `/api/program/blocks/${blocks[0].id}/confirm`)).statusCode, 200, 'confirming again changes nothing');

  // The Advisor ranks their catalog (the program run last is left out, as for the owner).
  await lee.send('POST', '/api/programs', { program: program('Plan Six') });
  const advisor = (await lee.get('/api/advisor')).json();
  assert.equal(advisor.available, true);
  assert.deepEqual(advisor.ranking.map((r) => r.program), ['Plan Six']);
});

test('PDF: Claude drafts with the user\'s AI; nothing is saved, the file is never kept; refused without the right or AI', async () => {
  const draft = { name: 'Paper Plan', weeks: 4, focus: 'Made-up plan', notes: ['Week 5 bonus workout left out'], phases: [
    { name: 'Phase 1', first_week: 1, last_week: 2, workouts_per_week: 3, deload_weeks: [], failure_weeks: [], workouts: [{ name: 'Day 1', exercises: [{ name: 'Barbell Squat', sets: '3', reps: '5' }, { name: 'Planks', sets: '', reps: '30s' }] }] },
    { name: 'Phase 2', first_week: 3, last_week: 4, workouts_per_week: 0, deload_weeks: [4], failure_weeks: [], workouts: [] },
  ] };
  const calls = [];
  const claude = { send: async (opts) => { calls.push(opts); return { data: draft, model: opts.model, text: JSON.stringify(draft) }; } };
  const { store, signIn } = await setup({ claude });
  const lee = await signIn('lee@example.com');
  const kim = await signIn('kim@example.com');
  const pdf = Buffer.from('%PDF-1.4 made-up test file').toString('base64');

  assert.equal((await lee.send('POST', '/api/programs/extract', { pdf, rightToUse: false })).statusCode, 400);
  assert.equal((await lee.send('POST', '/api/programs/extract', { pdf: Buffer.from('not a pdf at all').toString('base64'), rightToUse: true })).statusCode, 400);
  const noAi = await kim.send('POST', '/api/programs/extract', { pdf, rightToUse: true });
  assert.equal(noAi.statusCode, 503);
  assert.equal(noAi.json().aiReason, 'no_key');
  assert.equal(calls.length, 0);

  const res = await lee.send('POST', '/api/programs/extract', { pdf, rightToUse: true, filename: 'plan.pdf' });
  assert.equal(res.statusCode, 200);
  const r = res.json();
  assert.equal(r.program.name, 'Paper Plan');
  assert.deepEqual(r.program.phases[0].weeks, [1, 2]);
  assert.deepEqual(r.program.phases[0].workouts[0].exercises[1], { name: 'Planks', reps: '30s' }, 'blank sets left out');
  assert.deepEqual(r.program.phases[1].special_weeks, { deload: [4], failure: [] });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.notes, ['Week 5 bonus workout left out']);
  assert.equal(calls[0].messages[0].content[0].type, 'document');
  assert.equal(calls[0].schema, DRAFT_SCHEMA);
  assert.equal((await lee.get('/api/programs')).json().programs.length, 0, 'nothing saved');
  const runRow = store.db.prepare("SELECT * FROM runs WHERE name = 'program-extract'").get();
  assert.equal(runRow.user_id, 'lee');
  assert.ok(!JSON.stringify(runRow).includes('made-up test file'), 'the file is not in the run record');

  // Saving the checked draft keeps its source.
  const saved = await lee.send('POST', '/api/programs', { program: r.program, source: 'pdf' });
  assert.equal(saved.json().programs[0].source, 'pdf');
});

test('draftToProgram fills the catalog format from the schema\'s shape', () => {
  const p = draftToProgram({ name: ' X ', weeks: 2, focus: '', notes: [], phases: [{ name: 'Phase 1', first_week: 1, last_week: 2, workouts_per_week: 2, deload_weeks: [], failure_weeks: [], workouts: [] }] });
  assert.equal(p.name, 'X');
  assert.equal(p.profile, undefined);
  assert.deepEqual(p.phases, [{ name: 'Phase 1', weeks: [1, 2], workouts_per_week: 2, workouts: [] }]);
  assert.deepEqual(programProblems(p), []);
});

test('the owner keeps the MAPS file and can add programs of their own', async () => {
  const { signIn } = await setup();
  const owner = await signIn('owner@example.com');
  assert.deepEqual((await owner.get('/api/programs')).json().shared, ['HIIT']);
  await owner.send('POST', '/api/programs', { program: program('Owner Extra') });
  const v = (await owner.get('/api/programs')).json();
  assert.deepEqual(v.programs.map((r) => r.name), ['Owner Extra']);
  assert.deepEqual(v.shared, ['HIIT']);
  assert.ok(OWNER_ID);
});
