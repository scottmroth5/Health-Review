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
];
