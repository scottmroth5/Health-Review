// VO2 max report for the Health tab: Apple Watch estimates, which arrive every day or two and change
// slowly. Short views plot each reading; long views plot weekly or monthly averages. Days without a
// reading are unknown, so an empty week or month is left out rather than drawn as zero. Values only:
// no fitness-for-age labels (same rule as labs).
import { addDays, inRange, mean, round } from './stats.js';
import { saturdayOnOrAfter } from './volume.js';

export const VO2_VIEWS = ['90d', '1y', '2y', '5y', 'all'];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const yearsBack = (date, n) => `${Number(date.slice(0, 4)) - n}${date.slice(4)}`.replace(/-02-29$/, '-02-28');
const niceDay = (date) => `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}, ${date.slice(0, 4)}`;

/** First day the view covers (the All view starts at the first reading's month). */
export function vo2ViewStart(view, today, firstDate = today) {
  switch (view) {
    case '90d': return addDays(today, -89);
    case '1y': return addDays(today, -364);
    case '2y': return addDays(yearsBack(today, 2), 1);
    case '5y': return `${yearsBack(today, 5).slice(0, 7)}-01`;
    case 'all': return `${firstDate.slice(0, 7)}-01`;
    default: throw new Error(`Unknown view: ${view}`);
  }
}

/** The latest reading on or before date, if it is no more than 30 days older. */
function readingNear(readings, date) {
  const r = [...readings].reverse().find((x) => x.date <= date);
  return r && r.date >= addDays(date, -30) ? r : null;
}

function averaged(readings, keyOf, labelOf) {
  const groups = new Map();
  for (const r of readings) {
    const k = keyOf(r.date);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r.value);
  }
  return [...groups].map(([k, values]) => ({ date: k, value: round(mean(values), 1), label: labelOf(k), n: values.length }));
}

/**
 * @param {Array<{date: string, vo2max: number|null}>} rows
 * @param {string} view   one of VO2_VIEWS
 * @param {string} today
 */
export function vo2maxReport(rows, view, today) {
  if (!VO2_VIEWS.includes(view)) throw new Error(`Unknown view: ${view}`);
  const readings = rows
    .filter((r) => r.vo2max !== null && r.vo2max !== undefined && r.date <= today)
    .map((r) => ({ date: r.date, value: r.vo2max }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const range = { from: vo2ViewStart(view, today, readings[0]?.date), to: today };
  const inView = readings.filter((r) => inRange(r.date, range.from, range.to));

  let bucket;
  let points;
  if (view === '90d' || view === '1y') {
    bucket = 'reading';
    points = inView.map((r) => ({ date: r.date, value: round(r.value, 1) }));
  } else if (view === '2y') {
    bucket = 'week';
    points = averaged(inView, (d) => addDays(saturdayOnOrAfter(d), -6), (start) => `Week ending ${niceDay(addDays(start, 6))}`);
  } else {
    bucket = 'month';
    points = averaged(inView, (d) => `${d.slice(0, 7)}-01`, (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`);
  }

  const latest = readings[readings.length - 1] ?? null;
  const change = (daysAgo) => {
    const then = latest && readingNear(readings, addDays(today, -daysAgo));
    return then ? { value: round(latest.value - then.value, 1), from: { date: then.date, value: round(then.value, 1) } } : null;
  };
  const best = readings.reduce((b, r) => (!b || r.value > b.value ? r : b), null);

  return {
    view,
    range,
    bucket,
    points,
    latest: latest && { date: latest.date, value: round(latest.value, 1) },
    change90d: change(90),
    change1y: change(365),
    best: best && { date: best.date, value: round(best.value, 1) },
    rangeAvg: inView.length ? round(mean(inView.map((r) => r.value)), 1) : null,
    readings: inView.length,
  };
}
