# v1 golden outputs

What the frozen v1 scripts in `/legacy` return for synthetic inputs. They were generated once by running the `.gs` files in `node:vm` with stubbed Apps Script services (script time zone UTC). The harness lives outside the repo, so the repo never imports legacy code. `/legacy` is frozen, so these files never need regenerating. Date cells are stored as `{"$date": "<ISO>"}`.

`test/v1-characterization.test.js` checks the v2 ports against them. Cases whose name starts with `BUG:` are v1 defects. v2 fixes each one, and its test pins both the v1 behavior and the fix.

| File | v1 code | Status in v2 |
|---|---|---|
| `sheet-rows.json` | `getSheetData` | Row rules ported to `ingest/rows.js`. Dates are no longer flattened to `M/d/yyyy`. Phase 2 sync: the missing-tab (`No data`) and fetch-error (`Error fetching data`) cases become errors instead of text sent to the model. |
| `consolidate-health.json`, `consolidate-workouts.json` | `Consolidate*.gs` (still running in Google) | v1 kept partial-day duplicates; the import now keeps the fullest row per day (`mergeHealthDays` in `ingest/parsers.js`) and the patched script in `tools/apps-script` stops creating them. Workout sessions match v1. |
| `prompt.json` | `loadConfig`, `buildPrompt` | Section order and `{{TODAY}}` ported to `agent/prompts.js`. Appending raw rows is dropped: v2 sends computed summaries only (Phase 5). |
| `email.json` | `formatEmailHtml` | Email delivery is dropped. Phase 3 renders reports in the UI. v1 replaced em and en dashes with `-` and left `--`; v2 rejects all three (Phase 5 validator). |
| `claude-call.json` | `callClaudeAPI` | Replaced by agent-core `createClaude`; the two `BUG:` cases (truncation returned as complete, only the first text block read) are tested as fixed. |
| `run.json` | `runWeeklyHealthReport` | Error email becomes a failed run in agent-core's `runs` table. v1 doubled the prefix (`Error: Error: ...`). |
