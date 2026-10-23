// Health Auto Export's health metrics as JSON (Export Version 2, Time Grouping: Day): { data: { metrics: [{ name, units,
// data: [{ date, qty } | { date, Min, Avg, Max } | sleep fields]}] } }, one value per metric per day, the same daily
// values the Sheets-format export carried (checked against stored days 2026-10-23). The same JSON arrives from the Drive
// files and from the REST ingest route, so both go through here. Never logs values.
//
// Stand hours: the Day-grouped apple_stand_hour undercounts (7 against the Activity ring's 16), so it is ignored. A
// separate automation exports Apple Stand Hour grouped by hour (qty 1 for an hour with standing); each such hour is
// kept as { date, hour } and the day's stand hours are the distinct hours recorded (ingest/apply.js), because one export
// may hold only part of a day.

/** Metric name -> [column, units] for single-value metrics. */
export const HEALTH_JSON_METRICS = {
  active_energy: ['active_energy_kcal', 'kcal'],
  apple_exercise_time: ['exercise_min', 'min'],
  apple_move_time: ['move_min', 'min'],
  apple_stand_time: ['stand_min', 'min'],
  heart_rate_variability: ['hrv_ms', 'ms'],
  respiratory_rate: ['respiratory_rate', 'count/min'],
  resting_heart_rate: ['resting_hr', 'count/min'],
  step_count: ['steps', 'count'],
  vo2_max: ['vo2max', 'ml/(kg·min)'],
  cardio_recovery: ['cardio_recovery_bpm', 'count/min'],
  walking_heart_rate_average: ['walking_hr_avg', 'count/min'],
  walking_speed: ['walking_speed_mph', 'mi/hr'],
  apple_sleeping_wrist_temperature: ['wrist_temp_f', 'ºF'],
  physical_effort: ['physical_effort', 'kcal/hr·kg'],
  blood_oxygen_saturation: ['spo2_pct', '%'],
  breathing_disturbances: ['breathing_disturbances', 'count'],
  walking_asymmetry_percentage: ['walking_asymmetry_pct', '%'],
};
const HEART_RATE = { Min: 'hr_min', Avg: 'hr_avg', Max: 'hr_max' };
const SLEEP = { totalSleep: 'sleep_total_hr', asleep: 'sleep_asleep_hr', inBed: 'sleep_in_bed_hr', core: 'sleep_core_hr', deep: 'sleep_deep_hr', rem: 'sleep_rem_hr', awake: 'sleep_awake_hr' };
const WHOLE = new Set(['steps']); // stored as integers, like the Sheets import

// "2026-10-22 00:00:00 -0400": the phone's local wall clock, kept as written.
const TIME = /^(\d{4}-\d{2}-\d{2}) (\d{2}):\d{2}:\d{2}/;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * @param {object} json  a Health Auto Export health metrics payload
 * @param {{ file?: string }} [opts]  file: a name for warnings
 * @returns {{ records: object[], standHours: Array<{date: string, hour: number}>, warnings: object[] }}
 *   records: one per date with the columns found (others absent, so they never erase stored values)
 */
export function parseHealthJson(json, { file } = {}) {
  const source = 'health_json';
  const warnings = [];
  const metrics = json?.data?.metrics;
  if (!Array.isArray(metrics)) throw new Error('Health JSON has no data.metrics list (is it a Health Auto Export health metrics export, Version 2?)');
  const byDate = new Map();
  const day = (date) => {
    if (!byDate.has(date)) byDate.set(date, { date });
    return byDate.get(date);
  };
  const standHours = [];
  const warn = (kind, detail) => warnings.push({ source, tab: file, kind, ...(detail ? { detail } : {}) });

  for (const m of metrics) {
    const entries = Array.isArray(m?.data) ? m.data : [];
    const dated = entries.map((e) => ({ e, t: TIME.exec(String(e?.date ?? '')) })).filter((x) => x.t);
    if (m?.name === 'apple_stand_hour') {
      // Hour-grouped: every value is 0 or 1. Day-grouped (any value above 1) undercounts, so it is ignored.
      if (dated.some(({ e }) => num(e.qty) > 1)) continue;
      for (const { e, t } of dated) if (num(e.qty) > 0) standHours.push({ date: t[1], hour: Number(t[2]) });
      continue;
    }
    const perDay = new Map();
    for (const x of dated) perDay.set(x.t[1], (perDay.get(x.t[1]) ?? 0) + 1);
    if ([...perDay.values()].some((n) => n > 1)) { warn('not grouped by day', m.name); continue; } // set Time Grouping: Day
    if (m?.name === 'heart_rate') {
      if (m.units && m.units !== 'count/min') { warn('unexpected units', m.name); continue; }
      for (const { e, t } of dated) for (const [k, col] of Object.entries(HEART_RATE)) if (num(e[k]) !== null) day(t[1])[col] = e[k];
      continue;
    }
    if (m?.name === 'sleep_analysis') {
      if (m.units && m.units !== 'hr') { warn('unexpected units', m.name); continue; }
      for (const { e, t } of dated) for (const [k, col] of Object.entries(SLEEP)) if (num(e[k]) !== null) day(t[1])[col] = e[k];
      continue;
    }
    const known = HEALTH_JSON_METRICS[m?.name];
    if (!known) continue; // a metric the app does not store
    const [col, units] = known;
    if (m.units !== units) { warn('unexpected units', `${m.name} not in ${units}`); continue; } // never converted by guess
    for (const { e, t } of dated) {
      const v = num(e.qty);
      if (v !== null) day(t[1])[col] = WHOLE.has(col) ? Math.round(v) : v;
    }
  }
  return { records: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)), standHours, warnings };
}
