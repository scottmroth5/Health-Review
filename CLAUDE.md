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
/db                 migrations.js (append only) and openHealthStore (data/health.db, HEALTH_DB_PATH overrides)
/server             Fastify API (app.js routes with JSON schemas, queries.js holds all UI SQL, auth.js) and the
                    static UI in server/public (plain HTML, CSS and JS modules; no build step).
                    Demo mode (header checkbox, or ?demo=1 / ?demo=0; saved per browser, server/public/demo.js) hides
                    drinking and CBD on screen only: the Drinks box, the alcohol chart, and drinking or CBD lines in reviews
/evals              fixtures/metrics (metric regression), fixtures/v1 (v1 golden outputs, see its README), and the review
                    contract eval: review-cases.json (real weeks by date only, synthetic overlays), grade-review.js
                    (shared grading), run-review-eval.mjs (runner from the claude-api skill scaffold)
/tools              shared helpers: paths, google/auth.js (copied from Job-Agent; candidate to move into agent-core);
                    apps-script/ConsolidateHealthMetrics.gs (the fixed v1 consolidation; retired 2026-10-16, reference only)
/demo               the separate demo instance's made-up data: generate.js (seeded generator, run through the app's own
                    normalization, block detection and phases), catalog.json (invented "Sample" programs, never MAPS),
                    substitutions.json
/scripts            command-line entry points
/test               node:test suites with synthetic fixtures only
/data               gitignored; local health datastore and exports; google/ holds the OAuth client_secret.json and token.json
/legacy contains the v1 scripts for reference only. Do not modify or import from them.

## Commands
npm test                          run unit tests, including metric fixtures (CI runs them under TZ=America/New_York and UTC)
npm run check:personal -- --all   personal-data and secrets check of every tracked file (the pre-commit hook checks staged
                                  files; npm install turns the hook on; private terms go in data/private-terms.txt)
node --test test/google.test.js   run one suite
npm run google:login              one-time Google sign-in (read-only Sheets); saves data/google/token.json
npm run google:exports            count Health Auto Export's files in HEALTH_EXPORT_FOLDER_ID and WORKOUT_JSON_FOLDER_ID
npm run google:check              verify read access to each *_SHEET_ID in .env (prints tab names and row counts only)
npm run sync                      copy Health Auto Export's new files and the Workout Log into data/health.db (prints counts and warnings only)
npm run sync -- --backfill        one-time full import: every Workout Log year tab, the v1 drinking log and weekly check-ins
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
npm run demo                      the demo instance on http://localhost:5189: data/demo/demo.db only (built when missing),
                                  no .env, no sync, review or chat (server/demo.js sets HEALTH_INSTANCE=demo)
npm run demo:build                rebuild data/demo/demo.db from demo/generate.js (also the demo's reset)
npm run backup                    encrypted backup of data/health.db and data/maps/programs.json to the "Health-Review
                                  backups" folder in Google Drive (-- --to <folder> writes it to a folder instead, such as
                                  a USB drive; -- --check-passphrase checks HEALTH_BACKUP_PASSPHRASE in .env)
npm run backup:restore -- --file latest --out data/restored.db   decrypt a backup into a NEW file (never over health.db)
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
Time zone: OWNER_TZ (default America/New_York; tools/time.js, Intl, no library) decides every "today", the review week,
the review's due hour, file write times (localStamp), the January Workout Log tab rule and spend months, never the host's
zone, so a server on UTC gives the same results. Never use getHours/getDate/toLocale* or SQLite 'localtime' for these
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
counts only; warnings show on the Today tab, all go to the sync log, and the weekly summary's dataQuality carries the
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
Today tab shows and edits them; the Meds tab periods stay the defaults, and the weekly review ignores adjustments
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
"Cardio minutes by heart rate zone" card (stacked columnChart segments on one blue ramp, gray for no detail); bounds are null
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
on the Today and Reviews tabs; POST /api/reviews/run syncs, applies the same gate (force to override), and writes the review
in the background through services.review (main instance only; never in the demo). A failed manual run keeps its error name only.
Scheduling (server/scheduler.js, ported from Job-Agent; test/scheduler.test.js): while the server runs, SCHEDULE_SYNC
("daily 07:00"), SCHEDULE_REVIEW ("Sun,Mon,Tue 08:00"), SCHEDULE_BACKUP ("daily 23:00") and SCHEDULE_RESTORE_TEST
("monthly 1 05:00") run the same jobs as the npm scripts (jobs/sync.js syncJob, jobs/review.js weeklyReview with
scheduled true, jobs/backup.js backupJob). Times are in OWNER_TZ (tools/time.js zonedInstant), never the host's zone. A
missing or blank line turns that job off, so the PC (lines commented out) runs nothing and keeps its Windows tasks until
the move; a bad spec stops the server rather than silently disabling a job. A run missed within 12 hours runs on start
when the job has not run since; a job never overlaps itself (in this process, or a run of that name marked running in the
last 30 minutes). GET /api/jobs carries each job's schedule and next run for the Activity tab; [schedule] lines go to
stdout. The restore test's job arrives with the monthly restore test.
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
/auth/google/callback built from PUBLIC_URL (redirect URI PUBLIC_URL + that path), AUTH_ALLOWED_EMAILS re-checked on every
request, hr_session cookie signed with SESSION_SECRET (30 days, HttpOnly, SameSite=Lax, Secure on https), same-origin
required on writes, TRUST_PROXY set behind Caddy; open without a session: /auth/*, GET /api/health (status and version,
the deploy check) and /api/ingest/* (its own token). AUTH_MODE=demo: no sign-in, every non-GET request gets 403 (the
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
Health data may be stored or synced off this machine (cloud storage, backups, a future hosted deployment) only if it is
encrypted at rest and in transit (owner's choice, 2026-10-05): TLS for every transfer, and encryption at rest with keys
the owner controls. For files in consumer cloud storage (Google Drive and the like), encrypt before upload, and never
store the key or password with the data. Never store, sync or send it unencrypted, never put it in CI, and never
commit it. This is about where data is kept; what may be sent to the Claude API is governed by the rules below.
The approved off-machine copy is the nightly backup (tools/backup): an online SQLite snapshot that must pass its
integrity check, packed with the MAPS catalog, gzipped, then AES-256-GCM with a scrypt key from
HEALTH_BACKUP_PASSPHRASE (.env only, never uploaded or logged) and a fresh salt and nonce per file, verified by
decrypting before it is uploaded over HTTPS with the drive.file scope (the app sees only files it created). Plaintext
snapshots exist only in the OS temp folder and are deleted on every exit path. Kept: 7 nightly, 3 weekly, 1 monthly.
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
The MAPS PDFs and anything transcribed from them (data/maps) are Mind Pump's copyrighted material: never commit them,
put them in fixtures, or send their text anywhere; only computed facts (program, phase, week) leave this machine.
Metrics are computed in code, never by the model.
Anything involving medications, abnormal labs, or symptoms is flagged for physician discussion, not turned into a recommendation.
Blood oxygen and breathing disturbances (values and targets) appear in the review only in physicianDiscussion.
Never output em dashes, en dashes, or double hyphens in generated text.
Never commit anything under /data, or any .csv or .xml file. Never log or print API keys.

## Conventions
Every new tool gets a JSON schema, a handler, and a unit test.
Every metric change requires passing fixture tests.
Use plan mode for any change touching more than one file.