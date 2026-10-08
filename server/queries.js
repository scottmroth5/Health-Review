// All SQL behind the UI API. Routes validate input with JSON schemas before calling these.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildInstructions, WEEKLY_INCLUDES_SENSITIVE } from '../agent/prompts.js';
import { medicationEvents, eventImpact } from '../metrics/medications.js';
import { loadAdvisorInput, loadDataCheckInput, loadMedications, loadPrimarySets, loadSessionPhases, loadStrengthSets } from '../metrics/load.js';
import { trainingView } from '../metrics/volume.js';
import { vo2maxReport } from '../metrics/vo2max.js';
import { liftProgress } from '../metrics/plateau.js';
import { addDays } from '../metrics/stats.js';
import { recommendPrograms } from '../metrics/advisor.js';
import { dataChecks } from '../metrics/dataquality.js';

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

/** Local calendar date of a Date as 'YYYY-MM-DD'. */
export function localDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

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
  return {
    metrics: db.prepare(`SELECT date, hrv_ms, resting_hr, sleep_total_hr, steps, exercise_min FROM daily_metrics
      WHERE date BETWEEN ? AND ? ORDER BY date`).all(from, to),
    checkins: db.prepare(`SELECT date, cadence, readiness, energy, mood, stress, nutrition, weight_lbs FROM checkins
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

export const LOG_NAMES = ['sync', 'review', 'backup'];

/** The last lines of a scheduled task's log (data/logs/<name>.log); empty when it does not exist yet. */
export function readLog(dir, name, lines = 200) {
  if (!LOG_NAMES.includes(name)) throw new Error(`Unknown log ${name}`);
  const path = join(dir, `${name}.log`);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/).filter((l, i, all) => l !== '' || i < all.length - 1).slice(-lines);
}

export function lastSync(db) {
  const run = db.prepare("SELECT status, started_at, finished_at, summary FROM runs WHERE name = 'sync' ORDER BY id DESC LIMIT 1").get();
  return run ? { ...run, summary: run.summary ? JSON.parse(run.summary) : null } : null;
}

/** Data check warnings as of today (info findings, such as a lifting day without a watch workout, stay in the sync log). */
export function dataCheckWarnings(db, today) {
  return dataChecks(loadDataCheckInput(db, today)).filter((c) => c.severity === 'warn').map(({ kind, dates, message }) => ({ kind, dates, message }));
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
const asPeriod = (p) => ({ ...p, timings: JSON.parse(p.timings), start_estimated: Boolean(p.start_estimated) });
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

function insertPeriod(db, id, { dose, timings, started_on, stopped_on = null, stop_reason = null, start_estimated = false }) {
  db.prepare(`INSERT INTO medication_periods (medication_id, dose, timings, started_on, stopped_on, stop_reason, start_estimated, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, dose?.trim() || null, JSON.stringify(timings), started_on, stopped_on, stop_reason?.trim() || null, start_estimated ? 1 : 0, now());
}

// ---- daily check-off ----

/**
 * Medications in effect on a date, each with its timing slots and what was saved for that day. A slot can carry a
 * one-day adjustment: dose (what was taken instead of defaultDose) and movedTo (the slot it was taken in instead of
 * its scheduled timing); null means the default.
 */
export function dayMedications(db, date) {
  const rows = db.prepare(`SELECT m.id, m.name, m.kind, p.dose, p.timings FROM medication_periods p JOIN medications m ON m.id = p.medication_id
    WHERE p.started_on <= ? AND (p.stopped_on IS NULL OR p.stopped_on > ?) ORDER BY m.kind, m.name`).all(date, date);
  const saved = db.prepare('SELECT medication_id, timing, taken, dose, moved_to FROM medication_doses WHERE date = ?').all(date);
  const savedOf = (id, timing) => saved.find((s) => s.medication_id === id && s.timing === timing);
  return {
    saved: saved.length > 0,
    items: rows.map((r) => ({
      id: r.id, name: r.name, kind: r.kind, dose: r.dose,
      slots: JSON.parse(r.timings).map((t) => {
        const s = savedOf(r.id, t);
        return { timing: t, taken: s === undefined ? null : Boolean(s.taken), dose: s?.dose ?? null, defaultDose: r.dose, movedTo: s?.moved_to ?? null };
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
      const adjustedDose = dose && dose !== (item.dose ?? '').trim() ? dose : null;
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
export function changeMedication(db, id, { dose, timings, effective_on, correction = false }) {
  requireMedication(db, id);
  return db.transaction(() => {
    const open = openPeriod(db, id);
    if (!open) throw fail(409, 'Not currently taken; use Start again');
    if (!correction && !effective_on) throw fail(400, 'Choose the date the change took effect, or mark it as a correction');
    if (!correction && effective_on < open.started_on) throw fail(400, `The change cannot be before the current period started (${open.started_on})`);
    if (correction || effective_on === open.started_on) {
      db.prepare('UPDATE medication_periods SET dose = ?, timings = ? WHERE id = ?').run(dose?.trim() || null, JSON.stringify(timings), open.id);
    } else {
      db.prepare('UPDATE medication_periods SET stopped_on = ? WHERE id = ?').run(effective_on, open.id);
      insertPeriod(db, id, { dose, timings, started_on: effective_on });
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

export function startMedication(db, id, { dose, timings, started_on }) {
  requireMedication(db, id);
  return db.transaction(() => {
    if (openPeriod(db, id)) throw fail(409, 'Already being taken; use Change instead');
    assertNoOverlap(db, id, started_on, null);
    insertPeriod(db, id, { dose, timings, started_on });
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
export function listLabs(db) {
  const tests = db.prepare('SELECT id, name, panel, unit, position FROM lab_tests ORDER BY position, name').all();
  const results = db.prepare('SELECT id, test_id, drawn_on, value, value_text, source, corrected_from, corrected_from_date FROM lab_results ORDER BY drawn_on DESC').all();
  const panels = [];
  for (const t of tests) {
    const mine = results.filter((r) => r.test_id === t.id).map(({ test_id, ...r }) => r);
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

export function updateLabTest(db, id, { unit, panel }) {
  if (!db.prepare('SELECT 1 FROM lab_tests WHERE id = ?').get(id)) throw fail(404, 'Test not found');
  const sets = [];
  const values = { id };
  if (unit !== undefined) { sets.push('unit = @unit'); values.unit = unit?.trim() || null; }
  if (panel !== undefined) { sets.push('panel = @panel'); values.panel = panel?.trim() || null; }
  db.prepare(`UPDATE lab_tests SET ${sets.join(', ')} WHERE id = @id`).run(values);
  return db.prepare('SELECT id, name, panel, unit, position FROM lab_tests WHERE id = ?').get(id);
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
