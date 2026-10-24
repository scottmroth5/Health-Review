// Migrations 024 and 025: users, and user_id on every user table (multi-user, phase 1; owner's choice 2026-10-24: one
// shared database with user_id, ahead of the RDS move). Appended to MIGRATIONS in db/migrations.js.
//
// 025 rebuilds every user table with user_id NOT NULL (no default, so an insert that forgets it fails instead of landing
// on the owner) and per-user keys. Migrations run inside a transaction with foreign keys on, where SQLite's usual
// "foreign_keys = OFF" rebuild is not possible and dropping a parent would cascade into its children. So every table is
// first copied to a temp table, then dropped children first, created again parents first, and refilled with the owner's
// id. agent-core's runs table gets a nullable user_id instead (its tracer inserts without one; db/users.js
// startUserRun sets it); run_calls is reached through runs.
import { OWNER_ID, ownerEmailFromEnv } from './users.js';

// Final shapes, parents before children. Column names match the old tables plus user_id, so rows copy by name.
const TABLES = [
  ['daily_metrics', `CREATE TABLE daily_metrics (
    user_id TEXT NOT NULL REFERENCES users(id),
    date TEXT NOT NULL,
    active_energy_kcal REAL, exercise_min REAL, move_min REAL, stand_hours REAL, stand_min REAL, hrv_ms REAL,
    respiratory_rate REAL, resting_hr REAL, sleep_total_hr REAL, sleep_asleep_hr REAL, sleep_in_bed_hr REAL,
    sleep_core_hr REAL, sleep_deep_hr REAL, sleep_rem_hr REAL, sleep_awake_hr REAL, steps REAL, vo2max REAL,
    updated_at TEXT NOT NULL,
    cardio_recovery_bpm REAL, walking_hr_avg REAL, walking_speed_mph REAL, hr_min REAL, hr_max REAL, hr_avg REAL,
    wrist_temp_f REAL, physical_effort REAL, spo2_pct REAL, breathing_disturbances REAL, walking_asymmetry_pct REAL,
    exported_through TEXT,
    PRIMARY KEY (user_id, date)
  )`],
  ['workout_sessions', `CREATE TABLE workout_sessions (
    user_id TEXT NOT NULL REFERENCES users(id),
    type TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL,
    duration_sec INTEGER, total_energy_kcal REAL, active_energy_kcal REAL, max_hr REAL, avg_hr REAL, distance_mi REAL,
    avg_speed_mph REAL, step_count REAL, step_cadence_spm REAL, swim_stroke_count REAL, swim_stroke_cadence_spm REAL,
    flights_climbed REAL, elevation_up_ft REAL, elevation_down_ft REAL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, type, start, end)
  )`, ['CREATE INDEX workout_sessions_start ON workout_sessions(user_id, start)']],
  ['workout_hr_samples', `CREATE TABLE workout_hr_samples (
    user_id TEXT NOT NULL REFERENCES users(id),
    type TEXT NOT NULL, start TEXT NOT NULL, t TEXT NOT NULL,
    avg_bpm REAL NOT NULL, min_bpm REAL, max_bpm REAL,
    PRIMARY KEY (user_id, type, start, t)
  )`],
  ['stand_hour_samples', `CREATE TABLE stand_hour_samples (
    user_id TEXT NOT NULL REFERENCES users(id),
    date TEXT NOT NULL,
    hour INTEGER NOT NULL CHECK (hour BETWEEN 0 AND 23),
    PRIMARY KEY (user_id, date, hour)
  )`],
  ['strength_exercises', `CREATE TABLE strength_exercises (
    id INTEGER PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    tab_year INTEGER NOT NULL, row_no INTEGER NOT NULL, date TEXT NOT NULL,
    workout TEXT, prime TEXT, exercise TEXT NOT NULL, post TEXT, comment TEXT,
    canonical_id TEXT, implement TEXT, movement_pattern TEXT,
    is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
    map_status TEXT NOT NULL DEFAULT 'pending' CHECK (map_status IN ('pending', 'mapped', 'inferred', 'unmapped', 'ignored')),
    normalized_at TEXT,
    UNIQUE (user_id, tab_year, row_no)
  )`, ['CREATE INDEX strength_exercises_date ON strength_exercises(user_id, date)',
    'CREATE INDEX strength_exercises_canonical ON strength_exercises(user_id, canonical_id)']],
  ['strength_sets', `CREATE TABLE strength_sets (
    user_id TEXT NOT NULL REFERENCES users(id),
    exercise_id INTEGER NOT NULL REFERENCES strength_exercises(id) ON DELETE CASCADE,
    set_no INTEGER NOT NULL,
    weight_text TEXT, weight_lbs REAL, per_hand INTEGER NOT NULL DEFAULT 0, band TEXT,
    bodyweight INTEGER NOT NULL DEFAULT 0, reps_text TEXT, reps INTEGER, duration_sec INTEGER, distance_yd REAL,
    PRIMARY KEY (exercise_id, set_no)
  )`, ['CREATE INDEX strength_sets_user ON strength_sets(user_id)']],
  ['workout_log_notes', `CREATE TABLE workout_log_notes (
    user_id TEXT NOT NULL REFERENCES users(id),
    tab_year INTEGER NOT NULL, row_no INTEGER NOT NULL, date TEXT, text TEXT NOT NULL,
    PRIMARY KEY (user_id, tab_year, row_no)
  )`],
  ['sync_state', `CREATE TABLE sync_state (
    user_id TEXT NOT NULL REFERENCES users(id),
    source TEXT NOT NULL, tab TEXT NOT NULL, row_count INTEGER NOT NULL,
    header_hash TEXT, content_hash TEXT, synced_at TEXT NOT NULL,
    PRIMARY KEY (user_id, source, tab)
  )`],
  ['drive_exports', `CREATE TABLE drive_exports (
    user_id TEXT NOT NULL REFERENCES users(id),
    file_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('health', 'health_json', 'workouts')),
    name TEXT NOT NULL, modified_time TEXT NOT NULL, rows INTEGER NOT NULL, synced_at TEXT NOT NULL
  )`, ['CREATE INDEX drive_exports_user ON drive_exports(user_id, kind)']],
  ['ingest_log', `CREATE TABLE ingest_log (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    received_at TEXT NOT NULL,
    route TEXT NOT NULL CHECK (route IN ('health', 'workouts')),
    result TEXT NOT NULL CHECK (result IN ('ok', 'error')),
    counts TEXT, error TEXT
  )`, ['CREATE INDEX ingest_log_received ON ingest_log (user_id, route, received_at)']],
  ['checkins', `CREATE TABLE checkins (
    user_id TEXT NOT NULL REFERENCES users(id),
    date TEXT NOT NULL,
    cadence TEXT NOT NULL CHECK (cadence IN ('weekly', 'daily')),
    readiness INTEGER, energy INTEGER, mood INTEGER, stress INTEGER, nutrition INTEGER,
    weight_lbs REAL, body_fat_pct REAL, muscle_mass_lbs REAL, visceral_fat REAL, body_measured_on TEXT,
    notes TEXT, source TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, date)
  )`],
  ['drinking_days', `CREATE TABLE drinking_days (
    user_id TEXT NOT NULL REFERENCES users(id),
    date TEXT NOT NULL,
    beers INTEGER NOT NULL DEFAULT 0, wine INTEGER NOT NULL DEFAULT 0, bourbon INTEGER NOT NULL DEFAULT 0,
    other INTEGER NOT NULL DEFAULT 0, setting TEXT, mood_before INTEGER, mood_after INTEGER, notes TEXT,
    source TEXT NOT NULL, updated_at TEXT NOT NULL, cbd INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, date)
  )`],
  ['settings', `CREATE TABLE settings (
    user_id TEXT NOT NULL REFERENCES users(id),
    key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
  )`],
  ['health_targets', `CREATE TABLE health_targets (
    user_id TEXT NOT NULL REFERENCES users(id),
    metric TEXT NOT NULL, target REAL NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, metric)
  )`],
  ['reviews', `CREATE TABLE reviews (
    user_id TEXT NOT NULL REFERENCES users(id),
    week_ending TEXT NOT NULL,
    summary_json TEXT NOT NULL, report_md TEXT NOT NULL, run_id INTEGER, created_at TEXT NOT NULL,
    model TEXT, warnings TEXT, sensitive_sections TEXT,
    PRIMARY KEY (user_id, week_ending)
  )`],
  ['prompt_sections', `CREATE TABLE prompt_sections (
    id INTEGER PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    position INTEGER NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL,
    sensitive INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
    UNIQUE (user_id, name)
  )`],
  ['prompt_section_versions', `CREATE TABLE prompt_section_versions (
    id INTEGER PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    section_id INTEGER NOT NULL, position INTEGER NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL,
    sensitive INTEGER NOT NULL, replaced_at TEXT NOT NULL
  )`, ['CREATE INDEX prompt_section_versions_user ON prompt_section_versions(user_id, section_id)']],
  ['advisor_notes', `CREATE TABLE advisor_notes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'claude')),
    text TEXT NOT NULL, physician TEXT, weights TEXT, model TEXT, warnings TEXT
  )`, ['CREATE INDEX advisor_notes_created ON advisor_notes(user_id, created_at)']],
  ['program_blocks', `CREATE TABLE program_blocks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    program TEXT NOT NULL, phase TEXT, start_date TEXT NOT NULL, end_date TEXT,
    status TEXT NOT NULL CHECK (status IN ('completed', 'abandoned', 'in_progress')),
    source TEXT NOT NULL CHECK (source IN ('detected', 'confirmed')),
    notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, program_weeks INTEGER
  )`, ['CREATE INDEX program_blocks_user ON program_blocks(user_id, start_date)']],
  ['log_sessions', `CREATE TABLE log_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    date TEXT NOT NULL,
    block_id TEXT REFERENCES program_blocks(id) ON DELETE SET NULL,
    assignment TEXT NOT NULL CHECK (assignment IN ('block', 'unassigned')),
    program TEXT, week INTEGER,
    source TEXT NOT NULL CHECK (source IN ('detected', 'confirmed', 'forward')),
    updated_at TEXT NOT NULL, phase TEXT,
    UNIQUE (user_id, date)
  )`, ['CREATE INDEX log_sessions_block ON log_sessions(block_id)']],
  ['medications', `CREATE TABLE medications (
    id INTEGER PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL COLLATE NOCASE,
    kind TEXT NOT NULL CHECK (kind IN ('medication', 'supplement')),
    purpose TEXT, prescribed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, notes TEXT,
    UNIQUE (user_id, name)
  )`],
  ['medication_periods', `CREATE TABLE medication_periods (
    id INTEGER PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    medication_id INTEGER NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
    dose TEXT,
    timings TEXT NOT NULL, -- JSON array of morning, afternoon, before_bed, before_workout, after_workout, daily
    started_on TEXT NOT NULL, stopped_on TEXT, stop_reason TEXT, created_at TEXT NOT NULL,
    start_estimated INTEGER NOT NULL DEFAULT 0, ingredients TEXT,
    CHECK (stopped_on IS NULL OR stopped_on >= started_on)
  )`, ['CREATE UNIQUE INDEX medication_periods_one_open ON medication_periods(medication_id) WHERE stopped_on IS NULL',
    'CREATE INDEX medication_periods_started ON medication_periods(user_id, started_on)']],
  ['medication_doses', `CREATE TABLE medication_doses (
    user_id TEXT NOT NULL REFERENCES users(id),
    date TEXT NOT NULL,
    medication_id INTEGER NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
    timing TEXT NOT NULL,
    taken INTEGER NOT NULL CHECK (taken IN (0, 1)),
    updated_at TEXT NOT NULL, dose TEXT, moved_to TEXT,
    PRIMARY KEY (date, medication_id, timing)
  )`, ['CREATE INDEX medication_doses_user ON medication_doses(user_id, date)']],
  ['lab_tests', `CREATE TABLE lab_tests (
    id INTEGER PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL COLLATE NOCASE,
    panel TEXT, unit TEXT, position INTEGER NOT NULL DEFAULT 9999, created_at TEXT NOT NULL,
    ref_low REAL, ref_high REAL, ref_set INTEGER NOT NULL DEFAULT 0,
    UNIQUE (user_id, name)
  )`],
  ['lab_results', `CREATE TABLE lab_results (
    id INTEGER PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    test_id INTEGER NOT NULL REFERENCES lab_tests(id) ON DELETE CASCADE,
    drawn_on TEXT NOT NULL, value REAL, value_text TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('sheet', 'ui')),
    updated_at TEXT NOT NULL, corrected_from TEXT, corrected_from_date TEXT,
    UNIQUE (test_id, drawn_on)
  )`, ['CREATE INDEX lab_results_drawn_on ON lab_results(user_id, drawn_on)']],
];

