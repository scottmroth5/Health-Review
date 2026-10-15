// Lab results for the weekly summary: each test's latest value, its change from the previous draw, and its reference
// range with where the value sits (below, within or above). Ranges are the owner's from their lab report, or typical
// ones (config/lab-ranges.json) until then (owner's choice, 2026-10-15). Code marks below and above range only, never
// normal or abnormal; any interpretation belongs to physician discussion.
import { readFileSync } from 'node:fs';
import { repoPath } from '../tools/paths.js';
import { round, inRange, addDays, daysBetween } from './stats.js';

export const LAB_RANGES_PATH = repoPath('config', 'lab-ranges.json');
export const loadLabRanges = (path = LAB_RANGES_PATH) => JSON.parse(readFileSync(path, 'utf8'));

/** The typical range for a test name (case-insensitive name or alias), or null. */
export function typicalRange(name, config) {
  const key = String(name ?? '').trim().toLowerCase();
  const t = (config?.tests ?? []).find((x) => x.name.toLowerCase() === key || (x.aliases ?? []).some((a) => a.toLowerCase() === key));
  return t ? { low: t.low ?? null, high: t.high ?? null, unit: t.unit ?? null, note: t.note ?? null } : null;
}

/**
 * The range in effect for a test: the owner's (ref_set) or the typical one, with where it came from; null when neither.
 * @returns {{ low: number|null, high: number|null, source: 'yours'|'typical' }|null}
 */
export function effectiveRange(test, config) {
  if (test.ref_set) return test.ref_low === null && test.ref_high === null ? null : { low: test.ref_low, high: test.ref_high, source: 'yours' };
  const t = typicalRange(test.name, config);
  return t && (t.low !== null || t.high !== null) ? { low: t.low, high: t.high, source: 'typical' } : null;
}

/** Where a numeric value sits against a range: below, within (bounds included) or above; null without both. */
export function rangeStatus(value, range) {
  if (typeof value !== 'number' || !range || (range.low === null && range.high === null)) return null;
  if (range.low !== null && range.low !== undefined && value < range.low) return 'below';
  if (range.high !== null && range.high !== undefined && value > range.high) return 'above';
  return 'within';
}

const decimals = (text) => (/^-?\d+\.(\d+)$/.exec(String(text).trim())?.[1].length ?? 0);
const shown = (r) => (r.value === null || r.value === undefined ? r.value_text : r.value);

/**
 * @param {Array<{id, name, panel, unit, position}>} tests
 * @param {Array<{test_id, drawn_on, value, value_text}>} results
 * @param {string} weekEnd
 */
export function labsSummary(tests, results, weekEnd, rangesConfig = null) {
  const upTo = results.filter((r) => r.drawn_on <= weekEnd);
  const draws = [...new Set(upTo.map((r) => r.drawn_on))].sort();
  const latestDraw = draws[draws.length - 1] ?? null;

  const out = tests
    .map((t) => {
      const mine = upTo.filter((r) => r.test_id === t.id).sort((a, b) => b.drawn_on.localeCompare(a.drawn_on));
      if (!mine.length) return null;
      const [latest, previous] = mine;
      const numeric = previous && typeof latest.value === 'number' && typeof previous.value === 'number';
      const d = numeric ? Math.max(decimals(latest.value_text), decimals(previous.value_text)) : 0;
      return {
        panel: t.panel ?? null,
        test: t.name,
        unit: t.unit ?? null,
        latest: { date: latest.drawn_on, value: shown(latest) },
        previous: previous ? { date: previous.drawn_on, value: shown(previous) } : null,
        change: numeric ? round(latest.value - previous.value, d) : null,
        ...(() => {
          const range = effectiveRange(t, rangesConfig);
          return range ? { range: { low: range.low, high: range.high }, rangeStatus: rangeStatus(latest.value, range) } : {};
        })(),
        position: t.position ?? 9999,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.position - b.position || a.test.localeCompare(b.test))
    .map(({ position, ...r }) => r);

  return {
    draws: draws.length,
    latestDraw,
    daysSinceLatestDraw: latestDraw ? daysBetween(latestDraw, weekEnd) : null,
    newThisWeek: draws.some((d) => inRange(d, addDays(weekEnd, -6), weekEnd)),
    results: out,
  };
}
