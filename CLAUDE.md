# Health Review Agent

## Purpose
Weekly health review agent built on a shared core in /core.
/core is copied from Job-Agent; keep it generic and port any core improvements back.

## Structure
/core               generic agent infrastructure
/agent              prompts, tools, and review logic
/metrics            deterministic metric calculations with unit tests
/evals              metric regression fixtures
/data               gitignored; local health datastore and exports
/legacy contains the v1 scripts for reference only. Do not modify or import from them.

## Commands
npm test            run unit tests, including metric fixtures
npm run evals       run eval suites and print results
npm run review      generate the weekly health review

## Hard rules
All health data stays on this machine. Never add cloud storage, CI, or remote sync for /data.
Send the Claude API computed summaries only, never raw exports.
Include genetics or medication data only when a specific question requires it.
Metrics are computed in code, never by the model.
Anything involving medications, abnormal labs, or symptoms is flagged for physician discussion, not turned into a recommendation.
Never output em dashes, en dashes, or double hyphens in generated text.
Never commit anything under /data, or any .csv or .xml file. Never log or print API keys.

## Conventions
Every new tool gets a JSON schema, a handler, and a unit test.
Every metric change requires passing fixture tests.
Use plan mode for any change touching more than one file.