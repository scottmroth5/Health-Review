// Program blocks and sessions in the database. Detection proposes blocks from history; only blocks the
// owner has confirmed are authoritative, and re-detection never touches them or their sessions.
// Sessions are one per lifting day with a UUID derived from the date, so reruns update rather than add.
import { createHash, randomUUID } from 'node:crypto';
import { detectBlocks, weekOf } from '../metrics/blocks.js';
import { loadStrengthSets } from '../metrics/load.js';
import { performed } from '../metrics/strength.js';

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
