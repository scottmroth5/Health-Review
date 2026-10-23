// All SQL behind the UI API. Routes validate input with JSON schemas before calling these.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { localDate as ownerDate, zonedParts } from '../tools/time.js';
import { buildInstructions, WEEKLY_INCLUDES_SENSITIVE } from '../agent/prompts.js';
import { medicationEvents, eventImpact, doseText, ingredientsOf, weeklyCheckoffs } from '../metrics/medications.js';
import { loadAdherenceInput, loadConfirmedBlocks, loadAdvisorInput, loadDataCheckInput, loadMedications, loadMetricSettings, loadPrimarySets, loadProfile, loadSessionPhases, loadStrengthSets } from '../metrics/load.js';
import { cardioZones, zoneBounds, zoneBuckets } from '../metrics/zones.js';
import { trainingView } from '../metrics/volume.js';
import { vo2maxReport } from '../metrics/vo2max.js';
import { liftProgress } from '../metrics/plateau.js';
import { addDays, lastWeekEnd } from '../metrics/stats.js';
import { recommendPrograms } from '../metrics/advisor.js';
import { blockAdherence } from '../metrics/adherence.js';
import { dataChecks, partialDays, weekDataQuality } from '../metrics/dataquality.js';
import { effectiveRange, rangeStatus, typicalRange } from '../metrics/labs.js';

export const SCALE_FIELDS = ['readiness', 'energy', 'mood', 'stress', 'nutrition'];
export const BODY_FIELDS = ['weight_lbs', 'body_fat_pct', 'muscle_mass_lbs', 'visceral_fat'];
export const ALCOHOL_FIELDS = ['beers', 'wine', 'bourbon', 'other'];
export const DRINK_COUNT_FIELDS = [...ALCOHOL_FIELDS, 'cbd'];

const now = () => new Date().toISOString();
const alcoholOf = (d) => ALCOHOL_FIELDS.reduce((sum, f) => sum + (d[f] ?? 0), 0);

/** 'YYYY-MM-DD' for a real calendar date. */
export function isValidDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const d = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text;
}

/** The owner's calendar date (OWNER_TZ, tools/time.js) of a Date as 'YYYY-MM-DD', whatever the host's zone. */
export const localDate = (date = new Date()) => ownerDate(date);

// ---- one day ----

export function getDay(db, date) {
  const checkin = db.prepare('SELECT * FROM checkins WHERE date = ?').get(date) ?? null;
  const drinking = db.prepare('SELECT * FROM drinking_days WHERE date = ?').get(date) ?? null;
  return { date, checkin, drinking: drinking && { ...drinking, alcohol: alcoholOf(drinking) }, medications: dayMedications(db, date) };
}

/** Saves the day's check-in from the UI (daily cadence). Body fields mark the day as measured. */
export function saveCheckin(db, date, body) {
  const row = { date, notes: body.notes?.trim() || null };
  for (const f of [...SCALE_FIELDS, ...BODY_FIELDS]) row[f] = body[f] ?? null;
  row.body_measured_on = BODY_FIELDS.some((f) => row[f] !== null) ? date : null;
  const cols = [...SCALE_FIELDS, ...BODY_FIELDS, 'body_measured_on', 'notes'];
  db.prepare(`INSERT INTO checkins (date, cadence, ${cols.join(', ')}, source, updated_at)
    VALUES (@date, 'daily', ${cols.map((c) => `@${c}`).join(', ')}, 'ui', @updated_at)
    ON CONFLICT (date) DO UPDATE SET cadence = 'daily', ${cols.map((c) => `${c} = excluded.${c}`).join(', ')},
      source = 'ui', updated_at = excluded.updated_at`).run({ ...row, updated_at: now() });
  return getDay(db, date).checkin;
}

/** Saves the day's drinks from the UI. All zeros is a deliberate no-drink day. */
export function saveDrinking(db, date, body) {
  const row = { date, setting: body.setting?.trim() || null, notes: body.notes?.trim() || null };
  for (const f of DRINK_COUNT_FIELDS) row[f] = body[f] ?? 0;
  row.mood_before = body.mood_before ?? null;
  row.mood_after = body.mood_after ?? null;
  const cols = [...DRINK_COUNT_FIELDS, 'setting', 'mood_before', 'mood_after', 'notes'];
  db.prepare(`INSERT INTO drinking_days (date, ${cols.join(', ')}, source, updated_at)
    VALUES (@date, ${cols.map((c) => `@${c}`).join(', ')}, 'ui', @updated_at)
    ON CONFLICT (date) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(', ')},
      source = 'ui', updated_at = excluded.updated_at`).run({ ...row, updated_at: now() });
  return getDay(db, date).drinking;
}

export const deleteCheckin = (db, date) => db.prepare('DELETE FROM checkins WHERE date = ?').run(date).changes;
export const deleteDrinking = (db, date) => db.prepare('DELETE FROM drinking_days WHERE date = ?').run(date).changes;

// ---- history ----

export function history(db, from, to) {
  // Partial Apple Health days in the range, by the data checks' rule (exported before the day ended, else low steps).
  const steps = db.prepare('SELECT date, steps, exported_through FROM daily_metrics WHERE date BETWEEN ? AND ? ORDER BY date').all(addDays(from, -28), to);
  return {
    partialDays: partialDays(steps, from, to),
    metrics: db.prepare(`SELECT date, hrv_ms, resting_hr, sleep_total_hr, steps, exercise_min, cardio_recovery_bpm, walking_hr_avg,
      walking_speed_mph, walking_asymmetry_pct, wrist_temp_f, spo2_pct, breathing_disturbances FROM daily_metrics
      WHERE date BETWEEN ? AND ? ORDER BY date`).all(from, to),
    checkins: db.prepare(`SELECT date, cadence, readiness, energy, mood, stress, nutrition, weight_lbs, body_fat_pct, muscle_mass_lbs, visceral_fat FROM checkins
      WHERE date BETWEEN ? AND ? ORDER BY date`).all(from, to),
    drinking: db.prepare(`SELECT date, ${DRINK_COUNT_FIELDS.join(', ')} FROM drinking_days WHERE date BETWEEN ? AND ? ORDER BY date`)
      .all(from, to)
      .map((d) => ({ date: d.date, alcohol: alcoholOf(d), cbd: d.cbd })),
  };
}

