// One-off repair: the consolidated Workout Sessions sheet put every workout's start and end 3 hours late (the v1 Apps
// Script copied rows between files in different time zones), while Health Auto Export's own files are right (confirmed
// by the owner against Fitness, 2026-10-15). Rows written from the export files (updated_at equal to a workout file's
// synced_at in drive_exports) are kept as they are. Every other row came from the sheet: a late twin of an export row is
// deleted, and the rest move back 3 hours. Counts only; never workout details.
import { createTracer } from '@scottmroth5/agent-core';

export const SHEET_LATE_HOURS = 3;
const RUN_NAME = 'fix-session-times';

/** A local wall-clock 'YYYY-MM-DDTHH:MM:SS' moved by whole hours (the stored times have no zone). */
export function moveHours(text, hours) {
  const d = new Date(`${text}Z`);
  d.setUTCHours(d.getUTCHours() + hours);
  return d.toISOString().slice(0, 19);
}

/**
 * Plans the repair, and applies it when apply is true (one transaction; refused when it was applied before, or when a
 * moved workout would land on one already stored).
 * @returns {{ total: number, fromExports: number, lateTwins: number, toMove: number, movedToEarlierDate: number,
 *   collisions: number, alreadyApplied: boolean, applied: boolean }}
 */
export function fixSessionTimes(store, { apply = false, logger = { info() {}, warn() {}, error() {} } } = {}) {
  const { db } = store;
  const alreadyApplied = Boolean(db.prepare("SELECT 1 FROM runs WHERE name = ? AND status = 'ok'").get(RUN_NAME));
  const stamps = new Set(db.prepare("SELECT DISTINCT synced_at FROM drive_exports WHERE kind = 'workouts'").pluck().all());
  const rows = db.prepare('SELECT rowid AS id, type, start, end, updated_at FROM workout_sessions').all();
  const key = (type, start, end) => `${type}|${start}|${end}`;
  const fromExports = new Set(rows.filter((r) => stamps.has(r.updated_at)).map((r) => key(r.type, r.start, r.end)));
  const sheetRows = rows.filter((r) => !stamps.has(r.updated_at));
  const exportStarts = new Set(rows.filter((r) => stamps.has(r.updated_at)).map((r) => `${r.type}|${r.start}`));

  const lateTwins = [];
  const toMove = [];
  for (const r of sheetRows) {
    const start = moveHours(r.start, -SHEET_LATE_HOURS);
    const end = moveHours(r.end, -SHEET_LATE_HOURS);
    if (fromExports.has(key(r.type, start, end))) lateTwins.push(r);
    else toMove.push({ ...r, newStart: start, newEnd: end });
  }
  // Every sheet row moves or is deleted, so a moved workout can only clash with an export row of the same type and
  // start but a different end (an exact match would have been a twin): left for the owner to look at, never guessed.
  const collisions = toMove.filter((m) => exportStarts.has(`${m.type}|${m.newStart}`)).length;
  const plan = {
    total: rows.length,
    fromExports: fromExports.size,
    lateTwins: lateTwins.length,
    toMove: toMove.length,
    movedToEarlierDate: toMove.filter((m) => m.newStart.slice(0, 10) !== m.start.slice(0, 10)).length,
    collisions,
    alreadyApplied,
    applied: false,
  };
  if (!apply) return plan;
  if (alreadyApplied) throw new Error('The workout time fix was already applied; nothing changed.');
  if (collisions) throw new Error(`${collisions} moved workouts would land on stored ones; nothing changed.`);

  const run = createTracer({ store, logger }).startRun(RUN_NAME, { hours: -SHEET_LATE_HOURS });
  try {
    const del = db.prepare('DELETE FROM workout_sessions WHERE rowid = ?');
    const upd = db.prepare('UPDATE workout_sessions SET start = ?, end = ? WHERE rowid = ?');
    store.tx(() => {
      for (const r of lateTwins) del.run(r.id);
      // Earliest first is not enough when moves chain into each other's old slots; move all to a temporary mark first.
      for (const m of toMove) upd.run(`~${m.newStart}`, `~${m.newEnd}`, m.id);
      for (const m of toMove) upd.run(m.newStart, m.newEnd, m.id);
    });
    run.finish('ok', { deleted: lateTwins.length, moved: toMove.length });
  } catch (err) {
    run.finish('error', { error: err.name });
    throw err;
  }
  return { ...plan, applied: true };
}
