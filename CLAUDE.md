# Health Review Agent

## Purpose
Weekly health review agent built on the shared agent-core package.
agent-core comes from the public Agent-Core repo as a git dependency pinned to a version tag
("@scottmroth5/agent-core": "github:scottmroth5/Agent-Core#semver:^0.2.1"). Upgrade with npm install "github:scottmroth5/Agent-Core#semver:^<x.y.z>" (a caret on 0.x never crosses a minor version, so npm update will not); test unreleased changes with npm link ../Agent-Core.
Health specific logic stays in this repo; never add it to agent-core.


## Structure
/agent              prompts, tools, and review logic
/metrics            deterministic metric calculations with unit tests
/ingest             Google Sheets to SQLite: sheets.js (read-only client, fakeable), parsers.js (one per sheet), sync.js;
                    the only code touching raw source rows
/db                 migrations.js (append only) and openHealthStore (data/health.db, HEALTH_DB_PATH overrides)
/server             Fastify API (app.js routes with JSON schemas, queries.js holds all UI SQL, auth.js) and the
                    static UI in server/public (plain HTML, CSS and JS modules; no build step)
/evals              metric regression fixtures; fixtures/v1 holds v1 golden outputs (see its README)
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
npm run sync                      copy new rows from the Sheets into data/health.db (prints counts and warnings only)
npm run sync -- --backfill        one-time full import, including the v1 drinking log and weekly check-ins
powershell -ExecutionPolicy Bypass -File scripts\register-sync-task.ps1   (re)register the daily 7am sync task
                                  ("Health-Review daily sync"; runs scripts\sync-daily.cmd, logs to data\logs\sync.log)
npm start                         UI and API at http://localhost:5188 (API contract: /api/openapi.json)
npm run prompts:import-v1         one-time import of data/v1-export/prompts into prompt_sections (-- --replace to overwrite)
npm run evals                     run eval suites and print results (not built yet)
npm run review                    generate the weekly health review (not built yet)
Scripts that need secrets load .env through node --env-file. GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and
GOOGLE_REFRESH_TOKEN in the environment override the files in data/google.

## Data
Sheets are read unformatted with dates as serial numbers and stored as local wall-clock text; no time zone conversion.
Health metrics and workout sessions stay in Google Sheets (v1 consolidation scripts still feed them) and sync by
watermark plus overlap; duplicate health days merge field by field. The Workout Log has one tab per year: normal syncs
read the current year (and last year in January), and a tab is replaced only when its content hash changes.
Drinking days and check-ins came from v1 sheets once (source 'v1-sheet'); the UI owns them now and imports never
overwrite UI rows. The Workout Log can hold planned future workouts with weights but no reps: metrics count only sets
with reps, time, or distance, on dates up to today. Text in the log's date column (illness, injury, vacation) is kept
in workout_log_notes; treat it as symptom data under the hard rules.

## UI and API
AUTH_MODE=none binds to 127.0.0.1 only and rejects requests whose Host header is not localhost (DNS rebinding);
exposing the server requires a login mode in server/auth.js first. Check-in and drinking scales are 1 to 10 to match
v1 history. CBD drinks are stored in drinking_days.cbd and never counted as alcohol. Prompt sections live in
prompt_sections (edited on the Prompt tab; every save and delete copies the old row to prompt_section_versions);
sensitive sections are left out of the weekly review by buildInstructions in agent/prompts.js.

## Hard rules
All health data stays on this machine. Never add cloud storage, CI, or remote sync for /data.
Send the Claude API computed summaries only, never raw exports.
Include genetics or medication data only when a specific question requires it.
Metrics are computed in code, never by the model.
Anything involving medications, abnormal labs, or symptoms is flagged for physician discussion, not turned into a recommendation.
Never output em dashes, en dashes, or double hyphens in generated text.
Never commit anything under /data, or any .csv or .xml file. Never log or print API keys.

## Conventions
Every new tool gets a JSON schema, a handler, and a unit test.
Every metric change requires passing fixture tests.
Use plan mode for any change touching more than one file.