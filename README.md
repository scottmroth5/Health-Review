# Health Review

A local weekly health review agent. Health data stays on this machine (see [PRIVACY.md](PRIVACY.md));
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
of a program. Its phases are listed in its notes.

1. **Detect.** `npm run programs:detect` previews blocks found from the workout names, and `-- --write` saves them as *detected*.
   - **Gaps:** a gap of 21 or more days between lifting days ends a block.
   - **Non-program stretches:** "Between programs" and home-workout stretches are blocks of their own.
   - **Add-ons:** short HIIT or ab-program stretches inside a run join that run.
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
