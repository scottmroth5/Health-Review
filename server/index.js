// Starts the Health Review UI: npm start, then open http://localhost:5188
// Local only (AUTH_MODE=none binds to 127.0.0.1). Google sign-in loads on the first sync.
import { openHealthStore } from '../db/store.js';
import { getGoogleAuth } from '../tools/google/auth.js';
import { repoPath } from '../tools/paths.js';
import { createSheetsSource } from '../ingest/sheets.js';
import { runSync } from '../ingest/sync.js';
import { buildApp } from './app.js';
import { createReviewClaude } from '../agent/claude.js';
import { assertSafeBinding } from './auth.js';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 5188);
const authMode = process.env.AUTH_MODE ?? 'none';
assertSafeBinding({ host, mode: authMode });

const store = openHealthStore();
const quiet = { info() {}, warn() {}, error() {} };
const services = {
  sync: () => runSync({ store, source: createSheetsSource(getGoogleAuth()), logger: quiet }),
  // The Next program chat's client, made on first use (needs ANTHROPIC_API_KEY in .env).
  claude: (() => { let c; return () => (c ??= createReviewClaude()); })(),
};

const app = await buildApp({ store, services, publicDir: repoPath('server', 'public'), authMode });
await app.listen({ host, port });
console.log(`Health Review: http://localhost:${port}  (API contract: http://localhost:${port}/api/openapi.json)`);

const shutdown = async () => {
  await app.close();
  store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
