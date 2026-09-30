// Google Sheets serial dates (days since 1899-12-30, fraction = time of day) as local
// wall-clock text. The serial already holds the sheet's local time, so no time zone math.
const EPOCH_MS = Date.UTC(1899, 11, 30);

/** 'YYYY-MM-DDTHH:MM:SS', rounded to the second. */
export function serialToDateTime(serial) {
  return new Date(EPOCH_MS + Math.round(serial * 86400) * 1000).toISOString().slice(0, 19);
}

/** 'YYYY-MM-DD' of the calendar day the serial falls on. */
export function serialToDate(serial) {
  return serialToDateTime(serial).slice(0, 10);
}

/** A duration serial (fraction of a day) in whole seconds. */
export function serialToSeconds(serial) {
  return Math.round(serial * 86400);
}

/** 'MM/DD/YYYY' (or M/D/YYYY) text as 'YYYY-MM-DD', or null when it is not a valid date. */
export function parseUsDate(text) {
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(String(text));
  if (!m) return null;
  const [, mo, d, y] = m.map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}
