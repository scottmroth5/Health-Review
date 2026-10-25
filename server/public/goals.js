// A user's training goals (primary, and an optional secondary): what each goal puts first on the Home tiles, the
// Training and Health tabs and the Health charts, and the Next program card's default goal weights. Pure, no DOM: the
// browser imports it for the pages and the server for the review (one list of rules). A goal only reorders; every card
// and chart stays.

export const GOALS = {
  strength: 'Strength and muscle',
  cardio: 'Cardio fitness',
  weight: 'Lose weight / body composition',
  endurance: 'Endurance',
  health: 'General health',
};
export const GOAL_KEYS = Object.keys(GOALS);

// The Home tiles, in their usual order (each is a view name, its #link). Daily Check-in stays first unless moved by hand.
export const TILES = ['today', 'training', 'programs', 'health', 'meds', 'labs', 'reviews', 'prompt', 'settings', 'help', 'users', 'activity'];

// What each goal puts first. tiles: Home tiles after Daily Check-in; training and health: card ids on those tabs;
// charts: Health chart keys; weights: the Next program card's default goal weights (0 to 3; others stay 1).
const ORDER = {
  strength: { tiles: ['training', 'programs'], training: ['log-workout-card', 'program-card', 'lifts-card', 'training-card', 'advisor-card'], health: [],
    charts: ['weight_lbs', 'muscle_mass_lbs', 'body_fat_pct'], weights: { strength: 3 } },
  cardio: { tiles: ['health'], training: [], health: ['vo2-card', 'zones-card'],
    charts: ['resting_hr', 'hrv_ms', 'cardio_recovery_bpm', 'walking_hr_avg', 'exercise_min'], weights: { vo2: 3 } },
  weight: { tiles: ['health'], training: [], health: [],
    charts: ['weight_lbs', 'body_fat_pct', 'muscle_mass_lbs', 'visceral_fat', 'steps', 'exercise_min', 'alcohol'], weights: { time: 2, vo2: 2 } },
  endurance: { tiles: ['health'], training: [], health: ['zones-card', 'vo2-card'],
    charts: ['exercise_min', 'resting_hr', 'hrv_ms', 'cardio_recovery_bpm', 'walking_speed_mph'], weights: { vo2: 3 } },
  health: { tiles: ['health'], training: [], health: [],
    charts: ['sleep_total_hr', 'hrv_ms', 'resting_hr', 'steps', 'readiness', 'spo2_pct'], weights: { joint: 2, vo2: 2 } },
};

/** Checked goals: { primary, secondary } with unknown values dropped and a secondary equal to the primary removed. */
export function cleanGoals(goals = {}) {
  const primary = GOAL_KEYS.includes(goals.primary) ? goals.primary : null;
  const secondary = primary && GOAL_KEYS.includes(goals.secondary) && goals.secondary !== primary ? goals.secondary : null;
  return { primary, secondary };
}

/** A list reordered for the goals: the primary's items first, then the secondary's, then the rest as they were. */
export function orderFor(goals, list, kind) {
  const g = cleanGoals(goals);
  const first = [...new Set([...(ORDER[g.primary]?.[kind] ?? []), ...(ORDER[g.secondary]?.[kind] ?? [])])].filter((x) => list.includes(x));
  return [...first, ...list.filter((x) => !first.includes(x))];
}

/** The Home tiles' order: the user's own (unknown names dropped, newer tiles added at the end), else the goals' default. */
export function tileOrder(saved, goals) {
  if (Array.isArray(saved) && saved.length) {
    const own = [...new Set(saved.filter((t) => TILES.includes(t)))];
    return [...own, ...TILES.filter((t) => !own.includes(t))];
  }
  return ['today', ...orderFor(goals, TILES.filter((t) => t !== 'today'), 'tiles')];
}

/** The Next program card's default weights for the goals (primary's, then the secondary's where higher). */
export function goalWeights(goals) {
  const g = cleanGoals(goals);
  const w = { strength: 1, joint: 1, time: 1, vo2: 1 };
  for (const key of [g.secondary, g.primary]) for (const [k, v] of Object.entries(ORDER[key]?.weights ?? {})) w[k] = Math.max(w[k], key === g.primary ? v : Math.min(v, 2));
  return w;
}
