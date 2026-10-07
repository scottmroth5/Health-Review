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
import { repoPath } from '../tools/paths.js';

export const DEMO_DB_PATH = repoPath('data', 'demo', 'demo.db');
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

// Program runs, in days before today: [program, start offset, weeks run, lift trend over the run, VO2 change over the run].
const RUNS = [
  ['Sample Hypertrophy', 455, 10, 1.04, -0.3],
  ['Sample Strength', 379, 12, 1.09, -0.4],
  ['Sample Conditioning', 289, 8, 0.98, 2.2],
  ['Sample Hypertrophy', 227, 7, 1.03, 0.1],
  ['Sample Strength', 158, 12, 1.06, -0.2],
  ['Sample Balance', 66, 10, 1.01, 0.6],
];
// Starting loads (lb) for the primary lifts; pull-ups are bodyweight reps.
const LOADS = { 'Barbell Squat': 205, 'Barbell Bench Press': 165, 'Barbell Deadlift': 255, 'Barbell Z Press': 85 };
const ACCESSORY_LOADS = { 'Dumbbell Row': 50, 'Dumbbell Curls': 25, 'Dumbbell Skull Crushers': 20, 'Dumbbell Lateral Raises': 15,
  'Kettlebell Swings': 44, 'Goblet Squats': 45, 'Dumbbell Walking Lunges': 30, 'Dumbbell Bulgarian Split Squat': 30,
  'Single Arm Dumbbell Row': 55, 'Single Leg Standing Calf Raises': 25, 'Single Leg Dumbbell Romanian Deadlifts': 35, 'Circus Press': 40 };
const PER_HAND = new Set(['Dumbbell Curls', 'Dumbbell Lateral Raises', 'Dumbbell Walking Lunges', 'Dumbbell Bulgarian Split Squat', 'Single Leg Dumbbell Romanian Deadlifts']);
const BODYWEIGHT = new Set(['Pullups', 'Push-Up', 'Box Jumps', 'Bird Dog', 'Planks']);

/** Reps for a prescription like "8-12", "5" or "30s": a value in the range ({ seconds } for timed sets). */
function repsFor(text, r) {
  const timed = /s$/.test(text);
  const [lo, hi] = text.replace(/s$/, '').split('-').map(Number);
  const v = r.int(lo, hi ?? lo);
  return timed ? { seconds: v } : { reps: v };
}