export function listReviews(db) {
  return db.prepare('SELECT week_ending, report_md, created_at, model, warnings FROM reviews ORDER BY week_ending DESC').all()
    .map((r) => ({ ...r, warnings: r.warnings ? JSON.parse(r.warnings) : [] }));
}

// ---- activity: runs recorded by the tracer and the scheduled tasks' logs (metadata only by the hard rules) ----
const parseJson = (text) => { try { return text ? JSON.parse(text) : null; } catch { return null; } };
const RUN_COLUMNS = 'id, name, status, started_at, finished_at, duration_ms, calls, errors, input_tokens, output_tokens, cost_usd';

/** Recent runs, newest first. */
export function listRuns(db, limit = 100) {
  return db.prepare(`SELECT ${RUN_COLUMNS} FROM runs ORDER BY id DESC LIMIT ?`).all(limit);
}

/** One run with its parsed meta and summary and its Claude calls, or null. */
export function getRun(db, id) {
  const run = db.prepare(`SELECT ${RUN_COLUMNS}, cache_read_tokens, cache_write_tokens, meta, summary FROM runs WHERE id = ?`).get(id);
  if (!run) return null;
  return {
    ...run,
    meta: parseJson(run.meta),
    summary: parseJson(run.summary),
    calls: db.prepare(`SELECT id, label, model, stop_reason, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      cost_usd, duration_ms, error_name, error_message, created_at FROM run_calls WHERE run_id = ? ORDER BY id`).all(id),
  };
}

/** The scheduled jobs the Activity tab follows (their runs are recorded by the tracer, so no log file is needed). */
export const JOB_NAMES = ['sync', 'review', 'backup', 'restore-test'];

/**
 * Each scheduled job's last runs, and the last Health Auto Export posts (ingest_log), newest first. Metadata only:
 * status, times and counts, never report, prompt or health text.
 */
export function jobsActivity(db, { runs = 5, posts = 20 } = {}) {
  const last = db.prepare('SELECT id, status, started_at, finished_at, duration_ms, summary FROM runs WHERE name = ? ORDER BY id DESC LIMIT ?');
  return {
    jobs: JOB_NAMES.map((name) => ({ name, runs: last.all(name, runs).map((r) => ({ ...r, summary: parseJson(r.summary) })) })),
    ingest: db.prepare('SELECT received_at, route, result, counts, error FROM ingest_log ORDER BY received_at DESC LIMIT ?').all(posts)
      .map((r) => ({ ...r, counts: parseJson(r.counts) })),
  };
}

export function lastSync(db) {
  const run = db.prepare("SELECT status, started_at, finished_at, summary FROM runs WHERE name = 'sync' ORDER BY id DESC LIMIT 1").get();
  return run ? { ...run, summary: run.summary ? JSON.parse(run.summary) : null } : null;
}

/** Data check warnings as of today (info findings, such as a lifting day without a watch workout, stay in the sync log). */
export function dataCheckWarnings(db, today, { apple = 'drive', now = new Date() } = {}) {
  return dataChecks(loadDataCheckInput(db, today, { apple, now })).filter((c) => c.severity === 'warn').map(({ kind, dates, message }) => ({ kind, dates, message }));
}

// ---- called for vs logged ----

/**
 * Called for vs logged for one confirmed block (default: in progress, else the latest started), with the confirmed
 * blocks whose program is in the catalog for the picker. { available: false } without a catalog; null for an unknown block.
 */
export function programAdherence(db, today, { catalog, dictionary, substitutions, blockId }) {
  if (!catalog) return { available: false };
  const blocks = loadConfirmedBlocks(db).filter((b) => catalog.find(b.program));
  const block = blockId ? blocks.find((b) => b.id === blockId) : blocks.find((b) => b.status === 'in_progress') ?? blocks[0];
  if (blockId && !block) return null;
  const list = blocks.map(({ id, program, start_date, end_date, status }) => ({ id, program, start_date, end_date, status }));
  if (!block) return { available: true, blocks: list, block: null };
  const result = blockAdherence({ days: loadAdherenceInput(db, block.id, today), program: catalog.find(block.program), lookup: dictionary.lookup, substitutions });
  return { available: true, blocks: list, block: list.find((b) => b.id === block.id), ...result };
}

// ---- spend ----

const SPEND_KINDS = { review: 'reviews', 'advisor-chat': 'chat' };
const emptySpend = () => ({ reviews: 0, chat: 0, evals: 0, other: 0, total: 0 });
const cents = (v) => Math.round(v * 100) / 100;

/** Priced usage rows of the review eval: { month, usd, priced } per results row, dated by the results file's last write. */
export function evalSpendRows(evalDir, price) {
  if (!evalDir || !existsSync(evalDir)) return [];
  const rows = [];
  for (const variant of readdirSync(evalDir, { withFileTypes: true })) {
    const file = join(evalDir, variant.name, 'results.jsonl');
    if (!variant.isDirectory() || !existsSync(file)) continue;
    const month = localDate(statSync(file).mtime).slice(0, 7);
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      // Only the billed model and token counts are read; the rows' other fields are never used.
      for (const usage of [row.usage, row.judge_usage].filter(Boolean)) {
        const usd = price(row.model, usage);
        rows.push({ month, usd: usd ?? 0, priced: usd !== null });
      }
    }
  }
  return rows;
}

/**
 * Claude API spend by month and year: reviews and the Next program chat from the tracer's runs (cost_usd), and the
 * review eval priced from its saved token counts. Estimates at list prices.
 * @param {{ evalDir?: string, price?: (model: string, usage: object) => number|null, today: string }} options
 */
