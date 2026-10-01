// The one input the review model gets: computeWeek's numbers, trimmed to what the report uses, plus
// the owner's notes for the week. Every number in the report must come from this object (or the
// instructions), which the grounding check enforces.

const isEmptyMetric = (m) => m.days === 0 && m.baselineDays === 0;

/** Drops null fields from a list item (a missing field reads as no data); top-level nulls stay. */
const compact = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined)
  .map(([k, v]) => [k, v && typeof v === 'object' && !Array.isArray(v) ? compact(v) : v]));

/** An impact without its date windows (they follow from the event date) and without rows that have no data on either side. */
const compactImpact = ({ before, after, fields, ...rest }) => ({
  ...rest,
  fields: Object.fromEntries(Object.entries(fields).filter(([, f]) => f.beforeDays || f.afterDays).map(([k, f]) => [k, compact(f)])),
});

/**
 * @param {object} week     computeWeek() result
 * @param {object[]} notes  loadWeekNotes() rows
 * @param {{ today: string }} context
 */
export function buildSummary(week, notes, { today }) {
  const recovery = Object.fromEntries(Object.entries(week.recovery).filter(([key, m]) => key === 'vo2max' || !isEmptyMetric(m)));

  // Strength: every exercise done this week in full; the rest of the 28 days only as a count.
  const inWeek = week.strength.exercises.filter((e) => e.inWeek);
  const strength = {
    ...week.strength,
    exercises: inWeek.map(({ inWeek: _, ...e }) => compact(e)),
    otherExercisesIn28Days: week.strength.exercises.length - inWeek.length,
  };

  const medications = {
    current: week.medications.current.map(compact),
    changesThisWeek: week.medications.changesThisWeek.map(compact),
    recentChanges90d: week.medications.recentChanges90d.map(({ impact, ...e }) => ({ ...compact(e), impact: compactImpact(impact) })),
  };

  return {
    about: {
      today,
      weekEnd: week.weekEnd,
      week: week.week,
      units: 'hrv_ms in ms, resting_hr in bpm, sleep in hours, weights in lbs (total load; topPerHandLbs is per hand), durations in minutes unless named _sec',
      nullMeans: 'no data (not zero); a field missing from a list item also means no data',
    },
    recovery,
    cardio: week.cardio,
    strength,
    trainingVolume: week.trainingVolume,
    drinking: week.drinking,
    checkins: week.checkins,
    medications,
    labs: { ...week.labs, results: week.labs.results.map(compact) },
    notes,
  };
}
