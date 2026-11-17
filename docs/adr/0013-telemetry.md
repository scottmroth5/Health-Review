# 0013: Telemetry through an attribute allowlist, kept on the server for now

- **Status:** accepted (Phase 2, 2026-11-17: on the server; CloudWatch planned)
- **Date:** 2026-11-17

## Context
The app logs one line per event (`[sync] ok`, `[review] failed`) and records runs and their Claude calls in the
database, but it has no view of request rates, latencies or errors per route. The v3 plan adds OpenTelemetry traces
and metrics in Phase 2, with one hard rule: nothing derived from request bodies, health values, prompts or responses
may be recorded, and a test must fail if anything else appears.

Where the data goes was the owner's call (2026-11-17), with three options:
- **On the server only:** nothing leaves the server.
- **AWS CloudWatch in the owner's account:** dashboards and alarms, but new IAM permissions and Terraform.
- **A third-party service:** a new outside party, so it would need a privacy policy change.

The owner chose the server now and CloudWatch later.

## Decision
- **One module, `tools/telemetry.ts`,** owns OpenTelemetry's tracer and meter providers. Code never calls the
  OpenTelemetry API directly. It calls `telemetry().request()`, `.job()` and `.ai()`, which build attributes only
  through `clean()`.
- **The allowlist:** only these attribute keys exist, each with a check its value must pass.
  - `http.request.method`;
  - `http.route`: the route template, such as `/api/days/:date`, or "unmatched", never the URL or a query;
  - `http.response.status_code`;
  - `job.name` and `job.result`;
  - `db.engine` and `app.instance`;
  - `ai.capability` (the run's name) and `ai.outcome` (ok, refused, error).

  Anything else is dropped; the tests' strict option throws instead. The metrics views apply the same allowlist again
  (`createAllowListAttributesProcessor`), as a second layer.
- **What is recorded:** each request (`server/app.js`, an `onResponse` hook), each scheduled job run
  (`server/scheduler.js`), and each Claude call (`db/runs.ts recordCall`). Tokens and cost stay in the runs table.
- **Output (`TELEMETRY`):**
  - **`log`, the default:**
    - a `[trace]` line for a request slower than a second or answered with a server error, and for a failed job or
      Claude call;
    - a `[telemetry]` summary every 15 minutes: request count and errors, then per route the count, average and
      longest time, plus jobs and Claude calls by outcome.

    Both go to `docker compose logs`, the same as today's lines.
  - **`off`:** records nothing.
  - **CloudWatch, later:** an `otlp` mode will add the OTLP exporter package and send to an OpenTelemetry collector
    beside the app, which writes to CloudWatch in the owner's account (Terraform the owner applies). Nothing else
    changes.
- **Dependencies:** the official OpenTelemetry JS packages: `@opentelemetry/api` 1.10.0, `sdk-trace` 3.0.0, `sdk-metrics`
  3.0.0 and `resources` 3.0.0. They are pinned exactly, to releases at least two weeks old. No auto-instrumentation: it
  would record URLs and database statements.

## Alternatives considered
- **Auto-instrumentation (`@opentelemetry/auto-instrumentations-node`):** it records full URLs, SQL text and headers by
  default. Filtering them out afterwards is the wrong way round for health data.
- **Our own counters with no OpenTelemetry:** less code today, but CloudWatch and any later collector would need a
  rewrite. OpenTelemetry makes the later step a configuration change.
- **A third-party service:** steered away from because it is a new outside party for this data, even though the data is
  only route names and timings.

## Consequences
- **Tests:** `test/telemetry.test.js` sends requests carrying a made-up marker, an email and a user id in the URL,
  query, headers and body. It fails if any of them, or any attribute key not on the allowlist, appears in the exported
  spans or metrics.
- **Privacy:** no policy change. The data is counts, timings and route templates in the server's own logs, the same
  kind as today's log lines. Moving to CloudWatch keeps the data in the owner's AWS account; the policies are reviewed
  with the owner at that step.
- **A new attribute needs:** an entry in `ALLOWED` with its check, a test, and a line here.
