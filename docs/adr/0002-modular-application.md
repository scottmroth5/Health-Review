# 0002: A modular application, with a service split only for a stated reason

- **Status:** accepted (planned: module boundaries in v3.1, the service split in v3.3)
- **Date:** 2026-11-02

## Context
Today the app is one Node process: the web UI and API, Health Auto Export ingest, the scheduler running sync, review and backup jobs, and every Claude call.

It is run by one person for a handful of users. Some parts do differ for real reasons:
- **Ingest is on the internet with a token.** Its traffic comes in bursts.
- **Background jobs are slow** and hold Google access.
- **AI calls hold the Claude keys.**

## Decision
1. **Modules first.** Inside one deployable, draw module boundaries from the real import graph and enforce them in CI. The planned modules are identity, ingest, training, health records, reviews, admin and platform. Metrics become a shared library with no database access.
2. **Split a service only when an ADR names a security, scaling or failure reason.** The planned splits:
   - **web and API:** sessions, OAuth, the location database;
   - **ingest:** internet-facing, token only, a narrow database role, no AI or Google secrets;
   - **worker:** slow jobs, so their failures stay away from web requests;
   - **AI:** stateless, with no database role, so a compromise of it cannot read health data.
3. **The three TypeScript services share one image** with different entry points, on Docker Compose.

## Alternatives considered
- **A microservice per domain:**
  - It adds network calls, distributed failure and deploy work in exchange for scaling the app does not need.
  - Each extra service is one more thing for a single operator to patch and watch.
- **Keep one process with no boundaries:**
  - The ingest token, Google tokens and Claude keys would keep sharing one memory space, and slow jobs would keep sharing the web process.

## Consequences
- **Modules come first,** so a later split is a move, not a rewrite.
- **The secrets map gets a startup check:** each service refuses to start holding a secret it should not have.
- **Shared in-memory state moves to shared storage** only if a service ever runs more than one copy. That covers the rate limiters, the one-at-a-time guards and the visit set.
- **If a split stops paying for itself, we stop there.** Each phase leaves a complete system.
