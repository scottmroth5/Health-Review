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

The total averages the four by their weights, then scales by how much of the program you reached on past runs. Each
pick lists its reasons as facts from these numbers, such as "Your Mar 2024 run: Barbell Squat +8%" or
"About 3 x 45 min a week".

**Weights:** Off, 1x, 2x or 3x for each goal re-ranks the card immediately. Your choice is remembered in that
browser. The weights change only this view; the weekly review always uses equal weights.

**In the weekly review:** the summary carries the top 3 only when your block is within 21 days of its earliest
finish, or when no block is in progress. The model explains the ranking and doesn't re-rank it.

**API:** `GET /api/advisor?strength=1&joint=1&time=1&vo2=1` (each 0 to 3, default 1).

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
