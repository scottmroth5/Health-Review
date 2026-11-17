# API changelog

Every change to the API contract gets an entry here. The contract is [openapi.json](openapi.json), the OpenAPI document
in canonical form (keys sorted). To record a change:
1. Run `npm run api:snapshot`.
2. Add an entry at the top that names the hash it prints.

`test/api-contract.test.js` fails until the snapshot matches the running API and the newest entry names its hash.

Every path is served under `/api/v1/` (the stable, versioned prefix) as well as `/api/`. Health Auto Export's ingest
stays at `/api/ingest/*` for good: users' automations post there, so it is not under `/api/v1/`.

## 2026-11-17: v1 opened (fbfa07631b3d)
- `/api/v1/` serves every `/api/` route, except `/api/ingest/*`.
- The document's description says so. Otherwise the contract is the API as it stood after the route modules were split
  (v3 Phase 2 step 2), with no route, parameter or response changed.
