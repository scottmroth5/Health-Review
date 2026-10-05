// Program block detection from Workout Log history (pure). A block is one run of a program: consecutive
// lifting days on the same program, named by the program only (owner's choice: one block per run, phases ignored).
// Each lifting day's program comes from programsByDay (workout names, 7-day back-fill, Trigger Sessions
// ±14 days). Days with no program, and breaks of any length, between two days of the same program join that
// block as long as no other program comes in between (owner's rule, 2026-10-02: one block per program run,
// whatever the phases); unnamed days with no same-program day after them are left unassigned. Non-program stretches
// ("Between programs", "Home workouts") are blocks of their own, but a Between programs, HIIT or ab-program
// stretch between two parts of one program's run joins that run (counted in its notes). Phases are kept on the
// detection result only; blocks show the program name. Status: in progress when the last session is
// within IN_PROGRESS_DAYS of today, otherwise completed; "abandoned" is only ever set by the owner.
import { addDays, daysBetween } from './stats.js';
import { programsByDay } from './programs.js';

export const IN_PROGRESS_DAYS = 14;
// Stretches that never split a run: add-on programs done alongside another one, and time between programs.
// A stretch of them between two parts of the same program joins that block (counted in its notes).
export const ADDONS = ['HIIT', 'No BS 6-Pack', 'Between programs'];

const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5 };
/** "Phase 2" from "... Phase II Day 3", "Deload" from a deload week, or null. */
export function phaseOf(workoutName) {
  const text = String(workoutName ?? '');
  if (/deload/i.test(text)) return 'Deload';
  const m = /phase\s*([0-9]+|i{1,3}|iv|v)\b/i.exec(text);
  if (!m) return null;
  return `Phase ${ROMAN[m[1].toLowerCase()] ?? Number(m[1])}`;
}

/** Joins Between programs, HIIT and ab-program stretches sandwiched between two parts of the same program into it. */
function mergeAddons(blocks) {
  for (let i = 1; i < blocks.length - 1; i++) {
    const [before, addon, after] = [blocks[i - 1], blocks[i], blocks[i + 1]];
    if (!ADDONS.includes(addon.program) || before.program !== after.program) continue;
    before.sessions.push(...addon.sessions, ...after.sessions);
    for (const ph of after.phases) if (!before.phases.includes(ph)) before.phases.push(ph);
    before.addons = { ...before.addons };
    before.addons[addon.program] = (before.addons[addon.program] ?? 0) + addon.sessions.length;
    for (const [k, n] of Object.entries(after.addons ?? {})) before.addons[k] = (before.addons[k] ?? 0) + n;
    blocks.splice(i, 2);
    i -= 1;
  }
}

/** Week number within a block, starting at 1 on its first day. */
export const weekOf = (blockStart, date) => Math.floor(daysBetween(blockStart, date) / 7) + 1;

/**
 * The phases logged in a block, from workout names: [{ phase, start }] in order, one entry each time the named
 * phase changes. Deload weeks are markers inside a phase, not phases, so they are left out here.
 * @param {Array<{date: string, workout?: string|null}>} rows  the block's rows (any order)
 */
export function loggedPhases(rows) {
  const out = [];
  for (const r of [...rows].sort((x, y) => x.date.localeCompare(y.date))) {
    const p = phaseOf(r.workout);
    if (!p || p === 'Deload' || out[out.length - 1]?.phase === p) continue;
    out.push({ phase: p, start: r.date });
  }
  return out;
}

/** The phase of a day in a block: the latest logged phase on or before it, else the calendar's, else null. */
export function phaseOnDay(block, logged, catalog, date) {
  const named = [...logged].reverse().find((l) => l.start <= date);
  if (named) return named.phase;
  const at = catalog?.phaseAt(block.program, weekOf(block.start_date, date));
  return at ? (at.beyond ? 'Beyond program' : at.phase) : null;
}

/**
 * Where a program block stands on a date. The phase and its start come from the workout names (the owner misses
 * days and adjusts, so calendar weeks drift); the catalog only supplies phase lengths. Without phase names the
 * calendar is used and the result is marked estimated.
 *   week          program week: the phase's first catalog week plus weeks since the phase started
 *   earliestFinish  phase start plus the rest of this phase and all later phases at full speed
 *   paceFinish    the same, stretched by this block's pace so far (actual / planned weeks of completed phases)
 * @param {{program: string, start_date: string, status?: string}} block
 * @param {Array<{date: string, workout?: string|null}>} rows  the block's rows up to the date
 */
