// The demo's Workout Log: about two years of training on the MAPS-named programs of demo/catalog.json (made-up phases
// and workouts), written the way the owner logs (one row per exercise, sets below, "MAPS Anabolic Phase 2 Day B" on the
// first row of a day). It has runs back to back with between-program and home-workout stretches, one run abandoned early,
// and the last run in progress near its end (so the Program Advisor shows); deload weeks, trigger sessions, equipment
// swaps for the cable and machine slots a home gym lacks, the odd changed, skipped or added exercise and the odd name
// spelled another way (the dictionary maps them); and each main lift with its own trend, so Lift progress shows
// progressing, stalled and regressing lifts. Seeded, so the same day always gives the same log. Made-up values only.
import { addDays, daysBetween } from '../metrics/stats.js';

// Back to back, newest last: [program, weeks run, strength change over the run, VO2 max change over the run].
// Fewer weeks than the program has is a run stopped early. 'Between programs' and 'Home workouts' are named stretches.
export const RUNS = [
  ['MAPS Anabolic', 12, 1.07, 0.2],
  ['Between programs', 2, 1.0, 0],
  ['MAPS Aesthetic', 10, 1.03, -0.2],
  ['MAPS Performance', 12, 1.02, 2.4],
  ['MAPS Powerlift', 10, 1.08, -0.5],
  ['Home workouts', 3, 0.99, 0],
  ['MAPS Symmetry', 5, 1.0, 0.4],
  ['HIIT', 6, 0.99, 1.8],
  ['MAPS 15 Advanced', 8, 1.01, 0.6],
  ['MAPS Anabolic', 12, 1.05, 0.1],
  ['MAPS Aesthetic', 10, 1.03, 0],
  ['MAPS Split', 9, 1.03, -0.1],
];
// The in-progress run started this many days ago (week 9 of 10 today, near its end).
const CURRENT_RUN_DAYS = 8 * 7 + 3;

// How each program's days are named in the log (MAPS Performance is logged by its foundation name).
const LOGGED_AS = { 'MAPS Performance': 'MAPS Performance Foundation', HIIT: 'MAPS HIIT' };

// Estimated one-rep maxes (lb) at the start of the history for the main lifts; pull-ups are bodyweight reps.
const START_MAX = { 'Barbell Squat': 255, 'Barbell Bench Press': 205, 'Barbell Deadlift': 315, 'Barbell Z Press': 115,
  'Barbell Front Squat': 205, 'Incline Barbell Bench Press': 170, 'Close Grip Bench Press': 180, 'Box Squat': 235, 'Trap Bar Deadlifts': 325 };
