// All SQL behind the UI API. Routes validate input with JSON schemas before calling these.
import { buildInstructions } from '../agent/prompts.js';

export const SCALE_FIELDS = ['readiness', 'energy', 'mood', 'stress', 'nutrition'];
export const BODY_FIELDS = ['weight_lbs', 'body_fat_pct', 'muscle_mass_lbs', 'visceral_fat'];
export const ALCOHOL_FIELDS = ['beers', 'wine', 'bourbon', 'other'];
export const DRINK_COUNT_FIELDS = [...ALCOHOL_FIELDS, 'cbd'];

const now = () => new Date().toISOString();
const alcoholOf = (d) => ALCOHOL_FIELDS.reduce((sum, f) => sum + (d[f] ?? 0), 0);

/** 'YYYY-MM-DD' for a real calendar date. */
export function isValidDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const d = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text;
}

/** Local calendar date of a Date as 'YYYY-MM-DD'. */
export function localDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// ---- one day ----

export function getDay(db, date) {
  const checkin = db.prepare('SELECT * FROM checkins WHERE date = ?').get(date) ?? null;
  const drinking = db.prepare('SELECT * FROM drinking_days WHERE date = ?').get(date) ?? null;
  return { date, checkin, drinking: drinking && { ...drinking, alcohol: alcoholOf(drinking) } };
}

/** Saves the day's check-in from the UI (daily cadence). Body fields mark the day as measured. */
export function saveCheckin(db, date, body) {
  const row = { date, notes: body.notes?.trim() || null };
  for (const f of [...SCALE_FIELDS, ...BODY_FIELDS]) row[f] = body[f] ?? null;
  row.body_measured_on = BODY_FIELDS.some((f) => row[f] !== null) ? date : null;
  const cols = [...SCALE_FIELDS, ...BODY_FIELDS, 'body_measured_on', 'notes'];
  db.prepare(`INSERT INTO checkins (date, cadence, ${cols.join(', ')}, source, updated_at)
    VALUES (@date, 'daily', ${cols.map((c) => `@${c}`).join(', ')}, 'ui', @updated_at)
    ON CONFLICT (date) DO UPDATE SET cadence = 'daily', ${cols.map((c) => `${c} = excluded.${c}`).join(', ')},
      source = 'ui', updated_at = excluded.updated_at`).run({ ...row, updated_at: now() });
  return getDay(db, date).checkin;
}

/** Saves the day's drinks from the UI. All zeros is a deliberate no-drink day. */
export function saveDrinking(db, date, body) {
  const row = { date, setting: body.setting?.trim() || null, notes: body.notes?.trim() || null };
  for (const f of DRINK_COUNT_FIELDS) row[f] = body[f] ?? 0;
  row.mood_before = body.mood_before ?? null;
  row.mood_after = body.mood_after ?? null;
  const cols = [...DRINK_COUNT_FIELDS, 'setting', 'mood_before', 'mood_after', 'notes'];
  db.prepare(`INSERT INTO drinking_days (date, ${cols.join(', ')}, source, updated_at)
    VALUES (@date, ${cols.map((c) => `@${c}`).join(', ')}, 'ui', @updated_at)
    ON CONFLICT (date) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(', ')},
      source = 'ui', updated_at = excluded.updated_at`).run({ ...row, updated_at: now() });
  return getDay(db, date).drinking;
}

export const deleteCheckin = (db, date) => db.prepare('DELETE FROM checkins WHERE date = ?').run(date).changes;
export const deleteDrinking = (db, date) => db.prepare('DELETE FROM drinking_days WHERE date = ?').run(date).changes;

// ---- history ----

export function history(db, from, to) {
  return {
    metrics: db.prepare(`SELECT date, hrv_ms, resting_hr, sleep_total_hr, steps FROM daily_metrics
      WHERE date BETWEEN ? AND ? ORDER BY date`).all(from, to),
    checkins: db.prepare(`SELECT date, cadence, readiness, energy, mood, stress, nutrition, weight_lbs FROM checkins
      WHERE date BETWEEN ? AND ? ORDER BY date`).all(from, to),
    drinking: db.prepare(`SELECT date, ${DRINK_COUNT_FIELDS.join(', ')} FROM drinking_days WHERE date BETWEEN ? AND ? ORDER BY date`)
      .all(from, to)
      .map((d) => ({ date: d.date, alcohol: alcoholOf(d), cbd: d.cbd })),
  };
}