export function spend(db, { evalDir, price, today }) {
  const months = new Map();
  const add = (month, kind, usd) => {
    if (!months.has(month)) months.set(month, emptySpend());
    const m = months.get(month);
    m[kind] += usd;
    m.total += usd;
  };
  // started_at is UTC; each run counts in the owner's month (a run at 9pm on the 31st in New York is that month).
  const runs = db.prepare('SELECT name, started_at, cost_usd AS usd FROM runs WHERE cost_usd > 0').all();
  for (const r of runs) add(localDate(new Date(r.started_at)).slice(0, 7), SPEND_KINDS[r.name] ?? 'other', r.usd);
  let unpriced = 0;
  for (const e of price ? evalSpendRows(evalDir, price) : []) {
    if (!e.priced) unpriced += 1;
    else add(e.month, 'evals', e.usd);
  }

  const round = (s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, cents(v)]));
  const years = new Map();
  for (const [month, s] of months) {
    const y = years.get(month.slice(0, 4)) ?? emptySpend();
    for (const k of Object.keys(s)) y[k] += s[k];
    years.set(month.slice(0, 4), y);
  }
  const thisMonth = today.slice(0, 7);
  const last12 = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1 - i, 1));
    const month = d.toISOString().slice(0, 7);
    last12.push({ month, ...round(months.get(month) ?? emptySpend()) });
  }
  const all = [...months.values()].reduce((sum, s) => sum + s.total, 0);
  return {
    thisMonth: cents(months.get(thisMonth)?.total ?? 0),
    thisYear: cents(years.get(today.slice(0, 4))?.total ?? 0),
    allTime: cents(all),
    months: last12.reverse(),
    years: [...years].sort(([a], [b]) => b.localeCompare(a)).map(([year, s]) => ({ year, ...round(s) })),
    unpricedEvalRows: unpriced,
  };
}

/** The hour on the Sunday after a review week from which a missing review counts as overdue (the task runs at 8). */
export const REVIEW_DUE_HOUR = 9;

/**
 * Whether last week's review exists, and whether its Apple Health data is complete enough to write it: every day of
 * the week has a row and none looks like a partial export. Shared by npm run review (the gate) and the Reviews notice.
 * Dates only, never values.
 * @param {Date} now  local clock, for overdue (no review, and a run was tried or it is past 9am on the Sunday after)
 */
export function reviewStatus(db, today, now = new Date()) {
  const weekEnd = lastWeekEnd(today);
  const weekFrom = addDays(weekEnd, -6);
  const daily = db.prepare('SELECT date, steps, exported_through FROM daily_metrics WHERE date BETWEEN ? AND ? ORDER BY date').all(addDays(weekFrom, -28), weekEnd);
  const { missingDays, suspectedPartialDays } = weekDataQuality(daily, weekFrom, weekEnd);
  const saved = db.prepare('SELECT summary_json FROM reviews WHERE week_ending = ?').get(weekEnd);
  const hasReview = !!saved;
  // The saved summary carries dataQuality only when the review was written with missing or partial days.
  let gaps = null;
  try { gaps = saved ? JSON.parse(saved.summary_json).dataQuality ?? null : null; } catch { gaps = null; }
  const writtenWithGaps = gaps ? { missingDays: gaps.missingDays ?? [], partialDays: gaps.suspectedPartialDays ?? [] } : null;
  const run = db.prepare(`SELECT status, started_at, finished_at, summary FROM runs
    WHERE name = 'review' AND json_extract(meta, '$.weekEnd') = ? ORDER BY id DESC LIMIT 1`).get(weekEnd);
  const lastRun = run ? { ...run, summary: run.summary ? JSON.parse(run.summary) : null } : null;
  const due = today > addDays(weekEnd, 1) || zonedParts(now).hour >= REVIEW_DUE_HOUR;
  return {
    weekEnd,
    hasReview,
    lastRun,
    missingDays,
    partialDays: suspectedPartialDays,
    ready: !missingDays.length && !suspectedPartialDays.length,
    overdue: !hasReview && (!!lastRun || due),
    writtenWithGaps,
    // Written while days were missing or partial, and the week is complete now: offer to write it again.
    rewriteAvailable: !!writtenWithGaps && !missingDays.length && !suspectedPartialDays.length,
  };
}

// ---- settings ----

export const SETTING_KEYS = ['zone2_low_bpm', 'zone2_high_bpm'];

export function getSettings(db) {
  const rows = db.prepare(`SELECT key, value FROM settings WHERE key IN (${SETTING_KEYS.map(() => '?').join(', ')})`).all(...SETTING_KEYS);
  const values = Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]));
  return Object.fromEntries(SETTING_KEYS.map((k) => [k, values[k] ?? null]));
}

/** Sets the given keys; null removes a setting. */
export function saveSettings(db, changes) {
  const upsert = db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
  const remove = db.prepare('DELETE FROM settings WHERE key = ?');
  db.transaction(() => {
    for (const [k, v] of Object.entries(changes)) (v === null ? remove.run(k) : upsert.run(k, String(v), now()));
  })();
  return getSettings(db);
}

// ---- training volume ----

/** The training dashboard for one view (week, month, year, all), ending today. Planned future sets are excluded. */
export function trainingDashboard(db, view, today) {
  // Enough history for the view and its previous period; 'all' reads everything.
  const back = { week: 14, month: 60, year: 371 * 2, '2y': 31 * 48, '5y': 31 * 120 }[view];
  const from = back ? addDays(today, -back) : '0000-01-01';
  return trainingView(loadStrengthSets(db, from, today), view, today);
}

/** Plateau status of every primary lift as of today, with 26 weeks of trend points (Training tab). */
export function lifts(db, today) {
  return liftProgress(loadPrimarySets(db, today), today, { phases: new Map(Object.entries(loadSessionPhases(db))) });
}

