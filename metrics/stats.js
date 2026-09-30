// Small numeric and date helpers shared by the metric modules. Dates are 'YYYY-MM-DD' text.
const DAY_MS = 86400000;
const toMs = (date) => Date.parse(`${date}T00:00:00Z`);

export const addDays = (date, n) => new Date(toMs(date) + n * DAY_MS).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY_MS);
export const inRange = (date, from, to) => date >= from && date <= to;

/** Rounds half away from zero to d decimals; null stays null. -0 becomes 0. */
export function round(x, d = 0) {
  if (x === null || x === undefined || Number.isNaN(x)) return null;
  const f = 10 ** d;
  const r = (Math.sign(x) * Math.round(Math.abs(x) * f)) / f;
  return r === 0 ? 0 : r;
}

const clean = (values) => values.filter((v) => typeof v === 'number' && Number.isFinite(v));

export function mean(values) {
  const v = clean(values);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
}

/** Sample standard deviation; null with fewer than two values. */
export function sd(values) {
  const v = clean(values);
  if (v.length < 2) return null;
  const m = mean(v);
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1));
}

export const sum = (values) => clean(values).reduce((s, x) => s + x, 0);

/** Pearson correlation of paired values; null below minPairs or when either side is constant. */
export function pearson(pairs, minPairs = 10) {
  const p = pairs.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  if (p.length < minPairs) return null;
  const ma = mean(p.map(([a]) => a));
  const mb = mean(p.map(([, b]) => b));
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
export function windows(weekEnd) {
  return {
    week: { from: addDays(weekEnd, -6), to: weekEnd },
    prevWeek: { from: addDays(weekEnd, -13), to: addDays(weekEnd, -7) },
    baseline: { from: addDays(weekEnd, -34), to: addDays(weekEnd, -7) },
    strength: { from: addDays(weekEnd, -27), to: weekEnd },
    long: { from: addDays(weekEnd, -89), to: weekEnd },
  };
}

/** The most recent Saturday strictly before today (the week a Sunday report covers). */
export function lastWeekEnd(today) {
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(today, -(dow === 6 ? 7 : dow + 1));
}
