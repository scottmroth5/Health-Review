// Program blocks and sessions in the database. Detection proposes blocks from history; only blocks the
// owner has confirmed are authoritative, and re-detection never touches them or their sessions.
// Sessions are one per lifting day with a UUID derived from the date, so reruns update rather than add.
import { createHash, randomUUID } from 'node:crypto';
import { detectBlocks, loggedPhases, phaseOnDay, programProgress, weekOf } from '../metrics/blocks.js';
import { loadStrengthSets } from '../metrics/load.js';
import { performed } from '../metrics/strength.js';
import { daysBetween } from '../metrics/stats.js';

// UUID v5 (RFC 9562) in a fixed namespace for this app's sessions.
const SESSION_NAMESPACE = 'a3c1f6e2-5b8d-4f0a-9c7e-2d4b6a8e0f13';
export function uuidV5(name, namespace = SESSION_NAMESPACE) {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const bytes = createHash('sha1').update(Buffer.concat([ns, Buffer.from(name, 'utf8')])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export const sessionId = (date) => uuidV5(`session:${date}`);

/** Every set row up to today, and the days with performed sets. */
function history(db, today) {
  const sets = loadStrengthSets(db, '0000-01-01', today);
  return { sets, liftingDates: [...new Set(sets.filter(performed).map((s) => s.date))].sort() };
}

/** Detected blocks for the lifting days not already held by a confirmed block or a forward assignment. */
export function detect(db, today) {
  const { sets, liftingDates } = history(db, today);
  const held = new Set(db.prepare("SELECT date FROM log_sessions WHERE source IN ('confirmed', 'forward')").all().map((r) => r.date));
  return detectBlocks(sets, liftingDates.filter((d) => !held.has(d)), today);
}

/** Replaces previously detected blocks and sessions with a new detection. Confirmed ones are untouched. */
export function writeDetected(db, detection, { now = new Date() } = {}) {
  const stamp = now.toISOString();
  const insertBlock = db.prepare(`INSERT INTO program_blocks (id, program, phase, start_date, end_date, status, source, notes, created_at, updated_at)
    VALUES (?, ?, NULL, ?, ?, ?, 'detected', ?, ?, ?)`);
  const insertSession = db.prepare(`INSERT INTO log_sessions (id, date, block_id, assignment, program, week, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'detected', ?)`);
  db.transaction(() => {
    db.prepare("DELETE FROM log_sessions WHERE source = 'detected'").run();
    db.prepare("DELETE FROM program_blocks WHERE source = 'detected'").run();
    for (const b of detection.blocks) {
      const id = randomUUID();
      insertBlock.run(id, b.program, b.start_date, b.end_date, b.status, b.notes, stamp, stamp);
      for (const date of b.sessions) insertSession.run(sessionId(date), date, id, 'block', b.program, weekOf(b.start_date, date), stamp);
    }
    for (const date of detection.unassigned) insertSession.run(sessionId(date), date, null, 'unassigned', null, null, stamp);
  })();
}

/** Sessions by status, and lifting days with no session row yet. Counts only. */
export function sessionCoverage(db, today) {
  const { liftingDates } = history(db, today);
  const rows = db.prepare(`SELECT s.date, s.assignment, s.source, b.source AS block_source FROM log_sessions s
    LEFT JOIN program_blocks b ON b.id = s.block_id`).all();
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const out = { liftingDays: liftingDates.length, confirmed: 0, unassigned: 0, detected: 0, missing: 0 };
  for (const d of liftingDates) {
    const r = byDate.get(d);
    if (!r) out.missing += 1;
    else if (r.assignment === 'unassigned') out.unassigned += 1;
    else if (r.block_source === 'confirmed') out.confirmed += 1;
    else out.detected += 1;
  }
  return out;
}

/**
 * New lifting days (no session row yet) from the start of the in-progress confirmed block join it with its
 * program and week number, so future sessions never need detection. Without such a block nothing happens.
 */
export function assignForward(db, today, { now = new Date() } = {}) {
  const block = db.prepare(`SELECT * FROM program_blocks WHERE source = 'confirmed' AND status = 'in_progress'
    ORDER BY start_date DESC LIMIT 1`).get();
  if (!block) return { assigned: 0, block: null };
  const known = new Set(db.prepare('SELECT date FROM log_sessions WHERE date >= ?').all(block.start_date).map((r) => r.date));
  const insert = db.prepare(`INSERT INTO log_sessions (id, date, block_id, assignment, program, week, source, updated_at)
    VALUES (?, ?, ?, 'block', ?, ?, 'forward', ?)`);
  const days = history(db, today).liftingDates.filter((d) => d >= block.start_date && !known.has(d));
  const stamp = now.toISOString();
  db.transaction(() => { for (const d of days) insert.run(sessionId(d), d, block.id, block.program, weekOf(block.start_date, d), stamp); })();
  return { assigned: days.length, block: block.program };
}

// ---- phases and status from the program catalog ----

// The block's Workout Log rows (date and workout name) from its start to a date.
const blockRows = (db, block, to) => db.prepare('SELECT date, workout FROM strength_exercises WHERE date BETWEEN ? AND ? ORDER BY date, row_no')
  .all(block.start_date, to);

/**
 * Recomputes each block's program length and each session's phase. The phase comes from the workout names
 * (the latest phase named on or before the day); the catalog's calendar is the fallback for days before any
 * named phase. NULL when neither knows.
 */
export function refreshPhases(db, catalog) {
  const blocks = db.prepare('SELECT id, program, start_date, end_date FROM program_blocks').all();
  const setWeeks = db.prepare('UPDATE program_blocks SET program_weeks = ? WHERE id = ?');
  const setPhase = db.prepare('UPDATE log_sessions SET phase = ? WHERE id = ?');
  db.transaction(() => {
    db.prepare('UPDATE log_sessions SET phase = NULL WHERE block_id IS NULL').run();
    for (const b of blocks) {
      setWeeks.run(catalog?.programWeeks(b.program) ?? null, b.id);
      const sessions = db.prepare('SELECT id, date FROM log_sessions WHERE block_id = ? ORDER BY date').all(b.id);
      if (!sessions.length) continue;
      const logged = loggedPhases(blockRows(db, b, sessions[sessions.length - 1].date));
      for (const s of sessions) setPhase.run(phaseOnDay(b, logged, catalog, s.date), s.id);
    }
  })();
}

/**
 * Where a block stands (today for an in-progress block, its last session otherwise): phase and when it started,
 * week of the phase and of the program, deload or failure week, and the earliest and at-your-pace finish.
 * Facts only: status stays what detection or the owner set.
 */
export function blockStatus(db, block, today, catalog) {
  const sessions = db.prepare('SELECT COUNT(*) AS n, MAX(date) AS last FROM log_sessions WHERE block_id = ?').get(block.id);
  const inProgress = block.status === 'in_progress';
  const asOf = inProgress ? today : (sessions.last ?? block.start_date);
  const p = programProgress(block, blockRows(db, block, asOf), catalog, asOf);
  return {
    id: block.id,
    program: block.program,
    status: block.status,
    source: block.source,
    start_date: block.start_date,
    end_date: block.end_date,
    sessions: sessions.n,
    last_session: sessions.last,
    phase: p.phase,
    phase_started: p.phaseStarted,
    phase_week: p.phaseWeek,
    phase_weeks: p.phaseWeeks,
    week: p.week,
    program_weeks: p.programWeeks,
    estimated: p.estimated,
    beyond_program: p.pastProgramEnd,
    deload_week: p.deloadWeek,
    failure_week: p.failureWeek,
    earliest_finish: inProgress ? p.earliestFinish : null,
    pace_finish: inProgress ? p.paceFinish : null,
    days_left: inProgress && p.earliestFinish ? Math.max(0, daysBetween(today, p.earliestFinish)) : null,
    percent: p.week && p.programWeeks ? Math.min(100, Math.round((p.week / p.programWeeks) * 100)) : null,
  };
}

/** The confirmed in-progress block's status, or null. */
export function currentProgram(db, today, catalog) {
  const block = db.prepare(`SELECT * FROM program_blocks WHERE source = 'confirmed' AND status = 'in_progress'
    ORDER BY start_date DESC LIMIT 1`).get();
  return block ? blockStatus(db, block, today, catalog) : null;
}

// ---- review: list, confirm, edit, merge, split, unassign ----
const STATUSES = ['completed', 'abandoned', 'in_progress'];
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d ?? '') && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
export class ReviewError extends Error {}

/** A block by full id or a unique id prefix. */
export function findBlock(db, ref) {
  if (!ref) throw new ReviewError('Give a block id (the first characters are enough)');
  const rows = db.prepare('SELECT * FROM program_blocks WHERE id LIKE ?').all(`${String(ref).toLowerCase()}%`);
  if (rows.length === 0) throw new ReviewError(`No block ${ref}`);
  if (rows.length > 1) throw new ReviewError(`${ref} matches ${rows.length} blocks; use more characters`);
  return rows[0];
}

export function listBlocks(db, { unconfirmed = false } = {}) {
  return db.prepare(`SELECT b.*, COUNT(s.id) AS sessions, MAX(s.date) AS last_session FROM program_blocks b
    LEFT JOIN log_sessions s ON s.block_id = b.id ${unconfirmed ? "WHERE b.source = 'detected'" : ''}
    GROUP BY b.id ORDER BY b.start_date`).all();
}

function assertNoOverlap(db, block) {
  const other = db.prepare(`SELECT id, program, start_date FROM program_blocks WHERE source = 'confirmed' AND id <> ?
    AND start_date <= ? AND COALESCE(end_date, '9999-12-31') >= ?`).get(block.id, block.end_date ?? '9999-12-31', block.start_date);
  if (other) throw new ReviewError(`Overlaps confirmed block ${other.id.slice(0, 8)} (${other.program} from ${other.start_date})`);
}

/**
 * Makes the sessions agree with a block: lifting days in its date range join it (except days held by
 * another confirmed block or confirmed as unassigned), and its days outside the range become unassigned.
 */
function reassign(db, blockId, today, stamp) {
  const b = db.prepare('SELECT * FROM program_blocks WHERE id = ?').get(blockId);
  const end = b.end_date ?? today;
  const source = b.source === 'confirmed' ? 'confirmed' : 'detected';
  const upsert = db.prepare(`INSERT INTO log_sessions (id, date, block_id, assignment, program, week, source, updated_at)
    VALUES (?, ?, ?, 'block', ?, ?, ?, ?)
    ON CONFLICT (date) DO UPDATE SET block_id = excluded.block_id, assignment = 'block', program = excluded.program,
      week = excluded.week, source = excluded.source, updated_at = excluded.updated_at`);
  const held = new Set(db.prepare(`SELECT s.date FROM log_sessions s LEFT JOIN program_blocks o ON o.id = s.block_id
    WHERE (o.source = 'confirmed' AND o.id <> ?) OR (s.assignment = 'unassigned' AND s.source = 'confirmed')`).all(blockId).map((r) => r.date));
  for (const date of history(db, today).liftingDates) {
    if (date < b.start_date || date > end || held.has(date)) continue;
    upsert.run(sessionId(date), date, blockId, b.program, weekOf(b.start_date, date), source, stamp);
  }
  db.prepare(`UPDATE log_sessions SET block_id = NULL, assignment = 'unassigned', program = NULL, week = NULL,
    source = 'detected', updated_at = ? WHERE block_id = ? AND (date < ? OR date > ?)`).run(stamp, blockId, b.start_date, end);
}

/** Confirms one block, or every detected block with 'all-detected'. Returns the number confirmed. */
export function confirmBlocks(db, ref, { today, now = new Date() }) {
  const stamp = now.toISOString();
  const blocks = ref === 'all-detected'
    ? db.prepare("SELECT * FROM program_blocks WHERE source = 'detected' ORDER BY start_date").all()
    : [findBlock(db, ref)];
  db.transaction(() => {
    for (const b of blocks) {
      assertNoOverlap(db, b);
      db.prepare("UPDATE program_blocks SET source = 'confirmed', updated_at = ? WHERE id = ?").run(stamp, b.id);
      reassign(db, b.id, today, stamp);
    }
  })();
  return blocks.length;
}

/** Changes a block's fields; date changes move sessions in or out. */
export function editBlock(db, ref, changes, { today, now = new Date() }) {
  const b = findBlock(db, ref);
  const next = { ...b };
  for (const k of ['program', 'phase', 'notes']) if (changes[k] !== undefined) next[k] = changes[k] === '' ? null : changes[k];
  if (changes.start !== undefined) next.start_date = changes.start;
  if (changes.end !== undefined) next.end_date = changes.end === '' ? null : changes.end;
  if (changes.status !== undefined) next.status = changes.status;
  if (next.status === 'in_progress') next.end_date = null;
  if (!next.program?.trim()) throw new ReviewError('A block needs a program');
  if (!isDate(next.start_date)) throw new ReviewError(`Not a date: ${next.start_date}`);
  if (next.end_date !== null && !isDate(next.end_date)) throw new ReviewError(`Not a date: ${next.end_date}`);
  if (next.end_date && next.end_date < next.start_date) throw new ReviewError('The end is before the start');
  if (!STATUSES.includes(next.status)) throw new ReviewError(`Status must be one of ${STATUSES.join(', ')}`);
  if (!next.end_date && next.status !== 'in_progress') throw new ReviewError('Only an in-progress block can have no end date');
  const stamp = now.toISOString();
  db.transaction(() => {
    if (next.source === 'confirmed') assertNoOverlap(db, next);
    db.prepare(`UPDATE program_blocks SET program = ?, phase = ?, start_date = ?, end_date = ?, status = ?, notes = ?, updated_at = ?
      WHERE id = ?`).run(next.program.trim(), next.phase, next.start_date, next.end_date, next.status, next.notes, stamp, b.id);
    reassign(db, b.id, today, stamp);
  })();
  return db.prepare('SELECT * FROM program_blocks WHERE id = ?').get(b.id);
}

/** Merges the second block into the first: the earlier start, the later end, and all sessions. */
export function mergeBlocks(db, refA, refB, { today, now = new Date() }) {
  const a = findBlock(db, refA);
  const b = findBlock(db, refB);
  if (a.id === b.id) throw new ReviewError('Choose two different blocks');
  const stamp = now.toISOString();
  const end = a.end_date === null || b.end_date === null ? null : (a.end_date > b.end_date ? a.end_date : b.end_date);
  db.transaction(() => {
    db.prepare('UPDATE log_sessions SET block_id = ? WHERE block_id = ?').run(a.id, b.id);
    db.prepare('DELETE FROM program_blocks WHERE id = ?').run(b.id);
    db.prepare('UPDATE program_blocks SET start_date = ?, end_date = ?, status = ?, notes = ?, updated_at = ? WHERE id = ?')
      .run(a.start_date < b.start_date ? a.start_date : b.start_date, end, end === null ? 'in_progress' : a.status,
        [a.notes, b.notes].filter(Boolean).join('; ') || null, stamp, a.id);
    const merged = db.prepare('SELECT * FROM program_blocks WHERE id = ?').get(a.id);
    if (merged.source === 'confirmed') assertNoOverlap(db, merged);
    reassign(db, a.id, today, stamp);
  })();
  return db.prepare('SELECT * FROM program_blocks WHERE id = ?').get(a.id);
}

/** Splits a block at a date: sessions from that date on move to a new block of the same program and source. */
export function splitBlock(db, ref, date, { today, now = new Date() }) {
  const b = findBlock(db, ref);
  if (!isDate(date)) throw new ReviewError(`Not a date: ${date}`);
  const before = db.prepare('SELECT MAX(date) AS d FROM log_sessions WHERE block_id = ? AND date < ?').get(b.id, date).d;
  const after = db.prepare('SELECT MIN(date) AS d FROM log_sessions WHERE block_id = ? AND date >= ?').get(b.id, date).d;
  if (!before || !after) throw new ReviewError(`${date} does not fall between two sessions of this block`);
  const stamp = now.toISOString();
  const id = randomUUID();
  db.transaction(() => {
    db.prepare(`INSERT INTO program_blocks (id, program, phase, start_date, end_date, status, source, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, b.program, b.phase, after, b.end_date, b.status, b.source, b.notes, stamp, stamp);
    db.prepare("UPDATE program_blocks SET end_date = ?, status = CASE WHEN status = 'in_progress' THEN 'completed' ELSE status END, updated_at = ? WHERE id = ?")
      .run(before, stamp, b.id);
    db.prepare('UPDATE log_sessions SET block_id = ? WHERE block_id = ? AND date >= ?').run(id, b.id, date);
    reassign(db, b.id, today, stamp);
    reassign(db, id, today, stamp);
  })();
  return id;
}

/** Marks lifting days in a date range as confirmed unassigned (no block), creating session rows as needed. */
export function unassignDays(db, from, to = from, { today, now = new Date() }) {
  if (!isDate(from) || !isDate(to) || to < from) throw new ReviewError('Give a date, or a from and a to date');
  const stamp = now.toISOString();
  const upsert = db.prepare(`INSERT INTO log_sessions (id, date, block_id, assignment, program, week, source, updated_at)
    VALUES (?, ?, NULL, 'unassigned', NULL, NULL, 'confirmed', ?)
    ON CONFLICT (date) DO UPDATE SET block_id = NULL, assignment = 'unassigned', program = NULL, week = NULL,
      source = 'confirmed', updated_at = excluded.updated_at`);
  const days = history(db, today).liftingDates.filter((d) => d >= from && d <= to);
  db.transaction(() => { for (const d of days) upsert.run(sessionId(d), d, stamp); })();
  return days.length;
}
