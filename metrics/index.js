// The week's numbers, all computed in code. The model only ever receives this summary.
import { windows } from './stats.js';
import { recovery, nightBreathing } from './recovery.js';
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
import { blockAdherence, weekAdherence } from './adherence.js';

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
    // Blood oxygen and breathing disturbances: values only, for physician discussion (null with no data).
    nightBreathing: nightBreathing(data.daily_metrics, weekEnd),
    cardio: cardio(data.workout_sessions, weekEnd, { zone2 }),
    strength: strength(data.strength_sets, weekEnd),
    trainingVolume: volumeTrend(data.strength_sets, weekEnd),
    program: data.program ?? null,
    // Ranked at equal weights, only near the end of a block or between blocks.
    advisor: data.advisor_input && advisorDue(data.program ?? null, weekEnd) ? advisorForReview(recommendPrograms(data.advisor_input)) : null,
    // How the week's lifting days followed the program: counts and the owner's logged names only (never the catalog's).
    programAdherence: data.adherence_input
      ? weekAdherence(blockAdherence(data.adherence_input), w.week.from, w.week.to, data.adherence_input.programName) : null,
    lifts: liftsForReview(data.primary_sets ?? [], weekEnd, { phases: new Map(Object.entries(data.session_phases ?? {})) }),
    drinking: drinking(data.drinking_days, data.daily_metrics, weekEnd),
    checkins: checkins(data.checkins, data.daily_metrics, weekEnd),
    labs: labsSummary(data.lab_tests ?? [], data.lab_results ?? [], weekEnd, data.lab_ranges ?? null),
    // Health targets (computed in code): only metrics with data, numbers only.
    targets: (data.targets ?? []).filter((t) => t.current !== null && t.target !== null).map((t) => ({
      metric: t.label, target: t.target, setBy: t.setBy, current90d: t.current, basis: t.basis,
      healthyLow: t.healthy?.low ?? null, healthyHigh: t.healthy?.high ?? null,
    })),
    medications: medicationsWeek(data.medications ?? [], data.medication_periods ?? [], data.daily_metrics, data.checkins, weekEnd, data.medication_doses ?? []),
  };
}
