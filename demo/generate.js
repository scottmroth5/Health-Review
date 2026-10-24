// Builds the demo instance's database from made-up data (no real values; safe to publish). Seeded, so the same seed
// and "today" always give the same data. About 15 months: Apple Health days with believable trends (and a planted gap
// and partial day for the data checks), workouts, a Workout Log across five program blocks of the made-up programs in
// demo/catalog.json (the last one in progress and near its end, so the Advisor shows), check-ins, a few drink days,
// supplements, a lab panel, prompt sections, two sample reviews, a sample chat thread and a few run records.
// The Workout Log goes through the app's own normalization, block detection and phase steps.
//   node demo/generate.js [--out data/demo/demo.db] [--today YYYY-MM-DD] [--seed N]
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openHealthStore } from '../db/store.js';
import { loadDictionary } from '../metrics/dictionary.js';
import { createCatalog } from '../metrics/catalog.js';
import { addDays, daysBetween } from '../metrics/stats.js';
import { normalizeAll } from '../ingest/normalize.js';
import { detect, writeDetected, refreshPhases } from '../ingest/program-blocks.js';
import { repoPath, dataPath } from '../tools/paths.js';
import { localDate as ownerDate } from '../tools/time.js';
import { writeTraining } from './training.js';
import { writeDemoReview } from './reviews.js';
import { computeWeek } from '../metrics/index.js';
import { loadWeekData, loadMetricSettings, loadWeekNotes, loadAdvisorInput } from '../metrics/load.js';
import { buildSummary } from '../agent/summary.js';
import { renderReport } from '../agent/instructions.js';
import { recommendPrograms } from '../metrics/advisor.js';
import { scopeDb } from '../db/scope.js';
import { OWNER_ID } from '../db/users.js';

export const DEMO_DB_PATH = dataPath('demo', 'demo.db');
export const DEMO_CATALOG_PATH = repoPath('demo', 'catalog.json');
export const DEMO_SUBSTITUTIONS_PATH = repoPath('demo', 'substitutions.json');
export const DEFAULT_SEED = 20261007;

export function loadDemoCatalog() {
  const json = JSON.parse(readFileSync(DEMO_CATALOG_PATH, 'utf8'));
  return createCatalog(json, { programs: json.programs.map((p) => p.name) });
}

/** mulberry32: a small seeded generator, so the data is the same on every build. */
function random(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = (mean, sd) => mean + sd * Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
  return { next, normal, int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)), pick: (xs) => xs[Math.floor(next() * xs.length)] };
}

