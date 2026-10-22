# Health Review

A weekly health review agent that runs on its owner's machine. Health data is kept locally, and anything stored off the machine must be encrypted at rest and in transit (see [PRIVACY.md](PRIVACY.md));
[CLAUDE.md](CLAUDE.md) has the architecture, commands and rules. This page covers the training log's
exercise dictionary and program blocks.

## Exercise dictionary

`config/exercise-dictionary.json` maps every exercise name typed in the Workout Log to one canonical
exercise. Normalized values are stored next to the raw rows, and the raw names never change, so you can
edit the dictionary and rerun `npm run log:normalize` at any time.

```json
{
  "version": 1,
  "exercises": [
    {
      "id": "barbell-bench-press",
      "name": "Barbell Bench Press",
      "implement": "barbell",
      "pattern": "horizontal press",
      "primary": true,
      "variants": ["Bench Press", "Barbell Bench"]
    },
    {
      "id": "dumbbell-bench-press",
      "name": "Dumbbell Bench Press",
      "implement": "dumbbell",
      "pattern": "horizontal press",
      "primary": false
    }
  ],
  "ignore": ["superset"]
}
```

| Field | Meaning |
|---|---|
| `id` | Stable key: lowercase words joined by hyphens. |
| `name` | The name shown in the app and the weekly review. |
| `implement` | One of: barbell, dumbbell, machine, cable, landmine, bodyweight, kettlebell, band, suspension, other. |
| `pattern` | One of: squat, hinge, horizontal press, incline press, vertical press, horizontal pull, vertical pull, arms, core, carry, mobility, other. |
| `primary` | Whether the lift is tracked for progression. |
| `lift` | Optional label grouping related exercises for display. |
| `variants` | Other names for the same exercise. |
| `ignore` | Notes typed into the exercise column. These are not exercises. |

**How names are matched**
- **Small differences match automatically.** Names match after normalizing case, punctuation, hyphens, plurals, word order and the log's usual typos. So "Pull-ups", "Pull ups" and "Pullup" are one name, and one spelling in `variants` covers its look-alikes.
- **Different wording needs a variant.** Names that differ by words, such as "Bench Press" and "Barbell Bench", are the same exercise only if listed in `variants`.
- **Implements are never mixed.** Barbell and dumbbell versions of a lift are separate entries and are never combined in metrics.
- **Unmatched names are flagged, not guessed.** A name with no entry is `inferred` if exactly one implement word names its implement, and `unmapped` otherwise.
- **Invalid files are refused.** The loader lists every problem, such as a duplicate id, an unknown implement or pattern, or a name claimed by two entries.

**Workflow**
1. Run `npm run log:normalize` to apply the dictionary and print coverage (the share of sets mapped).
2. Run `npm run log:unmapped` to list the names still needing an entry, with set counts and years.
3. Add entries or variants to the JSON, then run step 1 again.
4. Optional: `npm run log:unmapped -- --suggest [--top 50]` asks Claude for proposals.
   - It sends exercise names only, after you type yes.
   - It writes the proposals to `data/exercise-proposals.json`.
   - Delete any proposals you don't want, then run `npm run log:unmapped -- --accept`.

Each sync re-applies the dictionary when Workout Log rows change.

## Exercise name typos

`npm run log:typos` lists exercise names that look like typos of each other, numbered: two dictionary exercises with
the same equipment and movement whose names differ by a letter or two in one word ("Dumbbell Should Press" and
"Dumbbell Shoulder Press"), and logged names with no entry that look like a dictionary exercise ("Assault Bik").
- `npm run log:typos -- --merge 1,3` folds those into the exercise they look like: the typo becomes a variant name,
  the duplicate entry is removed, and the dictionary is re-applied to all your history.
- `npm run log:typos -- --distinct 2` marks a pair as different exercises (Knee Abduction and Knee Adduction), so
  it is never listed again.
- Nothing changes until you give the numbers, and nothing is sent anywhere. Each sync's log notes how many look like
  typos.

## Program blocks

Each lifting day (session) belongs to a program block or is explicitly unassigned. A block is one run
of a program, named by the program only (phases are ignored).

