# 0004: PostgreSQL as the job queue, not SQS

- **Status:** accepted (planned: v3.2)
- **Date:** 2026-11-02

## Context
Sync, the weekly review, backups, the restore test and evals all run inside the web process today:
- **Scheduling:** an in-process scheduler fires them.
- **Overlap:** in-memory sets plus a 30-minute stale check on `runs` keep them from overlapping.

The owner wants these jobs in priority order, with the priorities set on an admin screen. A user's own "Sync now" should not wait behind scheduled work, and a change should reorder work that is already waiting.

## Decision
- **A `jobs` table in PostgreSQL:**
  - Workers claim jobs with `FOR UPDATE SKIP LOCKED`.
  - Priority is computed at claim time from the job type, the trigger (interactive, scheduled, admin, backfill) and how long the job has waited. The waiting time is capped, so nothing starves.
- **Admin control:** the admin edits `job_types` and trigger boosts, and every change is recorded.
- **Running a job:**
  - Leases and heartbeats replace the stale check.
  - A dedupe key replaces the in-memory overlap sets.
  - One scheduler, held by an advisory lock, only enqueues.

## Alternatives considered
- **Amazon SQS:**
  - SQS has no priority within a queue, so priority would mean one queue per level.
  - Work already waiting can't be reordered when the admin changes a setting.
  - Enqueuing can't share a transaction with the data change that caused it.
  - It adds a service, IAM policy and cost for a few jobs an hour.
- **A Node queue library on Redis:** it adds a stateful service to back up, patch and secure, for no gain at this scale.

## Consequences
- **No new infrastructure.** Enqueue is transactional, and queue state goes into the same backups.
- **The queue shares the database's load and failures.** At this volume (tens of jobs a day) that is negligible.
- **When SQS would win:**
  - throughput in the thousands of jobs a minute;
  - consumers outside this database's network;
  - fan-out to other systems;
  - or a need for the queue to outlive a database outage.
- **Job payloads hold identifiers and options only,** never health data, with a test that enforces it.
