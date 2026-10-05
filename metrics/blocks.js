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
import { daysBetween } from './stats.js';
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
 * Where a program block stands on a date, for the weekly review: program, week, and (with the catalog)
 * program length, phase and deload or failure week. Computed facts only; never blueprint text.
 */
export function programAt(block, catalog, date) {
  if (!block) return null;
  const week = weekOf(block.start_date, date);
  const at = catalog?.phaseAt(block.program, week) ?? null;
  return {
    program: block.program,
    status: block.status,
    week,
    programWeeks: catalog?.programWeeks(block.program) ?? null,
    phase: at && !at.beyond ? at.phase : null,
    pastProgramEnd: Boolean(at?.beyond),
    deloadWeek: Boolean(at?.deload),
    failureWeek: Boolean(at?.failure),
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