export function programProgress(block, rows, catalog, date) {
  const program = catalog?.find(block.program) ?? null;
  const logged = loggedPhases(rows.filter((r) => r.date <= date));
  const current = logged[logged.length - 1] ?? null;
  const base = { program: block.program, status: block.status ?? null, programWeeks: program?.weeks ?? null };
  const deloadLogged = rows.some((r) => r.date <= date && r.date > addDays(date, -7) && phaseOf(r.workout) === 'Deload');

  if (!current) {
    const week = weekOf(block.start_date, date);
    const at = catalog?.phaseAt(block.program, week) ?? null;
    return { ...base, estimated: true, phase: at && !at.beyond ? at.phase : null, phaseStarted: null, phaseWeek: null, phaseWeeks: null,
      week, pastProgramEnd: Boolean(at?.beyond), deloadWeek: Boolean(at?.deload) || deloadLogged, failureWeek: Boolean(at?.failure),
      earliestFinish: program ? addDays(block.start_date, program.weeks * 7 - 1) : null, paceFinish: null, pace: null };
  }

  const phaseWeek = weekOf(current.start, date);
  const ph = program?.phases.find((p) => p.name === current.phase) ?? null;
  if (!ph) {
    return { ...base, estimated: false, phase: current.phase, phaseStarted: current.start, phaseWeek, phaseWeeks: null,
      week: null, pastProgramEnd: false, deloadWeek: deloadLogged, failureWeek: false, earliestFinish: null, paceFinish: null, pace: null };
  }
  const phaseWeeks = ph.weeks[1] - ph.weeks[0] + 1;
  const week = ph.weeks[0] + Math.min(phaseWeek, phaseWeeks) - 1;
  const at = catalog.phaseAt(block.program, week);
  // Pace over the phases already finished in this block, each from its logged start to the next one's.
  let actual = 0;
  let planned = 0;
  for (let i = 0; i < logged.length - 1; i++) {
    const done = program.phases.find((p) => p.name === logged[i].phase);
    if (!done) continue;
    actual += daysBetween(logged[i].start, logged[i + 1].start) / 7;
    planned += done.weeks[1] - done.weeks[0] + 1;
  }
  const pace = planned ? Math.round((actual / planned) * 100) / 100 : null;
  const remainingDays = (program.weeks - ph.weeks[0] + 1) * 7;
  const earliestFinish = addDays(current.start, remainingDays - 1);
  return {
    ...base,
    estimated: false,
    phase: current.phase,
    phaseStarted: current.start,
    phaseWeek,
    phaseWeeks,
    week,
    pastProgramEnd: false,
    deloadWeek: Boolean(at?.deload) || deloadLogged,
    failureWeek: Boolean(at?.failure),
    earliestFinish,
    paceFinish: pace ? addDays(current.start, Math.round(remainingDays * Math.max(pace, 1)) - 1) : null,
    pace,
  };
}

/** Where a program block stands on a date, for the weekly review. Computed facts only; never blueprint text. */
export function programAt(block, catalog, date, rows = []) {
  if (!block) return null;
  const p = programProgress(block, rows, catalog, date);
  return {
    program: p.program, status: p.status, phase: p.phase, phaseStarted: p.phaseStarted, phaseWeek: p.phaseWeek, phaseWeeks: p.phaseWeeks,
    week: p.week, programWeeks: p.programWeeks, earliestFinish: p.earliestFinish, paceFinish: p.paceFinish,
    pastProgramEnd: p.pastProgramEnd, deloadWeek: p.deloadWeek, failureWeek: p.failureWeek, estimatedFromCalendar: p.estimated,
  };
}

/**
 * @param {Array<{date: string, workout?: string|null}>} sets  set rows (any order; planned rows are fine)
 * @param {string[]} liftingDates  days with performed sets, up to today
 * @param {string} today
 * @returns {{ blocks: Array<{program, phases: string[], notes, start_date, end_date, last_session, status, sessions: string[]}>,
 *             unassigned: string[] }}
 */
export function detectBlocks(sets, liftingDates, today) {
  const dates = [...new Set(liftingDates)].sort();
  const byDay = programsByDay(sets, dates);
  const phasesByDay = new Map();
  for (const s of [...sets].sort((a, b) => a.date.localeCompare(b.date))) {
    const p = phaseOf(s.workout);
    if (p && !phasesByDay.has(s.date)) phasesByDay.set(s.date, p);
  }

  const blocks = [];
  const unassigned = [];
  let current = null;
  let pending = []; // days with no program since the current block's last known day
  const close = () => {
    unassigned.push(...pending);
    pending = [];
    if (current) blocks.push(current);
    current = null;
  };
  for (const date of dates) {
    const program = byDay.get(date);
    if (!program) {
      if (current) pending.push(date); else unassigned.push(date);
      continue;
    }
    if (current && current.program === program) {
      current.sessions.push(...pending, date);
      pending = [];
    } else {
      close();
      current = { program, sessions: [date], phases: [] };
    }
    const phase = phasesByDay.get(date);
    if (phase && !current.phases.includes(phase)) current.phases.push(phase);
  }
  close();
  mergeAddons(blocks);

  return {
    blocks: blocks.map((b) => {
      const last = b.sessions[b.sessions.length - 1];
      const inProgress = daysBetween(last, today) <= IN_PROGRESS_DAYS;
      return {
        program: b.program,
        phases: b.phases,
        notes: Object.entries(b.addons ?? {}).map(([name, n]) => `includes ${n} ${name} session${n === 1 ? '' : 's'}`).join('; ') || null,
        start_date: b.sessions[0],
        end_date: inProgress ? null : last,
        last_session: last,
        status: inProgress ? 'in_progress' : 'completed',
        sessions: b.sessions,
      };
    }),
    unassigned: unassigned.sort(),
  };
}

