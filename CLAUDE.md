# Health Review Agent

## Purpose
Weekly health review agent built on the shared agent-core package.
agent-core comes from the public Agent-Core repo as a git dependency pinned to a version tag
("@scottmroth5/agent-core": "github:scottmroth5/Agent-Core#semver:^0.2.1"). Upgrade with npm install "github:scottmroth5/Agent-Core#semver:^<x.y.z>" (a caret on 0.x never crosses a minor version, so npm update will not); test unreleased changes with npm link ../Agent-Core.
Health specific logic stays in this repo; never add it to agent-core.


## Structure
/agent              the weekly review: summary.js (computeWeek trimmed for the model, plus the week's notes),
                    instructions.js (fixed CONTRACT + owner prompt sections, output schema, rendering), validate.js
                    (dashes, number grounding, physician routing), claude.js (agent-core client with refusal fallbacks),
                    review.js (one call, one retry on failed checks, saved to reviews), suggest-exercises.js (the
                    optional exercise-name assist)
/metrics            deterministic metric calculations: stats.js (windows, rounding, pearson), one module per report
                    area (recovery, cardio, strength, drinking, checkins), index.js computeWeek, load.js (SQL),
                    dictionary.js (exercise dictionary loader), blocks.js (program block detection), catalog.js (MAPS
                    program catalog loader);
                    fixtures with hand-computed expectations in evals/fixtures/metrics, run by test/metrics.test.js
/ingest             Google Sheets to SQLite: sheets.js (read-only client, fakeable), parsers.js (one per sheet), sync.js;
                    the only code touching raw source rows; normalize.js (dictionary onto the Workout Log) and
                    program-blocks.js (blocks, sessions, review operations)
/config             exercise-dictionary.json: canonical exercises and name variants (names only; see README.md)
/db                 migrations.js (append only) and openHealthStore (data/health.db, HEALTH_DB_PATH overrides)
/server             Fastify API (app.js routes with JSON schemas, queries.js holds all UI SQL, auth.js) and the
                    static UI in server/public (plain HTML, CSS and JS modules; no build step)
/evals              fixtures/metrics (metric regression), fixtures/v1 (v1 golden outputs, see its README), and the review
                    contract eval: review-cases.json (real weeks by date only, synthetic overlays), grade-review.js
                    (shared grading), run-review-eval.mjs (runner from the claude-api skill scaffold)
/tools              shared helpers: paths, google/auth.js (copied from Job-Agent; candidate to move into agent-core)
/scripts            command-line entry points
/test               node:test suites with synthetic fixtures only
/data               gitignored; local health datastore and exports; google/ holds the OAuth client_secret.json and token.json
/legacy contains the v1 scripts for reference only. Do not modify or import from them.

## Commands
npm test                          run unit tests, including metric fixtures
node --test test/google.test.js   run one suite
npm run google:login              one-time Google sign-in (read-only Sheets); saves data/google/token.json
npm run google:check              verify read access to each *_SHEET_ID in .env (prints tab names and row counts only)
npm run sync                      copy the Sheets into data/health.db (prints counts and warnings only)
npm run sync -- --backfill        one-time full import, including the v1 drinking log and weekly check-ins
powershell -ExecutionPolicy Bypass -File scripts\register-sync-task.ps1   (re)register the daily 7am sync task
                                  ("Health-Review daily sync"; runs scripts\sync-daily.cmd, logs to data\logs\sync.log)
powershell -ExecutionPolicy Bypass -File scripts\register-review-task.ps1   (re)register the Sunday 8am review task
                                  ("Health-Review weekly review"; runs scripts\review-weekly.cmd, logs to data\logs\review.log)
npm run log:normalize             apply config/exercise-dictionary.json to all Workout Log history (prints coverage)
npm run log:unmapped              names with no dictionary entry, with set counts (-- --suggest asks Claude, names only;
                                  -- --accept data/exercise-proposals.json adds the kept proposals)
npm run programs:detect           propose program blocks from history (-- --write saves them as detected)
npm run programs:review -- list   confirm, edit, merge, split blocks and unassign days (see README.md)
npm run programs:catalog          validate data/maps/programs.json and print each program's weeks and phases
npm start                         UI and API at http://localhost:5188 (API contract: /api/openapi.json)
powershell -ExecutionPolicy Bypass -File scripts\register-server-task.ps1   (re)register and start the server at sign-in
                                  ("Health-Review server"; runs scripts\server-start.cmd, logs to data\logs\server.log)
npm run prompts:import-v1         one-time import of data/v1-export/prompts into prompt_sections (-- --replace to overwrite)
npm run metrics                   print the computed summary for last week (-- --week YYYY-MM-DD for another Saturday)
npm run evals                     free: metric fixtures, then a summary of saved review eval results
npm run evals -- --regrade v1     free: re-apply the current checks to a variant's saved drafts
npm run evals -- --live [--variant v2] [--cases a,b]   paid: run the review contract eval (about $0.35 per case)
npm run review                    sync, then write the weekly review for the week ending last Saturday (-- --week YYYY-MM-DD,
                                  -- --dry-run to build and size the prompt without calling Claude, -- --no-sync)
Scripts that need secrets load .env through node --env-file. GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and
GOOGLE_REFRESH_TOKEN in the environment override the files in data/google.

## Data
Sheets are read unformatted with dates as serial numbers and stored as local wall-clock text; no time zone conversion.
Health metrics and workout sessions stay in Google Sheets (v1 consolidation scripts still feed them, nightly 4 to 5am).
Every sync reads the whole first tab of each (the consolidated tab, whatever it is named); the owner trims it into an
Archive tab, so a row-number watermark could skip rows, and archived rows stay in the database. Duplicate health days
merge field by field. The Workout Log has one tab per year: normal syncs
read the current year (and last year in January), and a tab is replaced only when its content hash changes.
Drinking days and check-ins came from v1 sheets once (source 'v1-sheet'); the UI owns them now and imports never
overwrite UI rows. The Workout Log can hold planned future workouts with weights but no reps: metrics count only sets
with reps, time, or distance, on dates up to today. Text in the log's date column (illness, injury, vacation) is kept
in workout_log_notes; treat it as symptom data under the hard rules.

## Metrics
The review week is the 7 days ending on the most recent Saturday before today; the baseline is the 28 days before it;
strength looks back 28 days; correlations and next-morning comparisons use 90 days and return null below their minimum
counts (3 per group, 10 pairs). Values are rounded in code to the precision the report prints, so the review can be
checked for numbers that are not in the summary. Days without a row are unknown, never zero (drinking rates are per
logged day). Zone 2 counts cardio sessions whose average heart rate is inside the range in settings (no per-minute HR).
Medications (metrics/medications.js): each dose or timing period is a row in medication_periods; stopped_on is the first
day it no longer applied, so a change closes one period and opens the next on the same date. Start, change and stop
events are derived, never stored. Impact compares the 28 days before an event with days 7 to 34 after it (minimums 14
days for daily metrics, 7 for check-ins; pending until the after window ends) and lists other events within 28 days.
These are observational before and after averages; never present them as cause, and route them to physician discussion.
A period with start_estimated (real start unknown; the owner's existing items count from 2026-01-01) is active from
started_on but never produces a start event. Daily check-off (medication_doses): saving a day records every slot taken
or skipped; a day with no rows is unknown, never missed. The weekly summary reports doses taken out of doses logged.
A dose or timing change is a new dated period; a correction (fixing a typo) updates the current period in place and
records no event. Each Meds card shows its dose history once there is more than one period.

Training volume (metrics/volume.js): reps x total load (per-hand weights x2) over performed sets dated up to today;
days without lifting are real zeros; band, bodyweight, timed and unparsed sets are counted as sets, not volume; weeks end
on Saturday. GET /api/training?view=week|month|year|2y|5y|all feeds the Training tab, and computeWeek's
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
VO2 max (metrics/vo2max.js): GET /api/vo2max?view=90d|1y|2y|5y|all feeds the card at the top of the Health tab; short
views plot each Apple Watch reading, 2 years weekly averages, 5 years and all monthly averages (empty weeks and months
left out, never zero). Tiles: latest, change vs the nearest reading within 30 days before 90 days and 1 year ago, and
best on record. Values only, no fitness-for-age labels (same rule as labs).

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

## Eval
The review contract eval runs the real pipeline on 13 cases (9 real weeks read from data/health.db by date, 4 synthetic
edge cases layered on a throwaway in-memory copy) and grades the first draft in code: sections, dashes, grounding,
routing, physician item when required, length. Results and traces live in data/evals/review (gitignored: traces hold the
full prompt, including sensitive sections); variants are baseline, v1, v2, ... with a change.md each. A harness sha
gate covers the runner, cases, grading and agent files: after changing any of them, the owner (never Claude) re-approves
with --approve-harness. Every live run sends health data to the Claude API and costs money: ask before running one.
Results so far: baseline 7/13 first drafts clean (9/13 re-graded), v1 9/13 (12/13 at the 3,000-word limit), 13/13 final.

## UI and API
AUTH_MODE=none binds to 127.0.0.1 only and rejects requests whose Host header is not localhost (DNS rebinding);
exposing the server requires a login mode in server/auth.js first. Check-in and drinking scales are 1 to 10 to match
v1 history. CBD drinks are stored in drinking_days.cbd and never counted as alcohol. The Meds tab manages medications and
supplements (add, change, stop, start again, delete for mistakes); the weekly review takes them from there, not from the
medical prompt section. The Labs tab shows lab_tests and lab_results by panel. The owner enters labs in the app (the March
2026 draw was imported once and marked as app results); syncing a lab sheet is supported but unused. Results can come from a lab sheet
(LAB_RESULTS_SHEET_ID; the tab whose A1 is "Lab Test"; capitalized rows with no values are panel headings; one column
per draw date), synced whole on every sync and replaced only when its content hash changes, or from the app (source
'ui'), which sync never overwrites and which win a clash. Any result can be corrected in the app: a corrected sheet
result becomes 'ui' with corrected_from and corrected_from_date (the sheet's original value and date), sync skips the
sheet's copy, and undoing restores the original. Sheet results cannot be deleted in the app. Prompt sections live in
prompt_sections (edited on the Prompt tab; every save and delete copies the old row to prompt_section_versions);
sensitive sections are included in the weekly review (WEEKLY_INCLUDES_SENSITIVE in agent/prompts.js) and badged in the UI;
buildInstructions leaves them out unless a caller opts in.
The Activity tab lists runs (GET /api/runs, /api/runs/:id: the tracer's runs and run_calls, metadata only) and the scheduled
tasks' logs (GET /api/logs/sync|review, the last lines of data/logs; only those two names can be read).

## Hard rules
Health data may be stored or synced off this machine (cloud storage, backups, a future hosted deployment) only if it is
encrypted at rest and in transit (owner's choice, 2026-10-05): TLS for every transfer, and encryption at rest with keys
the owner controls. For files in consumer cloud storage (Google Drive and the like), encrypt before upload, and never
store the key or password with the data. Never store, sync or send it unencrypted, never put it in CI, and never
commit it. This is about where data is kept; what may be sent to the Claude API is governed by the rules below.
Send the Claude API computed summaries only, never raw exports. The one exception is the owner's own notes from the review
week (check-in, drinking, Workout Log comments and date-column notes), sent as written by the owner's choice (2026-10-01).
Genetics and medication data (prompt sections marked sensitive, and the medications tracker) go to the Claude API only
as part of the weekly review, which includes them every week by the owner's choice (decided 2026-09-30); each run
records which sensitive sections it sent (names only). The summary's medications block (current list, changes, before
and after averages) is the one place medication data enters the summary. Lab values enter only through the summary's labs
block (latest value and change from the previous draw); there are no reference ranges by the owner's choice, so code
never labels a value high, low or abnormal, and any interpretation of labs goes only to physician discussion. Never send any of it to another service or
log its text.
The exercise-name assist (npm run log:unmapped -- --suggest) sends exercise names only (unmapped names and the
dictionary's own names), and only after the owner types yes; never weights, dates, set counts or other log data
(owner's choice, 2026-10-02). Its proposals reach the dictionary only through --accept.
The MAPS PDFs and anything transcribed from them (data/maps) are Mind Pump's copyrighted material: never commit them,
put them in fixtures, or send their text anywhere; only computed facts (program, phase, week) leave this machine.
Metrics are computed in code, never by the model.
Anything involving medications, abnormal labs, or symptoms is flagged for physician discussion, not turned into a recommendation.
Never output em dashes, en dashes, or double hyphens in generated text.
Never commit anything under /data, or any .csv or .xml file. Never log or print API keys.

## Conventions
Every new tool gets a JSON schema, a handler, and a unit test.
Every metric change requires passing fixture tests.
Use plan mode for any change touching more than one file.