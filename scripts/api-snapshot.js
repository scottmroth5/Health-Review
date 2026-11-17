// The recorded API contract (v3 Phase 2 step 3): writes docs/api/openapi.json, the OpenAPI document of a freshly built
// app in canonical form (keys sorted), and prints its short SHA-256 for the changelog entry in docs/api/CHANGELOG.md.
// test/api-contract.test.js fails until both match the running API, so every contract change is recorded on purpose.
//   npm run api:snapshot
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { repoPath } from '../tools/paths.ts';
import { openHealthStore } from '../db/store.ts';
import { buildApp } from '../server/app.js';

export const SNAPSHOT_PATH = repoPath('docs', 'api', 'openapi.json');
export const CHANGELOG_PATH = repoPath('docs', 'api', 'CHANGELOG.md');

/** Keys sorted at every level, so the text depends on the contract, never on the order routes were registered. */
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  return value;
}

/** The document as written to the snapshot: canonical JSON, two-space indent, a final newline. */
export const snapshotText = (doc) => `${JSON.stringify(canonical(doc), null, 2)}\n`;
export const snapshotHash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);

/** The OpenAPI document of a freshly built app (in memory, no data). */
export async function currentDocument() {
  const store = openHealthStore(':memory:', { log: {} });
  const app = await buildApp({ store, log: { info() {}, warn() {}, error() {} } });
  try {
    await app.ready();
    return app.swagger();
  } finally {
    await app.close();
    store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const text = snapshotText(await currentDocument());
  writeFileSync(SNAPSHOT_PATH, text);
  console.log(`docs/api/openapi.json written; hash ${snapshotHash(text)} (name it in a new docs/api/CHANGELOG.md entry)`);
}