1. **Detect.** `npm run programs:detect` previews blocks found from the workout names, and `-- --write` saves them as *detected*.
   - **Breaks:** the same program before and after a break, or after days with no program name, is one block. Only a different program in between starts a new one.
   - **Non-program stretches:** "Between programs" and home-workout stretches are blocks of their own.
   - **Inside a run:** a Between programs, HIIT or ab-program stretch with the same program on both sides joins that run, and the block's notes count it.
   - **Unnamed days:** these join a block only between that block's own days.
2. **Review** with `npm run programs:review -- <command>`. Name a block by the first characters of its id, as shown by `list`.

   | Command | What it does |
   |---|---|
   | `list [--unconfirmed]` | Blocks with dates, session counts and status. |
   | `confirm <id>` or `confirm all-detected` | Marks blocks as confirmed. |
   | `edit <id> --program "..." --start YYYY-MM-DD --end YYYY-MM-DD --status completed\|abandoned\|in_progress --notes "..."` | Changes fields. Date changes move sessions in or out and renumber weeks. |
   | `merge <id> <id>` | The second block joins the first. |
   | `split <id> <date>` | Sessions from the date on become a new block. |
   | `unassign <date> [<to date>]` | Marks lifting days as confirmed unassigned. |

   Every command ends with a coverage line: lifting days in confirmed blocks, unassigned, and still to review.
3. **Re-detect safely.** Running `programs:detect -- --write` again replaces only detected blocks. Confirmed blocks, days you marked unassigned, and later sessions are kept.
4. **Going forward.** Confirm the block you're currently running with status `in_progress`. After each sync, new lifting days join it with its program and a week number, so they never need detection. When you start a new program, end the old block (`edit <id> --status completed --end ...`), then add the new one by detecting and confirming it.

## MAPS program catalog

`data/maps/programs.json` holds each MAPS program's structure, taken from your own copies of the blueprints and
calendars in `data/MAPS Programs/`. Those are Mind Pump's copyrighted material, so both folders stay under
`data/`: they're gitignored, never committed, and their text is never sent anywhere.

```json
{ "version": 1,
  "programs": [
    { "name": "Program name from metrics/programs.js", "weeks": 9, "focus": "...", "equipment": ["barbell"],
      "phases": [
        { "name": "Phase 1", "weeks": [1, 3], "workouts_per_week": 6, "sets": "3", "reps": "8-12", "rest": "60 seconds",
          "special_weeks": { "deload": [], "failure": [2] },
          "workouts": [{ "name": "Day 1", "exercises": [{ "name": "...", "sets": "3", "reps": "8-12" }] }] }
      ] } ] }
```

