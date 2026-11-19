// Which training program a lifting day belongs to, read from the Workout Log's "Workout" names.
// To add or rename a built-in program, edit PROGRAMS (first match wins, so specific patterns go first). A user's own
// programs (multi-user, phase 5) add their match words in front of these (userMatchers), so theirs win.

import type { Row } from './stats.ts';

/** A program name and the pattern its Workout Log names match. */
export type Matcher = [string, RegExp];

export const PROGRAMS: Matcher[] = [
  ['MAPS Anabolic Advanced', /anabolic advanced/i],
  ['MAPS Anabolic', /anabolic/i],
  ['MAPS Anywhere', /anywhere/i],
  ['MAPS Performance', /performance foundation/i],
  ['MAPS Powerlift', /powerlift/i],
  ['MAPS Aesthetic', /aesthetic/i],
  ['MAPS Split', /\bsplit\b/i],
  ['MAPS Symmetry', /symmetry/i],
  ['MAPS 15 Advanced', /maps 15/i], // every MAPS 15 workout logged so far is Advanced (owner, 2026-10-05)
  ['No BS 6-Pack', /no bs/i],
  ['HIIT', /\bhiit\b|\bhitt\b/i],
  ['Between programs', /between programs/i],
  ['Home workouts', /\bhome\b|corona/i],
];

/** The program a workout name belongs to, or null (one-offs, notes typed in the column, blanks). */
export function programOf(workoutName: string | null | undefined, matchers: Matcher[] = PROGRAMS): string | null {
  if (!workoutName) return null;
  return matchers.find(([, re]) => re.test(workoutName))?.[0] ?? null;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A user's own programs as matchers, in front of PROGRAMS: each program's match words (comma separated; each one a
 * whole word or phrase, any case, spaces flexible), or its name when it has none.
 */
export function userMatchers(programs: { name: string, match?: string | null }[] = []): Matcher[] {
  const own = programs.map(({ name, match }): Matcher => {
    const words = String(match || name).split(',').map((w) => w.trim()).filter(Boolean);
    return [name, new RegExp(words.map((w) => `(?<![\\w])${escape(w).replace(/\s+/g, '\\s+')}(?![\\w])`).join('|'), 'i')];
  });
  return own.length ? [...own, ...PROGRAMS] : PROGRAMS;
}

// Programs run for weeks and the log names a workout only on its first row (and not every day), so a
// lifting day with no recognizable name takes the program of the nearest named day up to this many
// days before it.
export const FILL_DAYS = 7;

// Trigger Sessions belong to whatever program is running at the time (MAPS Symmetry, Anabolic, ...).
const TRIGGER = /trigger session/i;
export const TRIGGER_FILL_DAYS = 14;

/**
 * Program per lifting day.
 * sets: set rows (any order), a day's first named workout winning; liftingDates: the days to label; matchers: first
 * match wins (userMatchers; default PROGRAMS).
 */
export function programsByDay(sets: Row[], liftingDates: Iterable<string>, matchers: Matcher[] = PROGRAMS): Map<string, string | null> {
  const named = new Map<string, string>();
  for (const s of [...sets].sort((a, b) => a.date.localeCompare(b.date))) {
    const program = programOf(s.workout, matchers);
    if (program && !named.has(s.date)) named.set(s.date, program);
  }
  const shift = (date: string, n: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  // Trigger Sessions are add-ons to whichever program is running, so they may also look ahead (one
  // done at the very start of a program comes before its first named workout).
  const trigger = new Set(sets.filter((s) => TRIGGER.test(s.workout ?? '')).map((s) => s.date));
  const out = new Map<string, string | null>();
  for (const date of liftingDates) {
    let program = named.get(date) ?? null;
    if (!program && trigger.has(date)) {
      for (let n = 1; !program && n <= TRIGGER_FILL_DAYS; n++) program = named.get(shift(date, -n)) ?? named.get(shift(date, n)) ?? null;
    }
    for (let n = 1; !program && n <= FILL_DAYS; n++) program = named.get(shift(date, -n)) ?? null;
    out.set(date, program);
  }
  return out;
}

/** Programs across a set of days, most days first: [{ name, days }], plus the days with none. */
export function programSummary(dates: Iterable<string>, byDay: Map<string, string | null>) {
  const counts = new Map<string, number>();
  let unknown = 0;
  for (const d of dates) {
    const p = byDay.get(d);
    if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
    else unknown += 1;
  }
  return {
    programs: [...counts].map(([name, days]) => ({ name, days })).sort((a, b) => b.days - a.days || a.name.localeCompare(b.name)),
    noProgramDays: unknown,
  };
}