const round = (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d;
const to5 = (x) => Math.round(x / 5) * 5;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const dow = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();

/** Writes the made-up data into an empty store. */
export function generateDemo(store, { today, seed = DEFAULT_SEED, catalog = loadDemoCatalog(), dictionary = loadDictionary() }) {
  // The demo's made-up data all belongs to user 1 (OWNER_ID), the only user in a demo database.
  const db = scopeDb(store.db, OWNER_ID);
  const r = random(seed);
  const stamp = `${today}T12:00:00.000Z`;
  // ---- Workout Log: about two years on the MAPS-named programs (demo/training.js) ----
  const { runs, liftDays } = writeTraining(db, { today, r, catalog });
  const first = addDays(runs[0].start, -28);
  const days = [];
  for (let d = first; d < today; d = addDays(d, 1)) days.push(d);
  const vo2Path = runs.map((run) => [run.start, run.end, run.vo2]); // [start, end, change] at each run, for the daily VO2 trend

  // ---- Apple Health days: trends plus noise; a planted gap (9 days ago) and partial day (6 days ago) ----
  const insertDay = db.prepare(`INSERT INTO daily_metrics (user_id, date, active_energy_kcal, exercise_min, move_min, stand_hours, hrv_ms, respiratory_rate, resting_hr,
    sleep_total_hr, sleep_asleep_hr, sleep_in_bed_hr, sleep_core_hr, sleep_deep_hr, sleep_rem_hr, sleep_awake_hr, steps, vo2max,
    cardio_recovery_bpm, walking_hr_avg, walking_speed_mph, hr_min, hr_max, hr_avg, wrist_temp_f, physical_effort, spo2_pct, breathing_disturbances,
    walking_asymmetry_pct, updated_at)
    VALUES (@uid, @date, @active, @exercise, @move, @stand, @hrv, @resp, @rhr, @sleep, @sleep, @inBed, @core, @deep, @rem, @awake, @steps, @vo2,
    @cardioRecovery, @walkingHr, @walkingSpeed, @hrMin, @hrMax, @hrAvg, @wristTemp, @effort, @spo2, @breathing, @asymmetry, @stamp)`);
  const r3 = random(seed + 2); // walking asymmetry (added later still): its own stream too
  // The metrics added 2026-10-15 draw from their own stream, so every value generated before them stays the same.
  const r2 = random(seed + 1);
  const extra = (rhr) => ({
    cardioRecovery: round(clamp(r2.normal(24, 3), 14, 38), 1), walkingHr: Math.round(clamp(r2.normal(rhr + 42, 4), 80, 125)),
    walkingSpeed: round(clamp(r2.normal(3.1, 0.15), 2.5, 3.8), 2), hrMin: Math.round(rhr - 4), hrMax: Math.round(clamp(r2.normal(138, 12), 105, 175)),
    hrAvg: Math.round(clamp(r2.normal(rhr + 16, 3), 60, 95)), wristTemp: round(r2.normal(96.4, 0.35), 2), effort: round(clamp(r2.normal(1.7, 0.3), 1, 3), 1),
    spo2: round(clamp(r2.normal(96, 0.8), 92, 99), 1), breathing: round(clamp(r2.normal(2, 1.2), 0, 8), 1),
    asymmetry: round(clamp(r3.normal(3.5, 1.2), 0, 12), 1),
  });
  const vo2At = (d) => {
    let v = 40.5;
    for (const [s, e, change] of vo2Path) {
      if (d >= e) v += change;
      else if (d > s) v += change * (daysBetween(s, d) / daysBetween(s, e));
    }
    return v;
  };
  for (const d of days) {
    if (d === addDays(today, -9)) continue;
    const lifting = liftDays.has(d);
    const weekend = [0, 6].includes(dow(d));
    const sleep = round(clamp(r.normal(weekend ? 7.6 : 7.0, 0.6), 4.5, 9.5), 2);
    const steps = d === addDays(today, -6) ? 620 : Math.round(clamp(r.normal(weekend ? 10500 : 8200, 2300) + (lifting ? 800 : 0), 2500, 19000));
    const exercise = Math.round(clamp((lifting ? 55 : 15) + r.normal(0, 12) + steps / 1500, 2, 140));
    insertDay.run({
      date: d, active: Math.round(350 + steps * 0.04 + (lifting ? 250 : 0)), exercise, move: exercise + 20, stand: r.int(10, 15),
      hrv: round(clamp(r.normal(46 + (sleep - 7) * 3, 7), 22, 90), 1), resp: round(r.normal(14.5, 0.6), 1),
      rhr: round(clamp(r.normal(56 - (vo2At(d) - 40.5) * 0.6, 2.2), 46, 70), 1),
      sleep, inBed: round(sleep + 0.4, 2), core: round(sleep * 0.55, 2), deep: round(sleep * 0.16, 2), rem: round(sleep * 0.22, 2), awake: round(sleep * 0.07, 2),
      steps, vo2: daysBetween(first, d) % 5 === 0 ? round(vo2At(d) + r.normal(0, 0.25), 1) : null, stamp,
      ...extra(56 - (vo2At(d) - 40.5) * 0.6),
    });
  }

  // ---- Apple Watch workouts: lifting days and walks ----
  const insertSession = db.prepare(`INSERT INTO workout_sessions (user_id, type, start, end, duration_sec, active_energy_kcal, avg_hr, max_hr, distance_mi, step_count, updated_at)
    VALUES (@uid, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const at = (d, h, m) => `${d}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
  const r7 = random(seed + 6);
  for (const d of days) {
    if (d === addDays(today, -9)) continue;
    const lift = liftDays.get(d);
    if (lift) {
      const conditioning = lift.program === 'HIIT';
      const minutes = lift.minutes;
      const startMin = 17 * 60 + r.int(0, 60);
      const type = conditioning ? 'High Intensity Interval Training' : lift.program === 'MAPS Performance' ? 'Functional Strength Training' : 'Traditional Strength Training';
      insertSession.run(type, at(d, Math.floor(startMin / 60), startMin % 60),
        at(d, Math.floor((startMin + minutes) / 60), (startMin + minutes) % 60), minutes * 60 - r.int(0, 50), minutes * (conditioning ? 10 : 6),
        conditioning ? r.int(138, 152) : r.int(104, 118), conditioning ? r.int(170, 182) : r.int(140, 158), null, null, stamp);
    }
    if (r.next() < 0.55) {
      const minutes = r.int(24, 48);
      const startMin = 7 * 60 + r.int(0, 90);
      insertSession.run('Outdoor Walk', at(d, Math.floor(startMin / 60), startMin % 60), at(d, Math.floor((startMin + minutes) / 60), (startMin + minutes) % 60),
        minutes * 60 - r.int(0, 40), minutes * 5, r.int(95, 112), r.int(118, 135), round(minutes / 19, 2), minutes * 110, stamp);
    }
    // Other cardio from its own stream (added later, so the walks above stay the same): weekend runs and rides, an
    // elliptical now and then; together with the walks and HIIT they reach every heart rate zone.
    const extraCardio = [[6, 0.35, 'Outdoor Run', 25, 45, 138, 162, 9], [0, 0.4, 'Indoor Cycling', 30, 50, 118, 145, 0], [3, 0.15, 'Elliptical', 20, 35, 112, 132, 0]];
    for (const [weekday, chance, type, lo, hi, hrLo, hrHi, pace] of extraCardio) {
      if (dow(d) !== weekday || r7.next() >= chance) continue;
      const minutes = r7.int(lo, hi);
      const startMin = 9 * 60 + r7.int(0, 120);
      const avg = r7.int(hrLo, hrHi);
      insertSession.run(type, at(d, Math.floor(startMin / 60), startMin % 60), at(d, Math.floor((startMin + minutes) / 60), (startMin + minutes) % 60),
        minutes * 60 - r7.int(0, 40), minutes * (pace ? 11 : 8), avg, avg + r7.int(12, 22), pace ? round(minutes / pace, 2) : null, pace ? minutes * 160 : null, stamp);
    }
  }

  // Per-minute heart rate (the JSON workout export) for cardio workouts in the last 120 days, from its own stream so
  // nothing above changes; older workouts have none (the tile shows them as no detail), and a few minutes drop out.
  const r5 = random(seed + 4);
  const insertHr = db.prepare('INSERT INTO workout_hr_samples (user_id, type, start, t, avg_bpm, min_bpm, max_bpm) VALUES (@uid, ?, ?, ?, ?, ?, ?)');
  const cardioRows = db.prepare(`SELECT type, start, duration_sec, avg_hr FROM workout_sessions
    WHERE user_id = @uid AND type IN ('Outdoor Walk', 'High Intensity Interval Training', 'Outdoor Run', 'Indoor Cycling', 'Elliptical') AND start >= ?`).all(addDays(today, -120));
  for (const s of cardioRows) {
    const minutes = Math.round(s.duration_sec / 60);
    const t0 = Date.parse(`${s.start}Z`);
    for (let i = 0; i < minutes; i++) {
      if (r5.next() < 0.04) continue; // the watch missed a reading
      const hiit = s.type === 'High Intensity Interval Training';
      const bpm = Math.round(hiit ? s.avg_hr + (i % 4 < 2 ? 14 : -12) + r5.normal(0, 4) : s.avg_hr + 8 * Math.sin(i / 6) + r5.normal(0, 3));
      insertHr.run(s.type, s.start, new Date(t0 + i * 60000).toISOString().slice(0, 16), bpm, bpm - r5.int(1, 4), bpm + r5.int(1, 4));
    }
  }

  // ---- Check-ins (most days), a weight trend, a few drink days ----
  const insertCheckin = db.prepare(`INSERT INTO checkins (user_id, date, cadence, readiness, energy, mood, stress, nutrition, weight_lbs, body_measured_on, notes, source, updated_at)
    VALUES (@uid, ?, 'daily', ?, ?, ?, ?, ?, ?, ?, ?, 'ui', ?)`);
  const notes = ['Sample note: busy day at work.', 'Sample note: slept well.', 'Sample note: long walk with the dog.', null, null, null, null];
  for (const d of days.slice(-200)) {
    if (r.next() < 0.18) continue;
    const weight = d.endsWith('5') || d.endsWith('0') ? round(188 - daysBetween(days.at(-200), d) * 0.025 + r.normal(0, 0.8), 1) : null;
    insertCheckin.run(d, r.int(5, 9), r.int(5, 9), r.int(6, 9), r.int(2, 7), r.int(5, 9), weight, weight ? d : null, r.pick(notes), stamp);
  }
  // Body composition on the weigh-in days, from its own stream (added later, so nothing above changes).
  const r4 = random(seed + 3);
  const weighIns = db.prepare('SELECT date, weight_lbs FROM checkins WHERE user_id = @uid AND weight_lbs IS NOT NULL ORDER BY date').all();
  const setBody = db.prepare('UPDATE checkins SET body_fat_pct = ?, muscle_mass_lbs = ?, visceral_fat = ? WHERE user_id = @uid AND date = ?');
  weighIns.forEach((w, i) => {
    const fat = round(21.5 - i * 0.04 + r4.normal(0, 0.4), 1);
    setBody.run(fat, round(w.weight_lbs * (1 - fat / 100) * 0.55 + r4.normal(0, 0.5), 1), Math.round(9 - i * 0.02 + r4.normal(0, 0.4)), w.date);
  });
  const insertDrink = db.prepare("INSERT INTO drinking_days (user_id, date, beers, wine, bourbon, other, cbd, setting, mood_before, mood_after, notes, source, updated_at) VALUES (@uid, ?, ?, ?, 0, 0, ?, ?, ?, ?, NULL, 'ui', ?)");
  // Most days logged for 200 days (its own stream): drinks mostly on Friday and Saturday, alcohol-free days logged as
  // zeros (a logged day with none is a real alcohol-free day; an unlogged one is unknown), a CBD drink now and then.
  const r8 = random(seed + 7);
  for (const d of days.slice(-200)) {
    if (r8.next() < 0.2) continue;
    const weekend = [5, 6].includes(dow(d));
    const drinking = weekend ? r8.next() < 0.65 : r8.next() < 0.12;
    const beers = drinking ? r8.int(0, 2) : 0;
    const wine = drinking ? r8.int(beers ? 0 : 1, 2) : 0;
    insertDrink.run(d, beers, wine, r8.next() < 0.08 ? 1 : 0, drinking ? r8.pick(['Dinner out', 'Home', 'Friends', 'Game night']) : null,
      drinking ? r8.int(6, 8) : null, drinking ? r8.int(6, 8) : null, stamp);
  }

  // ---- Supplements only, with a dose check-off for the last 30 days ----
  const supplements = [['Sample Creatine', '5 g', ['morning']], ['Sample Vitamin D3', '2000 IU', ['morning']], ['Sample Magnesium', '200 mg', ['before_bed']], ['Sample Fish Oil', '2 capsules', ['morning']]];
  for (const [name, dose, timings] of supplements) {
    const id = db.prepare("INSERT INTO medications (user_id, name, kind, purpose, prescribed, created_at) VALUES (@uid, ?, 'supplement', 'Sample purpose', 0, ?)").run(name, stamp).lastInsertRowid;
    db.prepare('INSERT INTO medication_periods (user_id, medication_id, dose, timings, started_on, created_at, start_estimated) VALUES (@uid, ?, ?, ?, ?, ?, 1)')
      .run(id, dose, JSON.stringify(timings), addDays(today, -300), stamp);
    for (const d of days.slice(-30)) for (const t of timings) {
      db.prepare('INSERT INTO medication_doses (user_id, date, medication_id, timing, taken, updated_at) VALUES (@uid, ?, ?, ?, ?, ?)').run(d, id, t, r.next() < 0.9 ? 1 : 0, stamp);
    }
  }

  // ---- Today as a morning: the check-in and morning supplements logged, no Apple Health day yet (its own stream) ----
  const r6 = random(seed + 5);
  insertCheckin.run(today, r6.int(6, 9), r6.int(6, 9), r6.int(6, 9), r6.int(2, 5), r6.int(6, 9), null, null, 'Sample note: logged this morning.', stamp);
  for (const { id } of db.prepare("SELECT m.id FROM medications m JOIN medication_periods p ON p.medication_id = m.id AND p.user_id = m.user_id WHERE m.user_id = @uid AND p.timings LIKE '%morning%'").all()) {
    db.prepare("INSERT INTO medication_doses (user_id, date, medication_id, timing, taken, updated_at) VALUES (@uid, ?, ?, 'morning', 1, ?)").run(today, id, stamp);
  }

  // ---- A lab panel, two draws (their typical ranges come from config/lab-ranges.json, as in the real app) ----
  const labs = [['Total Cholesterol', 'Lipid Panel', 'mg/dL', 192, 181], ['LDL Cholesterol', 'Lipid Panel', 'mg/dL', 118, 109], ['HDL Cholesterol', 'Lipid Panel', 'mg/dL', 52, 55],
    ['Triglycerides', 'Lipid Panel', 'mg/dL', 110, 96], ['Glucose', 'Metabolic Panel', 'mg/dL', 92, 90], ['Hemoglobin A1c', 'Metabolic Panel', '%', 5.4, 5.3]];
  labs.forEach(([name, panel, unit, a, b], i) => {
    const id = db.prepare('INSERT INTO lab_tests (user_id, name, panel, unit, position, created_at) VALUES (@uid, ?, ?, ?, ?, ?)').run(name, panel, unit, i + 1, stamp).lastInsertRowid;
    db.prepare("INSERT INTO lab_results (user_id, test_id, drawn_on, value, value_text, source, updated_at) VALUES (@uid, ?, ?, ?, ?, 'ui', ?)").run(id, addDays(today, -330), a, String(a), stamp);
    db.prepare("INSERT INTO lab_results (user_id, test_id, drawn_on, value, value_text, source, updated_at) VALUES (@uid, ?, ?, ?, ?, 'ui', ?)").run(id, addDays(today, -40), b, String(b), stamp);
  });

  // ---- Prompt sections, settings, two sample reviews, a sample chat thread, a few run records ----
  const sections = [
    ['profile', 'Sample profile: a 45 year old who lifts at home three days a week and walks most days. Today is {{TODAY}}.', 0],
    ['training-notes', 'Sample notes: prefers barbell work, pauses exercises that bother a shoulder, wants better conditioning.', 0],
    ['medical', 'Sample medical section: no conditions (made-up data for the demo).', 1],
    ['rules', 'Keep the review practical and under 2,000 words.', 0],
  ];
  sections.forEach(([name, text, sensitive], i) => db.prepare('INSERT INTO prompt_sections (user_id, position, name, text, sensitive, updated_at) VALUES (@uid, ?, ?, ?, ?, ?)').run(i + 1, name, text, sensitive, stamp));
  // A made-up profile for the age-based targets (born 1975, male, 5 ft 10 in).
  // demo_built_for: the day this data was made for (server/index.js refreshes it when the owner's date moves on).
  for (const [k, v] of [['zone2_low_bpm', '108'], ['zone2_high_bpm', '126'], ['birth_year', '1975'], ['sex', 'male'], ['height_in', '70'], ['demo_built_for', today]]) db.prepare('INSERT INTO settings (user_id, key, value, updated_at) VALUES (@uid, ?, ?, ?)').run(k, v, stamp);
  // ---- Run records for the Activity tab: daily syncs and nightly backups for two weeks, the monthly restore test ----
  const insertRun = db.prepare("INSERT INTO runs (user_id, name, meta, status, started_at, finished_at, duration_ms, calls, cost_usd, summary) VALUES (@uid, ?, ?, 'ok', ?, ?, ?, ?, ?, ?)");
  for (let i = 14; i >= 1; i--) {
    const d = addDays(today, -i);
    insertRun.run('sync', '{"backfill":false}', `${d}T11:00:00.000Z`, `${d}T11:00:04.000Z`, 4000, 0, 0, '{"counts":{"workout_log":{"tabsRead":1,"tabsReplaced":1}},"warnings":0}');
    insertRun.run('backup', '{"to":"google-drive"}', `${d}T03:00:00.000Z`, `${d}T03:00:09.000Z`, 9000, 0, 0, '{"name":"health-sample.hrbk","bytes":1840000}');
  }
  insertRun.run('restore-test', '{"from":"google-drive"}', `${addDays(today, -((Number(today.slice(8, 10)) || 1) - 1))}T09:00:00.000Z`, null, 6000, 0, 0, '{"ok":true,"tables":27,"problems":[]}');

  // ---- The app's own pipeline: normalize names, detect blocks (confirmed), phases from workout names ----
  normalizeAll(db, dictionary, { now: new Date(stamp) });
  writeDetected(db, detect(db, today), { now: new Date(stamp) });
  db.prepare("UPDATE program_blocks SET source = 'confirmed' WHERE user_id = @uid").run();
  db.prepare("UPDATE log_sessions SET source = 'confirmed' WHERE user_id = @uid AND source = 'detected'").run();
  refreshPhases(db, catalog);

  // ---- Weekly reviews: the last 26 weeks, each written in code from that week's real summary (demo/reviews.js) ----
  const substitutions = JSON.parse(readFileSync(DEMO_SUBSTITUTIONS_PATH, 'utf8'));
  const settings = loadMetricSettings(db);
  const lastSaturday = addDays(today, -((dow(today) + 1) % 7 || 7));
  const insertReview = db.prepare(`INSERT INTO reviews (user_id, week_ending, summary_json, report_md, created_at, model, warnings, sensitive_sections)
    VALUES (@uid, ?, ?, ?, ?, 'sample', '[]', '[]')`);
  for (let k = 25; k >= 0; k--) {
    const weekEnd = addDays(lastSaturday, -7 * k);
    const written = `${addDays(weekEnd, 1)}T13:02:00.000Z`;
    const week = computeWeek(loadWeekData(db, weekEnd, { catalog, dictionary, substitutions }), { weekEnd, ...settings });
    const summary = buildSummary(week, loadWeekNotes(db, weekEnd), { today: addDays(weekEnd, 1) });
    insertReview.run(weekEnd, JSON.stringify(summary), renderReport(writeDemoReview(summary)), written);
    insertRun.run('review', JSON.stringify({ weekEnd, model: 'sample' }), `${addDays(weekEnd, 1)}T12:00:00.000Z`, written, 122000, 1, 0.34, '{"attempts":1,"warnings":0}');
  }

  // ---- The Next program chat: a short made-up thread about the Advisor's actual ranking (the chat is off in the demo) ----
  const ranked = recommendPrograms({ ...loadAdvisorInput(db, today, catalog), programs: catalog.programs, lookup: dictionary.lookup, substitutions }).ranking.map((x) => x.program);
  const [top1, top2, top3] = [ranked[0] ?? 'the top program', ranked[1] ?? 'the second', ranked[2] ?? 'the third'];
  const insertNote = db.prepare('INSERT INTO advisor_notes (user_id, id, created_at, role, text, physician, weights, model, warnings) VALUES (@uid, ?, ?, ?, ?, ?, ?, ?, NULL)');
  const thread = [
    ['owner', 'Sample note: my current block ends in a couple of weeks. What should I run next? I want to keep my strength and get my cardio up.', { strength: 2, joint: 1, time: 1, vo2: 2 }],
    ['claude', `Sample reply: with strength and VO2 max counting double, ${top1} leads, then ${top2} and ${top3}. ${top1} keeps heavy work in every phase and adds conditioning days, which fits both goals.`],
    ['owner', 'Sample note: my deadlift has been slipping lately. Does that change anything?', null],
    ['claude', `Sample reply: the Advisor already sees the deadlift as regressing. ${top1} starts with lighter hinge work in its first phase, a good chance to rebuild before pushing load again.`],
    ['owner', 'Sample note: I can only train four days a week, about an hour each.', { strength: 2, joint: 1, time: 2, vo2: 2 }],
    ['claude', `Sample reply: counting time double, ${top1} still fits at three main sessions a week; ${top2} asks for a bit more time across the week.`],
    ['owner', 'Sample note: what about my shoulders? Overhead pressing bothers them some weeks.', null],
    ['claude', `Sample reply: the Advisor scores joint health from one-side work and mobility; ${top3} has the most of both. You can also pause an exercise on the Training tab so it counts against programs that lean on it.`],
  ];
  thread.forEach(([role, text, weights], i) => insertNote.run(`00000000-0000-4000-8000-0000000000${String(i + 1).padStart(2, '0')}`,
    `${addDays(today, -3)}T18:${String(i * 2).padStart(2, '0')}:00.000Z`, role, text, role === 'claude' ? '[]' : null, weights ? JSON.stringify(weights) : null, role === 'claude' ? 'sample' : null));

  return {
    days: db.prepare('SELECT COUNT(*) FROM daily_metrics WHERE user_id = @uid').pluck().get(),
    sets: db.prepare('SELECT COUNT(*) FROM strength_sets WHERE user_id = @uid').pluck().get(),
    blocks: db.prepare('SELECT COUNT(*) FROM program_blocks WHERE user_id = @uid').pluck().get(),
  };
}

/** Builds a fresh demo database file (replacing any old one). */
export function buildDemoDatabase({ path = DEMO_DB_PATH, today = ownerDate(), seed = DEFAULT_SEED } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(path + suffix)) rmSync(path + suffix);
  const store = openHealthStore(path);
  try {
    return store.tx ? store.tx(() => generateDemo(store, { today, seed })) : generateDemo(store, { today, seed });
  } finally {
    store.close();
  }
}

/**
 * Makes the made-up data again in an open demo store, for a new today: every table emptied (schema_migrations kept;
 * the migrations seed no rows), then generateDemo, all in one transaction, so a request never sees half-built data
 * and the result equals a fresh build. The demo server runs this when the owner's date moves on.
 */
export function refreshDemoDatabase(store, { today = ownerDate(), seed = DEFAULT_SEED } = {}) {
  const { db } = store;
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migrations', 'users')").pluck().all();
  return store.tx(() => {
    db.pragma('defer_foreign_keys = ON');
    for (const t of tables) db.prepare(`DELETE FROM "${t}"`).run();
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").get()) db.prepare('DELETE FROM sqlite_sequence').run();
    return generateDemo(store, { today, seed });
  });
}

/** The day the stored demo data was made for, or null (a database from before demo_built_for, or not a demo one). */
export function demoBuiltFor(store) {
  try {
    return scopeDb(store.db, OWNER_ID).prepare("SELECT value FROM settings WHERE user_id = @uid AND key = 'demo_built_for'").pluck().get() ?? null;
  } catch {
    return null;
  }
}

const localToday = () => ownerDate(); // the owner's date (OWNER_TZ), whatever the host's zone

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : undefined; };
  const path = arg('--out') ?? DEMO_DB_PATH;
  const counts = buildDemoDatabase({ path, today: arg('--today') ?? localToday(), seed: Number(arg('--seed') ?? DEFAULT_SEED) });
  console.log(`Demo database written to ${path}: ${counts.days} health days, ${counts.sets} sets, ${counts.blocks} program blocks.`);
}