// The last 8 weeks, so Lift progress shows each status: squat and press climbing, bench flat, deadlift slipping.
const LATE_TREND = { 'Barbell Squat': 1.05, 'Barbell Z Press': 1.04, 'Barbell Bench Press': 0.985, 'Barbell Deadlift': 0.9 };
// Working loads (lb) for everything else, rising slowly with the program's trend.
const LOADS = {
  'Barbell Row': 135, 'Pendlay Row': 135, 'Barbell Hip Thrust': 185, 'Good Mornings': 95, 'Barbell Curls': 65, 'Barbell Shrugs': 185,
  'Dumbbell Lateral Raises': 20, 'Dumbbell Walking Lunges': 35, 'Dumbbell Curls': 30, 'Incline Dumbbell Press': 60,
  'Single Arm Dumbbell Row': 70, 'Dumbbell Romanian Deadlift': 55, 'Dumbbell Skull Crushers': 25, 'Dumbbell Bulgarian Split Squat': 35,
  'Dumbbell Hammer Curls': 30, 'Chest Supported Dumbbell Row': 50, 'Dumbbell Flyes': 30, 'Standing Calf Raises': 50,
  'Dumbbell Rear Delt Flyes': 15, 'Dumbbell Shoulder Press': 50, 'Dumbbell Upright Row': 25, 'Dumbbell Supinated Curls': 30,
  'Dumbbell Chest Press': 65, 'Seated Calf Raises': 45, 'Zottman Curls': 25, 'Arnold Presses': 40, 'Goblet Squats': 60,
  'Kettlebell Swings': 53, 'Double Swings': 35, 'Turkish Get Up': 35, 'Windmill': 26, 'Dumbbell Push Press': 45,
  'Box Step Up Dumbbell': 35, 'Dumbbell Farmer Carries': 70, 'Alternating Dumbbell Chest Press': 55, 'Single-Leg Dumbbell Romanian Deadlifts': 45,
  'Seated Single-Arm Arnold Press': 35, 'Dumbbell Suitcase Carries': 60, 'One Arm Kettlebell Squat': 35, 'One Arm Kettlebell Shoulder Press': 35,
  'Single Leg Standing Calf Raises': 35, 'Front Loaded Dumbbell Squats': 45, 'Renegade Row to Push Ups': 35, 'Weighted Pull ups': 25,
  'Band Lateral Raise': 0, 'Band Tricep Pressdowns': 0, 'Band Crossover': 0, 'Band Leg Curls': 0, 'Band Rows': 0, 'Seated Single-Arm Band Row': 0,
  'Single Arm Lat Pulldowns': 0, 'Band Pull-a-parts': 0,
};
const BODYWEIGHT = new Set(['Pullups', 'Chin Ups', 'Push-Up', 'Planks', 'Box Jumps', 'Dips', 'Hanging Leg Raises', 'Tuck Jumps', 'Ice Skaters',
  'Clapping Pushup', 'Plyo Pushups', 'Alternating Jump Lunges', 'Single Leg Hip Bridges', '90/90', 'Lizard w/ Rotation', 'Combat Stretch',
  'Sprint Intervals', 'Assault Bike', 'Bodyweight Squats', 'Bodyweight Lunges']);
const BAND = new Set(Object.keys(LOADS).filter((k) => LOADS[k] === 0));
const PER_HAND = (name) => /^(Dumbbell|Alternating Dumbbell|Arnold|Zottman|Seated Single-Arm Arnold)/.test(name) && !/Skull|Romanian|Farmer|Suitcase/.test(name);
// The sample home gym has no cable or machine (demo/substitutions.json): those slots are filled like the owner fills them.
const HOME_SWAPS = { 'Cable Lateral Raises': 'Band Lateral Raise', 'Rope Tricep Pressdown': 'Band Tricep Pressdowns', 'Cable Crossover': 'Band Crossover',
  'Leg Press': 'Goblet Squats', 'Lying Leg Curls': 'Band Leg Curls', 'Cable Rows': 'Band Rows', 'Seated Single-Arm Cable Row': 'Seated Single-Arm Band Row' };
// Now and then a lift is changed for one with the same movement pattern (adherence: changed).
const CHANGES = { 'Barbell Row': 'Pendlay Row', 'Incline Dumbbell Press': 'Dumbbell Chest Press', 'Dumbbell Curls': 'Dumbbell Hammer Curls',
  'Dumbbell Walking Lunges': 'Dumbbell Bulgarian Split Squat', 'Pullups': 'Chin Ups', 'Dumbbell Lateral Raises': 'Dumbbell Upright Row' };
