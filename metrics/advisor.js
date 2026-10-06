// Program Advisor (pure): ranks the MAPS programs for the owner's next block. The ranking is computed here, never by
// the model, from each program's prescription (the local catalog) and the owner's own history on it.
// Goal scores run 0 to 1:
//   strength  heavy sets (5 reps or fewer) plus half the 6-12 rep sets, as a share of all sets (50% scores 1), averaged with past runs' median change in estimated
//             max from the first 2 weeks to the last 2 (+10% scores 1, -10% scores 0); +0.1 when a stalled or
//             regressing primary lift was trained in a rep range other than the program's main one (fresh stimulus)
//   joint     0.5 one side at a time (40% scores 1) + 0.3 mobility (0 to 3) + 0.2 little arm isolation (40% scores 0);
//             x0.75 when the program prescribes anything on the avoid list
//   time      weekly minutes (sessions x minutes + extra sessions): 120 or less scores 1, 360 or more scores 0;
//             minutes per session are the owner's Apple Watch average on that program (10+ sessions), otherwise the
//             prescription estimate times the owner's typical watch-to-estimate ratio
//   vo2       conditioning (0 to 3), averaged with past runs' VO2 max change (first 4 weeks to last 4; +1 scores 1,
//             -1 scores 0)
// Total = the goals' scores averaged by weight (whole numbers 0 to 3, default 1 each; 0 leaves a goal out) x completion
// (0.5 + 0.5 x average share of the program reached on past runs; 1 with no past runs); null when every weight is 0.
// Goal scores are rounded to 2 places before the total. The program run last is left out;
// add-ons (profile.standalone false) are scored and listed apart. Reasons are facts from these numbers only.
import { addDays, daysBetween, round } from './stats.js';
import { totalLbs } from './strength.js';
import { epley, rangeOf } from './plateau.js';
import { midpoint, parseReps, phaseStats } from './catalog.js';

export const GOALS = ['strength', 'joint', 'time', 'vo2'];
export const MAX_WEIGHT = 3;
export const EQUAL_WEIGHTS = Object.freeze(Object.fromEntries(GOALS.map((g) => [g, 1])));
export const HISTORY_WINDOW_DAYS = 14; // lift change: first and last 2 weeks of a run
export const VO2_WINDOW_DAYS = 28; // VO2 max change: first and last 4 weeks of a run
export const MIN_WATCH_SESSIONS = 10;
const WORK_MIN_PER_SET = 0.75;
const DEFAULT_REST_MIN = 1.5;
const clamp = (x) => Math.min(1, Math.max(0, x));
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthYear = (d) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
const signed = (x, unit = '') => `${x > 0 ? '+' : ''}${x}${unit}`;

/** Rest in minutes from a phase's rest text ("60-90 seconds", "3-5 minutes"); 1.5 when not stated. */
export function restMinutes(text) {
  const m = /(\d+)\s*(?:-\s*(\d+))?\s*(seconds?|sec|minutes?|min)/i.exec(String(text ?? ''));
  if (!m) return /only the time/i.test(text ?? '') ? 0.25 : DEFAULT_REST_MIN;
  const v = m[2] ? (Number(m[1]) + Number(m[2])) / 2 : Number(m[1]);
  return /^sec/i.test(m[3]) ? v / 60 : v;
}

/**
 * What a program prescribes, averaged over its phases by weeks: sessions a week, estimated minutes per session
 * (0.75 min a set plus the phase's rest; superset partners share one rest; a stated session length wins), shares of
 * heavy, 6-12 rep (by the middle of the prescribed range), one-side and arm isolation sets, the main rep range, and exercises on the avoid list.
 * @param {object} program  catalog program with phases, workouts and profile
 * @param {(name: string) => {id: string|null, pattern: string|null, status: string}} lookup
 * @param {Set<string>} avoid  canonical ids
 */
