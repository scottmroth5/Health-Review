# Architecture as it runs today (v2)

This is the system as built at the start of v3 (2026-11-02), before any v3 phase. The planned changes are in `docs/adr`. No
addresses, account details or hostnames appear here; the server's own `.env` holds them.

```mermaid
flowchart LR
  subgraph Users
    B["Browser or installed web app<br/>(plain JS, no build, strict CSP)"]
    V["Demo visitor"]
    HAE["Health Auto Export<br/>(iPhone)"]
  end

  subgraph Server["One cloud server (Docker Compose)"]
    C["Caddy<br/>TLS, two sites"]
    subgraph App["app container (Node 22, Fastify)"]
      W["Web UI and API<br/>Google sign-in, sessions,<br/>US-only check, rate limits"]
      I["Ingest routes<br/>bearer token per user"]
      S["Scheduler in the web process<br/>sync, review, backup,<br/>restore test"]
      AI["Claude calls<br/>review, chat, help,<br/>program extraction"]
      T["run tracer (db/runs.js)<br/>runs, run_calls"]
    end
    D["demo container<br/>made-up data, read-only root,<br/>no secrets, no sign-in"]
    DB[("SQLite file<br/>one database, user_id on<br/>every user table")]
    F[("data folder<br/>MAPS catalog, Google sign-in,<br/>location database")]
  end

  subgraph Outside["Outside services"]
    G["Google<br/>sign-in, Sheets (read),<br/>Drive (exports, backups)"]
    CL["Claude API"]
    M["Gmail SMTP<br/>admin and user email"]
    PH["PostHog<br/>demo only, anonymous"]
  end

  B -->|HTTPS| C
  V -->|HTTPS| C
  HAE -->|"HTTPS POST, token"| C
  C --> W
  C --> I
  C --> D
  W --> DB
  I --> DB
  S --> DB
  S --> G
  S --> AI
  W --> AI
  AI --> CL
  AI --> T
  T --> DB
  W --> F
  S -->|"encrypted backup"| G
  W --> M
  W -->|"Google sign-in"| G
  D -.->|"counts only, when enabled"| PH
```

## Components
- **Web and API** (`server/app.js`, 112 routes):
  - Google sign-in and sessions.
  - Users who are pending, rejected or without consent are sent to their own pages.
  - The US-only check uses a local location database (DB-IP Lite), which also feeds the admin's usage totals. Nothing is looked up outside.
- **Ingest** (`/api/ingest/*`): Health Auto Export posts with each user's own token. It is open without a session and has its own rate limits.
- **Scheduler** (`server/scheduler.js`): it runs inside the web process, on the owner's time zone.
  - It runs sync and the review for each approved user, plus a nightly backup and a monthly restore test.
  - In-memory sets keep sync, review and chat to one at a time per user. A 30-minute stale check on `runs` stops a job overlapping itself.
  - Failures email the admin (`server/alerts.js`).
- **AI:** each Claude call happens in the request or job that needs it, on that user's AI access (their own key, or the owner's with a monthly cap).
  - The run tracer (`db/runs.js`) records metadata, tokens and cost in `runs` and `run_calls`. The monthly caps are computed from those.
  - Prompts and replies are never logged.
- **Data:** one SQLite file.
  - Every user table carries `user_id`. Every query binds it through `db/scope.js`, checked by a static guard and a route-by-route isolation test.
  - Migrations are append-only, and the file is copied and checked before any of them runs.
- **Backups:** a nightly online snapshot, gzipped and then encrypted with a passphrase-derived key before it leaves the server for Google Drive. A monthly restore test decrypts the newest one into a temporary folder and compares row counts.
- **Demo:** the same image in a separate container, with no env file, a read-only root, an empty tmpfs data folder and a made-up database rebuilt each day. It cannot reach the app's data or secrets.

## Trust boundaries
1. **The internet to Caddy:** TLS only. The demo is a separate site.
2. **Caddy to the app:**
   - every route except health and ingest needs a Google session for an approved account, from an allowed country;
   - writes must be same-origin;
   - every route has a per-address ceiling.
3. **Ingest:** a per-user bearer token (only its hash is stored), JSON only, 5 MB, rate limited.
4. **The app to outside services:**
   - only computed summaries and the owner's own notes go to Claude;
   - Google Sheets is read-only;
   - only the app's own files go to Drive, and backups are encrypted first;
   - email carries names, dates and links only.
5. **The demo:** made-up data, no secrets, every write refused. Anonymous counts go to PostHog only when enabled, and never with Global Privacy Control on.

## Known limits that v3 addresses
- The server's disk is encrypted with keys the cloud provider manages, an accepted temporary exception (ADR 0003).
- Background jobs share the web process (ADR 0002, ADR 0004).
- Ingest, jobs and AI calls share one process and its secrets (ADR 0002).
