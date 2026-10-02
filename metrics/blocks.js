// Program block detection from Workout Log history (pure). A block is one run of a program: consecutive
// lifting days on the same program, with its phases listed in notes (owner's choice: one block per run).
// Each lifting day's program comes from programsByDay (workout names, 7-day back-fill, Trigger Sessions
// ±14 days). A day with no program between two days of the same block joins it; otherwise it is left
// unassigned. A gap of GAP_DAYS or more between lifting days always ends a block. Non-program stretches
// ("Between programs", "Home workouts") are blocks of their own; a short add-on stretch (HIIT, ab programs)
// between two parts of one block joins it. Phases are listed once each, in order. Status: in progress when the last session is
// within IN_PROGRESS_DAYS of today, otherwise completed; "abandoned" is only ever set by the owner.
import { daysBetween } from './stats.js';
import { programsByDay } from './programs.js';

export const GAP_DAYS = 21;
export const IN_PROGRESS_DAYS = 14;
// Short add-on programs done alongside another one: a stretch of them between two parts of the same block
// joins that block (and is counted in its notes) instead of splitting it.
export const ADDONS = ['HIIT', 'No BS 6-Pack'];

const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5 };
/** "Phase 2" from "... Phase II Day 3", "Deload" from a deload week, or null. */
export function phaseOf(workoutName) {
  const text = String(workoutName ?? '');
  if (/deload/i.test(text)) return 'Deload';
  const m = /phase\s*([0-9]+|i{1,3}|iv|v)\b/i.exec(text);
  if (!m) return null;
  return `Phase ${ROMAN[m[1].toLowerCase()] ?? Number(m[1])}`;
}

/** Joins add-on stretches (HIIT, ab programs) sandwiched between two parts of the same block into it. */
function mergeAddons(blocks) {
  for (let i = 1; i < blocks.length - 1; i++) {
    const [before, addon, after] = [blocks[i - 1], blocks[i], blocks[i + 1]];
    if (!ADDONS.includes(addon.program) || before.program !== after.program || ADDONS.includes(before.program)) continue;
    const span = [before.sessions[before.sessions.length - 1], addon.sessions[0], addon.sessions[addon.sessions.length - 1], after.sessions[0]];
    if (daysBetween(span[0], span[1]) >= GAP_DAYS || daysBetween(span[2], span[3]) >= GAP_DAYS) continue;
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
  let prev = null;
  const close = () => {
    unassigned.push(...pending);
    pending = [];
    if (current) blocks.push(current);
    current = null;
  };
  for (const date of dates) {
    if (prev && daysBetween(prev, date) >= GAP_DAYS) close();
    prev = date;
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
        notes: [b.phases.length ? `Phases: ${b.phases.join(', ')}` : null,
          ...Object.entries(b.addons ?? {}).map(([name, n]) => `includes ${n} ${name} session${n === 1 ? '' : 's'}`)].filter(Boolean).join('; ') || null,
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