/** The VO2 max card for one view. Reads every reading: the tiles (best on record, change vs a year ago) need them all. */
export function vo2max(db, view, today) {
  const rows = db.prepare('SELECT date, vo2max FROM daily_metrics WHERE vo2max IS NOT NULL AND date <= ? ORDER BY date').all(today);
  return vo2maxReport(rows, view, today);
}

/**
 * Health tab: ranges of the cardio minutes by heart rate zone card, each grouped by day, Sunday-to-Saturday week or
 * calendar month; group defaults to days for 30 and 90 days and weeks for a year.
 */
export const CARDIO_ZONE_VIEWS = { '30d': { days: 30, weeks: 5, group: 'day' }, '90d': { days: 90, weeks: 13, group: 'day' }, '1y': { days: 365, weeks: 52, group: 'week' } };
export const CARDIO_ZONE_GROUPS = ['day', 'week', 'month'];

/** Cardio minutes by heart rate zone for one range and grouping, with the zone bounds (null without a Zone 2 range or birth year). */
export function cardioZoneView(db, view, today, group = CARDIO_ZONE_VIEWS[view].group) {
  const v = CARDIO_ZONE_VIEWS[view];
  const buckets = zoneBuckets(today, group === 'day' ? { days: v.days } : group === 'week' ? { weeks: v.weeks } : { monthsOver: v.days });
  const from = buckets[0].from;
  const to = buckets.at(-1).to;
  const { zone2 } = loadMetricSettings(db);
  const bounds = zoneBounds({ zone2Low: zone2?.low, zone2High: zone2?.high, birthYear: loadProfile(db, today).birthYear, year: Number(today.slice(0, 4)) });
  const sessions = db.prepare('SELECT type, start, end, duration_sec FROM workout_sessions WHERE start >= ? AND start < ? ORDER BY start')
    .all(from, `${addDays(to, 1)}`);
  const samples = db.prepare('SELECT type, start, avg_bpm FROM workout_hr_samples WHERE start >= ? AND start < ?').all(from, `${addDays(to, 1)}`);
  return { view, bucket: group, bounds, buckets: cardioZones({ sessions, samples, bounds, buckets }) };
}

/** The Program Advisor's ranking as of today (Training tab); available false without the MAPS catalog. */
export function advisor(db, today, { catalog, dictionary, substitutions, weights }) {
  if (!catalog) return { available: false };
  return {
    available: true,
    ...recommendPrograms({ ...loadAdvisorInput(db, today, catalog), programs: catalog.programs, lookup: dictionary.lookup, substitutions, weights }),
  };
}

// ---- medications and supplements ----
// Each dose or timing period is a row; stopped_on is the first day it no longer applied.

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const asPeriod = (p) => ({ ...p, timings: JSON.parse(p.timings), ingredients: ingredientsOf(p), start_estimated: Boolean(p.start_estimated) });

/**
 * A period's dose or ingredients from a request: trimmed, ingredients as JSON (null when none). An item has one dose or
 * a list of ingredients, never both, and an ingredient name appears once.
 */
function regimenOf({ dose, ingredients }) {
  const list = (ingredients ?? []).map((i) => ({ name: i.name.trim(), dose: i.dose?.trim() || null })).filter((i) => i.name);
  const single = dose?.trim() || null;
  if (list.length && single) throw fail(400, 'Give one dose or a list of ingredients, not both');
  const names = new Set(list.map((i) => i.name.toLowerCase()));
  if (names.size !== list.length) throw fail(400, 'Each ingredient can be listed once');
  return { dose: single, ingredients: list.length ? JSON.stringify(list) : null };
}
const openPeriod = (db, id) => db.prepare('SELECT * FROM medication_periods WHERE medication_id = ? AND stopped_on IS NULL').get(id);

function getMedication(db, id) {
  const m = db.prepare('SELECT id, name, kind, purpose, prescribed, notes, created_at FROM medications WHERE id = ?').get(id);
  if (!m) return null;
  const periods = db.prepare('SELECT * FROM medication_periods WHERE medication_id = ? ORDER BY started_on, id').all(id).map(asPeriod);
  return { ...m, prescribed: Boolean(m.prescribed), current: periods.find((p) => p.stopped_on === null) ?? null, periods };
}

function requireMedication(db, id) {
  const m = getMedication(db, id);
  if (!m) throw fail(404, 'Medication not found');
  return m;
}

/** Current ones first (by name), then stopped ones (most recently stopped first). */
export function listMedications(db) {
  const all = db.prepare('SELECT id FROM medications').all().map((r) => getMedication(db, r.id));
  const lastStop = (m) => m.periods.reduce((d, p) => (p.stopped_on > d ? p.stopped_on : d), '');
  return [
    ...all.filter((m) => m.current).sort((a, b) => a.name.localeCompare(b.name)),
    ...all.filter((m) => !m.current).sort((a, b) => lastStop(b).localeCompare(lastStop(a)) || a.name.localeCompare(b.name)),
  ];
}

/** Throws unless [start, stop) fits around the medication's existing periods. */
function assertNoOverlap(db, id, start, stop) {
  const periods = db.prepare('SELECT started_on, stopped_on FROM medication_periods WHERE medication_id = ?').all(id);
  const clash = periods.find((p) => start < (p.stopped_on ?? '9999-12-31') && p.started_on < (stop ?? '9999-12-31'));
  if (clash) throw fail(409, `Those dates overlap an existing period that started ${clash.started_on}`);
}