export function programProfile(program, lookup, avoid = new Set()) {
  const prof = program.profile ?? {};
  let weeks = 0;
  let sessions = 0;
  let minutes = 0;
  let heavy = 0;
  let uni = 0;
  let arms = 0;
  let allSets = 0;
  let moderate = 0;
  const ranges = new Map();
  const hits = [];
  for (const ph of program.phases) {
    const w = ph.weeks[1] - ph.weeks[0] + 1;
    const perWeek = ph.workouts_per_week ?? 3;
    const st = phaseStats(ph, lookup);
    const rest = restMinutes(ph.rest);
    let phaseMin = 0;
    for (const wo of ph.workouts ?? []) {
      const restGroups = new Map();
      wo.exercises.forEach((e, i) => {
        const n = midpoint(e.sets ?? '1') ?? 1;
        phaseMin += WORK_MIN_PER_SET * n;
        const key = e.superset ? `superset ${e.superset}` : `exercise ${i}`;
        restGroups.set(key, Math.max(restGroups.get(key) ?? 0, n));
        const reps = parseReps(e.reps ?? '');
        allSets += n * w;
        if (reps?.unit === 'reps') {
          const r = rangeOf((reps.min + reps.max) / 2);
          ranges.set(r, (ranges.get(r) ?? 0) + n * w);
          if (r === '6-12') moderate += n * w;
        }
        const id = lookup(e.name).id;
        if (id && avoid.has(id) && !hits.some((h) => h.id === id && h.phase === ph.name)) hits.push({ id, name: e.name, phase: ph.name });
      });
      for (const n of restGroups.values()) phaseMin += rest * n;
    }
    const workouts = (ph.workouts ?? []).length;
    const perSession = prof.minutes_per_session ?? (ph.minutes ? midpoint(ph.minutes) : (workouts ? phaseMin / workouts : 0));
    weeks += w;
    sessions += perWeek * w;
    minutes += perSession * perWeek * w;
    heavy += st.heavyPct * w;
    uni += st.unilateralPct * w;
    arms += st.armIsolationPct * w;
  }
  const mainRange = [...ranges].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
  return {
    weeks: program.weeks,
    sessionsPerWeek: round(sessions / weeks, 1),
    estimatedMinutes: Math.round(minutes / sessions),
    heavyPct: Math.round(heavy / weeks),
    unilateralPct: Math.round(uni / weeks),
    armIsolationPct: Math.round(arms / weeks),
    moderatePct: allSets ? Math.round((moderate / allSets) * 100) : 0,
    mainRange,
    conditioning: prof.conditioning ?? 0,
    mobility: prof.mobility ?? 0,
    extraMinutesPerWeek: prof.extra_minutes_per_week ?? 0,
    standalone: prof.standalone ?? true,
    focus: prof.focus ?? null,
    avoidHits: hits,
  };
}

/**
 * Change in each primary lift's estimated max over one run: best Epley in the first 14 days against the last 14,
 * within the rep range with the most sets across both windows (load only; deloads left out). Runs shorter than
 * 4 weeks give nothing.
 */
export function liftChanges(sets, start, end) {
  if (daysBetween(start, end) < 2 * HISTORY_WINDOW_DAYS - 1) return [];
  const earlyTo = addDays(start, HISTORY_WINDOW_DAYS - 1);
  const lateFrom = addDays(end, -(HISTORY_WINDOW_DAYS - 1));
  const lifts = new Map();
  for (const s of sets) {
    if (!s.is_primary || !s.canonical_id || s.date < start || s.date > end || !(s.reps >= 1)) continue;
    if (/deload/i.test(s.workout ?? '') || !(totalLbs(s) > 0)) continue;
    const win = s.date <= earlyTo ? 'early' : s.date >= lateFrom ? 'late' : null;
    if (!win) continue;
    if (!lifts.has(s.canonical_id)) lifts.set(s.canonical_id, { name: s.canonical_name ?? s.exercise, sets: [] });
    lifts.get(s.canonical_id).sets.push({ win, range: rangeOf(s.reps), e1rm: epley(totalLbs(s), s.reps) });
  }
  const out = [];
  for (const [id, { name, sets: ls }] of lifts) {
    const counts = new Map();
    for (const s of ls) counts.set(s.range, (counts.get(s.range) ?? 0) + 1);
    const both = [...counts].filter(([r]) => ls.some((s) => s.range === r && s.win === 'early') && ls.some((s) => s.range === r && s.win === 'late'));
    if (!both.length) continue;
    const range = both.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    const best = (win) => Math.max(...ls.filter((s) => s.range === range && s.win === win).map((s) => s.e1rm));
    const early = best('early');
    const late = best('late');
    out.push({ id, name, range, early, late, changePct: round(((late - early) / early) * 100, 1) });
  }
  return out.sort((a, b) => b.changePct - a.changePct || a.name.localeCompare(b.name));
}

/** VO2 max change over one run: mean of the readings in its last 28 days minus its first 28 (runs of 8+ weeks). */
export function vo2Change(readings, start, end) {
  if (daysBetween(start, end) < 2 * VO2_WINDOW_DAYS - 1) return null;
  const early = readings.filter((r) => r.date >= start && r.date <= addDays(start, VO2_WINDOW_DAYS - 1)).map((r) => r.value);
  const late = readings.filter((r) => r.date >= addDays(end, -(VO2_WINDOW_DAYS - 1)) && r.date <= end).map((r) => r.value);
  if (!early.length || !late.length) return null;
  return round(avg(late) - avg(early), 1);
}

