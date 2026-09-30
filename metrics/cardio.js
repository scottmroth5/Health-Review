// Apple Watch workout sessions for the week: totals by kind and type, and Zone 2.
// Zone 2 uses each session's average heart rate against the personal range, because the export
// has no per-minute heart rate: a session counts as Zone 2 when its average falls inside the range.
import { round, sum, inRange, windows } from './stats.js';

export function sessionKind(type) {
  if (/strength|core/i.test(type)) return 'strength';
  if (/yoga|flexibility|cooldown|pilates|stretch|mind/i.test(type)) return 'mobility';
  return 'cardio';
}

const minutesOf = (s) => {
  if (s.duration_sec !== null && s.duration_sec !== undefined) return s.duration_sec / 60;
  return (Date.parse(`${s.end}Z`) - Date.parse(`${s.start}Z`)) / 60000;
};

/** Duration-weighted average heart rate over sessions that have one. */
function weightedHr(sessions) {
  const withHr = sessions.filter((s) => s.avg_hr !== null && s.avg_hr !== undefined);
  const minutes = sum(withHr.map(minutesOf));
  return minutes ? sum(withHr.map((s) => s.avg_hr * minutesOf(s))) / minutes : null;
}

/**
 * @param {Array<object>} sessions  workout_sessions rows
 * @param {string} weekEnd
 * @param {{ zone2?: { low: number, high: number } | null }} [options]
 */
export function cardio(sessions, weekEnd, { zone2 = null } = {}) {
  const w = windows(weekEnd);
  const dayOf = (s) => s.start.slice(0, 10);
  const week = sessions.filter((s) => inRange(dayOf(s), w.week.from, w.week.to));
  const base = sessions.filter((s) => inRange(dayOf(s), w.baseline.from, w.baseline.to));

  const byType = {};
  for (const s of week) (byType[s.type] ??= []).push(s);
  const types = Object.entries(byType)
    .map(([type, list]) => ({
      type,
      kind: sessionKind(type),
      sessions: list.length,
      minutes: round(sum(list.map(minutesOf)), 0),
      avgHr: round(weightedHr(list), 0),
      activeKcal: round(sum(list.map((s) => s.active_energy_kcal)), 0),
      distanceMi: list.some((s) => s.distance_mi) ? round(sum(list.map((s) => s.distance_mi)), 1) : null,
    }))
    .sort((a, b) => b.minutes - a.minutes || a.type.localeCompare(b.type));

  const kindTotals = (list, kind) => {
    const k = list.filter((s) => sessionKind(s.type) === kind);
    return { sessions: k.length, minutes: sum(k.map(minutesOf)) };
  };
  const weekCardio = kindTotals(week, 'cardio');
  const baseCardio = kindTotals(base, 'cardio');
  const weekStrength = kindTotals(week, 'strength');

  let zone2Result = { range: null, sessions: null, minutes: null, belowSessions: null, aboveSessions: null };
  if (zone2) {
    const cardioWithHr = week.filter((s) => sessionKind(s.type) === 'cardio' && s.avg_hr !== null && s.avg_hr !== undefined);
    const inZone = cardioWithHr.filter((s) => s.avg_hr >= zone2.low && s.avg_hr <= zone2.high);
    zone2Result = {
      range: { low: zone2.low, high: zone2.high },
      sessions: inZone.length,
      minutes: round(sum(inZone.map(minutesOf)), 0),
      belowSessions: cardioWithHr.filter((s) => s.avg_hr < zone2.low).length,
      aboveSessions: cardioWithHr.filter((s) => s.avg_hr > zone2.high).length,
    };
  }

  const maxHrs = week.map((s) => s.max_hr).filter((v) => typeof v === 'number');
  return {
    sessions: week.length,
    activeDays: new Set(week.map(dayOf)).size,
    cardio: {
      sessions: weekCardio.sessions,
      minutes: round(weekCardio.minutes, 0),
      avgHr: round(weightedHr(week.filter((s) => sessionKind(s.type) === 'cardio')), 0),
      baselineWeeklyMinutes: round(baseCardio.minutes / 4, 0),
      changeVsBaselineMinutes: round(weekCardio.minutes - baseCardio.minutes / 4, 0),
    },
    strengthSessions: { sessions: weekStrength.sessions, minutes: round(weekStrength.minutes, 0) },
    zone2: zone2Result,
    peakHr: maxHrs.length ? round(Math.max(...maxHrs), 0) : null,
    byType: types,
  };
}
