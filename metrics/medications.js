// Medications and supplements: events derived from dated periods, and before/after averages around
// each event. A period's stopped_on is the first day it no longer applied, so a change on day X
// closes the old period with stopped_on X and opens the new one with started_on X.
// Impact numbers are observational (before and after averages), never evidence of cause.
import { mean, round, addDays, inRange, daysBetween } from './stats.js';

export const TIMINGS = ['morning', 'afternoon', 'before_bed', 'before_workout', 'during_workout', 'after_workout', 'daily'];

const BEFORE_DAYS = 28; // days before the event
const SETTLE_DAYS = 7; // days right after the event that are skipped
const AFTER_DAYS = 28; // days compared after the settling period
const OVERLAP_DAYS = 28;

/** Compared values: source table, decimals, and the minimum days needed on each side. */
export const IMPACT_FIELDS = {
  hrv_ms: { from: 'metrics', d: 0, min: 14 },
  resting_hr: { from: 'metrics', d: 1, min: 14 },
  sleep_total_hr: { from: 'metrics', d: 1, min: 14 },
  readiness: { from: 'checkins', d: 1, min: 7 },
  energy: { from: 'checkins', d: 1, min: 7 },
  mood: { from: 'checkins', d: 1, min: 7 },
  stress: { from: 'checkins', d: 1, min: 7 },
};

const regimen = (p) => ({ dose: p.dose ?? null, timings: typeof p.timings === 'string' ? JSON.parse(p.timings) : p.timings });

/**
 * Start, change and stop events, oldest first.
 * @param {Array<{id, name, kind, purpose, prescribed}>} medications
 * @param {Array<{id, medication_id, dose, timings, started_on, stopped_on, stop_reason}>} periods
 */
export function medicationEvents(medications, periods) {
  const byId = new Map(medications.map((m) => [m.id, m]));
  const grouped = new Map();
  for (const p of periods) {
    if (!grouped.has(p.medication_id)) grouped.set(p.medication_id, []);
    grouped.get(p.medication_id).push(p);
  }
  const events = [];
  for (const [id, list] of grouped) {
    const med = byId.get(id);
    if (!med) continue;
    list.sort((a, b) => a.started_on.localeCompare(b.started_on) || a.id - b.id);
    const base = { medicationId: id, name: med.name, kind: med.kind };
    list.forEach((p, i) => {
      const prev = list[i - 1];
      const next = list[i + 1];
      if (prev && prev.stopped_on === p.started_on) {
        events.push({ ...base, date: p.started_on, type: 'change', from: regimen(prev), to: regimen(p), reason: null });
      } else if (!p.start_estimated) {
        // An estimated start ("since at least") is not a real event, so it gets no start or impact.
        events.push({ ...base, date: p.started_on, type: 'start', from: null, to: regimen(p), reason: null });
      }
      if (p.stopped_on && !(next && next.started_on === p.stopped_on)) {
        events.push({ ...base, date: p.stopped_on, type: 'stop', from: regimen(p), to: null, reason: p.stop_reason ?? null });
      }
    });
  }
  return events.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}

/**
 * Averages in the 28 days before an event against days 7 to 34 after it.
 * @param {object} event        from medicationEvents
 * @param {object[]} metrics    daily_metrics rows
 * @param {object[]} checkins   checkins rows
 * @param {string} today        the last day that can have data
 * @param {object[]} [events]   all events, to note others close enough to muddy the comparison
 */
export function eventImpact(event, metrics, checkins, today, events = []) {
  const before = { from: addDays(event.date, -BEFORE_DAYS), to: addDays(event.date, -1) };
  const after = { from: addDays(event.date, SETTLE_DAYS), to: addDays(event.date, SETTLE_DAYS + AFTER_DAYS - 1) };
  const sources = { metrics, checkins };

  const fields = {};
  for (const [key, { from, d, min }] of Object.entries(IMPACT_FIELDS)) {
    const values = (range) => sources[from].filter((r) => inRange(r.date, range.from, range.to) && typeof r[key] === 'number').map((r) => r[key]);
    const b = values(before);
    const a = values(after);
    const bm = b.length >= min ? mean(b) : null;
    const am = a.length >= min ? mean(a) : null;
    fields[key] = {
      beforeDays: b.length,
      beforeMean: round(bm, d),
      afterDays: a.length,
      afterMean: round(am, d),
      change: bm !== null && am !== null ? round(am - bm, d) : null,
    };
  }

  return {
    status: today < after.to ? 'pending' : 'complete',
    before,
    after,
    fields,
    overlapsWith: events
      .filter((e) => !(e.medicationId === event.medicationId && e.date === event.date && e.type === event.type))
      .filter((e) => Math.abs(daysBetween(event.date, e.date)) <= OVERLAP_DAYS)
      .map((e) => ({ date: e.date, name: e.name, type: e.type })),
  };
}

/** The period in effect on a date, or null. */
export const activeOn = (periods, date) =>
  periods.find((p) => p.started_on <= date && (p.stopped_on === null || p.stopped_on === undefined || p.stopped_on > date)) ?? null;

/**
 * Medication context for the weekly summary: what was current at the week's end, how the week's
 * saved check-offs went, and recent changes.
 * @param {object[]} [doses]  medication_doses rows (a saved day has a row per slot, taken 1 or 0)
 */
export function medicationsWeek(medications, periods, metrics, checkins, weekEnd, doses = []) {
  const byId = new Map(medications.map((m) => [m.id, m]));
  const weekFrom = addDays(weekEnd, -6);
  const weekDoses = doses.filter((d) => inRange(d.date, weekFrom, weekEnd));
  const current = periods
    .filter((p) => p === activeOn(periods.filter((q) => q.medication_id === p.medication_id), weekEnd))
    .map((p) => {
      const m = byId.get(p.medication_id);
      const mine = weekDoses.filter((d) => d.medication_id === p.medication_id);
      const taken = mine.filter((d) => d.taken).length;
      return {
        name: m.name, kind: m.kind, ...regimen(p), since: p.started_on, sinceEstimated: Boolean(p.start_estimated),
        purpose: m.purpose ?? null, prescribed: Boolean(m.prescribed), notes: m.notes ?? null,
        week: {
          loggedDays: new Set(mine.map((d) => d.date)).size,
          dosesTaken: taken,
          dosesLogged: mine.length,
          takenPct: mine.length ? round((taken / mine.length) * 100, 0) : null,
        },
      };
    })
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));

  const events = medicationEvents(medications, periods).filter((e) => e.date <= weekEnd);
  const strip = ({ medicationId, ...e }) => e;
  return {
    current,
    changesThisWeek: events.filter((e) => inRange(e.date, addDays(weekEnd, -6), weekEnd)).map(strip),
    recentChanges90d: events
      .filter((e) => inRange(e.date, addDays(weekEnd, -89), weekEnd))
      .map((e) => ({ ...strip(e), impact: eventImpact(e, metrics, checkins, weekEnd, events) })),
  };
}