/**
 * @param {object} input
 * @param {Array<object>} input.programs  catalog programs
 * @param {(name: string) => object} input.lookup  dictionary lookup
 * @param {{avoid?: Array<{exercise: string}>}} [input.substitutions]
 * @param {Array<{program: string, start_date: string, end_date: string|null, status: string, percent: number|null}>} input.blocks
 * @param {Array<object>} input.sets  primary lift sets (date, canonical_id, canonical_name, weight_lbs, per_hand, reps, workout, is_primary)
 * @param {Array<{date: string, value: number}>} input.vo2  VO2 max readings
 * @param {Array<{program: string, minutes: number}>} input.watchMinutes  Apple Watch strength minutes per lifting day
 * @param {Array<{status: string, range: string|null, name: string}>} [input.lifts]  current lift progress
 * @param {string|null} input.lastProgram  the program run last (left out)
 * @param {string} input.asOf
 * @param {{strength?: number, joint?: number, time?: number, vo2?: number}} [input.weights]  0 to 3 each, default 1
 */
export function recommendPrograms({ programs, lookup, substitutions = {}, blocks = [], sets = [], vo2 = [], watchMinutes = [],
  lifts = [], lastProgram = null, asOf, weights = {} }) {
  const w = Object.fromEntries(GOALS.map((g) => [g, weights[g] ?? 1]));
  for (const g of GOALS) {
    if (!Number.isInteger(w[g]) || w[g] < 0 || w[g] > MAX_WEIGHT) throw new RangeError(`weight for ${g} must be a whole number from 0 to ${MAX_WEIGHT}`);
  }
  const weightSum = GOALS.reduce((a, g) => a + w[g], 0);
  const avoid = new Set((substitutions.avoid ?? []).map((a) => a.exercise));
  const profiles = new Map(programs.map((p) => [p.name, programProfile(p, lookup, avoid)]));

  // Watch minutes per program, and the owner's typical watch-to-estimate ratio from well-logged programs.
  const watch = new Map();
  for (const w of watchMinutes) {
    if (!watch.has(w.program)) watch.set(w.program, []);
    watch.get(w.program).push(w.minutes);
  }
  const watchAvg = (name) => {
    const m = watch.get(name) ?? [];
    return m.length >= MIN_WATCH_SESSIONS ? Math.round(avg(m)) : null;
  };
  const ratios = [...profiles].filter(([name, pr]) => watchAvg(name) && pr.estimatedMinutes).map(([name, pr]) => watchAvg(name) / pr.estimatedMinutes);
  const ratio = ratios.length ? round(median(ratios), 2) : 1;
  const stalled = lifts.filter((l) => (l.status === 'stalled' || l.status === 'regressing') && l.range);

  const past = blocks.filter((b) => b.status !== 'in_progress' && b.end_date && b.end_date <= asOf);
  const score = (program) => {
    const pr = profiles.get(program.name);
    const runs = past.filter((b) => b.program === program.name).sort((a, b) => a.start_date.localeCompare(b.start_date));
    const runLifts = runs.map((b) => ({ block: b, lifts: liftChanges(sets, b.start_date, b.end_date) })).filter((r) => r.lifts.length);
    const runVo2 = runs.map((b) => ({ block: b, change: vo2Change(vo2, b.start_date, b.end_date) })).filter((r) => r.change !== null);
    const liftHistory = runLifts.length ? round(avg(runLifts.map((r) => median(r.lifts.map((l) => l.changePct)))), 1) : null;
    const vo2History = runVo2.length ? round(avg(runVo2.map((r) => r.change)), 1) : null;
    const percents = runs.map((b) => b.percent).filter((p) => p !== null && p !== undefined);
    const completion = percents.length ? Math.round(avg(percents)) : null;

    const fresh = pr.mainRange && stalled.some((l) => l.range !== 'reps' && l.range !== pr.mainRange);
    const strengthProfile = Math.min(1, (pr.heavyPct + 0.5 * pr.moderatePct) / 50);
    const strengthBase = liftHistory === null ? strengthProfile : (strengthProfile + clamp(0.5 + liftHistory / 20)) / 2;
    const joint = (0.5 * Math.min(1, pr.unilateralPct / 40) + 0.3 * (pr.mobility / 3) + 0.2 * (1 - Math.min(1, pr.armIsolationPct / 40)))
      * (pr.avoidHits.length ? 0.75 : 1);
    const minutesPerSession = watchAvg(program.name) ?? Math.round(pr.estimatedMinutes * ratio);
    const weeklyMinutes = Math.round(minutesPerSession * pr.sessionsPerWeek + pr.extraMinutesPerWeek);
    const vo2Profile = pr.conditioning / 3;
    const scores = {
      strength: round(Math.min(1, strengthBase + (fresh ? 0.1 : 0)), 2),
      joint: round(joint, 2),
      time: round(clamp((360 - weeklyMinutes) / 240), 2),
      vo2: round(vo2History === null ? vo2Profile : (vo2Profile + clamp(0.5 + vo2History / 2)) / 2, 2),
    };
    const multiplier = completion === null ? 1 : 0.5 + (0.5 * completion) / 100;
    const total = weightSum ? round((GOALS.reduce((a, g) => a + w[g] * scores[g], 0) / weightSum) * multiplier, 2) : null;

    const reasons = [];
    const lastLifts = runLifts.at(-1);
    if (lastLifts) {
      const top = lastLifts.lifts.slice(0, 2).map((l) => `${l.name} ${signed(l.changePct, '%')}`);
      reasons.push(`Your ${monthYear(lastLifts.block.start_date)} run: ${top.join(', ')}`);
    }
    const lastVo2 = runVo2.at(-1);
    if (lastVo2) reasons.push(`VO2 max ${signed(lastVo2.change)} during your ${lastVo2.block.start_date.slice(0, 4)} run`);
    reasons.push(`About ${pr.sessionsPerWeek} x ${minutesPerSession} min a week${pr.extraMinutesPerWeek ? ` plus ${pr.extraMinutesPerWeek} min of extra sessions` : ''}`);
    if (completion !== null) reasons.push(`You reached ${completion}% of it on average (${runs.length} ${runs.length === 1 ? 'run' : 'runs'})`);
    if (fresh) reasons.push(`Trains mostly ${pr.mainRange} reps, a change for your stalled lifts`);
    const flags = pr.avoidHits.map((h) => `Prescribes ${h.name} (${h.phase}), on your avoid list`);

    return {
      program: program.name,
      total,
      scores,
      completion,
      runs: runs.length,
      lessHistory: !runLifts.length && !runVo2.length,
      liftChangePct: liftHistory,
      vo2Change: vo2History,
      minutesPerSession,
      minutesSource: watchAvg(program.name) ? 'watch' : 'estimate',
      sessionsPerWeek: pr.sessionsPerWeek,
      weeklyMinutes,
      heavyPct: pr.heavyPct,
      moderatePct: pr.moderatePct,
      unilateralPct: pr.unilateralPct,
      armIsolationPct: pr.armIsolationPct,
      mainRange: pr.mainRange,
      focus: pr.focus,
      reasons,
      flags,
    };
  };

  const byTotal = (a, b) => (b.total ?? 0) - (a.total ?? 0) || a.program.localeCompare(b.program);
  const standalone = programs.filter((p) => profiles.get(p.name).standalone);
  return {
    asOf,
    weights: w,
    minutesRatio: ratio,
    excluded: lastProgram ? [{ program: lastProgram, reason: 'run last' }] : [],
    ranking: standalone.filter((p) => p.name !== lastProgram).map(score).sort(byTotal),
    addons: programs.filter((p) => !profiles.get(p.name).standalone).map(score).sort(byTotal),
  };
}

