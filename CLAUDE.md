# Health Review Agent

## Purpose
Weekly health review agent built on the shared agent-core package.
agent-core comes from the public Agent-Core repo as a git dependency pinned to a version tag
("@scottmroth5/agent-core": "github:scottmroth5/Agent-Core#semver:^0.2.2"). Upgrade with npm install "github:scottmroth5/Agent-Core#semver:^<x.y.z>" (a caret on 0.x never crosses a minor version, so npm update will not); test unreleased changes with npm link ../Agent-Core.
Health specific logic stays in this repo; never add it to agent-core.


## Structure
/agent              the weekly review: summary.js (computeWeek trimmed for the model, plus the week's notes),
                    instructions.js (fixed CONTRACT + owner prompt sections, output schema, rendering), validate.js
                    (dashes, number grounding, physician routing), claude.js (agent-core client with refusal fallbacks),
                    review.js (one call, one retry on failed checks, saved to reviews), suggest-exercises.js (the
                    optional exercise-name assist), advisor-chat.js (the Next program chat)
/metrics            deterministic metric calculations: stats.js (windows, rounding, pearson), one module per report
                    area (recovery, cardio, strength, drinking, checkins), index.js computeWeek, load.js (SQL),
                    dictionary.js (exercise dictionary loader), blocks.js (program block detection), catalog.js (MAPS
                    program catalog loader);
                    fixtures with hand-computed expectations in evals/fixtures/metrics, run by test/metrics.test.js
/ingest             Google Sheets to SQLite: sheets.js (read-only client, fakeable), parsers.js (one per sheet), sync.js;
                    the only code touching raw source rows; normalize.js (dictionary onto the Workout Log) and
                    program-blocks.js (blocks, sessions, review operations)
/config             exercise-dictionary.json: canonical exercises and name variants (names only; see README.md);
                    substitutions.json: home equipment, what fills a cable or machine slot, and the avoid list
/db                 migrations.js (append only) and openHealthStore (data/health.db, HEALTH_DB_PATH overrides; the data folder
                    is DATA_DIR when set, tools/paths.js dataPath, which the container mounts at /app/data).
                    Users (multi-user, phase 1 of 6, plan 2026-10-24): users.js (OWNER_ID, the owner as user 1 and admin;
                    startUserRun stamps runs.user_id), migrations-users.js (024 users; 025 rebuilt every user table with
                    user_id NOT NULL, no default, and per-user keys; USER_TABLES), scope.js (scopeDb/scopeStore: one user's
                    view, binding @uid into every statement that names it), openOwnerStore (the scripts act as the owner).
                    openHealthStore copies an existing database file before opening it (VACUUM INTO, integrity checked) and
                    keeps the copy as data/backups/pre-migration-<stamp>.db only when a migration ran (newest 5 kept);
                    pendingMigrations runs the migrations on a throwaway temp copy (npm run db:pending: exit 0 none, 10 some)
/server             Fastify API (app.js routes with JSON schemas, queries.js holds all UI SQL, auth.js) and the
                    static UI in server/public (plain HTML, CSS and JS modules; no build step).
                    Home (#home, the default): a tile per section (Daily Check-in and Reviews tiles carry badges from /api/status
                    and /api/reviews/status), Sync now with the last sync, Demo mode and the account; wide screens keep the tab bar, phones (720 px and
                    under) show "‹ Home" and the section name instead. Installable on iPhone: manifest.webmanifest and
                    icon-180/192/512.png (scripts/make-icons.js; test/icons.test.js checks they are current).
                    Demo mode (Home page checkbox, or ?demo=1 / ?demo=0; saved per browser, server/public/demo.js) hides
                    drinking and CBD on screen only: the Drinks box, the alcohol chart, and drinking or CBD lines in reviews
/evals              fixtures/metrics (metric regression), fixtures/v1 (v1 golden outputs, see its README), and the review
                    contract eval: review-cases.json (real weeks by date only, synthetic overlays), grade-review.js
                    (shared grading), run-review-eval.mjs (runner from the claude-api skill scaffold)
/tools              shared helpers: paths, google/auth.js (copied from Job-Agent; candidate to move into agent-core);
                    apps-script/ConsolidateHealthMetrics.gs (the fixed v1 consolidation; retired 2026-10-16, reference only)
/demo               the separate demo instance's made-up data: generate.js (seeded generator, run through the app's own
                    normalization, block detection and phases), catalog.json (MAPS program names with made-up phases and
                    workouts, owner's choice 2026-10-24), training.js (two years of runs), reviews.js (26 reviews in code from
                    each week's summary, passing agent/validate.js),
                    substitutions.json. Data runs through yesterday, with today's check-in and morning supplements (no
                    Apple Health day yet); settings demo_built_for records the day, and server/index.js remakes it in
                    place (refreshDemoDatabase) on start and within 10 minutes of the owner's midnight. The demo's clock
                    is noon on demo_built_for, so a late refresh never shows "data stopped"
/jobs               the scheduled jobs shared by the npm scripts and the in-app scheduler: sync, review, backup,
                    restore-check (the monthly restore test)
/scripts            command-line entry points
/test               node:test suites with synthetic fixtures only
/data               gitignored; local health datastore and exports; google/ holds the OAuth client_secret.json and token.json
/legacy contains the v1 scripts for reference only. Do not modify or import from them.

## Commands
npm test                          run unit tests, including metric fixtures (CI runs them under TZ=America/New_York and UTC)
npm run check:personal -- --all   personal-data and secrets check of every tracked file (the pre-commit hook checks staged
                                  files; npm install turns the hook on; private terms go in data/private-terms.txt)
node --test test/google.test.js   run one suite
npm run google:login              one-time Google sign-in (read-only Sheets and Drive, drive.file for backups); saves
                                  data/google/token.json (copied into the server's data/google at cutover)
npm run google:exports            count Health Auto Export's files in HEALTH_EXPORT_FOLDER_ID and WORKOUT_JSON_FOLDER_ID
npm run google:check              verify read access to each *_SHEET_ID in .env (prints tab names and row counts only)
npm run sync                      copy Health Auto Export's new files and the Workout Log into data/health.db (prints counts and warnings only)
npm run sync -- --backfill        one-time full import: every Workout Log year tab, the v1 drinking log and weekly check-ins
The register-*-task.ps1 lines are the PC's Windows tasks, until cutover only: on the server the SCHEDULE_ lines in its .env
run the same jobs (never both at once), and afterwards the PC is the development machine with no tasks.
powershell -ExecutionPolicy Bypass -File scripts\register-sync-task.ps1   (re)register the daily 7am sync task
                                  ("Health-Review daily sync"; runs scripts\sync-daily.cmd, logs to data\logs\sync.log)
powershell -ExecutionPolicy Bypass -File scripts\register-review-task.ps1   (re)register the review task: Sunday 8am, catch-ups Monday and Tuesday
                                  ("Health-Review weekly review"; runs scripts\review-weekly.cmd, logs to data\logs\review.log)
npm run log:normalize             apply config/exercise-dictionary.json to all Workout Log history (prints coverage)
npm run log:unmapped              names with no dictionary entry, with set counts (-- --suggest asks Claude, names only;
                                  -- --accept data/exercise-proposals.json adds the kept proposals)
npm run fix:session-times         one-off, already applied: consolidated-sheet workout times back 3 hours (-- --apply; dry run default)
npm run log:typos                 exercise names that look like typos of each other, numbered (-- --merge 1,3 folds them
                                  into the exercise they look like and re-normalizes; -- --distinct 2 marks them different)
npm run programs:detect           propose program blocks from history (-- --write saves them as detected)
npm run programs:review -- list   confirm, edit, merge, split blocks and unassign days (see README.md)
npm run programs:catalog          validate data/maps/programs.json and print each program's weeks and phases
npm start                         UI and API at http://localhost:5188 (API contract: /api/openapi.json)
npm run server:restart            stop the server (task and its node process) and start the task again; run after code changes
npm run server:stop               stop it (ending the task alone leaves node running; stop-server.ps1 stops the process too)
npm run demo                      the demo instance on http://localhost:5189: data/demo/demo.db only (built when missing,
                                  remade when its day is past), no .env, no sync, review or chat (server/demo.js sets HEALTH_INSTANCE=demo)