/** Writes the made-up data into an empty store. */
export function generateDemo(store, { today, seed = DEFAULT_SEED, catalog = loadDemoCatalog(), dictionary = loadDictionary() }) {
  const { db } = store;
  const r = random(seed);
  const stamp = `${today}T12:00:00.000Z`;
  const first = addDays(today, -460);
  const days = [];
  for (let d = first; d < today; d = addDays(d, 1)) days.push(d);

  // ---- Workout Log, one row per exercise, sets below; lifting Mon, Wed, Fri during each run ----
  const insertEx = db.prepare('INSERT INTO strength_exercises (tab_year, row_no, date, workout, exercise, comment) VALUES (?, ?, ?, ?, ?, ?)');
  const insertSet = db.prepare(`INSERT INTO strength_sets (exercise_id, set_no, weight_text, weight_lbs, per_hand, band, bodyweight, reps_text, reps, duration_sec, distance_yd)
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL)`);
  const liftDays = new Map(); // date -> program
  const level = { ...LOADS, Pullups: 7 };
  const vo2Path = []; // [date, change] steps at run ends, for the daily VO2 trend
  let row = 1;
  for (const [program, startOffset, weeksRun, liftTrend, vo2Change] of RUNS) {
    const p = catalog.find(program);
    const start = addDays(today, -startOffset);
    const end = addDays(start, weeksRun * 7 - 1);
    vo2Path.push([start, end, vo2Change]);
    const startLevel = { ...level };
    let session = 0;
    for (let d = start; d <= end && d < today; d = addDays(d, 1)) {
      if (![1, 3, 5].includes(dow(d)) || r.next() < 0.08) continue; // the odd missed day
      const week = Math.floor(daysBetween(start, d) / 7) + 1;
      const phase = p.phases.find((ph) => week >= ph.weeks[0] && week <= ph.weeks[1]);
      const workout = phase.workouts[session % phase.workouts.length];
      session += 1;
      const progress = daysBetween(start, d) / (weeksRun * 7);
      const factor = 1 + (liftTrend - 1) * progress;
      liftDays.set(d, program);
      workout.exercises.forEach((ex, i) => {
        const name = ex.name;
        const id = insertEx.run(Number(d.slice(0, 4)), row++, d, i === 0 ? `${program} ${phase.name} ${workout.name}` : null, name, null).lastInsertRowid;
        const sets = Number(String(ex.sets).split('-').pop());
        for (let s = 1; s <= sets; s++) {
          const rep = repsFor(ex.reps, r);
          if (name === 'Pullups') {
            const reps = clamp(Math.round(startLevel.Pullups * factor + r.normal(0, 0.7)), 3, 15);
            insertSet.run(id, s, 'BW', null, 0, 1, String(reps), reps, null);
          } else if (BODYWEIGHT.has(name)) {
            insertSet.run(id, s, 'BW', null, 0, 1, rep.seconds ? `${rep.seconds} seconds` : String(rep.reps), rep.reps ?? null, rep.seconds ?? null);
          } else {
            // Heavier for fewer reps: about 3% more load per rep below 10.
            const base = LOADS[name] ? startLevel[name] * factor : ACCESSORY_LOADS[name] ?? 30;
            const load = LOADS[name] ? to5(base * (1 + 0.03 * (10 - rep.reps))) : to5(base);
            const perHand = PER_HAND.has(name);
            insertSet.run(id, s, String(load), load, perHand ? 1 : 0, 0, String(rep.reps), rep.reps, null);
          }
        }
      });
    }
    for (const k of Object.keys(LOADS)) level[k] = startLevel[k] * liftTrend;
    level.Pullups = startLevel.Pullups * liftTrend;
  }
  // A recent stall on the bench and a slip on the deadlift, so Lift progress shows more than one status.
  db.prepare(`UPDATE strength_sets SET weight_lbs = weight_lbs - 15, weight_text = CAST(weight_lbs - 15 AS INTEGER) WHERE exercise_id IN (
    SELECT id FROM strength_exercises WHERE exercise = 'Barbell Deadlift' AND date >= ?)`).run(addDays(today, -40));
  db.prepare(`UPDATE strength_sets SET weight_lbs = weight_lbs - 5, weight_text = CAST(weight_lbs - 5 AS INTEGER) WHERE exercise_id IN (
    SELECT id FROM strength_exercises WHERE exercise = 'Barbell Bench Press' AND date >= ?)`).run(addDays(today, -40));
  db.prepare('INSERT INTO workout_log_notes (tab_year, row_no, date, text) VALUES (?, ?, ?, ?)')
    .run(Number(addDays(today, -170).slice(0, 4)), row++, addDays(today, -170), 'Sample note: travel week, no gym');

  // ---- Apple Health days: trends plus noise; a planted gap (9 days ago) and partial day (6 days ago) ----
  const insertDay = db.prepare(`INSERT INTO daily_metrics (date, active_energy_kcal, exercise_min, move_min, stand_hours, hrv_ms, respiratory_rate, resting_hr,
    sleep_total_hr, sleep_asleep_hr, sleep_in_bed_hr, sleep_core_hr, sleep_deep_hr, sleep_rem_hr, sleep_awake_hr, steps, vo2max, updated_at)
    VALUES (@date, @active, @exercise, @move, @stand, @hrv, @resp, @rhr, @sleep, @sleep, @inBed, @core, @deep, @rem, @awake, @steps, @vo2, @stamp)`);
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
    });
  }

  // ---- Apple Watch workouts: lifting days and walks ----
  const insertSession = db.prepare(`INSERT INTO workout_sessions (type, start, end, duration_sec, active_energy_kcal, avg_hr, max_hr, distance_mi, step_count, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const at = (d, h, m) => `${d}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
  for (const d of days) {
    if (d === addDays(today, -9)) continue;
    const program = liftDays.get(d);
    if (program) {
      const conditioning = program === 'Sample Conditioning';
      const minutes = conditioning ? r.int(26, 34) : r.int(52, 72);
      const startMin = 17 * 60 + r.int(0, 60);
      insertSession.run(conditioning ? 'High Intensity Interval Training' : 'Traditional Strength Training', at(d, Math.floor(startMin / 60), startMin % 60),
        at(d, Math.floor((startMin + minutes) / 60), (startMin + minutes) % 60), minutes * 60 - r.int(0, 50), minutes * (conditioning ? 10 : 6),
        conditioning ? r.int(138, 152) : r.int(104, 118), conditioning ? r.int(170, 182) : r.int(140, 158), null, null, stamp);
    }
    if (r.next() < 0.55) {
      const minutes = r.int(24, 48);
      const startMin = 7 * 60 + r.int(0, 90);
      insertSession.run('Outdoor Walk', at(d, Math.floor(startMin / 60), startMin % 60), at(d, Math.floor((startMin + minutes) / 60), (startMin + minutes) % 60),
        minutes * 60 - r.int(0, 40), minutes * 5, r.int(95, 112), r.int(118, 135), round(minutes / 19, 2), minutes * 110, stamp);
    }
  }

  // ---- Check-ins (most days), a weight trend, a few drink days ----
  const insertCheckin = db.prepare(`INSERT INTO checkins (date, cadence, readiness, energy, mood, stress, nutrition, weight_lbs, body_measured_on, notes, source, updated_at)
    VALUES (?, 'daily', ?, ?, ?, ?, ?, ?, ?, ?, 'ui', ?)`);
  const notes = ['Sample note: busy day at work.', 'Sample note: slept well.', 'Sample note: long walk with the dog.', null, null, null, null];
  for (const d of days.slice(-200)) {
    if (r.next() < 0.18) continue;
    const weight = d.endsWith('5') || d.endsWith('0') ? round(188 - daysBetween(days.at(-200), d) * 0.025 + r.normal(0, 0.8), 1) : null;
    insertCheckin.run(d, r.int(5, 9), r.int(5, 9), r.int(6, 9), r.int(2, 7), r.int(5, 9), weight, weight ? d : null, r.pick(notes), stamp);
  }
  const insertDrink = db.prepare("INSERT INTO drinking_days (date, beers, wine, bourbon, other, cbd, setting, mood_before, mood_after, notes, source, updated_at) VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?, NULL, 'ui', ?)");
  for (const d of days.slice(-120)) {
    if (dow(d) === 6 && r.next() < 0.7) insertDrink.run(d, r.int(0, 2), r.int(0, 2), r.int(0, 1), r.pick(['Dinner out', 'Home', 'Friends']), r.int(6, 8), r.int(6, 8), stamp);
  }

  // ---- Supplements only, with a dose check-off for the last 30 days ----
  const supplements = [['Sample Creatine', '5 g', ['morning']], ['Sample Vitamin D3', '2000 IU', ['morning']], ['Sample Magnesium', '200 mg', ['before_bed']], ['Sample Fish Oil', '2 capsules', ['morning']]];
  for (const [name, dose, timings] of supplements) {
    const id = db.prepare("INSERT INTO medications (name, kind, purpose, prescribed, created_at) VALUES (?, 'supplement', 'Sample purpose', 0, ?)").run(name, stamp).lastInsertRowid;
    db.prepare('INSERT INTO medication_periods (medication_id, dose, timings, started_on, created_at, start_estimated) VALUES (?, ?, ?, ?, ?, 1)')
      .run(id, dose, JSON.stringify(timings), addDays(today, -300), stamp);
    for (const d of days.slice(-30)) for (const t of timings) {
      db.prepare('INSERT INTO medication_doses (date, medication_id, timing, taken, updated_at) VALUES (?, ?, ?, ?, ?)').run(d, id, t, r.next() < 0.9 ? 1 : 0, stamp);
    }
  }

  // ---- A lab panel, two draws (values only; no reference ranges, as in the real app) ----
  const labs = [['Total Cholesterol', 'Lipid Panel', 'mg/dL', 192, 181], ['LDL Cholesterol', 'Lipid Panel', 'mg/dL', 118, 109], ['HDL Cholesterol', 'Lipid Panel', 'mg/dL', 52, 55],
    ['Triglycerides', 'Lipid Panel', 'mg/dL', 110, 96], ['Glucose', 'Metabolic Panel', 'mg/dL', 92, 90], ['Hemoglobin A1c', 'Metabolic Panel', '%', 5.4, 5.3]];
  labs.forEach(([name, panel, unit, a, b], i) => {
    const id = db.prepare('INSERT INTO lab_tests (name, panel, unit, position, created_at) VALUES (?, ?, ?, ?, ?)').run(name, panel, unit, i + 1, stamp).lastInsertRowid;
    db.prepare("INSERT INTO lab_results (test_id, drawn_on, value, value_text, source, updated_at) VALUES (?, ?, ?, ?, 'ui', ?)").run(id, addDays(today, -330), a, String(a), stamp);
    db.prepare("INSERT INTO lab_results (test_id, drawn_on, value, value_text, source, updated_at) VALUES (?, ?, ?, ?, 'ui', ?)").run(id, addDays(today, -40), b, String(b), stamp);
  });

  // ---- Prompt sections, settings, two sample reviews, a sample chat thread, a few run records ----
  const sections = [
    ['profile', 'Sample profile: a 45 year old who lifts at home three days a week and walks most days. Today is {{TODAY}}.', 0],
    ['training-notes', 'Sample notes: prefers barbell work, pauses exercises that bother a shoulder, wants better conditioning.', 0],
    ['medical', 'Sample medical section: no conditions (made-up data for the demo).', 1],
    ['rules', 'Keep the review practical and under 2,000 words.', 0],
  ];
  sections.forEach(([name, text, sensitive], i) => db.prepare('INSERT INTO prompt_sections (position, name, text, sensitive, updated_at) VALUES (?, ?, ?, ?, ?)').run(i + 1, name, text, sensitive, stamp));
  for (const [k, v] of [['zone2_low_bpm', '108'], ['zone2_high_bpm', '126']]) db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(k, v, stamp);
  const lastSaturday = addDays(today, -((dow(today) + 1) % 7 || 7));
  for (const [i, weekEnd] of [addDays(lastSaturday, -7), lastSaturday].entries()) {
    db.prepare("INSERT INTO reviews (week_ending, summary_json, report_md, created_at, model, warnings, sensitive_sections) VALUES (?, '{}', ?, ?, 'sample', NULL, '[]')")
      .run(weekEnd, `## Weekly Wins\n- **Sample review ${i + 1}.** Made-up text for the demo: three lifting sessions and four walks this week.\n\n## Recovery\nSleep and HRV held steady against the baseline.\n\n## Next Week\n- Keep the walks going; target 3 lifting sessions.\n\n## Discuss with your physician\n- **Sample item:** a placeholder to show where health topics go.`, `${weekEnd}T15:00:00.000Z`);
  }
  const insertNote = db.prepare('INSERT INTO advisor_notes (id, created_at, role, text, physician, weights, model, warnings) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)');
  insertNote.run('00000000-0000-4000-8000-000000000001', `${addDays(today, -2)}T18:00:00.000Z`, 'owner',
    'Sample note: I want more strength next, but I can only train three days a week.', null, JSON.stringify({ strength: 2, joint: 1, time: 1, vo2: 1 }), null);
  insertNote.run('00000000-0000-4000-8000-000000000002', `${addDays(today, -2)}T18:01:00.000Z`, 'claude',
    'Sample reply (made up for the demo; the chat is off here): with strength counting double, Sample Strength leads. It runs three sessions a week, so it fits your schedule.',
    JSON.stringify([]), null, 'sample');
  const insertRun = db.prepare("INSERT INTO runs (name, meta, status, started_at, finished_at, duration_ms, calls, cost_usd, summary) VALUES (?, ?, 'ok', ?, ?, ?, ?, ?, ?)");
  insertRun.run('sync', '{"backfill":false}', `${addDays(today, -1)}T12:00:00.000Z`, `${addDays(today, -1)}T12:00:05.000Z`, 5000, 0, 0, '{"counts":{"health_metrics":{"upserted":30}},"warnings":0}');
  insertRun.run('review', '{"model":"sample"}', `${lastSaturday}T15:00:00.000Z`, `${lastSaturday}T15:03:00.000Z`, 180000, 1, 0, '{"attempts":1,"warnings":0}');

  // ---- The app's own pipeline: normalize names, detect blocks (confirmed), phases from workout names ----
  normalizeAll(db, dictionary, { now: new Date(stamp) });
  writeDetected(db, detect(db, today), { now: new Date(stamp) });
  db.prepare("UPDATE program_blocks SET source = 'confirmed'").run();
  db.prepare("UPDATE log_sessions SET source = 'confirmed' WHERE source = 'detected'").run();
  refreshPhases(db, catalog);
  return {
    days: db.prepare('SELECT COUNT(*) FROM daily_metrics').pluck().get(),
    sets: db.prepare('SELECT COUNT(*) FROM strength_sets').pluck().get(),
    blocks: db.prepare('SELECT COUNT(*) FROM program_blocks').pluck().get(),
  };
}

/** Builds a fresh demo database file (replacing any old one). */
export function buildDemoDatabase({ path = DEMO_DB_PATH, today, seed = DEFAULT_SEED } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(path + suffix)) rmSync(path + suffix);
  const store = openHealthStore(path);
  try {
    return store.tx ? store.tx(() => generateDemo(store, { today, seed })) : generateDemo(store, { today, seed });
  } finally {
    store.close();
  }
}

const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : undefined; };
  const path = arg('--out') ?? DEMO_DB_PATH;
  const counts = buildDemoDatabase({ path, today: arg('--today') ?? localToday(), seed: Number(arg('--seed') ?? DEFAULT_SEED) });
  console.log(`Demo database written to ${path}: ${counts.days} health days, ${counts.sets} sets, ${counts.blocks} program blocks.`);
}
