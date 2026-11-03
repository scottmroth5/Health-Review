# 0003: One shared PostgreSQL database, a schema and role per module

- **Status:** accepted (planned: PostgreSQL in v3.0, schemas and roles per module in v3.3)
- **Date:** 2026-11-02

## Context
- **Today:** all data lives in one SQLite file. Every user table carries `user_id`, and every query binds it (`db/scope.js`), checked by two test guards.
- **Why move:** the server's disk is encrypted with keys the cloud provider manages. The move to PostgreSQL closes that accepted exception: managed PostgreSQL and the server's disks get encrypted with a key the owner controls.
- **What spans tables:** reports, the weekly review and account export or deletion join across most tables.

## Decision
- **One managed PostgreSQL instance,** encrypted with a customer-managed key, in private subnets.
- **Each module owns a schema.** Each service connects with its own role, granted only what it reads and writes.
- **Code in other modules** reaches a module's data through that module's interface, not by querying its tables.
- **Row-level security is added on top of `@uid`**, with policies that match nothing when no user is set, as a second line of defense.

## Alternatives considered
- **A database per service:**
  - Account export and deletion would turn into distributed transactions.
  - The review's summary would need copies of data kept in sync.
  - Cost and backup work would multiply, for isolation that schemas, roles and RLS already give.
- **Stay on SQLite on the server:** it can't use the owner's key for storage and snapshots, and it can't serve more than one process well once ingest and the worker split.

## Consequences
- **Backups are one dump.** The encrypted off-site copy and the monthly restore test carry over.
- **The schema is a shared failure domain:** a bad migration affects every module. Migrations get a dry run on a restored copy, a snapshot first, and a separate migration role, since the app role has no DDL.
- **Revisit** if a module's load or data ever needs its own instance.
