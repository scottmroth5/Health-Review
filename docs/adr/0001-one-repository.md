# 0001: Keep one repository through v3

- **Status:** accepted
- **Date:** 2026-11-02

## Context
v3 moves the app to PostgreSQL, adds a job queue, splits a few services and adds a Python AI service. The current repository
already carries what keeps the app safe:
- CI with the tests in two time zones, the personal-data and security checks, CodeQL and the image scan;
- deploy automation with backup and rollback;
- the user isolation guards;
- the commit history.

Old and new code have to run side by side for weeks during each move.

## Decision
- **One repository:** all of v3 happens in this one.
- **Branches:** work lands on `main` through short-lived branches, with new behavior behind settings (feature flags) until it has run in production. There is no long-lived `v3` branch.
- **Versions:** milestones are tagged (`v2.0.0` for today's production, then `v3.0.0` and on).
- **New code gets its own folders:** `infra/` (Terraform), `docs/adr/`, `docs/architecture/`, `services/ai` (Python), and possibly `services/interop`.

## Alternatives considered
- **A new repository for v3:** this would mean rebuilding CI, the scans, deploy and the guards, and then keeping two codebases in step while both run in production.
- **A long-lived `v3` branch:** it would drift from production, every fix would need merging twice, and the cutover would become one large risky merge.

## Consequences
- **Every guard and CI check covers new code from day one.** The guards scan TypeScript as well (Phase 0), and a new top-level source folder fails the user-scope guard until it is added.
- **Each language added later brings its own checks into the same CI.**
- **The repository is public,** so nothing in `infra/` may hold account IDs, addresses, ARNs or state. `scripts/check-personal.js` refuses Terraform state, plans and variable values.
