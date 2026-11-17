# 0012: Module boundaries: layers checked in CI now, domain modules next

- **Status:** accepted (Phase 2 step 1, 2026-11-17: the layer rules and the check; the domain modules are planned)
- **Date:** 2026-11-17

## Context
ADR 0002 keeps one deployable, built so it can split later (v3 Phase 5). That only holds if the code's dependencies
already run in one direction. Nothing checked that. A count of every relative import between top-level folders on
2026-11-17 found the expected shape (server on top, then jobs, then agent and ingest, then metrics, db and tools) and six
imports that point the wrong way:
1. `jobs/review.js` and `jobs/backup.js` imported `server/queries.js` (`localDate`, `reviewStatus`).
2. `tools/backup/pg-deploy.js` imported two scripts (`export-to-sqlite.js`, `migrate-to-postgres.js`).
3. `agent/` and `metrics/` imported `server/public/goals.js` and `zone-defaults.js`.
4. Both eval runners imported `server/queries.js` for medication writes.
5. `metrics/load.js`, inside the pure metrics library, holds the SQL that loads metric input. Three `agent/` files import it.
6. `server/index.js` imported `demo/generate.js`, to start the demo instance.

Changing `agent/` or the review eval runner trips the eval's harness gate, which needs the owner's re-approval and a paid
run.

## Decision
- **Layers on today's folders, checked by `test/boundaries.test.js`** (every static, re-export and dynamic relative import). A layer may always import itself.

  | Layer | May import |
  |---|---|
  | tools | nothing else |
  | tools/backup | tools, db |
  | db | tools |
  | metrics | tools, shared (and no SQL) |
  | ingest, agent | metrics, db, tools, shared |
  | jobs | agent, ingest, metrics, db, tools, tools/backup, shared |
  | demo | agent, ingest, metrics, db, tools, shared |
  | server | everything above except demo; only `server/index.js` (the composition root) imports demo |
  | evals | agent, metrics, db, tools, demo, shared |
  | scripts | anything (entry points) |

  So nothing imports `scripts`, and only `scripts` imports `evals`.
- **Shared modules.** `server/public/goals.js` and `zone-defaults.js` stay where the browser loads them (no build step) and are importable by any layer. The test keeps them pure: they import only each other.
- **The fixes:**
  - The review gate moved to `jobs/review-status.js`. `server/queries.js` re-exports it, so the routes and scripts are unchanged.
  - The jobs take `localDate` from `tools/time.js`.
  - The two whole-database copies moved to `db/transfer-jobs.js`; the scripts keep only their arguments.
- **Named exceptions,** each with what removes it. The test fails when one stops occurring, so the list never goes stale.
  - The two eval runners' imports of `server/queries.js` move with the health-records data module.
  - `metrics/load.js`'s SQL moves out with the `agent/` files it serves.

  Both wait for the step that touches `agent/` and the eval runner anyway, under one harness re-approval.
- **The domain modules to come** (from the plan; one deployable, a folder each):

  | Domain | Today |
  |---|---|
  | Domain | Today |
  |---|---|
  | identity | `server/auth.js`, `session.js`, `db/users.js`, `server/routes/identity.js` (account, feeds, keys, goals, layouts, setup and Home, export, pause, delete) |
  | ingest | `ingest/` (sync, parsers, apply, Excel upload, app workouts), `server/routes/ingest.js` |
  | training | `metrics/` (volume, strength, plateau, blocks, programs, advisor, adherence), `ingest/program-blocks.js`, `user-programs.js`, `server/routes/training.js` |
  | health | the daily check-in and drinks, Apple Health history, VO2 max, heart rate zones, targets, profile and settings (`metrics/recovery.js`, `zones.js`, `vo2max.js`, `targets.js`), `server/routes/health.js` |
  | health-records | medications and labs (`metrics/medications.js`, `labs.js`), `server/routes/health-records.js` |
  | reviews | `agent/` (review, chat, prompts, supplements), `jobs/review.js`, `review-status.js`, `server/routes/reviews.js` |
  | admin | `server/admin-queries.js`, `usage-totals.js`, `alerts.js`, `server/routes/admin.js` (users, usage, feedback) |
  | platform | `db/`, `tools/`, `jobs/` scheduling and backup, `server/scheduler.js`, `security.js`, `geo.js`, `pages.js`, `server/routes/platform.js` (activity, spend, sync, help) |

  Health (the check-in and the Apple Health views) became its own domain when the routes were split: it fit neither
  training nor health-records.

  Step 2 (done 2026-11-17) split `server/app.js` into these route modules. `app.js` keeps the setup, hooks, sign-in and
  the helpers several modules use, handed to each as `ctx`. The OpenAPI document was the same before and after (key
  order aside), and so was the full route list, hidden routes included. The `server/queries.js` split and the
  `metrics/load.js` move follow. The layer rules are then restated per domain in the same test.

## Alternatives considered
- **dependency-cruiser.** It is a capable tool, but a new dependency with its own configuration language. The repository already scans its own source for the user-scope and SQL guards, and this check is about 100 lines.
- **Moving everything into domain folders at once.** A large rename while the review eval's harness gate covers `agent/`. Layers first gives the direction rule now, at no behavior risk.
- **Moving `goals.js` and `zone-defaults.js` out of `server/public`.** The browser would need a build step or a second copy, and both are worse than a named shared module.

## Consequences
- A wrong-way import fails CI with the file, the target and the rule it breaks.
- A new top-level folder fails the test until it gets a rule here and in the test.
- The import floor (450) catches a reader that quietly stops matching, as the user-scope guard's floor does.
- `/api/openapi.json` was byte-identical before and after this step.
