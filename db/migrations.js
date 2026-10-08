// App migrations for openStore(..., { app: 'health-review' }). Append only; never edit an applied one.
// Dates are local wall-clock text as the source sheets show them: 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM:SS'.
export const MIGRATIONS = [
  {
    id: '001-health-data',
    up: `
      CREATE TABLE daily_metrics (
        date TEXT PRIMARY KEY,
        active_energy_kcal REAL,
        exercise_min REAL,
        move_min REAL,
        stand_hours REAL,
        stand_min REAL,
        hrv_ms REAL,
        respiratory_rate REAL,
        resting_hr REAL,
        sleep_total_hr REAL,
        sleep_asleep_hr REAL,
        sleep_in_bed_hr REAL,
        sleep_core_hr REAL,
        sleep_deep_hr REAL,
        sleep_rem_hr REAL,
        sleep_awake_hr REAL,
        steps REAL,
        vo2max REAL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE workout_sessions (
        type TEXT NOT NULL,
        start TEXT NOT NULL,
        end TEXT NOT NULL,
        duration_sec INTEGER,
        total_energy_kcal REAL,
        active_energy_kcal REAL,
        max_hr REAL,
        avg_hr REAL,
        distance_mi REAL,
        avg_speed_mph REAL,
        step_count REAL,
        step_cadence_spm REAL,
        swim_stroke_count REAL,
        swim_stroke_cadence_spm REAL,
        flights_climbed REAL,
        elevation_up_ft REAL,
        elevation_down_ft REAL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (type, start, end)
      );
      CREATE INDEX workout_sessions_start ON workout_sessions(start);

      -- One row per Workout Log sheet row (an exercise), replaced tab by tab on sync.
      CREATE TABLE strength_exercises (
        id INTEGER PRIMARY KEY,
        tab_year INTEGER NOT NULL,
        row_no INTEGER NOT NULL,
        date TEXT NOT NULL,
        workout TEXT,
        prime TEXT,
        exercise TEXT NOT NULL,
        post TEXT,
        comment TEXT,
        UNIQUE (tab_year, row_no)
      );
      CREATE INDEX strength_exercises_date ON strength_exercises(date);

      -- One row per Weight N / Set N pair. The original cell text is always kept.
      CREATE TABLE strength_sets (
        exercise_id INTEGER NOT NULL REFERENCES strength_exercises(id) ON DELETE CASCADE,
        set_no INTEGER NOT NULL,
        weight_text TEXT,
        weight_lbs REAL,
        per_hand INTEGER NOT NULL DEFAULT 0,
        band TEXT,
        bodyweight INTEGER NOT NULL DEFAULT 0,
        reps_text TEXT,
        reps INTEGER,
        duration_sec INTEGER,
        distance_yd REAL,
        PRIMARY KEY (exercise_id, set_no)
      );

      -- Free text typed into the Workout Log date column (vacation, illness, injury).
      CREATE TABLE workout_log_notes (
        tab_year INTEGER NOT NULL,
        row_no INTEGER NOT NULL,
        date TEXT,
        text TEXT NOT NULL,
        PRIMARY KEY (tab_year, row_no)
      );

      CREATE TABLE drinking_days (
        date TEXT PRIMARY KEY,
        beers INTEGER NOT NULL DEFAULT 0,
        wine INTEGER NOT NULL DEFAULT 0,
        bourbon INTEGER NOT NULL DEFAULT 0,
        other INTEGER NOT NULL DEFAULT 0,
        setting TEXT,
        mood_before INTEGER,
        mood_after INTEGER,
        notes TEXT,
        source TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- v1 rows are weekly (date is the week ending); UI rows are daily.
      CREATE TABLE checkins (
        date TEXT PRIMARY KEY,
        cadence TEXT NOT NULL CHECK (cadence IN ('weekly', 'daily')),
        readiness INTEGER,
        energy INTEGER,
        mood INTEGER,
        stress INTEGER,
        nutrition INTEGER,
        weight_lbs REAL,
        body_fat_pct REAL,
        muscle_mass_lbs REAL,
        visceral_fat REAL,
        body_measured_on TEXT,
        notes TEXT,
        source TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE sync_state (
        source TEXT NOT NULL,
        tab TEXT NOT NULL,
        row_count INTEGER NOT NULL,
        header_hash TEXT,
        content_hash TEXT,
        synced_at TEXT NOT NULL,
        PRIMARY KEY (source, tab)
      );
    `,
  },
  {
    id: '002-cbd-prompts-reviews',
    up: `
      -- CBD drinks are tracked beside alcohol but never counted in the alcohol total.
      ALTER TABLE drinking_days ADD COLUMN cbd INTEGER NOT NULL DEFAULT 0;

      -- Prompt sections for the weekly review, edited in the UI. position sets the order.
      -- Sensitive sections (medications, genetics) are left out of the weekly review.
      CREATE TABLE prompt_sections (
        id INTEGER PRIMARY KEY,
        position INTEGER NOT NULL,
        name TEXT NOT NULL UNIQUE,
        text TEXT NOT NULL,
        sensitive INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      -- Previous contents, kept on every save and delete.
      CREATE TABLE prompt_section_versions (
        id INTEGER PRIMARY KEY,
        section_id INTEGER NOT NULL,
        position INTEGER NOT NULL,
        name TEXT NOT NULL,
        text TEXT NOT NULL,
        sensitive INTEGER NOT NULL,
        replaced_at TEXT NOT NULL
      );

      CREATE TABLE reviews (
        week_ending TEXT PRIMARY KEY,
        summary_json TEXT NOT NULL,
        report_md TEXT NOT NULL,
        run_id INTEGER,
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    id: '003-settings',
    up: `
      -- Personal values the metrics use (for example zone2_low_bpm, zone2_high_bpm), edited in the UI.
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    id: '004-medications',
    up: `
      -- Medications and supplements. Each dose or timing period is its own row, so every start,
      -- change and stop is dated; at most one period per medication is open (stopped_on null).
      CREATE TABLE medications (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('medication', 'supplement')),
        purpose TEXT,
        prescribed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE medication_periods (
        id INTEGER PRIMARY KEY,
        medication_id INTEGER NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
        dose TEXT,
        timings TEXT NOT NULL, -- JSON array of morning, afternoon, before_bed, before_workout, after_workout, daily
        started_on TEXT NOT NULL,
        stopped_on TEXT,
        stop_reason TEXT,
        created_at TEXT NOT NULL,
        CHECK (stopped_on IS NULL OR stopped_on >= started_on)
      );
      CREATE UNIQUE INDEX medication_periods_one_open ON medication_periods(medication_id) WHERE stopped_on IS NULL;
      CREATE INDEX medication_periods_started ON medication_periods(started_on);
    `,
  },
  {
    id: '005-estimated-starts-and-doses',
    up: `
      -- A period whose real start date is unknown ("taking since at least started_on"). It counts as
      -- active from started_on but never produces a start event or an impact comparison.
      ALTER TABLE medication_periods ADD COLUMN start_estimated INTEGER NOT NULL DEFAULT 0;

      -- Daily check-off: one row per medication and timing slot on a saved day. A saved day records
      -- every slot (taken 1 or 0); a day with no rows is unknown, never counted as missed.
      CREATE TABLE medication_doses (
        date TEXT NOT NULL,
        medication_id INTEGER NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
        timing TEXT NOT NULL,
        taken INTEGER NOT NULL CHECK (taken IN (0, 1)),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (date, medication_id, timing)
      );
    `,
  },
  {
    id: '006-medication-notes',
    up: `
      -- Free-form notes per medication or supplement (for example "take with food"). Timings now also
      -- allow during_workout; timings are validated in code, so that needs no schema change.
      ALTER TABLE medications ADD COLUMN notes TEXT;
    `,
  },
  {
    id: '007-labs',
    up: `
      -- Lab tests (catalog) and results. No reference ranges by the owner's choice: values are stored
      -- and trended, never marked out of range. Results come from the lab sheet (source 'sheet',
      -- replaced on sync) or the app (source 'ui', never overwritten by sync).
      CREATE TABLE lab_tests (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        panel TEXT,
        unit TEXT,
        position INTEGER NOT NULL DEFAULT 9999,
        created_at TEXT NOT NULL
      );
      CREATE TABLE lab_results (
        id INTEGER PRIMARY KEY,
        test_id INTEGER NOT NULL REFERENCES lab_tests(id) ON DELETE CASCADE,
        drawn_on TEXT NOT NULL,
        value REAL,
        value_text TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('sheet', 'ui')),
        updated_at TEXT NOT NULL,
        UNIQUE (test_id, drawn_on)
      );
      CREATE INDEX lab_results_drawn_on ON lab_results(drawn_on);
    `,
  },
  {
    id: '008-lab-corrections',
    up: `
      -- A sheet result corrected in the app becomes source 'ui' (sync never overwrites it) and keeps
      -- the sheet's original value and date, so the correction stays visible and sync does not
      -- re-add the sheet's copy under the old date.
      ALTER TABLE lab_results ADD COLUMN corrected_from TEXT;
      ALTER TABLE lab_results ADD COLUMN corrected_from_date TEXT;
    `,
  },
  {
    id: '009-review-details',
    up: `
      -- Which model wrote a review, problems the output checks could not resolve (shown with the
      -- report), and the names of sensitive prompt sections it was sent (never their text).
      ALTER TABLE reviews ADD COLUMN model TEXT;
      ALTER TABLE reviews ADD COLUMN warnings TEXT;
      ALTER TABLE reviews ADD COLUMN sensitive_sections TEXT;
    `,
  },
  {
    id: '010-normalization-and-blocks',
    up: `
      -- Normalized values next to the raw logged ones (exercise stays as typed). Rewritten by every
      -- normalize run, so changing the dictionary and rerunning is always safe.
      ALTER TABLE strength_exercises ADD COLUMN canonical_id TEXT;
      ALTER TABLE strength_exercises ADD COLUMN implement TEXT;
      ALTER TABLE strength_exercises ADD COLUMN movement_pattern TEXT;
      ALTER TABLE strength_exercises ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1));
      ALTER TABLE strength_exercises ADD COLUMN map_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (map_status IN ('pending', 'mapped', 'inferred', 'unmapped', 'ignored'));
      ALTER TABLE strength_exercises ADD COLUMN normalized_at TEXT;
      CREATE INDEX strength_exercises_canonical ON strength_exercises(canonical_id);

      -- New tables use portable types only (UUIDs as TEXT, UTC ISO timestamps, CHECK instead of enums)
      -- so they move to PostgreSQL cleanly. Dates are local wall-clock YYYY-MM-DD like the rest of the log.
      CREATE TABLE program_blocks (
        id TEXT PRIMARY KEY,
        program TEXT NOT NULL,
        phase TEXT,
        start_date TEXT NOT NULL,
        end_date TEXT,
        status TEXT NOT NULL CHECK (status IN ('completed', 'abandoned', 'in_progress')),
        source TEXT NOT NULL CHECK (source IN ('detected', 'confirmed')),
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- One session per lifting day (the log has no session ids); the id is a UUID derived from the date.
      CREATE TABLE log_sessions (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL UNIQUE,
        block_id TEXT REFERENCES program_blocks(id) ON DELETE SET NULL,
        assignment TEXT NOT NULL CHECK (assignment IN ('block', 'unassigned')),
        program TEXT,
        week INTEGER,
        source TEXT NOT NULL CHECK (source IN ('detected', 'confirmed', 'forward')),
        updated_at TEXT NOT NULL
      );
      CREATE INDEX log_sessions_block ON log_sessions(block_id);
    `,
  },
  {
    id: '011-session-phase',
    up: `
      -- Phase of each session and the length of each block's program, from the MAPS catalog
      -- (data/maps/programs.json); recomputed by refreshPhases, NULL when the program is not in the catalog.
      ALTER TABLE log_sessions ADD COLUMN phase TEXT;
      ALTER TABLE program_blocks ADD COLUMN program_weeks INTEGER;
    `,
  },
  {
    id: '012-session-duration-fix',
    up: `
      -- The sheet's Duration cells were 3 hours too long (a time zone shift in the v1 consolidation); repair stored
      -- rows with the rule in ingest/parsers.js sessionDuration. Archived rows are no longer in the sheet, so a
      -- resync cannot fix them. Values that fit neither way become NULL (minutes then come from start to end).
      UPDATE workout_sessions SET duration_sec = CASE
        WHEN duration_sec - 10800 > 0
          AND duration_sec - 10800 <= (julianday(end) - julianday(start)) * 86400 + 120 THEN duration_sec - 10800
        WHEN duration_sec > 0 AND duration_sec <= (julianday(end) - julianday(start)) * 86400 + 120 THEN duration_sec
        ELSE NULL END
      WHERE duration_sec IS NOT NULL;
    `,
  },
  {
    id: '013-advisor-chat',
    up: `
      -- The Next program chat: the owner's notes and Claude's replies, one thread. Text stays in this database (and its
      -- encrypted backup); runs record metadata only.
      CREATE TABLE advisor_notes (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('owner', 'claude')),
        text TEXT NOT NULL,
        physician TEXT,
        weights TEXT,
        model TEXT,
        warnings TEXT
      );
      CREATE INDEX advisor_notes_created ON advisor_notes(created_at);
    `,
  },
  {
    id: '014-dose-adjustments',
    up: `
      -- One-day adjustments on the Today tab: the dose actually taken and the slot it was actually taken in. NULL means
      -- the item's default from its current period. timing stays the scheduled slot (the key), so a move never
      -- collides with another slot of the same item. Only the Today tab reads these; the review counts taken or not.
      ALTER TABLE medication_doses ADD COLUMN dose TEXT;
      ALTER TABLE medication_doses ADD COLUMN moved_to TEXT;
    `,
  },
];