export function listReviews(db) {
  return db.prepare('SELECT week_ending, report_md, created_at FROM reviews ORDER BY week_ending DESC').all();
}

export function lastSync(db) {
  const run = db.prepare("SELECT status, started_at, finished_at, summary FROM runs WHERE name = 'sync' ORDER BY id DESC LIMIT 1").get();
  return run ? { ...run, summary: run.summary ? JSON.parse(run.summary) : null } : null;
}

// ---- settings ----

export const SETTING_KEYS = ['zone2_low_bpm', 'zone2_high_bpm'];

export function getSettings(db) {
  const rows = db.prepare(`SELECT key, value FROM settings WHERE key IN (${SETTING_KEYS.map(() => '?').join(', ')})`).all(...SETTING_KEYS);
  const values = Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]));
  return Object.fromEntries(SETTING_KEYS.map((k) => [k, values[k] ?? null]));
}

/** Sets the given keys; null removes a setting. */
export function saveSettings(db, changes) {
  const upsert = db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
  const remove = db.prepare('DELETE FROM settings WHERE key = ?');
  db.transaction(() => {
    for (const [k, v] of Object.entries(changes)) (v === null ? remove.run(k) : upsert.run(k, String(v), now()));
  })();
  return getSettings(db);
}

// ---- prompt sections ----

const SECTION_COLS = 'id, position, name, text, sensitive, updated_at';
const asSection = (r) => r && { ...r, sensitive: Boolean(r.sensitive) };

export function listSections(db) {
  return db.prepare(`SELECT ${SECTION_COLS} FROM prompt_sections ORDER BY position, name`).all().map(asSection);
}

export function getSection(db, id) {
  return asSection(db.prepare(`SELECT ${SECTION_COLS} FROM prompt_sections WHERE id = ?`).get(id));
}

function keepVersion(db, section) {
  db.prepare(`INSERT INTO prompt_section_versions (section_id, position, name, text, sensitive, replaced_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(section.id, section.position, section.name, section.text, section.sensitive ? 1 : 0, now());
}

export function createSection(db, { position, name, text, sensitive = false }) {
  const id = db.prepare(`INSERT INTO prompt_sections (position, name, text, sensitive, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run(position, name.trim(), text, sensitive ? 1 : 0, now()).lastInsertRowid;
  return getSection(db, id);
}

/** Updates a section, keeping its previous contents. Returns null when it does not exist. */
export function updateSection(db, id, changes) {
  const current = getSection(db, id);
  if (!current) return null;
  const next = { ...current, ...changes, name: (changes.name ?? current.name).trim() };
  const unchanged = ['position', 'name', 'text', 'sensitive'].every((k) => next[k] === current[k]);
  if (unchanged) return current;
  db.transaction(() => {
    keepVersion(db, current);
    db.prepare('UPDATE prompt_sections SET position = ?, name = ?, text = ?, sensitive = ?, updated_at = ? WHERE id = ?')
      .run(next.position, next.name, next.text, next.sensitive ? 1 : 0, now(), id);
  })();
  return getSection(db, id);
}

export function deleteSection(db, id) {
  const current = getSection(db, id);
  if (!current) return false;
  db.transaction(() => {
    keepVersion(db, current);
    db.prepare('DELETE FROM prompt_sections WHERE id = ?').run(id);
  })();
  return true;
}

/** The weekly review's instructions as the model would receive them (sensitive sections left out). */
export function previewInstructions(db, today) {
  const sections = listSections(db);
  const text = buildInstructions(sections, today);
  return {
    text,
    characters: text.length,
    included: sections.filter((s) => !s.sensitive).map((s) => s.name),
    leftOut: sections.filter((s) => s.sensitive).map((s) => s.name),
  };
}