export const REVIEW_DAYS_BEFORE_FINISH = 21;

/**
 * Whether the weekly review gets the ranking: no program block that week, a block that has ended or run past its
 * program, or one within 21 days of its earliest finish.
 * @param {{status?: string, earliestFinish?: string|null, pastProgramEnd?: boolean}|null} program  the week's block (programAt)
 */
export function advisorDue(program, weekEnd) {
  if (!program || program.status !== 'in_progress' || program.pastProgramEnd) return true;
  return Boolean(program.earliestFinish) && daysBetween(weekEnd, program.earliestFinish) <= REVIEW_DAYS_BEFORE_FINISH;
}

/** The review's copy of a ranking: the top 3 with scores, reasons and flags, the program left out and the add-ons. */
export function advisorForReview(result, top = 3) {
  return {
    weights: result.weights,
    leftOut: result.excluded.map((x) => `${x.program} (${x.reason})`),
    top: result.ranking.slice(0, top).map((r) => ({
      program: r.program, total: r.total, scores: r.scores, completionPct: r.completion, weeklyMinutes: r.weeklyMinutes,
      lessHistory: r.lessHistory, reasons: r.reasons, flags: r.flags,
    })),
    addons: result.addons.map((r) => ({ program: r.program, total: r.total })),
  };
}