// Names logged another way now and then (dictionary variants, mapped back by normalization).
const SPELLED = { 'Barbell Squat': 'Squats', 'Barbell Deadlift': 'Deadlift', 'Barbell Bench Press': 'Bench Press', 'Dumbbell Lateral Raises': 'Lateral Raises' };
// What the between-program and home stretches look like (no catalog workout).
const LOOSE_DAYS = {
  'Between programs': [['Barbell Squat', 3, '5'], ['Barbell Bench Press', 3, '5'], ['Barbell Row', 3, '8'], ['Dumbbell Curls', 2, '12']],
  'Home workouts': [['Goblet Squats', 3, '15'], ['Push-Up', 3, '20'], ['Single Arm Dumbbell Row', 3, '12'], ['Kettlebell Swings', 3, '20'], ['Planks', 2, '60s']],
};
const DAYS_FOR = { 3: [1, 3, 5], 4: [1, 2, 4, 5], 5: [1, 2, 3, 4, 5] };
const dow = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
const to5 = (x) => Math.max(5, Math.round(x / 5) * 5);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** The runs laid out back to back so the last is in progress today: [{ program, start, end, weeks, trend, vo2 }]. */
export function layoutRuns(today, r) {
  const out = [];
  let start = addDays(today, -CURRENT_RUN_DAYS);
  for (let i = RUNS.length - 1; i >= 0; i--) {
    const [program, weeks, trend, vo2] = RUNS[i];
    if (i < RUNS.length - 1) start = addDays(out[0].start, -(weeks * 7) - r.int(3, 9)); // a few rest days between runs
    out.unshift({ program, weeks, trend, vo2, start, end: addDays(start, weeks * 7 - 1) });
  }
  return out;
}

/** Reps for a prescription like "8-12", "5" or "30s": a value in the range ({ seconds } for timed sets). */
function repsFor(text, r) {
  const timed = /s$/.test(text);
  const [lo, hi] = text.replace(/s$/, '').split('-').map(Number);
  const v = r.int(lo, hi ?? lo);
  return timed ? { seconds: v } : { reps: v };
}

/**
 * Writes the Workout Log (strength_exercises, strength_sets, workout_log_notes) and returns which program each lifting
 * day belongs to and the runs, for the Apple Watch workouts and the VO2 max trend.
 * @returns {{ runs: object[], liftDays: Map<string, { program: string, minutes: number }> }}
 */