npm run demo:build                rebuild data/demo/demo.db from demo/generate.js (also the demo's reset)
docker build -t health-review .   the server image (Dockerfile; code only: .dockerignore keeps data/, .env, sign-in files,
                                  backups and MAPS files out; runs as uid 1000, DATA_DIR=/app/data, HEALTHCHECK on
                                  /api/health). The demo runs the same image: AUTH_MODE=demo, no env file, a read-only root
                                  and an empty tmpfs /app/data, where it builds its made-up database at start
deploy/                           the server (/opt/health-review): compose.yml (app with .env and ./data, demo with no env
                                  file or volume, caddy:2 on 80/443; all restart: unless-stopped for the 04:30 reboots),
                                  Caddyfile (SITE_ADDRESS, DEMO_SITE_ADDRESS, automatic HTTPS, demo noindex, no access
                                  log), deploy.sh (deploy <tag>, rollback, up, pull, status; reads SSH_ORIGINAL_COMMAND for
                                  the forced deploy key, health checks app and demo, rolls back on failure; before an image
                                  that would migrate starts (its db:pending on a copy), an encrypted Drive backup with the
                                  current image, and on a failed deploy the pre-migration copy goes back before the old
                                  image starts; --no-backup, --skip-db-check; the server's copy is installed by hand; state in
                                  ./state, owned by deploy), cloud.env.example (the server .env's names, placeholders)
.github/workflows/deploy.yml      after CI passes on a push to main: build ghcr.io/scottmroth5/health-review (sha-<7>, latest;
                                  a public package, code only), then, only when the repository variable DEPLOY_ENABLED is
                                  true, SSH as deploy and run deploy.sh deploy <tag>; manual runs deploy a tag or roll back
npm run backup                    encrypted backup of data/health.db and data/maps/programs.json to the "Health-Review
                                  backups" folder in Google Drive (-- --to <folder> writes it to a folder instead, such as
                                  a USB drive; -- --check-passphrase checks HEALTH_BACKUP_PASSPHRASE in .env)
npm run backup:restore -- --file latest --out data/restored.db   decrypt a backup into a NEW file (never over health.db)
npm run backup:test               the restore test: decrypt the newest backup into the OS temp folder, integrity check,
                                  compare tables by row count with the live database, delete it (-- --file <path> for a file)
powershell -ExecutionPolicy Bypass -File scripts\register-backup-task.ps1   (re)register the 11pm nightly backup
                                  ("Health-Review nightly backup"; runs scripts\backup-nightly.cmd, logs to data\logs\backup.log)
powershell -ExecutionPolicy Bypass -File scripts\register-server-task.ps1   (re)register and start the server at sign-in
                                  ("Health-Review server"; runs scripts\server-start.cmd, logs to data\logs\server.log)
npm run prompts:import-v1         one-time import of data/v1-export/prompts into prompt_sections (-- --replace to overwrite)
npm run metrics                   print the computed summary for last week (-- --week YYYY-MM-DD for another Saturday)
npm run evals                     free: metric fixtures, then a summary of saved review eval results
npm run evals -- --regrade v1     free: re-apply the current checks to a variant's saved drafts
npm run evals -- --live [--variant v2] [--cases a,b]   paid: run the review contract eval (about $0.35 per case)
npm run review                    sync, then write the weekly review for the week ending last Saturday (-- --week YYYY-MM-DD,
                                  -- --dry-run to build and size the prompt without calling Claude, -- --no-sync,
                                  -- --force to write it although Apple Health days are missing or partial)
Scripts that need secrets load .env through node --env-file. GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and
GOOGLE_REFRESH_TOKEN in the environment override the files in data/google.

## Data
Time zone: the user's zone (tools/time.js, Intl, no library) decides every "today", the review week, file write times
(localStamp), the January Workout Log tab rule and spend months, never the host's zone, so a server on UTC gives the same
results. A user's zone is their settings row time_zone (PUT /api/account/time-zone, Settings), else OWNER_TZ (default
America/New_York); the owner is always OWNER_TZ. Requests run in their user's zone (app.js preHandler withTimeZone), as do
ingest posts and each user's scheduled sync and review; ownerTz() returns the current zone, so localDate() and the like
need no argument. The schedule itself (and the review's due hour) is on OWNER_TZ. Never use getHours/getDate/toLocale* or SQLite 'localtime' for these
(migration 021 used 'localtime' once, on the owner's New York machine, so its stored values are right). Tests pass under
both TZ=UTC and TZ=America/New_York (test/time.test.js holds the Saturday 11:30 pm case).
Sheets are read unformatted with dates as serial numbers and stored as local wall-clock text; no time zone conversion.
Apple Health comes only from Health Auto Export's own day files, one Drive folder per kind (ingest/sync.js syncExports;
listed with drive.metadata.readonly and filtered to that kind's file names): HEALTH_EXPORT_FOLDER_ID holds health metrics
as Google Sheets files (read with the Sheets scope); WORKOUT_JSON_FOLDER_ID holds workouts as JSON (Workouts automation,
Export Version 2, Include Workout Metrics, grouped by minute; HealthAutoExport-YYYY-MM-DD.json; downloaded with
drive.readonly, owner's choice 2026-10-22, reading only that folder). ingest/parsers.js parseWorkoutJson keeps start and end
to the minute like every stored workout and each workout's heartRateData as workout_hr_samples (migration 022: one row a
local minute, Avg, Min and Max bpm); a stored workout of the same type starting within a minute is the same one (its
values fill gaps, then it is replaced), so re-exports never duplicate. The Sheets-format workout export (broken by iOS
27.0.1) is retired; its stored rows stay. Both folders: only new or changed files
(drive_exports, migration 016), at most 100 per folder per sync, saved every 25, every Sheets read paced 1.1 s apart
(createPacer; Google allows 60 a minute) and a 429 ending that folder's reading for the sync rather than failing it, and each health day merged with the stored day by
mergeHealthDays so a partial export never lowers a full day. A missing folder variable skips that kind with a warn line.
The v1 consolidated health and workout sheets (and their Apps Script) are retired (owner's choice, 2026-10-16) and never
read; days stored from them stay, have no exported_through, and keep the steps rule for partial days.
Health metrics as JSON (ingest/health-json.js parseHealthJson; Export Version 2, Time Grouping Day; checked against stored
days 2026-10-23: 21 metrics matched on every full day): files of any automation name in the health folder (kind health_json;
the Sheets files stay kind health) and in STAND_EXPORT_FOLDER_ID. Units are checked per metric (a mismatch is skipped with a
warning); readings not grouped by day are skipped. Past-range exports lack the day's totals (steps, exercise, stand time),
and the merge keeps stored ones. Stand hours: the Day-grouped apple_stand_hour undercounts (7 vs the ring's 16), so it is
ignored; a separate "Stand Hours" automation (Apple Stand Hour only, Time Grouping Hours) gives qty 1 per hour with standing,
kept in stand_hour_samples (migration 023), and stand_hours = MAX(stored, distinct hours), since one export may hold part of
a day. ingest/apply.js applyHealthDays, writeJsonWorkout and applyWorkouts are the one write path for the Drive files and
the REST posts.
REST ingest (the server, APPLE_SOURCE=rest; the default drive keeps reading the Drive folders, and rest reads none):
POST /api/ingest/health and /api/ingest/workouts take Health Auto Export's REST automation payloads (the same JSON), with
Authorization: Bearer INGEST_TOKEN (SHA-256 then timingSafeEqual; no token set: 503), application/json only (415), 5 MB
(413), 30 posts per 15 minutes per address (429); open without a Google session, refused in the demo. The receipt time
(owner time) is exported_through. ingest_log (migration 023) keeps time, route, result, counts and error name, never the
body. With rest, the "export stopped" check counts from the last accepted post of each route (test/ingest.test.js).
Data checks (metrics/dataquality.js, pure; fixture evals/fixtures/metrics/dataquality.json) run after every sync and
on GET /api/status: Apple Health data stale (nothing after a day before yesterday), the export automation stopped
(export_stale: the latest sync that looked in the health export folder ran more than 26 hours after the newest file was
written; workout_export_stale: the same for the workouts folder at 72 hours, as a rest day can write no file; measured to
that sync, never the clock; loadDataCheckInput's lookedAt and workoutsLookedAt), gaps in the last 14 days, partial
days (owner's choice, 2026-10-16: a day whose latest export file was written before the day ended, from
daily_metrics.exported_through, migration 021, set by syncExports as the latest file time in local wall clock; a day with
no file time, from the consolidated sheet, falls back to steps under a quarter of the 28-day median, at least 10 days of
it; partialReasons says which), lifting days with no Apple Watch strength
workout (info only), durations longer than their start-to-end span, and impossible values. Findings name dates and
counts only; warnings show on Daily Check-in (#today), all go to the sync log, and the weekly summary's dataQuality carries the
week's missing and partial days (only when there are any), which CONTRACT says to treat as incomplete, never as bad days. The Workout Log has one tab per year: normal syncs
read the current year (and last year in January), and a tab is replaced only when its content hash changes.
Drinking days and check-ins came from v1 sheets once (source 'v1-sheet'); the UI owns them now and imports never
overwrite UI rows. The Workout Log can hold planned future workouts with weights but no reps: metrics count only sets
with reps, time, or distance, on dates up to today. Text in the log's date column (illness, injury, vacation) is kept
in workout_log_notes; treat it as symptom data under the hard rules. History: the retired consolidated Workout Sessions
sheet ran 3 hours late in Start, End and Duration alike (the v1 Apps Script copied between files in different time zones;
the export files are right, confirmed against Fitness 2026-10-15): migration 012 repaired stored durations, and the one-off
npm run fix:session-times (ingest/session-times.js, run 2026-10-15) moved stored starts and ends back and deleted the late
twins of export rows. ingest/parsers.js sessionDuration still drops a Duration 3 hours longer than the workout's span; a
duration that fits neither way is NULL and minutes come from start to end.

## Metrics
The review week is the 7 days ending on the most recent Saturday before today; the baseline is the 28 days before it;
strength looks back 28 days; correlations and next-morning comparisons use 90 days and return null below their minimum
counts (3 per group, 10 pairs). Values are rounded in code to the precision the report prints, so the review can be
checked for numbers that are not in the summary. Days without a row are unknown, never zero (drinking rates are per
logged day). Zone 2 counts cardio sessions whose average heart rate is inside the range in settings (no per-minute HR).
Metrics turned on in Health Auto Export 2026-10-15 (migrations 017 and 018): cardio recovery, walking heart rate, speed and
asymmetry (lower is more even), heart
rate min, max and average, sleeping wrist temperature and physical effort join RECOVERY_METRICS (week vs baseline, unusual
days); blood oxygen and breathing disturbances form the summary's nightBreathing block (no unusual-day flags), which
CONTRACT treats like lab values and prepareReview routes like lab names (NIGHT_BREATHING_NAMES). The Health tab charts
all but heart rate min, max and average and physical effort, plus the check-in's weight, body fat, muscle mass and visceral
fat; a chart with no data in the selected range is left out and named in one line below the charts (#charts-hidden).
Partial days (GET /api/history partialDays, by dataquality.js partialDays) are drawn red on the Apple Health charts with a
hover line, labeled in the table view, and left out of each card's avg; check-in and drink charts are not marked.
Medications (metrics/medications.js): each dose or timing period is a row in medication_periods; stopped_on is the first
day it no longer applied, so a change closes one period and opens the next on the same date. Start, change and stop
events are derived, never stored. Impact compares the 28 days before an event with days 7 to 34 after it (minimums 14
days for daily metrics, 7 for check-ins; pending until the after window ends) and lists other events within 28 days.
These are observational before and after averages; never present them as cause, and route them to physician discussion.
A period with start_estimated (real start unknown; the owner's existing items count from 2026-01-01) is active from
started_on but never produces a start event. Daily check-off (medication_doses): saving a day records every slot taken
or skipped; a day with no rows is unknown, never missed. The weekly summary reports doses taken out of doses logged.
A saved slot can carry a one-day adjustment (migration 014): dose (taken instead of the period's dose) and moved_to (the
slot it was taken in; timing stays the scheduled slot, the key). Values equal to the default are stored as NULL. The
Daily Check-in (#today) shows and edits them; the Meds tab periods stay the defaults, and the weekly review ignores adjustments
(owner's choice, 2026-10-07).
A dose or timing change is a new dated period; a correction (fixing a typo) updates the current period in place and
records no event.
Ingredients (migration 015): a period has dose or ingredients (JSON [{ name, dose }], never both; names unique per item), so
each ingredient's dose history is the period history; change events carry ingredientChanges ({ name, from, to }) and the
weekly summary's current list carries ingredients. POST /api/medications/combine (queries.js combineMedications;
preview first) merges items taken as one pill into one item: periods split at every start, change and stop of any of them,
estimated starts stay estimated, one slot for all, one check-off per logged day (taken if any was), old items removed.
medicationNames (metrics/load.js) gives medication names plus their ingredients' names for the review and chat routing
checks. Each Meds card shows its dose history once there is more than one period, and the last 12 weeks of check-offs
(weeklyCheckoffs; GET /api/medications/checkoffs?weeks=4..52): taken out of logged per week ending Saturday, the current
week so far last, a week with nothing logged shown as not logged, never missed.

Training volume (metrics/volume.js): reps x total load (per-hand weights x2) over performed sets dated up to today;
days without lifting are real zeros; band, bodyweight, timed and unparsed sets are counted as sets, not volume; weeks end
on Saturday. GET /api/training?view=week|month|3m|6m|year|2y|5y|all (3m, 6m and year: 13, 26 and 52 weekly bars) feeds the Training tab, and computeWeek's
trainingVolume (last 12 weeks and 12 months) goes to the weekly review.
Each bar also lists its training programs (metrics/programs.js): Workout Log "Workout" names map to programs via
PROGRAMS (first match wins); an unnamed lifting day takes the program from up to 7 days before, and a Trigger Session
day takes the nearest named program within 14 days either way. Edit PROGRAMS to add or rename a program.
Exercise normalization: config/exercise-dictionary.json maps every name variant to a canonical exercise with an
implement, movement pattern and primary flag; ingest/normalize.js writes canonical_id, implement, movement_pattern,
is_primary and map_status next to the raw strength_exercises row (raw names never change), and sync reruns it after
replacing a tab. Names match by baseKey (spelling, plural, hyphen, typo and word order); same lifts named with
different words merge only through dictionary variants, which the owner decides. Unknown names are flagged, never
guessed ('inferred' only when one implement word names the implement). Volume and strength group by canonical
exercise, so barbell and dumbbell versions are never combined; unmapped names fall back to baseKey.
Typo finder (metrics/name-typos.js, pure): two spelling keys that differ in one word 1 or 2 letters apart (at most half
the longer word, 3+ letters); dictionary pairs must share implement and pattern; the keeper is the side whose word is more
common in the dictionary, then more sets. The dictionary's distinct list (ids, or key:<baseKey> for a logged name) holds
pairs the owner marked different. Nothing merges without the owner's numbers; each sync adds an info line with the count.
Program blocks: one block per program run, named by program only (phases ignored); detected from workout names (metrics/blocks.js: the
same program before and after unassigned days or a break of any length is one block unless another program comes
between; Between programs and Home workouts are blocks, but a Between programs, HIIT or ab-program stretch with the
same program on both sides joins that run),
then confirmed by the owner. log_sessions holds one row per lifting day (UUID v5 of the date) with its block or an
explicit unassigned; re-detection never touches confirmed blocks, owner-unassigned days or forward sessions. After a
sync, new lifting days join the in-progress confirmed block with program and week (source 'forward').
MAPS catalog (metrics/catalog.js, data/maps/programs.json): each program's weeks, phases with week ranges, deload and
failure weeks and prescriptions, transcribed from the owner's Mind Pump PDFs in data/MAPS Programs. refreshPhases
(after detection, review commands and sync) stores each session's phase and each block's program_weeks. Phases come
from the logged workout names (the owner misses days, so calendar weeks drift); the catalog supplies phase lengths, and
its calendar is only the fallback for a block with no phase names (marked estimated). blockStatus and programProgress
(metrics/blocks.js) give the phase and when it started, week of phase and of program, the earliest finish (rest of
the program at full speed from the current phase's start) and the finish at this block's pace (actual over planned
weeks of its finished phases); status stays detected or owner-set, and abandoned is never proposed.
GET /api/program feeds the Training tab's Current program card, and the weekly summary's program block carries the
same facts. Everything works without the catalog (phases unknown).
New tables use portable types (UUID text keys, UTC ISO timestamps, CHECK constraints) for a later PostgreSQL move.
Plateaus (metrics/plateau.js): each primary lift (one canonical exercise and implement) is judged within one rep range,
the range trained most in the last 42 days: 1-5 and 6-12 reps by the session best Epley estimated max (load x (1 + reps
/ 30), per-hand x2), 13+ by the heaviest load for 13+ reps, and bodyweight lifts with no added load by reps per set.
Deload sessions (stored phase or workout name) and a lift's first session back after 21+ days off are left out.
Recent (42 days) against baseline (the 84 before): progressing at +2.5% or more, regressing at -5% or worse, stalled
in between; fewer than 4 recent or 2 baseline sessions is not_enough_data; a range absent from the baseline is
new_rep_range, never a stall. GET /api/lifts feeds the Training tab's Lift progress card; the weekly summary's
lifts holds recently trained lifts only (no trend points), and CONTRACT tells the model to report these statuses as given.
Program Advisor (metrics/advisor.js, pure; fixture evals/fixtures/metrics/advisor.json): ranks the catalog's standalone
programs (the one run last and those listed under not_ranked in config/substitutions.json left out with their reason; add-ons such as No BS 6-Pack listed apart) on the owner's goals (strength, joint
health and balance, time, VO2 max), each 0 to 1 from the prescription (heavy and 6-12 rep shares, one-side and arm
isolation shares, the profile's judged conditioning and mobility, the avoid list in config/substitutions.json) and past
runs (first vs last 2 weeks of primary lift estimated maxes, first vs last 4 weeks of VO2 max), times completion on
past runs; a program never run assumes the owner's average completion over all past runs, and the lowest score among
goals weighted above 0, when under 0.2 (LOW_GOAL), scales the total by 0.5 + 0.5 x score / 0.2 (owner's choice after the
2026-10-14 backtest, where an untried HIIT with strength 0 ranked first for 8 years). Lift history compares only within one
rep range (across ranges was tried and dropped: submaximal high-rep sets read as losses). Minutes per session are Apple Watch strength minutes on that program (10+ sessions) or the prescription
estimate times the owner's watch-to-estimate ratio. The model never ranks; reasons are facts from these numbers.
Goal weights (0 to 3 each, default 1; 0 leaves a goal out) change the weighted average. GET /api/advisor?strength=&joint=&time=&vo2=
feeds the Training tab's Next program card, whose weight buttons are saved per browser and change that view only;
the weekly review uses equal weights. The weekly summary carries advisor (the top 3 at equal weights, the program
left out and add-ons, no focus text) only when advisorDue: within 21 days of the block's earliest finish, after it
ends, or between blocks; CONTRACT tells the model to explain the ranking, never re-rank it. loadAdvisorInput
(metrics/load.js) gathers the input for both the API and the review.
Called for vs logged (metrics/adherence.js, pure; fixture evals/fixtures/metrics/adherence.json): each lifting day of a
confirmed block matches its catalog workout by program, stored phase and the number (or capital letter) in the logged
Workout name; a phase with one workout matches every day; Focus, Trigger and Mobility sessions are focus (no fixed list); anything
else is not_matched, never guessed. Exercises pair in order: as_called (same canonical id), swapped (substitutions swaps,
then the fill rule), changed (same movement pattern), then skipped and added; only performed sets up to today count.
GET /api/program/adherence?block= (loadAdherenceInput, loadConfirmedBlocks in metrics/load.js) feeds the Training tab's
card. The weekly summary's programAdherence (weekAdherence) carries the review week's counts, sets logged against called
for, and the names of exercises the owner logged instead or on top; never the catalog's own exercise names (MAPS rule).
Heart rate zones (metrics/zones.js, pure; fixture evals/fixtures/metrics/zones.json): Zone 2 is the saved range (settings
zone2_low_bpm and zone2_high_bpm), Zone 1 below it, Zones 3 to 5 split evenly from its top to 208 - 0.7 x age (profile
birth year; above it is Zone 5). Each per-minute sample counts one minute in the zone of its Avg; cardio workout minutes
with no sample (gaps, workouts before the JSON export) are noDetail, never guessed from the average; strength is left out
(cardio.js sessionKind). GET /api/cardio-zones?view=30d|90d|1y&group=day|week|month (Sunday-to-Saturday weeks; calendar months overlapping the range, the current one to today; the card's Days / Weeks / Months switch is saved per browser) feeds the Health tab's
"Cardio minutes by heart rate zone" card (stacked columnChart segments in distinct hues: sky blue, green, purple, yellow, red, gray for no detail; owner's choice 2026-10-24); bounds are null
without a Zone 2 range or birth year. The weekly summary carries heartRateZones (weekZones: the week and the 28-day baseline's weekly average per zone, noDetail apart, the bounds; absent without bounds or cardio); CONTRACT says report as given, noDetail is unknown and never Zone 1, and its Zone 2 minutes beat cardio.zone2 (whole sessions by average).
VO2 max (metrics/vo2max.js): GET /api/vo2max?view=90d|1y|2y|5y|all feeds the card at the top of the Health tab; short
views plot each Apple Watch reading, 2 years weekly averages, 5 years and all monthly averages (empty weeks and months
left out, never zero). Tiles: latest, change vs the nearest reading within 30 days before 90 days and 1 year ago, and
best on record, plus its target (below).
Targets (metrics/targets.js, pure; norms in config/health-targets.json with sources; fixture evals/fixtures/metrics/targets.json):
every Health tab metric gets a suggested target from the owner's current value (90-day average; VO2 max's latest reading)
and the healthy level for their sex and age (profile in settings: birth_year, sex, height_in): one step toward it, or
straight to it when closer; past it, half a step, held at the cap; ranges get inside and hold; weight's range is BMI 18.5
to 24.9 for the height; no norm means improving on their own data (said so in the reason). The owner can set any target
(health_targets, migration 019; GET /api/targets, PUT and DELETE /api/targets/:metric, PUT /api/profile); the rest follow
the data. The weekly summary's targets block carries each metric with data; CONTRACT says report progress as given, never
invent a target. Age norms on these metrics are the owner's choice (2026-10-15), replacing "values only, no
fitness-for-age labels".
Lab ranges (metrics/labs.js; fixture evals/fixtures/metrics/labs-ranges.json): config/lab-ranges.json holds typical adult
ranges (US conventional units, by name or alias; tests whose unit or method varies are left out); lab_tests.ref_low,
ref_high and ref_set (migration 020) hold the owner's own, which win once set (both NULL with ref_set means no range).
rangeStatus is below, within (bounds inclusive) or above, null without a range or a numeric value. GET /api/labs
carries each test's range and source and each result's status; PUT /api/labs/tests/:id takes ref_low, ref_high or
reset_range.

## Review
npm run review makes one structured-output call (REVIEW_MODEL, default claude-opus-5-5; REVIEW_EFFORT, default high;
refusal fallbacks on via the beta endpoint). The system prompt is CONTRACT in agent/instructions.js followed by the owner's
prompt sections; the report format sections in those prompts were written for v1 raw data, and CONTRACT tells the model the
summary replaces them. Output is checked in code: no em or en dashes or double hyphens; every number must appear in the summary or
instructions (small counts, window lengths and calendar dates allowed, and suggested targets written as "target N");
medication names, lab values (a lab name with a number next to it) and symptom words only in physicianDiscussion; and
at most 3,000 words (the owner's rules ask for under 2,000; the margin avoids paying for a retry over small overruns). Failed checks get one retry listing the problems; dashes left after that are
replaced in code, and anything else is saved with the report as warnings. Runs record metadata only, including the names
of sensitive sections sent; prompt and report text never go to logs or run records.
Data gate (reviewStatus in server/queries.js, weekDataQuality underneath): without --force, a week with any day missing
from daily_metrics or a likely partial export is skipped, recorded as a 'skipped' review run with the dates, and nothing is
sent. GET /api/reviews/status (overdue: no review and a run was tried or it is past 9am on the Sunday after) drives a notice
on Daily Check-in and Reviews; POST /api/reviews/run syncs, applies the same gate (force to override), and writes the review
in the background through services.review (main instance only; never in the demo). A failed manual run keeps its error name only.
Scheduling (server/scheduler.js, ported from Job-Agent; test/scheduler.test.js): while the server runs, SCHEDULE_SYNC
("daily 07:00"), SCHEDULE_REVIEW ("Sun,Mon,Tue 08:00 | Sun 13:00": several parts separated by "|", the earliest next
run wins), SCHEDULE_BACKUP ("daily 23:00") and SCHEDULE_RESTORE_TEST
("monthly 1 05:00") run the same jobs as the npm scripts (jobs/sync.js syncJob, jobs/review.js weeklyReview with
scheduled true, jobs/backup.js backupJob). Times are in OWNER_TZ (tools/time.js zonedInstant), never the host's zone. A
missing or blank line turns that job off, so the PC (lines commented out) runs nothing and keeps its Windows tasks until
the move; a bad spec stops the server rather than silently disabling a job. A run missed within 12 hours runs on start
when the job has not run since; a job never overlaps itself (in this process, or a run of that name marked running in the
last 30 minutes). GET /api/jobs carries each job's schedule and next run for the Activity tab; [schedule] lines go to
stdout. The restore test runs jobs/restore-check.js restoreTestJob.
The scheduled review (and the Windows task's --scheduled): a Monday or Tuesday catch-up does nothing once the week's review exists. A review whose saved
summary has dataQuality (written with gaps) gets rewriteAvailable once the week is complete; the notice offers Rewrite with
the full week (POST /api/reviews/run overwrites the week's review); nothing rewrites automatically.
server-start.cmd runs stop-server.ps1 -KeepTask first, so starting the task replaces a leftover server (it holds port 5188
and server.log open).

## Eval
The review contract eval runs the real pipeline on 13 cases (9 real weeks read from data/health.db by date, 4 synthetic
edge cases layered on a throwaway in-memory copy) and grades the first draft in code: sections, dashes, grounding,
routing, physician item when required, length. Results and traces live in data/evals/review (gitignored: traces hold the
full prompt, including sensitive sections); variants are baseline, v1, v2, ... with a change.md each. A harness sha
gate covers the runner, cases, grading and agent files: after changing any of them, the owner (never Claude) re-approves
with --approve-harness. Every live run sends health data to the Claude API and costs money: ask before running one.
Results so far: baseline 7/13 first drafts clean (9/13 re-graded), v1 9/13 (12/13 at the 3,000-word limit), 13/13 final.
v2 (Advisor and dataQuality blocks) 11/13 first drafts clean, 12/13 final: synthetic-empty-week failed routing because the
advisor wording ("prescription") tripped the medication check; v4 reworded it to "calls for" and passed that case on
the first draft (v3 was the same prompt as v2, a single lucky pass).

## UI and API
Access (server/auth.js, server/session.js, server/security.js; ported from Job-Agent, test/auth.test.js):
AUTH_MODE=none (local default) binds to 127.0.0.1 only and rejects requests whose Host header is not localhost (DNS
rebinding). AUTH_MODE=google: Google sign-in with GOOGLE_WEB_CLIENT_ID and GOOGLE_WEB_CLIENT_SECRET, callback
/auth/google/callback built from PUBLIC_URL (redirect URI PUBLIC_URL + that path). Registration (phase 2): any verified
Google account gets a session; the users row is looked up on every request: none goes to /auth/register (Request access,
terms checkbox; POST creates a pending user and emails the admin), pending to /auth/waiting, rejected to
/auth/not-approved; approved and paused get in (req.uid, req.role). AUTH_ALLOWED_EMAILS's first address is the owner
(user 1, admin; syncOwnerEmail). /privacy and /terms (PRIVACY.md, TERMS.md through server/pages.js) are open. hr_session cookie signed with SESSION_SECRET (30 days, HttpOnly, SameSite=Lax, Secure on https), same-origin
required on writes, TRUST_PROXY set behind Caddy; sign-in asks for openid email profile, and the session carries the
Google first name (given_name, else name; 60 characters, never logged) for the header's "(name)", which GET /api/me
returns; open without a session: /auth/*, GET /api/health (status and version, the deploy check), /api/ingest/* (its own
token), and /manifest.webmanifest and /icon-*.png (iOS fetches them without cookies). AUTH_MODE=demo: no sign-in, every non-GET request gets 403 (the
test enumerates the route table through app.routeList, so new write routes are covered), /api/status readOnly true hides
write controls (body.read-only) and api() refuses changes before sending. Security headers (CSP, nosniff, frame DENY,
HSTS on https) always; rate limits (sign-in, refused requests, the demo's request cap) when not none. Check-in and drinking scales are 1 to 10 to match
v1 history. CBD drinks are stored in drinking_days.cbd and never counted as alcohol. The Meds tab manages medications and
supplements (add, change, stop, start again, delete for mistakes); the weekly review takes them from there, not from the
medical prompt section. The Labs tab shows lab_tests and lab_results by panel, with a Range column, out-of-range results
marked with an arrow and "below range" or "above range", and a range editor in each test's detail, whose chart shades the
range (lineChart's range option: band, dashed low and high lines, red out-of-range points, the hover says which). The owner enters labs in the app (the March
2026 draw was imported once and marked as app results); syncing a lab sheet is supported but unused. Results can come from a lab sheet
(LAB_RESULTS_SHEET_ID; the tab whose A1 is "Lab Test"; capitalized rows with no values are panel headings; one column
per draw date), synced whole on every sync and replaced only when its content hash changes, or from the app (source
'ui'), which sync never overwrites and which win a clash. Any result can be corrected in the app: a corrected sheet
result becomes 'ui' with corrected_from and corrected_from_date (the sheet's original value and date), sync skips the
sheet's copy, and undoing restores the original. Sheet results cannot be deleted in the app. Prompt sections live in
prompt_sections (edited on the Prompt tab; every save and delete copies the old row to prompt_section_versions);
sensitive sections are included in the weekly review (WEEKLY_INCLUDES_SENSITIVE in agent/prompts.js) and badged in the UI;
buildInstructions leaves them out unless a caller opts in.
The Activity tab lists runs (GET /api/runs, /api/runs/:id: the tracer's runs and run_calls, metadata only) and, under
Scheduled jobs, each job's last runs (sync, review, backup, restore-test) plus the last Health Auto Export posts
(GET /api/jobs, queries.js jobsActivity: runs and ingest_log only). It reads no log files (the Windows tasks still write
data/logs until the move, but nothing serves them). The server logs one line per event to stdout through buildApp's log
(console by default): [sync] ok with counts, [review] ok or failed with the week, [ingest] route ok or error; counts and
names only, never health, prompt or report text, so docker compose logs shows what ran.
GET /api/spend (queries.js spend) totals estimated Claude API cost by month and year: runs.cost_usd by kind (review, advisor-chat,
other) plus the review eval's results.jsonl usage priced with agent-core's pricing.js (imported by path until agent-core
exports it), dated by each results file's last write; only model and usage are read. The demo passes no eval folder.

## Hard rules
Users, phase 6 (2026-10-24), account controls and help: GET /api/account/export (server/admin-queries.js exportUserData:
the account row without claude_key_enc, ingest_token_hash or google_refresh_enc, plus every row of theirs in every table
with a user_id column, found from the schema, and their run_calls); POST /api/account/pause and /resume (settings row
paused_by_self; an admin's pause or resume clears it, so only the admin resumes theirs); POST /api/account/delete and POST
/api/admin/users/:id/delete, both with the typed email (deleteUserData: every user_id table children first, run_calls by
cascade, then the users row, one transaction, never an admin; the admin is emailed, the session cookie cleared). Help
(#help, agent/help.js): GET /api/help and POST /api/help/ask (claude-sonnet-5-5, the user's AI by ai-access, 20 an hour per
user in memory; system prompt is the guides HELP_GUIDES, the prompt is the question; dashes replaced; nothing stored, the
help-ask run keeps lengths and cost). docs/guides/using-the-app.md is the tile-by-tile guide. The demo's banner and Home
link to REQUEST_ACCESS_URL (deploy/compose.yml: the main app's /auth/login from SITE_ADDRESS), only in the demo.
Users, phase 5 (2026-10-24), each user's own programs: user_programs (migration 028; in USER_TABLES, so the scope and
isolation guards cover it) holds programs in the catalog format with match words; ingest/user-programs.js (saveProgram,
deleteProgram, importPrograms all or nothing, exportPrograms their own only) checks each with metrics/catalog.js
programProblems (any name, 80 characters) and re-runs detection (detected blocks only) and refreshPhases after every
change. metrics/load.js userCatalog(db, shared) is the catalog a user gets: their own first, then the shared one (the MAPS
file for the owner and maps_shared users; mergeCatalogs, theirs win a name clash); left undefined, every default reads
the MAPS file plus the user's own (loadWeekData, sync, the programs scripts). programMatchers(db) (metrics/programs.js
userMatchers: whole-word match words, any case, before PROGRAMS) names days in detectBlocks and trainingView. Routes:
GET/POST /api/programs, PUT/DELETE /api/programs/:id, POST /api/programs/import, GET /api/programs/export, GET
/api/program/blocks and POST /api/program/blocks/:id/confirm (users confirm blocks in the app; edits, merges and splits
stay npm run programs:review), and POST /api/programs/extract: a PDF (20 MB, base64, rightToUse required, the user's AI by
ai-access) read by agent/extract-program.js (claude-opus-5-5, DRAFT_SCHEMA structured output, the PDF as a document
block) into a draft the user checks in the builder; nothing saved, and the PDF is never stored, logged or in the run
record (program-extract: bytes, model, counts, cost). GET /api/programs shows the shared catalog by name only. The Users
screen shows each user's program count only.
Users, phase 4 (2026-10-24), administration: server/ai-access.js decides each user's AI (aiAccess, pure): the owner's
server key for the owner; a user's own key first; else the owner's key when the admin turned it on (users.uses_owner_key
with owner_key_cap_usd, $1 to $100 a month) while their runs.cost_usd since the start of the owner's month is under the
cap; else none, with aiReason no_key, cap or paused (any status but approved). createAiAccess.check (server/index.js
claudeFor, hasAi and services.aiAccess) emails the user and the admin once a month at the cap (their settings row
owner_key_cap_notified = YYYY-MM; changing the cap clears it). A run that starts under the cap may end a little over it.
Admin routes (onRequest adminOnly, so non-admins get 403 before validation): GET /api/admin/users (listUsers: account
facts, feeds chosen, has_token, google_connected, sheet_set, last post and sync, has_key, cap, spent_month, maps_shared,
counts of health days, lifting days and reviews; never a key, token, hash or sheet ID), /:id/approve, /:id/reject (end
access), /:id/pause and /:id/resume (approved to paused and back), /:id/owner-key ({ on, cap, confirmEmail }: on needs the
user's email typed and a cap; the user is emailed on and off), /:id/maps ({ shared }). None act on an admin; owner-key and
maps need an approved or paused user. Paused: signs in and sees their data; ingest token 401, POST /api/sync 403, no AI,
no scheduled jobs (activeUserIds), and a note on Home. The scheduled review skips a user with no AI with its reason.
Goals, tiles, feedback, prompt builder (2026-10-25): server/public/goals.js (pure; the browser and the server import it)
holds the goals (strength, cardio, weight, endurance, health; settings goal_primary and goal_secondary, PUT
/api/account/goals) and what each puts first: Home tiles (after Daily Check-in), Training and Health card ids, Health chart
keys, and the Next program card's default weights (when the browser has none saved). Order only, nothing hidden. The
review summary's goals (labels, metrics/load.js loadGoals) and a CONTRACT line make the review open with them; the chat
context carries them too. Home's Arrange tiles saves settings tile_order (PUT /api/account/tile-order, known tiles only);
the tab bar follows it. Feedback (migration 029 feedback, a user table): POST /api/feedback (feedback, enhancement, bug;
subject 120, body 5,000, screen and app version and browser as context; 5 an hour; not the demo or paused accounts) is
stored and emailed to the admin with the sender as reply-to; GET /api/feedback (their own), GET /api/admin/feedback and
POST /api/admin/feedback/:id/status (the Users screen's Feedback card; the Users tile badge counts new ones). The Prompt
tab's Help me write a section (agent/prompt-draft.js SECTION_KINDS): GET /api/prompt/builder, POST /api/prompt/draft
(a template without AI, or claude-sonnet-5-5 with the user's AI from their answers and goals only, never their data or
medications; 20 an hour; prompt-draft run with lengths), opened as a new section to edit and save. Guide:
docs/guides/prompts.md (guidance and examples per section).
Excel Workout Log (2026-10-25): GET /api/workout-log/template.xlsx (ingest/excel-upload.js workoutTemplate: the year tab with
WORKOUT_LOG_HEADER, bold and frozen, Date as m/d/yyyy, and How to use) and POST /api/workout-log/upload: the raw body with
the .xlsx content type only (its own parser, 5 MB; anything else 415), an X-File-Name ending .xlsx, never the demo, the
owner, a paused user or one with a Google Sheet Workout Log set, 10 an hour per user. tools/xlsx.js (no dependency; Node
zlib) reads it strictly: the central directory, no encryption or zip64, safe part names, at most 200 parts, inflation
capped (10 MB a part, 40 MB in all, ratio 200), a spreadsheetml workbook only (no .xls, macros, external links or
embedded objects), no DOCTYPE or ENTITY, at most 50 tabs, 20,000 rows and 60 columns, cells cut at 2,000 characters,
formulas as their cached values; 1904 workbooks shift the Date column. Year tabs go through parseWorkoutLogTab and replace
those years (tab_year = year), then afterChange (ingest/app-workouts.js); the file is never stored or logged, and the
workout-upload run keeps counts only. test/fixtures/excel holds files saved by Excel with made-up rows and personal
information removed.
Enhancements (2026-10-25): sync, the manual review run and the chat question are one at a time per user (app.js syncing,
reviewRuns, chatting), never shared. server/alerts.js emails the admin: a scheduled job failing (per user for sync and
review, at most once a day per kind, settings row alert:<key> on the owner, cleared on recovery), the owner's week still
skipped at Tuesday's catch-up, and after the owner's scheduled sync health_stale, export_stale or workout_export_stale
(once until it clears); names, dates and error names only. A sheet the app created (settings workout_log_created) gets
each new year's tab on its first sync of the year (ensureYearTab; a failure is a sync warning). Workouts logged in the
app (ingest/app-workouts.js, the Training tab's Log workout card): strength_exercises and strength_sets at tab_year 0
(APP_TAB_YEAR; the Sheets sync deletes only the year tabs it reads), one per day, parsed with parseWeight and parseSet,
then the dictionary, detection, assignForward and refreshPhases; GET /api/workouts, /api/workouts/suggest (their history
and dictionary names, their own programs' workouts only), PUT and DELETE /api/workouts/:date (up to today).
Create my Workout Log (2026-10-25): /auth/google/sheets?create=1 asks for spreadsheets.readonly plus drive.file (DRIVE_FILE_SCOPE,
non-sensitive: only files the app created); the callback refuses a grant without both, stores the token, then app.js
createSheet (never the owner) calls services.createWorkoutSheet (ingest/create-sheet.js: "Health Review Workout Log",
a tab named with the owner's year holding WORKOUT_LOG_HEADER in row 1, bold and frozen, and a How to use tab; no example
rows) and saves it as workout_log_sheet_id (sheets-created, or sheets-create-failed). feedsView gives the user their own
sheetUrl (never the admin screens) and canCreate. The Today section is labeled Daily Check-in (#today unchanged).
Users, phase 3 (2026-10-24), per-user feeds: a user's Health Auto Export token (POST/DELETE /api/account/ingest-token;
32 random bytes shown once, only its SHA-256 in users.ingest_token_hash) makes the ingest guard store their posts under
their id (INGEST_TOKEN stays the owner's; a pending, rejected or paused user's token gets 401). Their Workout Log: a
separate Google consent for spreadsheets.readonly only (/auth/google/sheets and SHEETS_CALLBACK_PATH, PKCE, state cookie
hr_sheets; the refresh token sealed in users.google_refresh_enc, migration 027), then PUT /api/account/workout-sheet
(a link or ID, checked by listing its tabs with their permission; needs a year tab; stored in their own settings row
workout_log_sheet_id, never on the admin screen); DELETE /api/account/google forgets both. jobs/sync.js syncJob with
userFeed reads only that sheet (apple rest, no Drive folders, no lab sheet, no v1 imports; catalog null unless MAPS is
shared). users.feeds (PUT /api/account/feeds, chosen at Request access too) drives the Settings Data feeds card. Setup
guides are public pages /guides and /guides/<name> (docs/guides/*.md through server/pages.js; {{SITE}} filled in at
render time, so the repo never names the live address).
Users, phase 2 (2026-10-24): admin routes /api/admin/users (+ /:id/approve, /:id/reject; server/admin-queries.js; role
admin only, never in the demo) approve with the default prompt sections (agent/default-prompts.js) and an email
(tools/mail.js: Gmail SMTP with SMTP_USER and SMTP_APP_PASSWORD; names, addresses and links only; without them nothing is
sent). A user's Claude key (PUT/DELETE /api/account/claude-key) is checked with Anthropic's free model list, sealed with
AES-256-GCM under USER_KEY_SECRET bound to the user id (tools/secret-box.js), decrypted only in memory for that user's
own call (server/index.js claudeFor), and never returned, logged or shown to the admin (only "set"). No key, no AI: chat
and review answer needsKey, and the scheduled review records a skipped run (reason no_key). The owner's key is
ANTHROPIC_API_KEY. The owner's MAPS catalog file is the owner's and maps_shared users' only (phase 5 adds each user's own).
Users (owner's choice, 2026-10-24: one shared database, user_id on every user table, ahead of the RDS move): every query
on a user table is scoped to one user, writing "user_id = @uid" (inserts include user_id with @uid) and run on a scoped
database (db/scope.js); joins and subqueries scope each user table too. Only server/admin-queries.js reads across users
(system checks, the admin's screens). Requests run as their signed-in user (server/app.js preHandler, AsyncLocalStorage;
none and demo modes are the owner), scheduled sync and review loop over approved users, and backup and the restore test
cover the whole database as the owner. Guards: test/user-scope.test.js (static: user_id at least once per user table in
each statement) and test/user-isolation.test.js (every route from app.routeList as a second user shows and changes none of
the first user's data); a new query or route must keep both passing.
The owner's machine is the owner's own computer plus the servers the owner runs in their own AWS account (owner's choice,
2026-10-23): today one Lightsail instance at SITE_ADDRESS (deploy/), reached only over TLS (Caddy, Let's Encrypt) and
only after Google sign-in as an allowed email, with Health Auto Export posting over HTTPS with INGEST_TOKEN. Its address,
IP, users and keys stay out of the repo (public).
Health data and the MAPS catalog and PDFs may live there (/opt/health-review/data, never in the image, the repo, CI,
GitHub secrets, logs or the demo). After the move the PC is the development machine. Lightsail encrypts its disks and
snapshots with AWS-managed keys, not keys the owner controls: an accepted temporary exception (2026-10-23) until the
move to RDS plus EC2 with a KMS customer-managed key; nothing else is excepted.
Anywhere else, health data may be stored or synced (cloud storage, backups) only if it is encrypted at rest and in
transit (owner's choice, 2026-10-05): TLS for every transfer, and encryption at rest with keys the owner controls. For
files in consumer cloud storage (Google Drive and the like), encrypt before upload, and never store the key or password
with the data. Never store, sync or send it unencrypted, never put it in CI, and never commit it. This is about where
data is kept; what may be sent to the Claude API is governed by the rules below.
The approved off-machine copy is the nightly backup (tools/backup): an online SQLite snapshot that must pass its
integrity check, packed with the MAPS catalog, gzipped, then AES-256-GCM with a scrypt key from
HEALTH_BACKUP_PASSPHRASE (.env only, never uploaded or logged) and a fresh salt and nonce per file, verified by
decrypting before it is uploaded over HTTPS with the drive.file scope (the app sees only files it created). Plaintext
snapshots exist only in the OS temp folder and are deleted on every exit path. Kept: 7 nightly, 3 weekly, 1 monthly.
The monthly restore test (tools/backup/restore-check.js restoreTest, jobs/restore-check.js; SCHEDULE_RESTORE_TEST,
npm run backup:test) proves the newest backup can be read: decrypted into a new OS temp folder (deleted on every exit
path), integrity checked, and compared with the live database by table row counts only. It fails on a decrypt or integrity
failure, a table missing from the backup (unless the backup predates the migration that added it), or a table empty in
the backup that holds 10+ rows live; other differences are recorded (a backup is a day old, and some rows are replaced on
purpose). Each result is a 'restore-test' run; a failed last run is a warning on Daily Check-in until a later one passes.
Send the Claude API computed summaries only, never raw exports. The one exception is the owner's own notes from the review
week (check-in, drinking, Workout Log comments and date-column notes), sent as written by the owner's choice (2026-10-01).
Genetics and medication data (prompt sections marked sensitive, and the medications tracker) go to the Claude API only
as part of the weekly review, which includes them every week by the owner's choice (decided 2026-09-30); each run
records which sensitive sections it sent (names only). The summary's medications block (current list, changes, before
and after averages) is the one place medication data enters the summary. Lab values enter only through the summary's labs
block (latest value, change from the previous draw, and its range and rangeStatus). Reference ranges are the owner's
choice (2026-10-15, replacing "no reference ranges"): code marks a value below or above its range and never says normal
or abnormal; ranges, statuses and any interpretation of labs go only to physician discussion (the routing check catches a
lab name with range wording elsewhere). Never send any of it to another service or
log its text.
The Next program chat (agent/advisor-chat.js, POST /api/advisor/chat) sends computed training facts only: the Advisor
ranking at the owner's current weights (scores, reasons, flags), lift statuses, the current program and week, equipment
and paused exercises, plus the owner's typed note and the last 10 messages of the thread (owner's choice, 2026-10-07).
Never program focus text, raw logs, medications, labs or genetics. Replies get the review's checks (dashes, grounded
numbers, medication and symptom wording only in the physician list; one retry, then warnings). The thread lives in
advisor_notes (migration 013); the advisor-chat run records metadata only. features.chat false turns it off (the demo).
The exercise-name assist (npm run log:unmapped -- --suggest) sends exercise names only (unmapped names and the
dictionary's own names), and only after the owner types yes; never weights, dates, set counts or other log data
(owner's choice, 2026-10-02). Its proposals reach the dictionary only through --accept.
The demo may use MAPS program names (owner's choice, 2026-10-24; the app shows only name, phase and week); its phases,
weeks and workouts are made up, never copied from data/maps or the PDFs.
Help's Ask sends the app's guides and the user's question only, never any of their data.
A user's own programs (user_programs) and the PDFs they upload are theirs: a PDF goes to the Claude API only through
POST /api/programs/extract, after the user confirms the right to use it, on their own AI, and is never kept; their
programs never reach another user, the admin screens, logs or fixtures.
The MAPS PDFs and anything transcribed from them (data/maps) are Mind Pump's copyrighted material: never commit them,
put them in fixtures or the image, or send their text anywhere; only computed facts (program, phase, week) leave the
owner's machine (as defined above, so the server may hold them in its data folder).
Metrics are computed in code, never by the model.
Anything involving medications, abnormal labs, or symptoms is flagged for physician discussion, not turned into a recommendation.
Blood oxygen and breathing disturbances (values and targets) appear in the review only in physicianDiscussion.
Never output em dashes, en dashes, or double hyphens in generated text.
Back up before every database change (owner's rule, 2026-10-24): a migration never runs on a database file without a
checked copy taken first (db/store.js), and a deploy whose image would migrate makes the encrypted Drive backup first and
stops if it fails (deploy/deploy.sh).
Never commit anything under /data, or any .csv or .xml file. Never log or print API keys.

## Conventions
Every new tool gets a JSON schema, a handler, and a unit test.
Every metric change requires passing fixture tests.
Use plan mode for any change touching more than one file.