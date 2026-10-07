// The week's numbers, all computed in code. The model only ever receives this summary.
import { windows } from './stats.js';
import { recovery } from './recovery.js';
import { cardio } from './cardio.js';
import { strength } from './strength.js';
import { drinking } from './drinking.js';
import { checkins } from './checkins.js';
import { medicationsWeek } from './medications.js';
import { labsSummary } from './labs.js';
import { volumeTrend } from './volume.js';
import { liftsForReview } from './plateau.js';
import { advisorDue, advisorForReview, recommendPrograms } from './advisor.js';
import { weekDataQuality } from './dataquality.js';

/**
 * @param {{ daily_metrics: object[], workout_sessions: object[], strength_sets: object[], drinking_days: object[], checkins: object[] }} data
 * @param {{ weekEnd: string, zone2?: { low: number, high: number } | null }} options
 */
export function computeWeek(data, { weekEnd, zone2 = null }) {
  const w = windows(weekEnd);
  return {
    weekEnd,
    week: w.week,
    // Days of the week with no Apple Health row, or that look like a partial export (dates only).
    dataQuality: weekDataQuality(data.daily_metrics, w.week.from, w.week.to),
    recovery: recovery(data.daily_metrics, weekEnd),
    cardio: cardio(data.workout_sessions, weekEnd, { zone2 }),
    strength: strength(data.strength_sets, weekEnd),
    trainingVolume: volumeTrend(data.strength_sets, weekEnd),
    program: data.program ?? null,
    // Ranked at equal weights, only near the end of a block or between blocks.
    advisor: data.advisor_input && advisorDue(data.program ?? null, weekEnd) ? advisorForReview(recommendPrograms(data.advisor_input)) : null,
    lifts: liftsForReview(data.primary_sets ?? [], weekEnd, { phases: new Map(Object.entries(data.session_phases ?? {})) }),
    drinking: drinking(data.drinking_days, data.daily_metrics, weekEnd),
    checkins: checkins(data.checkins, data.daily_metrics, weekEnd),
    labs: labsSummary(data.lab_tests ?? [], data.lab_results ?? [], weekEnd),
    medications: medicationsWeek(data.medications ?? [], data.medication_periods ?? [], data.daily_metrics, data.checkins, weekEnd, data.medication_doses ?? []),
  };
}