export function writeTraining(db, { today, r, catalog }) {
  const runs = layoutRuns(today, r);
  const insertEx = db.prepare('INSERT INTO strength_exercises (user_id, tab_year, row_no, date, workout, exercise, comment) VALUES (@uid, ?, ?, ?, ?, ?, ?)');
  const insertSet = db.prepare(`INSERT INTO strength_sets (user_id, exercise_id, set_no, weight_text, weight_lbs, per_hand, band, bodyweight, reps_text, reps, duration_sec, distance_yd)
    VALUES (@uid, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`);
  const liftDays = new Map();
  const maxes = { ...START_MAX };
  const loads = { ...LOADS };
  const lateFrom = addDays(today, -56);
  let row = 1;
  const COMMENTS = ['Sample note: last set was a grind', 'Sample note: felt strong today', 'Sample note: short on time, cut the last exercise',
    'Sample note: new gym shoes', 'Sample note: moved this to the evening'];

  const logExercise = (d, workoutName, name, sets, reps, { deload = false, trend = 1, comment = null } = {}) => {
    const logged = SPELLED[name] && r.next() < 0.06 ? SPELLED[name] : name;
    const id = insertEx.run(Number(d.slice(0, 4)), row++, d, workoutName, logged, comment).lastInsertRowid;
    const setCount = Math.max(1, Number(String(sets).split('-').pop()) - (deload ? 1 : 0));
    for (let s = 1; s <= setCount; s++) {
      const rep = repsFor(reps, r);
      if (rep.seconds) {
        insertSet.run(id, s, 'BW', null, 0, null, 1, `${rep.seconds} seconds`, null, rep.seconds);
      } else if (BODYWEIGHT.has(name)) {
        const n = name === 'Pullups' || name === 'Chin Ups' ? clamp(Math.round(8 * trend + r.normal(0, 0.8)), 3, 16) : rep.reps;
        insertSet.run(id, s, 'BW', null, 0, null, 1, String(n), n, null);
      } else if (BAND.has(name)) {
        insertSet.run(id, s, 'Band', null, 0, r.pick(['Red', 'Black', 'Purple']), 0, String(rep.reps), rep.reps, null);
      } else {
        // Main lifts from their estimated max at the reps done (Epley); others from their working load.
        const base = maxes[name] ? maxes[name] / (1 + rep.reps / 30) : (loads[name] ?? 30) * trend;
        const load = to5(base * (deload ? 0.8 : 1) * (1 + r.normal(0, 0.012)));
        insertSet.run(id, s, String(load), load, PER_HAND(name) ? 1 : 0, null, 0, String(rep.reps), rep.reps, null);
      }
    }
  };

  for (const run of runs) {
    const p = catalog.find(run.program);
    const display = LOGGED_AS[run.program] ?? run.program;
    const startMax = { ...maxes };
    let session = 0;
    for (let d = run.start; d <= run.end && d < today; d = addDays(d, 1)) {
      const progress = daysBetween(run.start, d) / (run.weeks * 7);
      const trend = 1 + (run.trend - 1) * progress;
      for (const k of Object.keys(START_MAX)) {
        // A gain builds over the late weeks; a loss lands at once (a setback), so the recent best shows it.
        const late = LATE_TREND[k] && d >= lateFrom ? (LATE_TREND[k] < 1 ? LATE_TREND[k] : 1 + (LATE_TREND[k] - 1) * (daysBetween(lateFrom, d) / 56)) : 1;
        maxes[k] = startMax[k] * trend * late;
      }
      if (!p) {
        // Between programs and home workouts: three loose days a week.
        if (![1, 3, 5].includes(dow(d)) || r.next() < 0.15) continue;
        liftDays.set(d, { program: run.program, minutes: r.int(35, 50) });
        LOOSE_DAYS[run.program].forEach(([name, sets, reps], i) => logExercise(d, i === 0 ? (run.program === 'Home workouts' ? 'Home workout' : 'Between programs') : null, name, sets, reps, { trend }));
        continue;
      }
      const week = Math.floor(daysBetween(run.start, d) / 7) + 1;
      const phase = p.phases.find((ph) => week >= ph.weeks[0] && week <= ph.weeks[1]);
      const deload = (phase.special_weeks?.deload ?? []).includes(week);
      // Trigger sessions: a short Saturday add-on in the strength programs.
      if (dow(d) === 6 && ['MAPS Anabolic', 'MAPS Powerlift'].includes(run.program) && r.next() < 0.35) {
        liftDays.set(d, { program: run.program, minutes: r.int(12, 18) });
        logExercise(d, 'Trigger Session', 'Push-Up', 2, '15-20');
        logExercise(d, null, 'Goblet Squats', 2, '15', { trend });
        continue;
      }
      if (!DAYS_FOR[phase.workouts_per_week].includes(dow(d)) || r.next() < 0.07) continue; // the odd missed day
      const workout = phase.workouts[session % phase.workouts.length];
      session += 1;
      const minutes = run.program === 'MAPS 15 Advanced' ? r.int(15, 22) : run.program === 'HIIT' ? r.int(22, 30) : r.int(50, 75);
      liftDays.set(d, { program: run.program, minutes });
      const name = deload ? `${display} Deload ${workout.name}` : `${display} ${phase.name} ${workout.name}`;
      let first = true;
      for (const [i, ex] of workout.exercises.entries()) {
        if (i > 0 && r.next() < 0.03) continue; // an accessory skipped now and then (never the day's main lift)
        const swap = HOME_SWAPS[ex.name] ?? (CHANGES[ex.name] && r.next() < 0.06 ? CHANGES[ex.name] : ex.name);
        logExercise(d, first ? name : null, swap, ex.sets, ex.reps, { deload, trend, comment: r.next() < 0.02 ? r.pick(COMMENTS) : null });
        first = false;
      }
      if (r.next() < 0.08) logExercise(d, null, 'Band Pull-a-parts', 2, '20'); // added on top
    }
    for (const [k, v] of Object.entries(loads)) if (v) loads[k] = v * (1 + (run.trend - 1) * 0.6);
  }
  db.prepare('INSERT INTO workout_log_notes (user_id, tab_year, row_no, date, text) VALUES (@uid, ?, ?, ?, ?)')
    .run(Number(addDays(today, -170).slice(0, 4)), row++, addDays(today, -170), 'Sample note: travel week, no gym');
  return { runs, liftDays };
}