function insertPeriod(db, id, { dose, ingredients, timings, started_on, stopped_on = null, stop_reason = null, start_estimated = false }) {
  const r = regimenOf({ dose, ingredients });
  db.prepare(`INSERT INTO medication_periods (medication_id, dose, ingredients, timings, started_on, stopped_on, stop_reason, start_estimated, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, r.dose, r.ingredients, JSON.stringify(timings), started_on, stopped_on, stop_reason?.trim() || null, start_estimated ? 1 : 0, now());
}

// ---- daily check-off ----

/**
 * Medications in effect on a date, each with its timing slots and what was saved for that day. A slot can carry a
 * one-day adjustment: dose (what was taken instead of defaultDose) and movedTo (the slot it was taken in instead of
 * its scheduled timing); null means the default.
 */
export function dayMedications(db, date) {
  const rows = db.prepare(`SELECT m.id, m.name, m.kind, p.dose, p.ingredients, p.timings FROM medication_periods p JOIN medications m ON m.id = p.medication_id
    WHERE p.started_on <= ? AND (p.stopped_on IS NULL OR p.stopped_on > ?) ORDER BY m.kind, m.name`).all(date, date);
  const saved = db.prepare('SELECT medication_id, timing, taken, dose, moved_to FROM medication_doses WHERE date = ?').all(date);
  const savedOf = (id, timing) => saved.find((s) => s.medication_id === id && s.timing === timing);
  return {
    saved: saved.length > 0,
    items: rows.map((r) => ({
      id: r.id, name: r.name, kind: r.kind, dose: r.dose, ingredients: ingredientsOf(r),
      slots: JSON.parse(r.timings).map((t) => {
        const s = savedOf(r.id, t);
        return { timing: t, taken: s === undefined ? null : Boolean(s.taken), dose: s?.dose ?? null, defaultDose: doseText(r), movedTo: s?.moved_to ?? null };
      }),
    })),
  };
}

/**
 * Saves the day's check-off: every listed slot is recorded taken or not, replacing what was saved before. Each slot
 * must belong to a medication in effect that day. An optional dose or moved_to adjusts that slot for this day only; a
 * value equal to the default is stored as no adjustment.
 */
export function saveDoses(db, date, doses) {
  const day = dayMedications(db, date);
  const expected = new Map(day.items.flatMap((m) => m.slots.map((s) => [`${m.id}|${s.timing}`, m])));
  for (const d of doses) {
    if (!expected.has(`${d.medication_id}|${d.timing}`)) throw fail(400, 'One of the checked items is not in effect on that day');
  }
  db.transaction(() => {
    db.prepare('DELETE FROM medication_doses WHERE date = ?').run(date);
    const ins = db.prepare('INSERT INTO medication_doses (date, medication_id, timing, taken, updated_at, dose, moved_to) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const d of doses) {
      const item = expected.get(`${d.medication_id}|${d.timing}`);
      const dose = d.dose?.trim() || null;
      const adjustedDose = dose && dose !== (doseText(item) ?? '').trim() ? dose : null;
      const movedTo = d.moved_to && d.moved_to !== d.timing ? d.moved_to : null;
      ins.run(date, d.medication_id, d.timing, d.taken ? 1 : 0, now(), adjustedDose, movedTo);
    }
  })();
  return dayMedications(db, date);
}

export const clearDoses = (db, date) => db.prepare('DELETE FROM medication_doses WHERE date = ?').run(date).changes;

/**
 * Adds a medication, or a new period for one that is not currently taken. A stopped_on date
 * records a past course. Adding a name that is currently taken is a conflict.
 */
export function addMedication(db, body) {
  if (body.stopped_on && body.stopped_on < body.started_on) throw fail(400, 'The stop date cannot be before the start date');
  return db.transaction(() => {
    const existing = db.prepare('SELECT id FROM medications WHERE name = ?').get(body.name.trim());
    let id = existing?.id;
    if (id) {
      if (openPeriod(db, id) && !body.stopped_on) throw fail(409, `${body.name.trim()} is already in your current list; use Change instead`);
      assertNoOverlap(db, id, body.started_on, body.stopped_on ?? null);
      const sets = ['kind', 'purpose', 'prescribed', 'notes'].filter((k) => body[k] !== undefined);
      if (sets.length) {
        db.prepare(`UPDATE medications SET ${sets.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`)
          .run({ id, kind: body.kind, purpose: body.purpose?.trim() || null, prescribed: body.prescribed ? 1 : 0, notes: body.notes?.trim() || null });
      }
    } else {
      id = db.prepare('INSERT INTO medications (name, kind, purpose, prescribed, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(body.name.trim(), body.kind, body.purpose?.trim() || null, body.prescribed ? 1 : 0, body.notes?.trim() || null, now()).lastInsertRowid;
    }
    insertPeriod(db, id, body);
    return getMedication(db, id);
  })();
}

/**
 * A dose or timing change from effective_on, kept as a new period. A correction (or a change on the
 * current period's start day) fixes the current period in place instead, so no change is recorded.
 */
export function changeMedication(db, id, { dose, ingredients, timings, effective_on, correction = false }) {
  requireMedication(db, id);
  return db.transaction(() => {
    const open = openPeriod(db, id);
    if (!open) throw fail(409, 'Not currently taken; use Start again');
    if (!correction && !effective_on) throw fail(400, 'Choose the date the change took effect, or mark it as a correction');
    if (!correction && effective_on < open.started_on) throw fail(400, `The change cannot be before the current period started (${open.started_on})`);
    if (correction || effective_on === open.started_on) {
      const r = regimenOf({ dose, ingredients });
      db.prepare('UPDATE medication_periods SET dose = ?, ingredients = ?, timings = ? WHERE id = ?').run(r.dose, r.ingredients, JSON.stringify(timings), open.id);
    } else {
      db.prepare('UPDATE medication_periods SET stopped_on = ? WHERE id = ?').run(effective_on, open.id);
      insertPeriod(db, id, { dose, ingredients, timings, started_on: effective_on });
    }
    return getMedication(db, id);
  })();
}

export function stopMedication(db, id, { stopped_on, reason }) {
  requireMedication(db, id);
  const open = openPeriod(db, id);
  if (!open) throw fail(409, 'Not currently taken');
  if (stopped_on < open.started_on) throw fail(400, `The stop date cannot be before it started (${open.started_on})`);
  db.prepare('UPDATE medication_periods SET stopped_on = ?, stop_reason = ? WHERE id = ?').run(stopped_on, reason?.trim() || null, open.id);
  return getMedication(db, id);
}

export function startMedication(db, id, { dose, ingredients, timings, started_on }) {
  requireMedication(db, id);
  return db.transaction(() => {
    if (openPeriod(db, id)) throw fail(409, 'Already being taken; use Change instead');
    assertNoOverlap(db, id, started_on, null);
    insertPeriod(db, id, { dose, ingredients, timings, started_on });
    return getMedication(db, id);
  })();
}

/** Label edits (name, type, purpose, prescribed, notes); these are not dated events. */
export function updateMedicationDetails(db, id, changes) {
  requireMedication(db, id);
  const keys = ['name', 'kind', 'purpose', 'prescribed', 'notes'].filter((k) => changes[k] !== undefined);
  const values = { id, ...changes, name: changes.name?.trim(), purpose: changes.purpose?.trim() || null, prescribed: changes.prescribed ? 1 : 0, notes: changes.notes?.trim() || null };
  try {
    db.prepare(`UPDATE medications SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run(values);
  } catch (err) {
    if (/UNIQUE/.test(err.message)) throw fail(409, 'Another entry already has that name');
    throw err;
  }
  return getMedication(db, id);
}

export const deleteMedication = (db, id) => db.prepare('DELETE FROM medications WHERE id = ?').run(id).changes > 0;

/**
 * Combines items taken as one pill into one item with ingredients, for past history and from now on. Every start,
 * change and stop date of any of them starts a new period whose ingredients are the items in effect then, at their doses
 * (an item with ingredients is flattened); consecutive identical periods merge. A period that begins only where estimated
 * starts began stays estimated (no start event). All periods use the one slot given: the old slots count as a
 * correction, not a dated change. Each logged day becomes one check-off in that slot, taken if any item was taken that
 * day; one-day adjustments on the old rows are dropped. The old items are removed. preview returns the plan unchanged.
 */
export function combineMedications(db, { ids, name, timing, preview = false }) {
  const items = [...new Set(ids)].map((id) => requireMedication(db, id));
  if (items.length < 2) throw fail(400, 'Choose at least two items to combine');
  const newName = name.trim();
  const clash = db.prepare('SELECT id FROM medications WHERE name = ?').get(newName);
  if (clash && !items.some((m) => m.id === clash.id)) throw fail(409, 'Another entry already has that name');

  const periods = items.flatMap((m) => m.periods.map((p) => ({ ...p, item: m })));
  const bounds = [...new Set(periods.flatMap((p) => [p.started_on, p.stopped_on]).filter(Boolean))].sort();
  const segments = [];
  bounds.forEach((start, i) => {
    const active = periods.filter((p) => p.started_on <= start && (p.stopped_on === null || p.stopped_on > start));
    if (!active.length) return;
    const ingredients = items.flatMap((m) => {
      const p = active.find((a) => a.item.id === m.id);
      if (!p) return [];
      return p.ingredients ?? [{ name: m.name, dose: p.dose ?? null }];
    });
    const open = active.some((p) => p.stopped_on === null);
    const stop = i + 1 < bounds.length ? bounds[i + 1] : open ? null : start;
    const prev = segments.at(-1);
    const contiguous = prev && prev.stopped_on === start;
    if (contiguous && JSON.stringify(prev.ingredients) === JSON.stringify(ingredients)) {
      prev.stopped_on = stop;
      return;
    }
    const starting = active.filter((p) => p.started_on === start);
    segments.push({
      started_on: start, stopped_on: stop, ingredients,
      start_estimated: !contiguous && starting.length > 0 && starting.every((p) => p.start_estimated),
    });
  });
  // A combined period that ends with no combined period right after it is a stop: keep the reasons given then.
  segments.forEach((seg, i) => {
    if (!seg.stopped_on || segments[i + 1]?.started_on === seg.stopped_on) return;
    const reasons = [...new Set(periods.filter((p) => p.stopped_on === seg.stopped_on && p.stop_reason).map((p) => p.stop_reason))];
    seg.stop_reason = reasons.join('; ') || null;
  });

  const marks = db.prepare(`SELECT date, taken, dose, moved_to FROM medication_doses WHERE medication_id IN (${items.map(() => '?').join(', ')})`)
    .all(...items.map((m) => m.id));
  const days = new Map();
  for (const r of marks) {
    const d = days.get(r.date) ?? { any: false, all: true };
    d.any ||= Boolean(r.taken);
    d.all &&= Boolean(r.taken);
    days.set(r.date, d);
  }
  const disagreed = [...days].filter(([, d]) => d.any && !d.all).map(([date]) => date).sort();
  const joined = (key) => [...new Set(items.map((m) => m[key]?.trim()).filter(Boolean))].join('; ') || null;
  const plan = {
    name: newName,
    kind: items.some((m) => m.kind === 'medication') ? 'medication' : 'supplement',
    prescribed: items.some((m) => m.prescribed),
    purpose: joined('purpose'),
    notes: joined('notes'),
    timing,
    replaces: items.map((m) => m.name),
    periods: segments,
    daysMerged: days.size,
    daysDisagreeing: disagreed,
    adjustmentsDropped: marks.filter((r) => r.dose !== null || r.moved_to !== null).length,
  };
  for (const seg of segments) regimenOf({ ingredients: seg.ingredients }); // the same ingredient in two items is refused
  if (preview) return { preview: true, ...plan };

  return db.transaction(() => {
    for (const m of items) db.prepare('DELETE FROM medications WHERE id = ?').run(m.id);
    const id = db.prepare('INSERT INTO medications (name, kind, purpose, prescribed, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(plan.name, plan.kind, plan.purpose, plan.prescribed ? 1 : 0, plan.notes, now()).lastInsertRowid;
    for (const seg of segments) insertPeriod(db, id, { ...seg, timings: [timing] });
    const ins = db.prepare('INSERT INTO medication_doses (date, medication_id, timing, taken, updated_at) VALUES (?, ?, ?, ?, ?)');
    for (const [date, d] of days) ins.run(date, id, timing, d.any ? 1 : 0, now());
    return { preview: false, ...plan, medication: getMedication(db, id) };
  })();
}

/** Weekly check-offs (taken out of logged) for each current item, oldest week first, ending with this week so far. */
export function medicationCheckoffs(db, today, weeks = 12) {
  const current = db.prepare(`SELECT m.id, m.name FROM medications m JOIN medication_periods p ON p.medication_id = m.id
    WHERE p.stopped_on IS NULL ORDER BY m.name`).all();
  const from = addDays(today, -7 * weeks);
  const doses = db.prepare('SELECT date, medication_id, taken FROM medication_doses WHERE date BETWEEN ? AND ?').all(from, today);
  const { weekEnds, items } = weeklyCheckoffs(doses, { weeks, today });
  const empty = () => weekEnds.map((weekEnd) => ({ weekEnd, taken: 0, logged: 0 }));
  return { weekEnds, items: current.map((m) => ({ id: m.id, name: m.name, weeks: items.get(m.id) ?? empty() })) };
}

/** Every start, change and stop with its before and after averages, newest first. */
export function medicationImpact(db, today) {
  const { medications, medication_periods: periods } = loadMedications(db);
  const events = medicationEvents(medications, periods).filter((e) => e.date <= today);
  if (!events.length) return [];
  const from = addDays(events[0].date, -28);
  const metrics = db.prepare('SELECT date, hrv_ms, resting_hr, sleep_total_hr FROM daily_metrics WHERE date BETWEEN ? AND ?').all(from, today);
  const checkins = db.prepare('SELECT date, readiness, energy, mood, stress FROM checkins WHERE date BETWEEN ? AND ?').all(from, today);
  return events
    .map((e) => ({ ...e, impact: eventImpact(e, metrics, checkins, today, events) }))
    .reverse();
}

// ---- labs ----
// Results come from the lab sheet (source 'sheet', replaced on sync) or the app (source 'ui').
// Only app results can be edited or deleted here; sheet results are changed in the sheet.

/** Tests grouped by panel in sheet order, each with its results newest first, plus all draw dates. */
/**
 * Lab tests by panel with their results, newest first. Each test carries the range in effect (yours, or typical from
 * config/lab-ranges.json), the typical one for "Use typical range", and each result where it sits (below, within, above).
 */
export function listLabs(db, rangesConfig = null) {
  const tests = db.prepare('SELECT id, name, panel, unit, position, ref_low, ref_high, ref_set FROM lab_tests ORDER BY position, name').all()
    .map(({ ref_low, ref_high, ref_set, ...t }) => {
      const range = effectiveRange({ name: t.name, ref_low, ref_high, ref_set }, rangesConfig);
      return { ...t, range, typicalRange: typicalRange(t.name, rangesConfig) };
    });
  const results = db.prepare('SELECT id, test_id, drawn_on, value, value_text, source, corrected_from, corrected_from_date FROM lab_results ORDER BY drawn_on DESC').all();
  const panels = [];
  for (const t of tests) {
    const mine = results.filter((r) => r.test_id === t.id).map(({ test_id, ...r }) => ({ ...r, rangeStatus: rangeStatus(r.value, t.range) }));
    const name = t.panel ?? 'Other';
    let p = panels.find((x) => x.panel === name);
    if (!p) panels.push((p = { panel: name, tests: [] }));
    p.tests.push({ ...t, results: mine });
  }
  return { draws: [...new Set(results.map((r) => r.drawn_on))], panels };
}

const labValue = (text) => {
  const value_text = String(text).trim();
  if (!value_text) throw fail(400, 'Enter a value');
  return { value_text, value: /^-?\d+(\.\d+)?$/.test(value_text) ? Number(value_text) : null };
};

/** Adds an app-entered result for an existing test (test_id) or a new or existing test by name. */
export function addLabResult(db, { test_id, name, panel, unit, drawn_on, value }) {
  return db.transaction(() => {
    let id = test_id;
    if (!id) {
      if (!name?.trim()) throw fail(400, 'Choose a test or enter a new test name');
      id = db.prepare('SELECT id FROM lab_tests WHERE name = ?').get(name.trim())?.id;
      id ??= Number(db.prepare('INSERT INTO lab_tests (name, panel, unit, created_at) VALUES (?, ?, ?, ?)')
        .run(name.trim(), panel?.trim() || null, unit?.trim() || null, now()).lastInsertRowid);
    } else if (!db.prepare('SELECT 1 FROM lab_tests WHERE id = ?').get(id)) {
      throw fail(404, 'Test not found');
    }
    const existing = db.prepare('SELECT source FROM lab_results WHERE test_id = ? AND drawn_on = ?').get(id, drawn_on);
    if (existing) {
      throw fail(409, existing.source === 'sheet' ? 'That test already has a result from the Google Sheet on that date; change it in the sheet' : 'That test already has a result on that date; edit it instead');
    }
    const v = labValue(value);
    const rid = db.prepare("INSERT INTO lab_results (test_id, drawn_on, value, value_text, source, updated_at) VALUES (?, ?, ?, ?, 'ui', ?)")
      .run(id, drawn_on, v.value, v.value_text, now()).lastInsertRowid;
    return db.prepare('SELECT * FROM lab_results WHERE id = ?').get(rid);
  })();
}

function requireResult(db, id) {
  const r = db.prepare('SELECT * FROM lab_results WHERE id = ?').get(id);
  if (!r) throw fail(404, 'Result not found');
  return r;
}

/**
 * Corrects a result's value or date. A sheet result becomes an app correction: it keeps the sheet's
 * original value and date, and sync never overwrites it or re-adds the sheet's copy.
 */
export function updateLabResult(db, id, { drawn_on, value }) {
  const r = requireResult(db, id);
  const v = value === undefined ? { value: r.value, value_text: r.value_text } : labValue(value);
  const date = drawn_on ?? r.drawn_on;
  if (v.value_text === r.value_text && date === r.drawn_on) return r;
  const fromSheet = r.source === 'sheet';
  try {
    db.prepare(`UPDATE lab_results SET drawn_on = ?, value = ?, value_text = ?, source = 'ui', updated_at = ?,
        corrected_from = ?, corrected_from_date = ? WHERE id = ?`)
      .run(date, v.value, v.value_text, now(), fromSheet ? r.value_text : r.corrected_from, fromSheet ? r.drawn_on : r.corrected_from_date, id);
  } catch (err) {
    if (/UNIQUE/.test(err.message)) throw fail(409, 'That test already has a result on that date');
    throw err;
  }
  return db.prepare('SELECT * FROM lab_results WHERE id = ?').get(id);
}

/**
 * Deletes a result added in the app. Undoing a correction restores the sheet's original value and
 * date right away. Sheet results cannot be deleted here, since the next sync would bring them back.
 */
export function deleteLabResult(db, id) {
  const r = requireResult(db, id);
  if (r.source === 'sheet') throw fail(409, 'This result comes from the Google Sheet and would return on the next sync; correct its value, or remove it from the sheet');
  if (r.corrected_from_date) {
    const original = labValue(r.corrected_from);
    try {
      db.prepare(`UPDATE lab_results SET drawn_on = ?, value = ?, value_text = ?, source = 'sheet', corrected_from = NULL,
          corrected_from_date = NULL, updated_at = ? WHERE id = ?`).run(r.corrected_from_date, original.value, original.value_text, now(), id);
    } catch (err) {
      if (/UNIQUE/.test(err.message)) throw fail(409, 'Another result already sits on the original date; move or delete it first');
      throw err;
    }
    return { restored: true };
  }
  db.prepare('DELETE FROM lab_results WHERE id = ?').run(id);
  return { restored: false };
}

/** Unit, panel, or reference range (your own from the lab report, either bound null; reset_range goes back to typical). */
export function updateLabTest(db, id, { unit, panel, ref_low, ref_high, reset_range }) {
  if (!db.prepare('SELECT 1 FROM lab_tests WHERE id = ?').get(id)) throw fail(404, 'Test not found');
  const sets = [];
  const values = { id };
  if (unit !== undefined) { sets.push('unit = @unit'); values.unit = unit?.trim() || null; }
  if (panel !== undefined) { sets.push('panel = @panel'); values.panel = panel?.trim() || null; }
  if (reset_range) {
    sets.push('ref_low = NULL', 'ref_high = NULL', 'ref_set = 0');
  } else if (ref_low !== undefined || ref_high !== undefined) {
    if (ref_low !== undefined && ref_low !== null && ref_high !== undefined && ref_high !== null && ref_low > ref_high) {
      throw fail(400, 'The low end of the range is above the high end');
    }
    sets.push('ref_low = @ref_low', 'ref_high = @ref_high', 'ref_set = 1');
    values.ref_low = ref_low ?? null;
    values.ref_high = ref_high ?? null;
  }
  if (!sets.length) throw fail(400, 'Nothing to change');
  db.prepare(`UPDATE lab_tests SET ${sets.join(', ')} WHERE id = @id`).run(values);
  return db.prepare('SELECT id, name, panel, unit, position, ref_low, ref_high, ref_set FROM lab_tests WHERE id = ?').get(id);
}

// ---- prompt sections ----

const SECTION_COLS = 'id, position, name, text, sensitive, updated_at';
const asSection = (r) => r && { ...r, sensitive: Boolean(r.sensitive) };

export function listSections(db) {
  return db.prepare(`SELECT ${SECTION_COLS} FROM prompt_sections ORDER BY position, name`).all().map(asSection);
}

export function getSection(db, id) {
  return asSection(db.prepare(`SELECT ${SECTION_COLS} FROM prompt_sections WHERE id = ?`).get(id));
}

function keepVersion(db, section) {
  db.prepare(`INSERT INTO prompt_section_versions (section_id, position, name, text, sensitive, replaced_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(section.id, section.position, section.name, section.text, section.sensitive ? 1 : 0, now());
}

export function createSection(db, { position, name, text, sensitive = false }) {
  const id = db.prepare(`INSERT INTO prompt_sections (position, name, text, sensitive, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run(position, name.trim(), text, sensitive ? 1 : 0, now()).lastInsertRowid;
  return getSection(db, id);
}

/** Updates a section, keeping its previous contents. Returns null when it does not exist. */
export function updateSection(db, id, changes) {
  const current = getSection(db, id);
  if (!current) return null;
  const next = { ...current, ...changes, name: (changes.name ?? current.name).trim() };
  const unchanged = ['position', 'name', 'text', 'sensitive'].every((k) => next[k] === current[k]);
  if (unchanged) return current;
  db.transaction(() => {
    keepVersion(db, current);
    db.prepare('UPDATE prompt_sections SET position = ?, name = ?, text = ?, sensitive = ?, updated_at = ? WHERE id = ?')
      .run(next.position, next.name, next.text, next.sensitive ? 1 : 0, now(), id);
  })();
  return getSection(db, id);
}

export function deleteSection(db, id) {
  const current = getSection(db, id);
  if (!current) return false;
  db.transaction(() => {
    keepVersion(db, current);
    db.prepare('DELETE FROM prompt_sections WHERE id = ?').run(id);
  })();
  return true;
}

/** The weekly review's instructions as the model would receive them (sensitive sections left out). */
export function previewInstructions(db, today) {
  const sections = listSections(db);
  const includeSensitive = WEEKLY_INCLUDES_SENSITIVE;
  const text = buildInstructions(sections, today, { includeSensitive });
  const sent = sections.filter((s) => includeSensitive || !s.sensitive);
  return {
    text,
    characters: text.length,
    included: sent.map((s) => s.name),
    sensitiveIncluded: sent.filter((s) => s.sensitive).map((s) => s.name),
    leftOut: sections.filter((s) => !sent.includes(s)).map((s) => s.name),
  };
}