/** Every table that carries user_id (test/user-scope.test.js checks each query on them names user_id). */
export const USER_TABLES = TABLES.map(([name]) => name);

export const USER_MIGRATIONS = [
  {
    id: '024-users',
    up: (db) => {
      db.exec(`CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT,
        role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'paused')),
        created_at TEXT NOT NULL,
        approved_at TEXT,
        last_seen_at TEXT
      )`);
      const now = new Date().toISOString();
      db.prepare("INSERT INTO users (id, email, role, status, created_at, approved_at) VALUES (?, ?, 'admin', 'approved', ?, ?)")
        .run(OWNER_ID, ownerEmailFromEnv(), now, now);
    },
  },
  {
    id: '025-user-id-everywhere',
    up: (db) => {
      const exists = (t) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));
      for (const [name] of TABLES) db.exec(`CREATE TEMP TABLE "old_${name}" AS SELECT * FROM main."${name}"`);
      for (const [name] of [...TABLES].reverse()) if (exists(name)) db.exec(`DROP TABLE main."${name}"`);
      for (const [, create, indexes = []] of TABLES) {
        db.exec(create);
        for (const sql of indexes) db.exec(sql);
      }
      for (const [name] of TABLES) {
        const cols = db.prepare(`SELECT name FROM pragma_table_info('old_${name}', 'temp')`).pluck().all().map((c) => `"${c}"`).join(', ');
        db.prepare(`INSERT INTO main."${name}" (${cols}, user_id) SELECT ${cols}, ? FROM temp."old_${name}"`).run(OWNER_ID);
        db.exec(`DROP TABLE temp."old_${name}"`);
      }
      db.exec('ALTER TABLE runs ADD COLUMN user_id TEXT REFERENCES users(id)');
      db.exec('CREATE INDEX runs_user ON runs(user_id, name, started_at)');
      db.prepare('UPDATE runs SET user_id = ?').run(OWNER_ID);
    },
  },
  {
    // Phase 2 (registration, keys) and the columns later phases use: a user's Claude key sealed with tools/secret-box.js
    // (never plain), when they accepted the terms, the admin's switch to the owner's key with its monthly cap, their
    // ingest token's hash, their chosen feeds, and whether the owner shares the MAPS catalog with them.
    id: '026-user-settings',
    up: `
      ALTER TABLE users ADD COLUMN claude_key_enc TEXT;
      ALTER TABLE users ADD COLUMN claude_key_set_at TEXT;
      ALTER TABLE users ADD COLUMN terms_accepted_at TEXT;
      ALTER TABLE users ADD COLUMN uses_owner_key INTEGER NOT NULL DEFAULT 0 CHECK (uses_owner_key IN (0, 1));
      ALTER TABLE users ADD COLUMN owner_key_cap_usd REAL;
      ALTER TABLE users ADD COLUMN ingest_token_hash TEXT;
      ALTER TABLE users ADD COLUMN feeds TEXT;
      ALTER TABLE users ADD COLUMN maps_shared INTEGER NOT NULL DEFAULT 0 CHECK (maps_shared IN (0, 1));
    `,
  },
];