**Validation:** phase week ranges must run from week 1 to the program's last week with no gaps or overlaps. `sets`
and `reps` are a number or a range. `npm run programs:catalog` validates the file and prints each program's weeks,
phases, prescriptions and how many blueprint exercise names map to the exercise dictionary (`-- --unmapped` lists
the ones that don't).

**Uses:**
- **Phase:** taken from your workout names ("... Phase 3"). Each session gets the latest phase named on or before
  it. The catalog's calendar is used only for a block whose names never mention a phase, and is marked as an
  estimate.
- **Program week:** the week of the program the current phase began in, plus the weeks since it began. Missed days
  don't push you ahead.
- **Finish:** a range.
  - **Earliest:** the rest of the program at full speed, counted from the day the current phase started.
  - **At your pace:** the same, stretched by how long this block's finished phases actually took compared with plan.
- **Where you stand:** `programs:review list`, the Training tab's Current program card and the weekly review show
  the program, phase and when it started, program week, any deload or failure week, the finish range and days left.
- **Status:** detection marks a block completed or in progress, and never abandoned. You set abandoned yourself.

**Workouts and profiles:** each phase's `workouts` list its exercises with `sets` and `reps`:
- Reps can be a number, a range, or seconds for holds and timed work (`"30-60s"`).
- Superset partners share a `superset` number.
- Trigger, focus, flow and mobility sessions are short rules under `extras`.

Each program also has a `profile`, written as short summaries rather than copied from the blueprints:
- `focus`: one line
- `conditioning` and `mobility`: 0 to 3
- `extra_minutes_per_week`: sessions on non-lifting days
- `minutes_per_session`: only where the blueprint states it
- `standalone: false`: an add-on, such as No BS 6-Pack

## Substitutions and the avoid list

`config/substitutions.json` is committed, so keep it free of health details. It holds:
- **`equipment`:** your home gym. There are no machines or cable pulley, so band, dumbbell or bodyweight versions stand
  in for those exercises.
- **`swaps`:** which of your exercises fill a prescribed one. For example, the standing overhead barbell press is
  filled by the Z press or a standing dumbbell press, and "Alternating Cable Crossover" by your alternating band
  crossover.
- **`fill_rule`:** any band, dumbbell or bodyweight exercise with the same movement in that session fills a cable or
  machine slot, even if no swap names it.
- **`not_ranked`:** programs the Advisor leaves out, each with a reason. MAPS Anywhere is listed, since you only run it
  as a break from equipment. The card shows it as "Left out" with the reason. Delete the entry to rank it again.
- **`avoid`:** exercises you've paused, such as circus press. A program that prescribes one is flagged, and its joint
  health and balance score is cut. Delete the entry when you want it back. Exercise ids are the `id`s in
  `config/exercise-dictionary.json`.

## More Apple Health metrics

Turned on in Health Auto Export on 2026-10-15 and stored from then on: cardio recovery, walking heart rate, walking
speed, walking asymmetry (lower is more even), heart rate (min, max, average), sleeping wrist temperature, physical effort, blood oxygen and breathing
disturbances. The Health tab charts cardio recovery, walking heart rate and speed, wrist temperature, blood oxygen and
breathing disturbances. The weekly review compares each with the previous week and your 28-day baseline. Blood oxygen
and breathing disturbances are values only (no high or low labels) and appear in the review only for
physician discussion. The Health tab also charts weight, body fat, muscle mass and visceral fat from the Today tab
check-in. A partial day (see the data checks below) is drawn in red on the Apple
Health charts, its hover says so, and it is left out of the card's average. A chart with no data in the range you picked is left out, and a line below the charts names it, so it comes
back by itself once data arrives. To fill earlier days, export a past date range from Health Auto Export into the same folder;
the app reads the new files and fills the new columns on days it already has.

## Cardio minutes by heart rate zone

The Health tab's zones card shows cardio minutes per day (30 or 90 days) or per week (1 year), each bar split by heart rate
zone:
- **Zone 2** is your saved range (Settings, on the Prompt tab).
- **Zone 1** is below it.
- **Zones 3 to 5** split the span from its top to an estimated maximum heart rate from your age (208 - 0.7 x age; birth
  year in Your profile), evenly.

Each minute counts in the zone of that minute's average heart rate, from the JSON workout export. Workout time with no
minute-by-minute heart rate (workouts from before that export, or moments the watch missed) shows in gray, never guessed
from the workout's average. Strength workouts are left out. Hover a bar for minutes per zone; the table lists them too.

The weekly review gets the same numbers for the review week and the weekly average of the 4 weeks before it, so it can
comment on how hard your cardio was. Minutes with no heart rate reading are reported as unknown, not as easy minutes.

## Health targets

Every chart on the Health tab, and the VO2 max card, shows a **target**: a dashed line on the chart, and a line above it
such as "Target 9,500 · suggested" with **Edit** and **Why**.
- **Suggested targets** are computed from your 90-day average (VO2 max: your latest reading) and the healthy level for
  your sex and age. Below it, the target is one step closer, or the healthy level itself when that's nearer. Past it,
  the target is half a step better, up to a ceiling. A range (sleep, blood oxygen, weight) aims to get inside it and
  hold. Fill in **Your profile** (birth year, sex, height) for the age-based levels; without it, targets come from your
  own data only. Suggestions follow your data as it changes.
- **Your own target:** Edit, type a number, Save. It stays until you choose "Use suggested".
- **Why** shows the healthy level, your current value and the source.
- **The weekly review** reports progress against each target, and never sets one itself. Blood oxygen and breathing
  disturbances stay in the physician discussion section.

| Metric | Healthy level (men 50 to 59) | Source |
|---|---|---|
| VO2 max | Good 39.2, Excellent 43.4 ml/kg/min | Cooper Institute norms |
| Resting heart rate | 60 bpm or lower | Copenhagen, CALIBER and Gothenburg cohorts |
| Steps | 8,000 to 10,000 a day (6,000 to 8,000 at 60 and over) | Paluch 2022, Lancet Public Health |
| Sleep | 7 to 9 h | AASM and Sleep Research Society |
| Exercise minutes | 30 a day | US Physical Activity Guidelines |
| Cardio recovery | more than 12 bpm | Cole 1999, NEJM |
| Walking speed | about 3.2 mph | Bohannon 2011 |
| Walking asymmetry | under 10% | iPhone mobility guidance |
| Body fat | 11 to 21% (men 40 to 59) | Tanita, from Gallagher 2000 |
| Visceral fat | 1 to 12 | Tanita |
| Weight | BMI 18.5 to 24.9 for your height | NIH and CDC |
| Blood oxygen | 95 to 100% | general clinical range |
| Alcohol | 2 or fewer drinks a day | US Dietary Guidelines |

HRV, walking heart rate, muscle mass, wrist temperature, breathing disturbances and readiness have no reliable
published norm, so their targets improve on your own data. The norms live in `config/health-targets.json`.

## Lab reference ranges

Each lab test on the Labs tab has a reference range in the Range column. It starts as a typical adult range from
config/lab-ranges.json (US conventional units, matched by test name or alias), so check it against your lab report:
open a test by its name, enter Low and High (either can be blank for a one-sided range) and Save range. Use typical
range puts the typical one back. Tests whose unit or method varies (CRP, cystatin C, urine tests) start blank; add range
enters your lab's.

A test's chart (open it by its name) shades the range, with a dashed line at each bound and values outside it in red.
A result outside the range is marked "below range" or "above range" with an arrow; the app never says normal or
abnormal. The weekly review gets each latest result's range and whether it is below, within or above it, and only
for the physician discussion section: a lab name next to range wording ("LDL above range", "elevated ALT") anywhere
else fails the review's checks.

## Called for vs logged

The Training tab's **Called for vs logged** card compares each lifting day of a confirmed block with the workout the
catalog lists for that phase. Pick any confirmed block; the one in progress shows first.
- **Matching a day:** the program and phase come from the block, and the workout from the number in your logged
  name ("Foundation 2", "Foundational 1", "Day 3", "Workout 2"). A phase with one workout matches every day. Focus,
  Trigger and Mobility sessions have no fixed list, and a name with no number (such as "In between programs") is shown as not
  matched, never guessed. A line says how many days matched.
- **Each exercise is one of:** as called for; swapped (a swap in `config/substitutions.json`, or the fill rule);
  changed (something else with the same movement pattern); skipped; or added. Sets logged are compared with the sets
  called for (fewer, within, more), and reps with the called-for range.
- **Your usual changes:** what you most often do instead, skip and add across the block. A typo in a logged name shows
  up here as a change or a skip plus an add; adding the typo as a variant in the exercise dictionary fixes it.
- **The weekly review** gets the week's counts (as called for, swapped, changed, skipped, added), the sets logged
  against the sets called for, and the names of the exercises you logged instead or on top. The program's own exercise
  names never leave your machine (they come from the Mind Pump PDFs), so the review can say "2 skipped" but not which.
  Nothing from the catalog is committed.

## One-day dose adjustments

On the Today tab, **Adjust** next to a supplement or medication changes, for that day only, the dose you took and the
slot you took it in (for example, the morning magnesium taken before bed). The values on the Meds tab stay the
defaults. A lasting change is still a dated change on the Meds tab, which is what the before-and-after averages use.
Adjustments are saved with the day's check-off, and the weekly review counts only taken or skipped.

## Ingredients and combined pills

A medication or supplement has either **one dose** or a **list of ingredients, each with its dose** (a compounded pill,
a blend). Choose between them in the Dose box of the Meds tab's Add, Change and Start again forms.
- **Each ingredient's dose history is kept.** Changing one ingredient's dose from a date is a dated change like any
  other: the dose history and the Changes and impact list show it as, for example, "Beta 10 mg to 20 mg". Fix a mistake
  marks it as a correction, with no change recorded.
- **On the Today tab** the item has one checkbox, with its ingredients on the line underneath.
- **Each current item's card** shows the last 12 weeks of check-offs: this week so far, the share taken over the 12
  weeks, a bar per week (an outlined box when nothing was logged, which counts as unknown, not missed), and the numbers
  as a table.
- **Combine items taken as one pill** (on the Meds tab) turns two or more current items into one item with ingredients,
  for past history and from now on. Every start, change and stop date of any of them becomes a period of the new item.
  Each logged day becomes one check-off in the slot you choose, and it counts as taken if any of them was taken. One-day
  adjustments on the old items are dropped. Preview shows all of this before anything changes.
- **The weekly review** gets the ingredients and which ingredient changed. Ingredient names of medications count as
  medication names for its checks, so they appear only in the physician discussion section.

## Program Advisor

The Training tab's **Next program** card ranks the MAPS programs for your next block. The ranking is computed in
code by `metrics/advisor.js`, never by the model. The program you ran last is left out, and add-ons are listed apart.

Each program gets four goal scores from 0 to 1:
- **Strength:** heavy sets (5 reps or fewer) plus half credit for sets of 6 to 12 reps, averaged with the median change
  in your primary lifts' estimated max from the first 2 weeks to the last 2 on past runs. A program whose main rep
  range differs from your stalled lifts' range gets a small bonus.
- **Joints and balance:** one-arm or one-leg work, mobility, and little arm isolation, cut when the program prescribes
  something on your avoid list.
- **Time:** minutes a week, from 120 or less (full score) to 360 or more (zero). The minutes are your Apple Watch
  average for that program once it has 10 or more sessions. Otherwise they're the prescription estimate scaled by how
  much longer your sessions usually run.
- **VO2 max:** the program's conditioning, averaged with your VO2 max change from the first 4 weeks to the last 4 on
  past runs.

The total averages the four by their weights, then scales by how much of the program you reached on past runs. Two
rules keep it honest (from a backtest against your past program choices, 2026-10-14):
- **A program you've never run** assumes your average completion across all past runs, so being untried earns no bonus.
- **A goal scoring under 0.2** (of the ones you weight above Off) lowers the total, down to half for a 0. Before this,
  HIIT ranked first for eight straight years with a strength score of 0. Set strength to Off and it ranks on the rest.

Lift changes from past runs compare only within one rep range: comparing a 10-rep finish with heavy singles at the
start read as a large strength loss, so those runs give no lift number rather than a wrong one. Each
pick lists its reasons as facts from these numbers, such as "Your Mar 2024 run: Barbell Squat +8%" or
"About 3 x 45 min a week".

**Weights:** Off, 1x, 2x or 3x for each goal re-ranks the card immediately. Your choice is remembered in that
browser. The weights change only this view; the weekly review always uses equal weights.

**In the weekly review:** the summary carries the top 3 only when your block is within 21 days of its earliest
finish, or when no block is in progress. The model explains the ranking and doesn't re-rank it.

**API:** `GET /api/advisor?strength=1&joint=1&time=1&vo2=1` (each 0 to 3, default 1).

**Ask Claude about your next program:** under the card, type a note, for example a different mindset, a schedule
change, or something bothering you, and Claude answers in light of the ranking at your current weights.
- **What's sent:** the ranking, lift progress, your current program and week, your equipment and paused exercises,
  your note, and the last 10 messages of the thread.
- **What's never sent:** medications, labs, genetics, your logs, or the program focus lines.
- **Health topics:** anything about pain, injury or medication comes back as a point to discuss with a physician,
  never as advice.
- **Checks:** replies get the same checks as the weekly review.
- **Saving:** the thread is saved in your database, so it's in the encrypted backup. Delete single messages, or
  clear the thread.
- **Cost:** each question is one call at medium effort, usually 30 to 60 seconds and a few cents.

## Sheets pipeline and data checks

Apple Health and Apple Watch data start in Health Auto Export on your phone, which writes one file per day to Drive:
health metrics as Google Sheets files to one folder, and workouts as JSON files to another. The app reads those files
directly. Set `HEALTH_EXPORT_FOLDER_ID` (the health metrics folder) and `WORKOUT_JSON_FOLDER_ID` (the JSON workouts folder)
in `.env`; each is the long id in the folder's Drive URL.

**The workouts automation** in Health Auto Export: type Workouts, format JSON, Export Version 2, Include Workout Metrics
on, time grouping Minutes, route data off, destination that Google Drive folder, daily. Each workout then carries its heart
rate minute by minute, which the Health tab's zones card uses. Reading JSON files needs Google's read-only Drive permission
(`npm run google:login` once); the app reads only the configured folder. A JSON workout matching one stored earlier (same
type, starting within a minute) replaces it, so exporting a past range again never duplicates. (The older Sheets-format
workout export broke with iOS 27.0.1 and is no longer read; workouts already stored from it stay.)
- **What a sync reads:** each folder is listed, and only files that are new or changed since the last read
  (`drive_exports`) are read, at most 100 per folder per sync.
- **Google's limit:** 60 Sheets reads a minute, so reads are spaced about a second apart and saved every 25 files. If
  Google still says "too many requests", the sync keeps what it read and the next sync continues.
- **Partial exports:** a day read again from a partial export never lowers the full day already stored.
- **A missing variable:** that kind is skipped and the sync log says so.

To set it up:
1. Set both variables, then run `npm run google:login` once. It adds permission to list the folders (names and dates
   only); the files themselves are read with the Sheets permission you already granted.
2. Run `npm run google:exports` to see how many files each folder holds and how many syncs the first read takes.
3. Run `npm run sync`.

To fill earlier days, export a past date range from Health Auto Export into the same folders.

**The consolidated sheets are retired (2026-10-16).** The v1 Apps Scripts that consolidated the export files into two
sheets are no longer read by the app, so you can turn off their triggers. `HEALTH_METRICS_SHEET_ID` and
`WORKOUT_SESSIONS_SHEET_ID` can come out of `.env`. Days already stored from those sheets stay in the database. Their
3-hour workout time shift was fixed once in the stored rows (`npm run fix:session-times`, 2026-10-15).
`tools/apps-script/ConsolidateHealthMetrics.gs` is kept for reference only.

**Data checks:** after every sync, the app checks the data. Problems show above the day on the Today tab and in the
sync log (Activity tab). The checks look for:
- **Apple Health data that stopped:** nothing after a given day. Today is never expected to be complete.
- **The workouts export stopped:** the same for the JSON workouts folder at 72 hours, since a rest day can write no file.
- **The export automation stopped:** a sync looked in the Health Auto Export folder and found no file newer than 26 hours,
  so the warning names when the last export was written. It counts from the last sync, so a sync that just hasn't run yet
  never sets it off.
- **Missing days:** gaps in the last 14 days.
- **Partial days:** a day whose latest Health Auto Export file was written before the day ended, such as an export you
  ran by hand in the afternoon, whatever its steps. The next export written after midnight fills it in and clears it.
  Days from the old consolidated sheet have no file time, so for them a partial day is one whose steps are under a
  quarter of your usual day.
- **Lifting without a watch workout:** a Workout Log day with no Apple Watch strength workout. This one appears in the
  sync log only, since you may simply not have worn the watch.
- **A workout longer than its start-to-end time:** the Duration shift coming back.
- **Impossible values.**

The weekly review gets the week's missing and partial days, so it doesn't read them as bad days.

**The Sunday review waits for complete data.** If any day of the review week (Sunday to Saturday) has no Apple Health
data, or looks like a partial export, the scheduled run skips the review. It sends nothing and records a *skipped*
run with the dates (Activity tab). From 9am on Sunday, while last week has no review, the Today and Reviews tabs say
why and offer **Run review now**, which syncs first. While days are still missing the button reads **Run anyway** and
asks first. From the command line, `npm run review -- --force` writes it anyway, and `-- --dry-run` shows the check.

**Catch-up runs.** The scheduled task also runs Monday and Tuesday at 8am. Once the week's review exists those runs do
nothing (no sync, no cost); otherwise they try again, so a week skipped on Sunday for a late Apple Health export is
usually written by Monday. Re-run `scripts\register-review-task.ps1` after updating to pick up the extra days.

**Rewrite with the full week.** If a review was written while days were missing or partial (with Run anyway, or
`--force`) and those days arrive later, the Today and Reviews tabs offer **Rewrite with the full week** (about $0.35).
It replaces that week's review. Nothing rewrites a review automatically.

**Restarting the server.** `npm run server:restart` stops the running server and starts the "Health-Review server"
task again, then waits for it to answer; run it after updating the code. `npm run server:stop` stops it. Ending the
task in Task Scheduler alone leaves the server running, because Windows does not stop the node process it started.

**What it costs:** the Activity tab's Claude API spend card shows this month, this year and all time, plus the last 12
months and each year split into reviews, the Next program chat and evals. Reviews and chat come from the recorded runs;
evals are priced from their saved token counts and dated by when each variant last ran. These are estimates at list
prices; the Anthropic Console bill is the real number. Syncs and backups cost nothing.

## Demo instance

To show the app without your data, run a second, separate instance with made-up data:

```
npm run demo          # http://localhost:5189 (builds data/demo/demo.db first if it is missing)
npm run demo:build    # rebuild the demo database from scratch, which also resets anything changed while demoing
```

- **It never touches your data:** its own database (`data/demo/demo.db`), its own log folder, no Google sign-in,
  and no `.env`, so no API keys are in reach.
- **Off in the demo:** sync, reviews and the Claude chat. A banner says it's sample data.
- **Your instance keeps running:** on 5188, as before. The two share only code.
- **The data:** about 15 months, made up by `demo/generate.js` from a fixed seed, so every build is the same for a
  given day. It includes:
  - Apple Health days and workouts, with a planted gap and a partial day so the data checks have something to show
  - a Workout Log across five runs of four made-up programs, the last one near its end so the Advisor appears
  - check-ins, a few drink days, supplements (no prescription medicines), a lab panel, sample reviews and a sample
    chat thread
- **Publishing:** the programs in `demo/catalog.json` ("Sample Strength" and so on) are invented, not MAPS. The
  generator, catalog and `demo/substitutions.json` hold no real values, so they are safe to publish. The generated
  database stays in `data/` (gitignored).

## Planned

- **Users and logins** (deferred, 2026-10-07): register users, tie your data to your login, mark a user as demo or
  real, and give each demo user an isolated copy of the demo data while the base never changes. Until then, the
  separate demo instance covers showing the app.
  - Exposing the server beyond this computer first needs a login mode in `server/auth.js`, and HTTPS.
- **Apple data without Google, with the move to AWS** (chosen 2026-10-15): replace the Drive read with Health Auto
  Export's REST API automation, posting JSON to an authenticated HTTPS ingest endpoint reached over Tailscale (encrypted
  between phone and server, nothing open to the internet). Apple Health and Apple Watch data then never pass through
  Google, which also removes the last unencrypted cloud copy of them. Needs the login mode above first.

