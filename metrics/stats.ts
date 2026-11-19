// Small numeric and date helpers shared by the metric modules. Dates are 'YYYY-MM-DD' text.
/** A database row as the metrics read it: its SQL decides the shape (as in db/). */
export type Row = Record<string, any>;

const DAY_MS = 86400000;
const toMs = (date: string): number => Date.parse(`${date}T00:00:00Z`);

export const addDays = (date: string, n: number): string => new Date(toMs(date) + n * DAY_MS).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string): number => Math.round((toMs(b) - toMs(a)) / DAY_MS);
export const inRange = (date: string, from: string, to: string): boolean => date >= from && date <= to;

/** Rounds half away from zero to d decimals; null stays null. -0 becomes 0. */
export function round(x: number, d?: number): number;
export function round(x: number | null | undefined, d?: number): number | null;
export function round(x: number | null | undefined, d = 0): number | null {
  if (x === null || x === undefined || Number.isNaN(x)) return null;
  const f = 10 ** d;
  const r = (Math.sign(x) * Math.round(Math.abs(x) * f)) / f;
  return r === 0 ? 0 : r;
}

/** Values as the metrics hold them: numbers, with null or undefined for unknown. */
export type Values = readonly (number | null | undefined)[];

const clean = (values: Values): number[] => values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

export function mean(values: Values): number | null {
  const v = clean(values);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
}

/** Sample standard deviation; null with fewer than two values. */
export function sd(values: Values): number | null {
  const v = clean(values);
  if (v.length < 2) return null;
  const m = mean(v) as number;
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1));
}

export const sum = (values: Values): number => clean(values).reduce((s, x) => s + x, 0);

/** Pearson correlation of paired values; null below minPairs or when either side is constant. */
export function pearson(pairs: readonly (readonly [number | null | undefined, number | null | undefined])[], minPairs = 10): number | null {
  const p = pairs.filter((x): x is [number, number] => Number.isFinite(x[0]) && Number.isFinite(x[1]));
  if (p.length < minPairs) return null;
  const ma = mean(p.map(([a]) => a)) as number;
  const mb = mean(p.map(([, b]) => b)) as number;
  let num = 0;
  let da = 0;
  let db = 0;
  for (const [a, b] of p) {
    num += (a - ma) * (b - mb);
    da += (a - ma) ** 2;
    db += (b - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : null;
}

/** The review week and comparison windows for a week ending on weekEnd (inclusive). */
/** A from and to date, both inclusive. */
export interface Window { from: string; to: string }

export function windows(weekEnd: string): Record<'week' | 'prevWeek' | 'baseline' | 'strength' | 'long', Window> {
  return {
    week: { from: addDays(weekEnd, -6), to: weekEnd },
    prevWeek: { from: addDays(weekEnd, -13), to: addDays(weekEnd, -7) },
    baseline: { from: addDays(weekEnd, -34), to: addDays(weekEnd, -7) },
    strength: { from: addDays(weekEnd, -27), to: weekEnd },
    long: { from: addDays(weekEnd, -89), to: weekEnd },
  };
}

/** The most recent Saturday strictly before today (the week a Sunday report covers). */
export function lastWeekEnd(today: string): string {
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(today, -(dow === 6 ? 7 : dow + 1));
}
