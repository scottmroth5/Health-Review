// The owner's time zone. Every "today", local wall-clock time and schedule goes through OWNER_TZ (default
// America/New_York), never the host's zone, so the app is right on a server set to UTC. Pure, no library: the
// platform's Intl time zone data. Dates are stored as local wall-clock text (YYYY-MM-DD, YYYY-MM-DDTHH:MM).
export const DEFAULT_TZ = 'America/New_York';

/** The owner's IANA time zone (OWNER_TZ), checked once per value; an unknown zone throws rather than falling back. */
export function ownerTz(env = process.env) {
  const tz = env.OWNER_TZ || DEFAULT_TZ;
  formatter(tz);
  return tz;
}

const formatters = new Map();
function formatter(tz) {
  if (!formatters.has(tz)) {
    formatters.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return formatters.get(tz);
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * The wall-clock parts of an instant in a time zone.
 * @param {Date|string|number} [instant]  defaults to now
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, second: number, weekday: number }}
 *   month 1 to 12; weekday 0 (Sunday) to 6
 */
export function zonedParts(instant = new Date(), tz = ownerTz()) {
  const d = instant instanceof Date ? instant : new Date(instant);
  const p = Object.fromEntries(formatter(tz).formatToParts(d).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second), weekday: WEEKDAYS[p.weekday],
  };
}

const pad = (n) => String(n).padStart(2, '0');

/** The owner's calendar date of an instant, YYYY-MM-DD. */
export function localDate(instant = new Date(), tz = ownerTz()) {
  const p = zonedParts(instant, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** The owner's wall-clock minute of an instant (such as Drive's modifiedTime), YYYY-MM-DDTHH:MM. */
export function localStamp(instant, tz = ownerTz()) {
  const p = zonedParts(instant, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}