## Encrypted backups

Every night at 11pm, `npm run backup` uploads an encrypted copy of `data/health.db` and your program catalog to a
"Health-Review backups" folder in your Google Drive. It keeps 7 nightly, 3 weekly and 1 monthly copies.

**How a backup is made:**
1. Take a safe snapshot of the live database, even while the app is running, and check its integrity.
2. Compress it, then encrypt it with AES-256-GCM using a key derived from your passphrase.
3. Prove the file decrypts back to the same bytes.
4. Upload it over HTTPS.

Google stores only an unreadable file. The app's Drive permission (`drive.file`) can see only the files it created,
nothing else in your Drive.

**One-time setup:**
1. **Passphrase:** add `HEALTH_BACKUP_PASSPHRASE=<a long passphrase>` to `.env`, and save the same passphrase in your
   password manager. **Without it the backups can't be read by anyone, including you.** `npm run backup --
   --check-passphrase` checks it's set.
2. **Google permission:** in Google Cloud, add the `.../auth/drive.file` scope to the app's consent screen. Then run
   `npm run google:login` again to grant it.
3. **Schedule:** register the nightly task with
   `powershell -ExecutionPolicy Bypass -File scripts\register-backup-task.ps1`.

**USB copies:** `npm run backup -- --to E:\HealthBackups` writes the same encrypted file to a folder, with no upload.

**Restoring:** `npm run backup:restore -- --file latest --out data/restored.db` downloads the newest backup (or give a
file path instead of `latest`). It decrypts it, checks it and writes it to a new file. It never overwrites
`data/health.db`, and it prints the steps to swap the restored file in.

Runs appear on the Activity tab, with the Backup log.
