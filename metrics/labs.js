// Lab results for the weekly summary: each test's latest value and its change from the previous
// draw. There are no reference ranges (the owner's choice), so nothing is marked high or low here;
// any interpretation belongs to physician discussion.
import { round, inRange, addDays, daysBetween } from './stats.js';

const decimals = (text) => (/^-?\d+\.(\d+)$/.exec(String(text).trim())?.[1].length ?? 0);
const shown = (r) => (r.value === null || r.value === undefined ? r.value_text : r.value);

/**
 * @param {Array<{id, name, panel, unit, position}>} tests
 * @param {Array<{test_id, drawn_on, value, value_text}>} results
 * @param {string} weekEnd
 */
export function labsSummary(tests, results, weekEnd) {
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
